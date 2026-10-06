/**
 * Runs a scheduled job (brief §7.5, RNG-GOV-021/024/025): one run at a time across every API and
 * worker instance (MySQL named lock on a pinned connection), a run log in `job_runs` with one line
 * per institution in `job_run_items` (RC-26), and a failure alert on the job stream. Manual runs from
 * the back office (GOV-004) take the same lock, so a manual and a scheduled run never overlap.
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/ringpe_models';
import { newPublicIdPair } from '../utils/idGenerator';
import { opsMetrics } from '../utils/metrics';
import type { JobItem } from '../services/subscription.service';
import type { JobDefinition, JobTrigger } from './index';

export interface RunOutcome {
  readonly runId: string;
  readonly status: 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILED';
  readonly processed: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Lines of one institution are merged into one log item (one row per institution and run). */
function merge(items: readonly JobItem[]) {
  const by = new Map<string, JobItem>();
  const out: JobItem[] = [];
  for (const i of items) {
    if (i.institutionId === null) {
      out.push(i);
      continue;
    }
    const prev = by.get(i.institutionId);
    if (!prev) {
      by.set(i.institutionId, i);
      continue;
    }
    by.set(i.institutionId, {
      institutionId: i.institutionId,
      status:
        prev.status === 'FAILED' || i.status === 'FAILED'
          ? 'FAILED'
          : prev.status === 'SUCCESS' || i.status === 'SUCCESS'
            ? 'SUCCESS'
            : 'SKIPPED',
      processed: prev.processed + i.processed,
      failed: prev.failed + i.failed,
      note: [prev.note, i.note].filter(Boolean).join('; ').slice(0, 500) || null,
      errorCode: prev.errorCode ?? i.errorCode ?? null,
    });
  }
  return [...out, ...by.values()];
}

export class JobRunner {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly loggers: Loggers },
  ) {}

  /**
   * Runs `job` for `periodKey` under its lock. Returns null when another run holds the lock.
   */
  async run(
    job: JobDefinition,
    o: {
      trigger: JobTrigger;
      periodKey: string;
      requestedBy?: Buffer | null;
      reason?: string | null;
      /** An institution's own run (GOV-007), row id. */
      scopeInstitutionId?: string | null;
    },
  ): Promise<RunOutcome | null> {
    const lock = `ringpe:job:${job.id}`;
    return this.deps.db.connection().execute(async (conn) => {
      const got = await sql<{ ok: number | null }>`SELECT GET_LOCK(${lock}, 0) AS ok`.execute(conn);
      if (Number(got.rows[0]?.ok) !== 1) return null;
      try {
        const pub = newPublicIdPair();
        const startedAt = new Date();
        const ins = await conn
          .insertInto('job_runs')
          .values({
            public_id: pub.bin,
            job_id: job.id,
            period_key: o.periodKey,
            trigger_kind: o.trigger,
            requested_by: o.requestedBy ?? null,
            reason: o.reason ?? null,
            scope_institution_id: o.scopeInstitutionId ?? null,
            correlation_id: randomBytes(16),
            status: 'STARTED',
            processed: 0,
            failed: 0,
            skipped: 0,
            started_at: startedAt,
          })
          .executeTakeFirstOrThrow();
        const runId = String(ins.insertId);
        this.deps.loggers.job.info('job started', {
          job: job.id,
          period: o.periodKey,
          trigger: o.trigger,
        });
        const raw: JobItem[] = [];
        let crashed: unknown = null;
        try {
          await job.run({
            periodKey: o.periodKey,
            trigger: o.trigger,
            scope: o.scopeInstitutionId ? { institutionId: o.scopeInstitutionId } : undefined,
            item: (i) => raw.push(i),
          });
        } catch (e) {
          crashed = e;
        }
        const items = merge(raw);
        const endedAt = new Date();
        for (const i of items) {
          await conn
            .insertInto('job_run_items')
            .values({
              job_run_id: runId,
              institution_id: i.institutionId,
              status: i.status,
              items_processed: i.processed,
              items_failed: i.failed,
              note: i.note,
              error_code: i.errorCode ?? null,
              started_at: startedAt,
              ended_at: endedAt,
            })
            .execute();
        }
        const processed = items.filter((i) => i.status === 'SUCCESS').length;
        const failed = items.filter((i) => i.status === 'FAILED').length;
        const skipped = items.filter((i) => i.status === 'SKIPPED').length;
        const status: RunOutcome['status'] =
          crashed || (failed > 0 && processed === 0 && skipped === 0)
            ? 'FAILED'
            : failed > 0
              ? 'PARTIAL_FAILURE'
              : 'SUCCESS';
        await conn
          .updateTable('job_runs')
          .set({ status, processed, failed, skipped, ended_at: endedAt })
          .where('id', '=', runId)
          .execute();
        opsMetrics.jobRun(job.id, status, (endedAt.getTime() - startedAt.getTime()) / 1000);
        if (status === 'SUCCESS') {
          this.deps.loggers.job.info('job finished', { job: job.id, processed, skipped });
        } else {
          // Failure alert (RNG-GOV-025): the job stream at error level feeds the alerting.
          this.deps.loggers.job.error('job failed', {
            job: job.id,
            period: o.periodKey,
            status,
            failed,
            error: crashed ? String(crashed) : undefined,
          });
        }
        return { runId: pub.id, status, processed, failed, skipped };
      } finally {
        await sql`SELECT RELEASE_LOCK(${lock})`.execute(conn);
      }
    });
  }
}

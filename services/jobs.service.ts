/**
 * Scheduled processing in the back office (GOV-001…004; SRS 26.6, RNG-GOV-021/024/025; prototype
 * o.jobs): the catalogue with each process's last run, run history, run log by institution, and a
 * manual run. A process runs only when its module has registered a runner (schedulers/index.ts);
 * until then a manual run is refused and the catalogue names the phase that brings it. A manual run
 * takes the same lock as the worker's scheduled run and is recorded with who asked and why.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { JOB_CATALOGUE } from '../schedulers/catalogue';
import { RUNNABLE_JOB_IDS, type JobDefinition } from '../schedulers';
import type { JobRunner } from '../schedulers/runner';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import type { Principal } from '../utils/principal';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

type RunRow = {
  public_id: Buffer;
  job_id: string;
  period_key: string;
  trigger_kind: 'SCHEDULE' | 'MANUAL' | 'CATCH_UP';
  status: 'STARTED' | 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILED';
  processed: number;
  failed: number;
  skipped: number;
  started_at: Date;
  ended_at: Date | null;
};

const run = (r: RunRow) => ({
  id: binToUuid(r.public_id),
  jobId: r.job_id,
  period: r.period_key,
  trigger: r.trigger_kind,
  status: r.status,
  processed: r.processed,
  failed: r.failed,
  skipped: r.skipped,
  startedAt: iso(r.started_at) ?? '',
  endedAt: iso(r.ended_at),
});

const RUN_COLUMNS = [
  'public_id',
  'job_id',
  'period_key',
  'trigger_kind',
  'status',
  'processed',
  'failed',
  'skipped',
  'started_at',
  'ended_at',
] as const;

/**
 * GOV-006: the console task that owns each job's effect on an institution — a user sees the runs of
 * the jobs whose task they hold (role → task → sub-task).
 */
const OWNING_TASK: Readonly<Record<string, string>> = {
  'allowance-cycle': 'allowances.view',
  'coupon-expiry': 'coupons.view',
  'event-status': 'events.view',
  'tuition-autodebit': 'fees.view',
  'settlement-run': 'settlements.view',
  'accounting-vouchers': 'vouchers.view',
  'auto-absent': 'attendance.view',
  'trip-generation': 'transport.view',
  'transport-daily-notice': 'transport.view',
  'announcement-dispatch': 'comms.view',
  'comm-log-purge': 'commreport.view',
  'held-credit-release': 'members.view',
  'subscription-billing': 'home.view',
};

export class JobsService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly exec: {
      readonly jobs: readonly JobDefinition[];
      readonly runner: JobRunner;
    } | null = null,
  ) {}

  /** GOV-006: the runs that touched the caller's institution, newest first (keyset cursor). */
  async institutionRuns(
    p: Principal,
    f: { jobId?: string | undefined; cursor?: string | undefined },
  ) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await this.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!inst) throw new NotFoundError();
    const allowed = Object.entries(OWNING_TASK)
      .filter(([, task]) => p.subTasks.includes(task))
      .map(([job]) => job)
      .filter((job) => !f.jobId || job === f.jobId);
    if (!allowed.length) return { items: [], nextCursor: null };
    let q = this.db
      .selectFrom('job_run_items as i')
      .innerJoin('job_runs as r', 'r.id', 'i.job_run_id')
      .select([
        'i.id',
        'i.status',
        'i.items_processed',
        'i.items_failed',
        'i.note',
        'i.started_at',
        'i.ended_at',
        'r.public_id',
        'r.job_id',
        'r.period_key',
        'r.trigger_kind',
        'r.status as run_status',
      ])
      .where('i.institution_id', '=', String(inst.id))
      .where('r.job_id', 'in', allowed);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('i.id', '<', f.cursor);
    const rows = await q.orderBy('i.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((r) => ({
        runId: binToUuid(r.public_id),
        job: { id: r.job_id, name: JOB_CATALOGUE.find((j) => j.id === r.job_id)?.name ?? r.job_id },
        periodKey: r.period_key,
        trigger: r.trigger_kind,
        runStatus: r.run_status,
        status: r.status,
        processed: r.items_processed,
        failed: r.items_failed,
        note: r.note,
        startedAt: new Date(r.started_at).toISOString(),
        endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      })),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  /** GOV-001: every process with its schedule, behaviour and last run. */
  async catalogue() {
    const last = await this.db
      .selectFrom('job_runs')
      .select(RUN_COLUMNS)
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('job_runs')
          .select((x) => x.fn.max('id').as('id'))
          .groupBy('job_id'),
      )
      .execute();
    const runnable = new Set(RUNNABLE_JOB_IDS);
    return {
      items: JOB_CATALOGUE.map((j) => {
        const r = last.find((x) => x.job_id === j.id);
        return { ...j, available: runnable.has(j.id), lastRun: r ? run(r as RunRow) : null };
      }),
    };
  }

  /** GOV-002: a process's runs, newest first. */
  async runs(jobId: string, limit = 50) {
    if (!JOB_CATALOGUE.some((j) => j.id === jobId)) throw new NotFoundError();
    const rows = await this.db
      .selectFrom('job_runs')
      .select(RUN_COLUMNS)
      .where('job_id', '=', jobId)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return { items: rows.map((r) => run(r as RunRow)) };
  }

  /** GOV-003: one run with its log by institution. */
  async runLog(runId: string) {
    if (!isUuid(runId)) throw new NotFoundError();
    const r = await this.db
      .selectFrom('job_runs')
      .select(['id', ...RUN_COLUMNS])
      .where('public_id', '=', uuidToBin(runId))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    const items = await this.db
      .selectFrom('job_run_items as i')
      .leftJoin('institutions as inst', 'inst.id', 'i.institution_id')
      .select([
        'inst.name as institution',
        'i.status',
        'i.items_processed',
        'i.items_failed',
        'i.note',
        'i.error_code',
      ])
      .where('i.job_run_id', '=', r.id)
      .orderBy('i.id')
      .execute();
    return {
      ...run(r as RunRow),
      items: items.map((i) => ({
        institution: i.institution,
        status: i.status,
        processed: i.items_processed,
        failed: i.items_failed,
        note: i.note,
        errorCode: i.error_code,
      })),
    };
  }

  /**
   * GOV-007: an institution runs a job for itself now (the tuition auto-debit). Same lock, run log
   * and re-run safety as the schedule; the run touches only the caller's institution and is
   * recorded with who asked and why. Jobs that aren't institution-scoped are not found here.
   */
  async institutionRun(
    p: Principal,
    jobId: string,
    input: { period?: string | undefined; reason: string },
  ) {
    const job = this.exec?.jobs.find((j) => j.id === jobId && j.institutionRunSubTask);
    if (!job?.institutionRunSubTask || !this.exec) throw new NotFoundError();
    if (!p.subTasks.includes(job.institutionRunSubTask)) throw new AuthorizationError();
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await this.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!inst) throw new NotFoundError();
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 5)
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.REQUIRED' }]);
    const today = istBusinessDate(new Date());
    const period = input.period?.trim() || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period) || Number.isNaN(Date.parse(period)) || period > today) {
      throw new ValidationError([{ field: 'period', code: 'VALIDATION.FORMAT' }]);
    }
    const out = await this.exec.runner.run(job, {
      trigger: 'MANUAL',
      periodKey: period,
      requestedBy: isUuid(p.subject) ? uuidToBin(p.subject) : null,
      reason,
      scopeInstitutionId: String(inst.id),
    });
    if (!out) throw new ConflictError('GOV.JOB_RUNNING');
    const item = await this.db
      .selectFrom('job_run_items as i')
      .innerJoin('job_runs as r', 'r.id', 'i.job_run_id')
      .select(['i.status', 'i.items_processed', 'i.items_failed', 'i.note'])
      .where('r.public_id', '=', uuidToBin(out.runId))
      .where('i.institution_id', '=', String(inst.id))
      .executeTakeFirst();
    return {
      runId: out.runId,
      job: { id: job.id, name: JOB_CATALOGUE.find((j) => j.id === job.id)?.name ?? job.id },
      periodKey: period,
      runStatus: out.status,
      status: item?.status ?? 'SKIPPED',
      processed: item?.items_processed ?? 0,
      failed: item?.items_failed ?? 0,
      note: item?.note ?? null,
    };
  }

  /** GOV-004: a manual run for a stated period (default today, IST), under the job's lock. */
  async runNow(
    jobId: string,
    input: { period?: string | undefined; reason: string },
    p?: Principal,
  ) {
    const entry = JOB_CATALOGUE.find((j) => j.id === jobId);
    if (!entry) throw new NotFoundError();
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 5)
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.REQUIRED' }]);
    const job = this.exec?.jobs.find((j) => j.id === jobId);
    // Other runners arrive with their modules (Phases 3–8); until then a manual run is refused.
    if (!job || !this.exec)
      throw new ConflictError('GOV.JOB_NOT_AVAILABLE', { params: { phase: entry.phase } });
    const today = istBusinessDate(new Date());
    const period = input.period?.trim() || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period) || Number.isNaN(Date.parse(period)) || period > today) {
      throw new ValidationError([{ field: 'period', code: 'VALIDATION.FORMAT' }]);
    }
    const out = await this.exec.runner.run(job, {
      trigger: 'MANUAL',
      periodKey: period,
      requestedBy: p && isUuid(p.subject) ? uuidToBin(p.subject) : null,
      reason,
    });
    if (!out) throw new ConflictError('GOV.JOB_RUNNING');
    return this.runLog(out.runId);
  }
}

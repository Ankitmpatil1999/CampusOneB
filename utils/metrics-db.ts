/**
 * Gauges read from the database when Prometheus scrapes (the alerts of docs/runbooks): how long the
 * oldest due outbox event has waited, how many are dead, and how many job runs failed in the last day.
 * Each read is one indexed query; a failed read leaves the gauge as it was.
 */
import { sql, type Kysely } from 'kysely';
import { Gauge } from 'prom-client';
import type { Database } from '../models/campusone_models';
import type { Metrics } from './metrics';

export function registerDatabaseGauges(metrics: Metrics, db: Kysely<Database>): void {
  const p = metrics.prefix;
  new Gauge({
    name: `${p}outbox_oldest_pending_seconds`,
    help: 'Age of the oldest outbox event due and not yet dispatched (0 when none)',
    registers: [metrics.registry],
    async collect() {
      try {
        const r = await sql<{ s: number | null }>`
          SELECT TIMESTAMPDIFF(SECOND, MIN(available_at), UTC_TIMESTAMP(3)) AS s
          FROM outbox_events WHERE status = 'PENDING' AND available_at <= UTC_TIMESTAMP(3)`.execute(
          db,
        );
        this.set(Math.max(0, Number(r.rows[0]?.s ?? 0)));
      } catch {
        // keep the last value
      }
    },
  });
  new Gauge({
    name: `${p}outbox_dead_events`,
    help: 'Outbox events that exhausted their attempts (status DEAD)',
    registers: [metrics.registry],
    async collect() {
      try {
        const r = await sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'DEAD'`.execute(db);
        this.set(Number(r.rows[0]?.n ?? 0));
      } catch {
        // keep the last value
      }
    },
  });
  new Gauge({
    name: `${p}job_runs_failed_last_day`,
    help: 'Job runs that ended FAILED or PARTIAL_FAILURE in the last 24 hours, by job',
    labelNames: ['job'] as const,
    registers: [metrics.registry],
    async collect() {
      try {
        const r = await sql<{ job_id: string; n: number }>`
          SELECT job_id, COUNT(*) AS n FROM job_runs
          WHERE status IN ('FAILED', 'PARTIAL_FAILURE')
            AND started_at >= UTC_TIMESTAMP(3) - INTERVAL 1 DAY
          GROUP BY job_id`.execute(db);
        this.reset();
        for (const row of r.rows) this.set({ job: row.job_id }, Number(row.n));
      } catch {
        // keep the last value
      }
    },
  });
}

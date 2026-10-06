/**
 * Prometheus metrics (brief §7.3). Exposed on `/metrics` to the internal network only (the API, and
 * the worker on its health port). Request rate, errors and duration per route; database queries;
 * payment-engine refusals by check; job runs; messages sent by channel and outcome; rate-limit
 * refusals. Gauges read from the database (outbox lag) are added by `registerDatabaseGauges`.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  readonly registry: Registry;
  readonly prefix: string;
  observeHttp(method: string, route: string, status: number, seconds: number): void;
  observeDbQuery(seconds: number, ok: boolean): void;
  /** A payment refused by the engine (§9.11): which check, at which stage. */
  paymentRefused(check: string, stage: string): void;
  /** A finished job run: SUCCESS, PARTIAL_FAILURE or FAILED. */
  jobRun(job: string, status: string, seconds: number): void;
  /** One message attempt in the communication log (CR-16). */
  commSent(kind: string, channel: string, outcome: string): void;
  /** A request refused by a rate limiter (global, session, auth…). */
  rateLimited(limiter: string): void;
}

export function createMetrics(opts: { prefix?: string; defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  const prefix = opts.prefix ?? 'ringpe_';
  if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: registry, prefix });

  const httpDuration = new Histogram({
    name: `${prefix}http_request_duration_seconds`,
    help: 'HTTP request duration by method, route and status',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1, 2, 5],
    registers: [registry],
  });
  const httpErrors = new Counter({
    name: `${prefix}http_errors_total`,
    help: 'HTTP responses with status >= 500',
    labelNames: ['method', 'route'] as const,
    registers: [registry],
  });
  const dbQueries = new Histogram({
    name: `${prefix}db_query_duration_seconds`,
    help: 'Database query duration',
    labelNames: ['outcome'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 5],
    registers: [registry],
  });
  const refusals = new Counter({
    name: `${prefix}payment_refusals_total`,
    help: 'Payments refused by the engine, by check (P1… / V1…) and stage',
    labelNames: ['check', 'stage'] as const,
    registers: [registry],
  });
  const jobRuns = new Counter({
    name: `${prefix}job_runs_total`,
    help: 'Finished job runs by job and status (SUCCESS, PARTIAL_FAILURE, FAILED)',
    labelNames: ['job', 'status'] as const,
    registers: [registry],
  });
  const jobDuration = new Histogram({
    name: `${prefix}job_run_duration_seconds`,
    help: 'Job run duration by job',
    labelNames: ['job'] as const,
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900, 1800],
    registers: [registry],
  });
  const comm = new Counter({
    name: `${prefix}comm_messages_total`,
    help: 'Messages attempted, by kind, channel and outcome (the communication log)',
    labelNames: ['kind', 'channel', 'outcome'] as const,
    registers: [registry],
  });
  const limited = new Counter({
    name: `${prefix}rate_limited_total`,
    help: 'Requests refused by a rate limiter, by limiter',
    labelNames: ['limiter'] as const,
    registers: [registry],
  });

  return {
    registry,
    prefix,
    observeHttp(method, route, status, seconds) {
      httpDuration.observe({ method, route, status: String(status) }, seconds);
      if (status >= 500) httpErrors.inc({ method, route });
    },
    observeDbQuery(seconds, ok) {
      dbQueries.observe({ outcome: ok ? 'ok' : 'error' }, seconds);
    },
    paymentRefused(check, stage) {
      refusals.inc({ check, stage });
    },
    jobRun(job, status, seconds) {
      jobRuns.inc({ job, status });
      jobDuration.observe({ job }, seconds);
    },
    commSent(kind, channel, outcome) {
      comm.inc({ kind, channel, outcome });
    },
    rateLimited(limiter) {
      limited.inc({ limiter });
    },
  };
}

let processMetrics: Metrics | null = null;

/** The process's metrics (set once at start-up), for code that has no request at hand. */
export function setProcessMetrics(m: Metrics | null): void {
  processMetrics = m;
}

/** Records into the process's metrics; a no-op before start-up and in unit tests. */
export const opsMetrics = {
  paymentRefused: (check: string, stage: string) => processMetrics?.paymentRefused(check, stage),
  jobRun: (job: string, status: string, seconds: number) =>
    processMetrics?.jobRun(job, status, seconds),
  commSent: (kind: string, channel: string, outcome: string) =>
    processMetrics?.commSent(kind, channel, outcome),
  rateLimited: (limiter: string) => processMetrics?.rateLimited(limiter),
};

/**
 * The request log behind the log analyser (IDN-075/076, SRS 6.31). Rows are buffered in memory and
 * written in batches, off the request path, so a slow database never slows a response; when the
 * buffer is full the oldest rows are dropped (and counted) rather than holding memory. Never bodies or
 * query values (OI-INT-08); the client address loses its last part.
 */
import type { Kysely } from 'kysely';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/campusone_models';

export interface RequestLogRow {
  readonly at: Date;
  readonly correlationId: string | null;
  readonly method: string;
  readonly route: string;
  readonly path: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly surface: string | null;
  readonly actor: Buffer | null;
  readonly institution: Buffer | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly queryKeys: readonly string[];
  readonly problemCode: string | null;
}

/** 192.168.1.23 → 192.168.1.x · 2001:db8:a:b:… → 2001:db8:a:x */
export const ipPrefix = (ip: string | null | undefined) => {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.x`;
  const parts = ip.split(':').filter(Boolean);
  return parts.length ? `${parts.slice(0, 3).join(':')}:x` : null;
};

const istDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

export class RequestLogStore {
  private buffer: RequestLogRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  dropped = 0;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly loggers: Loggers;
      readonly maxBuffer?: number;
      readonly batchSize?: number;
      readonly intervalMs?: number;
    },
  ) {}

  push(row: RequestLogRow) {
    const max = this.deps.maxBuffer ?? 10_000;
    if (this.buffer.length >= max) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(row);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.deps.intervalMs ?? 1000);
      this.timer.unref?.();
    }
  }

  /** Writes what is buffered (also called on shutdown). */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const size = this.deps.batchSize ?? 500;
      while (this.buffer.length) {
        const batch = this.buffer.splice(0, size);
        try {
          await this.deps.db
            .insertInto('request_log')
            .values(
              batch.map((r) => ({
                logged_on: istDate(r.at),
                at: r.at,
                correlation_id: r.correlationId?.slice(0, 64) ?? null,
                method: r.method.slice(0, 8),
                route: r.route.slice(0, 200),
                path: r.path.slice(0, 300),
                status: r.status,
                latency_ms: Math.max(0, Math.round(r.latencyMs)),
                surface: r.surface?.slice(0, 16) ?? null,
                actor: r.actor,
                institution: r.institution,
                ip_prefix: ipPrefix(r.ip),
                user_agent: r.userAgent?.slice(0, 200) ?? null,
                query_keys: r.queryKeys.length ? r.queryKeys.join(',').slice(0, 300) : null,
                problem_code: r.problemCode?.slice(0, 80) ?? null,
              })),
            )
            .execute();
        } catch (e) {
          this.dropped += batch.length;
          this.deps.loggers.app.warn('request log not written', {
            rows: batch.length,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }
}

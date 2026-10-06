/**
 * Logging (brief §7.2; reference logger trio kept, plus app/audit/security/job streams).
 * JSON lines on stdout (collected centrally); optional daily-rotated files per stream when
 * LOG_DIR is set. Every line carries the correlation, tenant and actor ids; metadata is redacted
 * by default.
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getContext } from '../utils/request-context';
import { redact, redactText } from '../utils/redact';

export const LOG_STREAMS = [
  'app',
  'request',
  'response',
  'database',
  'audit',
  'security',
  'job',
] as const;
export type LogStream = (typeof LOG_STREAMS)[number];
export type Loggers = Readonly<Record<LogStream, winston.Logger>>;

export interface LoggingOptions {
  readonly level: string;
  readonly dir?: string;
  readonly retentionDays: number;
  readonly silent?: boolean;
  /** Extra transport (tests capture lines with it). */
  readonly transport?: winston.transport;
}

const RESERVED = new Set(['level', 'message', 'timestamp', 'stream']);

const enrich = (stream: LogStream) =>
  winston.format((info) => {
    const ctx = getContext();
    const out = info as winston.Logform.TransformableInfo & Record<string, unknown>;
    out['stream'] = stream;
    if (ctx) {
      out['correlationId'] ??= ctx.correlationId;
      if (ctx.institutionId) out['institutionId'] ??= ctx.institutionId;
      if (ctx.actorId) out['actorId'] ??= ctx.actorId;
    }
    if (typeof out.message === 'string') out.message = redactText(out.message);
    for (const key of Object.keys(out)) {
      if (!RESERVED.has(key)) out[key] = redact(out[key]);
    }
    return out;
  })();

export function createLoggers(opts: LoggingOptions): Loggers {
  const make = (stream: LogStream): winston.Logger => {
    const transports: winston.transport[] = [new winston.transports.Console()];
    if (opts.dir) {
      transports.push(
        new DailyRotateFile({
          dirname: opts.dir,
          filename: `${stream}-%DATE%.log`,
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxFiles: `${opts.retentionDays}d`,
        }),
      );
    }
    if (opts.transport) transports.push(opts.transport);
    return winston.createLogger({
      level: opts.level,
      silent: opts.silent ?? false,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        enrich(stream),
        winston.format.json(),
      ),
      transports,
      exitOnError: false,
    });
  };
  return Object.fromEntries(LOG_STREAMS.map((s) => [s, make(s)])) as Loggers;
}

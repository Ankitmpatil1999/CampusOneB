/**
 * Request and response loggers (reference trio). Logs method, path, status and latency — never
 * bodies or query values (OI-INT-08); query parameter names only.
 */
import type { Request, RequestHandler } from 'express';
import type { Loggers } from '../controllers/logger';
import type { Metrics } from '../utils/metrics';
import { isUuid, uuidToBin } from '../utils/idGenerator';
import type { RequestLogStore } from '../utils/request-log';
import { updateContext } from '../utils/request-context';

const routeOf = (req: Request): string => {
  const r = req.route as { path?: unknown } | undefined;
  return typeof r?.path === 'string' ? `${req.baseUrl}${r.path}` : 'unmatched';
};

/** A uuid as its binary form, or null. */
const bin = (v: string | undefined) => (v && isUuid(v) ? uuidToBin(v) : null);

export function requestLogger(
  loggers: Loggers,
  metrics?: Metrics,
  store?: RequestLogStore,
): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    loggers.request.info('request', {
      method: req.method,
      path: req.path,
      queryKeys: Object.keys(req.query ?? {}),
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 200),
    });
    res.on('finish', () => {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const route = routeOf(req);
      updateContext({ route });
      const meta = {
        method: req.method,
        path: req.path,
        route,
        status: res.statusCode,
        latencyMs: Math.round(latencyMs * 10) / 10,
        contentLength: res.getHeader('content-length'),
      };
      if (res.statusCode >= 500) loggers.response.error('response', meta);
      else if (res.statusCode >= 400) loggers.response.warn('response', meta);
      else loggers.response.info('response', meta);
      metrics?.observeHttp(req.method, route, res.statusCode, latencyMs / 1000);
      // The log analyser's row (IDN-075): health probes and the realtime handshake are left out.
      if (store && !req.path.startsWith('/health') && !req.path.startsWith('/realtime')) {
        const p = req.principal;
        store.push({
          at: new Date(),
          correlationId: req.correlationId ?? null,
          method: req.method,
          route,
          path: req.path,
          status: res.statusCode,
          latencyMs,
          surface: p?.surface ?? null,
          actor: bin(p?.subject),
          institution: bin(p?.institutionId),
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          queryKeys: Object.keys(req.query ?? {}),
          problemCode:
            typeof res.locals['problemCode'] === 'string' ? res.locals['problemCode'] : null,
        });
      }
    });
    next();
  };
}

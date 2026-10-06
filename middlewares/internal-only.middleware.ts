import type { RequestHandler } from 'express';
import { NotFoundError } from '../utils/CustomAPIError';

/**
 * Restricts a route to the internal network (detailed health, metrics). Outside callers get the
 * same 404 as an unknown route, so the endpoint's existence is not revealed.
 */
export function internalOnly(allowlist: readonly string[]): RequestHandler {
  const allowed = new Set(allowlist.flatMap((ip) => [ip, `::ffff:${ip}`]));
  return (req, _res, next) => {
    next(req.ip && allowed.has(req.ip) ? undefined : new NotFoundError('GEN.ROUTE_NOT_FOUND'));
  };
}

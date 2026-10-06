import type { RequestHandler } from 'express';
import { runWithContext } from '../utils/request-context';
import { isUuid, newCorrelationId } from '../utils/idGenerator';

export const CORRELATION_HEADER = 'X-Correlation-Id';

/**
 * Generates a correlation id at the edge, or accepts the caller's when trusted callers are
 * configured (brief §7.2), and runs the rest of the request inside its context.
 */
export function correlationId(opts: { trustInbound: boolean }): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get(CORRELATION_HEADER);
    const id = opts.trustInbound && isUuid(inbound) ? inbound : newCorrelationId();
    req.correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);
    runWithContext({ correlationId: id, ...(req.ip ? { ip: req.ip } : {}) }, () => next());
  };
}

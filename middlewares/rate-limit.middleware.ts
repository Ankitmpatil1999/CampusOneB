/**
 * Rate limiters (reference classes; NFR-04). In-memory store for a single instance; Redis store
 * when REDIS_URL is set (several instances, D-08). Refusals use the register message (429).
 */
import type { Request, RequestHandler } from 'express';
import { rateLimit, type Options, type Store } from 'express-rate-limit';
import { RateLimitError } from '../utils/CustomAPIError';
import { opsMetrics } from '../utils/metrics';

export interface RateLimiterOptions {
  readonly name: string;
  readonly windowMs: number;
  readonly limit: number;
  readonly exemptIps?: readonly string[];
  readonly store?: Store;
  /** Key per caller; defaults to the client IP (IPv6 subnet-aware). */
  readonly keyGenerator?: Options['keyGenerator'];
  /** Requests this limiter doesn't count (besides exempt addresses). */
  readonly skip?: (req: Request) => boolean;
}

export function createRateLimiter(opts: RateLimiterOptions): RequestHandler {
  const exempt = new Set(opts.exemptIps ?? []);
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: opts.name,
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.keyGenerator ? { keyGenerator: opts.keyGenerator } : {}),
    skip: (req) => (req.ip !== undefined && exempt.has(req.ip)) || (opts.skip?.(req) ?? false),
    handler: (_req, _res, next, options) => {
      opsMetrics.rateLimited(opts.name);
      next(new RateLimitError(Math.ceil(options.windowMs / 1000)));
    },
  });
}

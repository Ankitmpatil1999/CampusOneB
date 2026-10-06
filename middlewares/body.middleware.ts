/**
 * Request bodies: JSON only (size-capped), except routes that accept uploads. The raw bytes are
 * kept for signed partner webhooks so the HMAC can be verified over exactly what was received.
 */
import express, { type RequestHandler } from 'express';
import { UnsupportedMediaTypeError } from '../utils/CustomAPIError';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const PARTNER_PATH_PREFIX = '/api/v1/partners/';

export interface BodyOptions {
  readonly jsonLimitBytes: number;
  /** Path prefixes allowed to send multipart/form-data (upload routes). */
  readonly multipartPrefixes?: readonly string[];
}

/** Refuses a body that is not JSON (415) unless the route accepts uploads. */
export function requireJsonBody(opts: BodyOptions): RequestHandler {
  const multipart = opts.multipartPrefixes ?? [];
  return (req, _res, next) => {
    const hasBody =
      METHODS_WITH_BODY.has(req.method) &&
      (Number(req.get('content-length') ?? '0') > 0 || req.get('transfer-encoding') !== undefined);
    if (!hasBody) return next();
    if (req.is(['application/json', 'application/*+json'])) return next();
    if (req.is('multipart/form-data') && multipart.some((p) => req.path.startsWith(p))) {
      return next();
    }
    next(new UnsupportedMediaTypeError());
  };
}

export function jsonBody(opts: BodyOptions): RequestHandler {
  return express.json({
    limit: opts.jsonLimitBytes,
    strict: true,
    type: ['application/json', 'application/*+json'],
    verify: (req, _res, buf) => {
      const r = req as unknown as { originalUrl?: string; rawBody?: Buffer };
      if (r.originalUrl?.startsWith(PARTNER_PATH_PREFIX)) r.rawBody = Buffer.from(buf);
    },
  });
}

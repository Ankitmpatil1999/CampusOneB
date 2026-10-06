/**
 * CORS allowlist (reference cors-config). Unknown browser origins get no CORS headers, so the
 * browser blocks the response; calls without an Origin (server-to-server, mobile) pass.
 */
import type { RequestHandler } from 'express';
import cors from 'cors';

export function corsPolicy(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => callback(null, origin === undefined || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept-Language',
      'Idempotency-Key',
      'If-Match',
      'X-Correlation-Id',
      'X-CSRF-Token',
    ],
    exposedHeaders: ['X-Correlation-Id', 'ETag', 'Retry-After'],
    maxAge: 600,
  });
}

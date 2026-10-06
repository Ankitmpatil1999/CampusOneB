/**
 * Security headers for a JSON API (docs/06): no content may be framed or scripted, no referrer,
 * no sniffing, HSTS in production, and API responses are never cached.
 */
import type { RequestHandler } from 'express';
import helmet from 'helmet';

export function securityHeaders(opts: { production: boolean }): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: opts.production
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
      xFrameOptions: { action: 'deny' },
    }),
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  ];
}

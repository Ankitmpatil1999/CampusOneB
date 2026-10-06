/**
 * CSRF protection for cookie sessions (docs/06, ADR-0011): every state-changing request that is
 * authenticated by a cookie must echo the session's CSRF token in `X-CSRF-Token`. Bearer clients
 * (the member app) are not exposed to CSRF and are not checked. SameSite=Strict is the first line;
 * this is the second.
 */
import type { RequestHandler } from 'express';
import type { Loggers } from '../controllers/logger';
import { CustomAPIError } from '../utils/CustomAPIError';
import { CSRF_HEADER, csrfMatches, csrfTokenFor } from '../utils/cookies';
import type { FieldCipher } from '../utils/fieldEncryption';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(cipher: FieldCipher, loggers: Loggers): RequestHandler {
  return (req, _res, next) => {
    if (SAFE.has(req.method) || req.authVia !== 'cookie' || !req.principal) return next();
    const expected = csrfTokenFor(cipher, req.principal.sessionId);
    if (csrfMatches(expected, req.get(CSRF_HEADER))) return next();
    loggers.security.warn('auth.csrf_refused', {
      surface: req.principal.surface,
      path: req.path,
      ip: req.ip,
    });
    next(new CustomAPIError(403, 'AUTH.CSRF'));
  };
}

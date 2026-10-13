import type { RequestHandler } from 'express';
import type { Loggers } from './logger';
import { refreshRequestSchema } from '../schemas/auth.schema';
import type { SessionService, SessionTokens } from '../services/session.service';
import { AuthenticationError, CustomAPIError } from '../utils/CustomAPIError';
import {
  CSRF_HEADER,
  clearSessionCookies,
  cookieNames,
  cookieSurfaceOf,
  csrfMatches,
  csrfTokenFor,
  readCookie,
  setSessionCookies,
  type CookieSurface,
} from '../utils/cookies';
import type { FieldCipher } from '../utils/fieldEncryption';

const iso = (d: Date) => d.toISOString();

export function authController(deps: {
  sessions: SessionService;
  cipher: FieldCipher;
  loggers: Loggers;
}) {
  /** Web response: tokens go to cookies; the body carries only the expiry times. */
  const sendWeb = (
    res: Parameters<RequestHandler>[1],
    surface: CookieSurface,
    t: SessionTokens,
  ) => {
    setSessionCookies(res, surface, { ...t, csrfToken: csrfTokenFor(deps.cipher, t.sessionId) });
    res.json({
      sessionId: t.sessionId,
      accessTokenExpiresAt: iso(t.accessTokenExpiresAt),
      refreshTokenExpiresAt: iso(t.refreshTokenExpiresAt),
    });
  };

  const refresh: RequestHandler = async (req, res, next) => {
    try {
      const body = refreshRequestSchema.parse(req.body ?? {});
      const client = { ip: req.ip, userAgent: req.get('user-agent') };
      if (body.refreshToken) {
        // Member app (Bearer client): tokens in the body, never in cookies.
        const t = await deps.sessions.refresh(body.refreshToken, client, 'member');
        res.json({
          sessionId: t.sessionId,
          accessToken: t.accessToken,
          accessTokenExpiresAt: iso(t.accessTokenExpiresAt),
          refreshToken: t.refreshToken,
          refreshTokenExpiresAt: iso(t.refreshTokenExpiresAt),
        });
        return;
      }
      const surface = cookieSurfaceOf(req);
      if (!surface) throw new AuthenticationError();
      const names = cookieNames(surface);
      const token = readCookie(req, names.refresh);
      if (!token) throw new AuthenticationError();
      // Double-submit check: the page echoes its CSRF cookie (SameSite=Strict, __Host-).
      const csrfCookie = readCookie(req, names.csrf);
      if (!csrfCookie || !csrfMatches(csrfCookie, req.get(CSRF_HEADER))) {
        throw new CustomAPIError(403, 'AUTH.CSRF');
      }
      try {
        sendWeb(res, surface, await deps.sessions.refresh(token, client, surface));
      } catch (e) {
        // A renewal that lost to a parallel one (another tab) leaves the winner's cookies alone:
        // clearing them here signed every tab out (client 2026-10-13).
        if (!(e instanceof CustomAPIError && e.code === 'AUTH.REFRESH_SUPERSEDED')) {
          clearSessionCookies(res, surface);
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  };

  const signout: RequestHandler = async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw new AuthenticationError();
      await deps.sessions.end(p.sessionId, 'SIGN_OUT');
      deps.loggers.security.info('auth.signed_out', { surface: p.surface });
      if (req.authVia === 'cookie') clearSessionCookies(res, p.surface as CookieSurface);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  };

  return { refresh, signout, sendWeb };
}

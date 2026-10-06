/**
 * Web sessions in cookies (ADR-0011, docs/06): `__Host-` prefix (host-only, Secure, Path=/),
 * HttpOnly for the tokens, SameSite=Strict, one set per surface so a console session and a portal
 * session in the same browser never mix. The CSRF cookie is readable by the page, which echoes it
 * in `X-CSRF-Token`; its value is bound to the session (HMAC of the session id).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { FieldCipher } from './fieldEncryption';

export const COOKIE_SURFACES = ['console', 'ops', 'portal', 'member'] as const;
export type CookieSurface = (typeof COOKIE_SURFACES)[number];

export const SURFACE_HEADER = 'X-RingPe-Surface';
export const CSRF_HEADER = 'X-CSRF-Token';

/**
 * Plain-HTTP test servers (a LAN address, client 2026-10-06): browsers keep Secure cookies only over
 * HTTPS or on localhost, so a development server may drop the flag — and with it the `__Host-`
 * prefix, which requires it. Set once at start-up from COOKIE_SECURE; production always keeps both.
 */
let secureCookies = true;
export function useSecureCookies(on: boolean): void {
  secureCookies = on;
}

export const cookieNames = (s: CookieSurface) => {
  const prefix = secureCookies ? '__Host-' : '';
  return {
    access: `${prefix}rp_${s}_at`,
    refresh: `${prefix}rp_${s}_rt`,
    csrf: `${prefix}rp_${s}_csrf`,
  };
};

const isCookieSurface = (v: unknown): v is CookieSurface =>
  typeof v === 'string' && (COOKIE_SURFACES as readonly string[]).includes(v);

/**
 * Which surface's cookies a request uses: the area prefix of the path (`/api/v1/console/…`),
 * otherwise the `X-RingPe-Surface` header the web app sends on shared routes (refresh, sign-out).
 */
export function cookieSurfaceOf(req: Request): CookieSurface | undefined {
  const m = /^\/api\/v1\/(console|ops|portal)(\/|$)/.exec(req.originalUrl);
  if (m) return m[1] as CookieSurface;
  const header = req.get(SURFACE_HEADER);
  return isCookieSurface(header) ? header : undefined;
}

export function csrfTokenFor(cipher: FieldCipher, sessionId: string): string {
  return createHmac('sha256', cipher.secret('csrf')).update(sessionId).digest('base64url');
}

export function csrfMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

const base = (): CookieOptions => ({ secure: secureCookies, sameSite: 'strict', path: '/' });

export function setSessionCookies(
  res: Response,
  surface: CookieSurface,
  t: {
    accessToken: string;
    accessTokenExpiresAt: Date;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
    csrfToken: string;
  },
  now: Date = new Date(),
): void {
  const names = cookieNames(surface);
  const until = (d: Date) => Math.max(0, d.getTime() - now.getTime());
  res.cookie(names.access, t.accessToken, {
    ...base(),
    httpOnly: true,
    maxAge: until(t.accessTokenExpiresAt),
  });
  res.cookie(names.refresh, t.refreshToken, {
    ...base(),
    httpOnly: true,
    maxAge: until(t.refreshTokenExpiresAt),
  });
  res.cookie(names.csrf, t.csrfToken, {
    ...base(),
    httpOnly: false,
    maxAge: until(t.refreshTokenExpiresAt),
  });
}

export function clearSessionCookies(res: Response, surface: CookieSurface): void {
  const names = cookieNames(surface);
  for (const name of [names.access, names.refresh, names.csrf]) {
    res.clearCookie(name, { ...base(), httpOnly: name !== names.csrf });
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const v = cookies?.[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

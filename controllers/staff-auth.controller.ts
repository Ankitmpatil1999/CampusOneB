import type { RequestHandler } from 'express';
import { institutionChoiceSchema } from '../schemas/member-auth.schema';
import {
  staffAppRefreshSchema,
  staffForgotSchema,
  staffPasswordResetSchema,
  staffResendSchema,
  staffSignInSchema,
  staffVerifySchema,
} from '../schemas/staff-auth.schema';
import type {
  StaffAuthService,
  StaffChallenge,
  StaffSurface,
} from '../services/staff-auth.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { csrfTokenFor, setSessionCookies } from '../utils/cookies';
import type { FieldCipher } from '../utils/fieldEncryption';

const iso = (d: Date) => d.toISOString();

const challenge = (c: StaffChallenge) => ({
  challengeId: c.challengeId,
  expiresAt: iso(c.expiresAt),
  resendAfterSeconds: c.resendAfterSeconds,
  sentTo: c.sentTo,
  channel: c.channel,
  emailFallback: c.emailFallback,
  ...(c.alreadySent ? { alreadySent: true } : {}),
  ...(c.testCode ? { testCode: c.testCode } : {}),
});

export function staffAuthController(service: StaffAuthService, cipher: FieldCipher) {
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };

  const signIn = (surface: StaffSurface) =>
    wrap(async (req, res) => {
      const body = staffSignInSchema.parse(req.body ?? {});
      res.setHeader('Cache-Control', 'no-store');
      res.status(202).json(challenge(await service.signIn(surface, body)));
    });

  const resend = (surface: StaffSurface) =>
    wrap(async (req, res) => {
      const body = staffResendSchema.parse(req.body ?? {});
      res.status(202).json(challenge(await service.resend(surface, body)));
    });

  /** The session lives in `__Host-` cookies (ADR-0011); the body carries the CSRF token only. */
  const verify = (surface: StaffSurface) =>
    wrap(async (req, res) => {
      const body = staffVerifySchema.parse(req.body ?? {});
      const out = await service.verify(surface, body, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.setHeader('Cache-Control', 'no-store');
      if ('passwordChange' in out) {
        res.json({
          passwordChangeRequired: true,
          resetToken: out.passwordChange.resetToken,
          name: out.name,
        });
        return;
      }
      const { tokens, name } = out;
      const csrfToken = csrfTokenFor(cipher, tokens.sessionId);
      setSessionCookies(res, surface, { ...tokens, csrfToken });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        sessionId: tokens.sessionId,
        name,
        csrfToken,
        accessTokenExpiresAt: iso(tokens.accessTokenExpiresAt),
        refreshTokenExpiresAt: iso(tokens.refreshTokenExpiresAt),
        // The console's institutions (client 2026-10-27): the web asks which to open.
        ...(out.institutions ? { institutions: out.institutions } : {}),
      });
    });

  /** Tokens for the staff app, in the body (never cookies): the app sends them as Bearer. */
  const appTokens = (t: {
    sessionId: string;
    accessToken: string;
    accessTokenExpiresAt: Date;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
  }) => ({
    sessionId: t.sessionId,
    accessToken: t.accessToken,
    accessTokenExpiresAt: iso(t.accessTokenExpiresAt),
    refreshToken: t.refreshToken,
    refreshTokenExpiresAt: iso(t.refreshTokenExpiresAt),
  });

  /** IDN-088: the staff app's step 2 (client 2026-10-19) — a console session of its own. */
  const appVerify = wrap(async (req, res) => {
    const body = staffVerifySchema.parse(req.body ?? {});
    const out = await service.verify(
      'console',
      body,
      { ip: req.ip, userAgent: req.get('user-agent') },
      { staffApp: true },
    );
    res.setHeader('Cache-Control', 'no-store');
    if ('passwordChange' in out) {
      res.json({
        passwordChangeRequired: true,
        resetToken: out.passwordChange.resetToken,
        name: out.name,
      });
      return;
    }
    res.json({ ...appTokens(out.tokens), name: out.name, institutions: out.institutions ?? [] });
  });

  /** IDN-089. */
  const appRefresh = wrap(async (req, res) => {
    const body = staffAppRefreshSchema.parse(req.body ?? {});
    const t = await service.refreshStaffApp(body.refreshToken, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(appTokens(t));
  });

  /** Same answer whether or not the account exists (enumeration-safe). */
  const forgot = (surface: StaffSurface) =>
    wrap(async (req, res) => {
      await service.forgotPassword(surface, staffForgotSchema.parse(req.body ?? {}));
      res.status(202).end();
    });

  const passwordReset = wrap(async (req, res) => {
    await service.resetPassword(staffPasswordResetSchema.parse(req.body ?? {}));
    res.status(204).end();
  });

  const consoleSession = wrap(async (req, res) => {
    if (!req.principal) throw new AuthenticationError();
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.consoleSession(req.principal));
  });

  const opsSession = wrap(async (req, res) => {
    if (!req.principal) throw new AuthenticationError();
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.opsSession(req.principal));
  });

  const portalSession = wrap(async (req, res) => {
    if (!req.principal) throw new AuthenticationError();
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.portalSession(req.principal));
  });

  /** IDN-094 / IDN-095 (client 2026-10-27): the console's institutions, and opening another. */
  const consoleInstitutions = wrap(async (req, res) => {
    if (!req.principal) throw new AuthenticationError();
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.consoleInstitutions(req.principal));
  });

  const setConsoleInstitution = wrap(async (req, res) => {
    if (!req.principal) throw new AuthenticationError();
    const body = institutionChoiceSchema.parse(req.body ?? {});
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.setConsoleInstitution(req.principal, body));
  });

  return {
    signIn,
    resend,
    verify,
    appVerify,
    appRefresh,
    forgot,
    passwordReset,
    consoleSession,
    opsSession,
    portalSession,
    consoleInstitutions,
    setConsoleInstitution,
  };
}

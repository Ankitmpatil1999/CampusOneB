import type { RequestHandler, Response } from 'express';
import {
  codeVerifySchema,
  deviceVerifySchema,
  passwordResetSchema,
  recoveryStartSchema,
  recoveryVerifySchema,
  resendSchema,
  signInSchema,
  signupCompleteSchema,
  signupStartSchema,
  socialCallbackSchema,
  socialStartSchema,
} from '../schemas/member-auth.schema';
import type { AccountSummary, MemberAuthService } from '../services/member-auth.service';
import type { IssuedChallenge, OtpService } from '../services/otp.service';
import type { SessionTokens } from '../services/session.service';
import type { SocialAuthService } from '../services/social-auth.service';

const iso = (d: Date) => d.toISOString();

const challenge = (c: IssuedChallenge) => ({
  challengeId: c.challengeId,
  expiresAt: iso(c.expiresAt),
  resendAfterSeconds: c.resendAfterSeconds,
  sentTo: c.sentTo,
  ...(c.alreadySent ? { alreadySent: true } : {}),
  ...(c.testCode ? { testCode: c.testCode } : {}),
});

/** The member app keeps its tokens in Keychain / Keystore; they travel in the body only. */
const session = (res: Response, t: SessionTokens, account: AccountSummary, status = 200) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({
    sessionId: t.sessionId,
    accessToken: t.accessToken,
    accessTokenExpiresAt: iso(t.accessTokenExpiresAt),
    refreshToken: t.refreshToken,
    refreshTokenExpiresAt: iso(t.refreshTokenExpiresAt),
    account,
  });
};

const client = (req: Parameters<RequestHandler>[0]) => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

export function memberAuthController(
  service: MemberAuthService,
  otp: OtpService,
  social: SocialAuthService,
) {
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };

  return {
    reference: wrap(async (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(await service.signupReference());
    }),
    signupStart: wrap(async (req, res) => {
      const c = await service.startSignup(signupStartSchema.parse(req.body));
      res.status(c.alreadySent ? 200 : 202).json(challenge(c));
    }),
    signupVerify: wrap(async (req, res) => {
      const r = await service.verifySignupCode(codeVerifySchema.parse(req.body));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ signupToken: r.signupToken, expiresAt: iso(r.expiresAt) });
    }),
    signupComplete: wrap(async (req, res) => {
      const r = await service.completeSignup(signupCompleteSchema.parse(req.body), client(req));
      session(res, r.tokens, r.account, 201);
    }),
    resend: wrap(async (req, res) => {
      const body = resendSchema.parse(req.body);
      res.json(challenge(await otp.resend(body.challengeId, body.mobile)));
    }),
    signIn: wrap(async (req, res) => {
      const r = await service.signIn(signInSchema.parse(req.body), client(req));
      if (r.kind === 'device') {
        res.status(202).json({ deviceChallenge: challenge(r.challenge) });
        return;
      }
      session(res, r.tokens, r.account);
    }),
    deviceVerify: wrap(async (req, res) => {
      const r = await service.verifyDevice(deviceVerifySchema.parse(req.body), client(req));
      session(res, r.tokens, r.account);
    }),
    recoveryStart: wrap(async (req, res) => {
      const r = await service.startRecovery(recoveryStartSchema.parse(req.body));
      res.status(202).json({
        recoveryId: r.recoveryId,
        question: r.question,
        challenge: challenge(r.challenge),
      });
    }),
    recoveryVerify: wrap(async (req, res) => {
      const r = await service.verifyRecovery(recoveryVerifySchema.parse(req.body));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ resetToken: r.resetToken, expiresAt: iso(r.expiresAt) });
    }),
    socialStart: wrap(async (req, res) => {
      const r = await social.start(
        String(req.params['provider']),
        socialStartSchema.parse(req.body),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        mode: r.mode,
        authorizationUrl: r.authorizationUrl,
        state: r.state,
        expiresAt: iso(r.expiresAt),
      });
    }),
    socialCallback: wrap(async (req, res) => {
      const r = await social.callback(
        String(req.params['provider']),
        socialCallbackSchema.parse(req.body),
        client(req),
      );
      if (r.kind === 'device') {
        res.status(202).json({ deviceChallenge: challenge(r.challenge) });
        return;
      }
      if (r.kind === 'signup') {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ signupTicket: r.signupTicket, expiresAt: iso(r.expiresAt), prefill: r.prefill });
        return;
      }
      session(res, r.tokens, r.account);
    }),
    passwordReset: wrap(async (req, res) => {
      await service.resetPassword(passwordResetSchema.parse(req.body));
      res.status(204).end();
    }),
  };
}

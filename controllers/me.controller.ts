import type { RequestHandler } from 'express';
import {
  emailChangeSchema,
  emailConfirmSchema,
  languageSchema,
  passwordChangeSchema,
} from '../schemas/member-auth.schema';
import type { MeService } from '../services/me.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import type { Principal } from '../utils/principal';

export function meController(service: MeService) {
  const withPrincipal =
    (fn: (p: Principal, ...a: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
    async (req, res, next) => {
      try {
        if (!req.principal) throw new AuthenticationError();
        await fn(req.principal, req, res, next);
      } catch (e) {
        next(e);
      }
    };

  return {
    me: withPrincipal(async (p, _req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.me(p));
    }),
    changePassword: withPrincipal(async (p, req, res) => {
      await service.changePassword(p, passwordChangeSchema.parse(req.body));
      res.status(204).end();
    }),
    devices: withPrincipal(async (p, _req, res) => {
      res.json(await service.devices(p));
    }),
    startEmailChange: withPrincipal(async (p, req, res) => {
      const r = await service.startEmailChange(p, emailChangeSchema.parse(req.body));
      res.setHeader('Cache-Control', 'no-store');
      res.status(202).json({
        challenge: {
          challengeId: r.challenge.challengeId,
          expiresAt: r.challenge.expiresAt.toISOString(),
          resendAfterSeconds: r.challenge.resendAfterSeconds,
          sentTo: r.challenge.sentTo,
          ...(r.challenge.alreadySent ? { alreadySent: true } : {}),
          ...(r.challenge.testCode ? { testCode: r.challenge.testCode } : {}),
        },
        changeToken: r.changeToken,
      });
    }),
    confirmEmailChange: withPrincipal(async (p, req, res) => {
      res.json(await service.confirmEmailChange(p, emailConfirmSchema.parse(req.body)));
    }),
    language: withPrincipal(async (p, req, res) => {
      res.json(await service.setLanguage(p, languageSchema.parse(req.body).lang));
    }),
  };
}

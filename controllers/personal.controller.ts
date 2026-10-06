import type { RequestHandler } from 'express';
import {
  addressSchema,
  bankAccountSchema,
  correctionSchema,
  incomeSchema,
  nomineeSchema,
} from '../schemas/personal.schema';
import type { PersonalDetailsService } from '../services/personal-details.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import type { Principal } from '../utils/principal';

export function personalController(service: PersonalDetailsService) {
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
    view: withPrincipal(async (p, _req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.view(p));
    }),
    address: withPrincipal(async (p, req, res) => {
      const r = await service.saveAddress(p, addressSchema.parse(req.body), expectedVersion(req));
      setEtag(res, r.version);
      res.json(r);
    }),
    bankAccount: withPrincipal(async (p, req, res) => {
      const r = await service.saveBankAccount(
        p,
        bankAccountSchema.parse(req.body),
        expectedVersion(req),
      );
      setEtag(res, r.version);
      res.json(r);
    }),
    nominee: withPrincipal(async (p, req, res) => {
      const r = await service.saveNominee(p, nomineeSchema.parse(req.body), expectedVersion(req));
      setEtag(res, r.version);
      res.json(r);
    }),
    income: withPrincipal(async (p, req, res) => {
      const r = await service.saveIncome(p, incomeSchema.parse(req.body), expectedVersion(req));
      setEtag(res, r.version);
      res.json(r);
    }),
    requestCorrection: withPrincipal(async (p, req, res) => {
      res.status(201).json(await service.requestCorrection(p, correctionSchema.parse(req.body)));
    }),
    corrections: withPrincipal(async (p, _req, res) => {
      res.json({ items: await service.corrections(p) });
    }),
  };
}

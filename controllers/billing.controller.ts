import type { Request, RequestHandler } from 'express';
import {
  billingProfileInputSchema,
  invoiceGenerateSchema,
  invoicePaymentSchema,
  invoicesQuerySchema,
} from '../schemas/billing.schema';
import type { BillingService } from '../services/billing.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function billingController(service: BillingService) {
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  const principal = (req: Request) => {
    if (!req.principal) throw new AuthenticationError();
    return req.principal;
  };

  return {
    list: wrap(async (req, res) => {
      const { institutionId } = invoicesQuerySchema.parse(req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.list({ institutionId }));
    }),
    pdf: wrap(async (req, res) => {
      const out = await service.document(String(req.params['invoiceId']));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
    profile: wrap(async (_req, res) => {
      const out = await service.profile();
      res.setHeader('Cache-Control', 'no-store');
      setEtag(res, out.etag);
      res.json(out);
    }),
    updateProfile: wrap(async (req, res) => {
      const body = billingProfileInputSchema.parse(req.body ?? {});
      const out = await service.updateProfile(principal(req), expectedVersion(req), body);
      setEtag(res, out.etag);
      res.json(out);
    }),
    generate: wrap(async (req, res) => {
      const body = invoiceGenerateSchema.parse(req.body ?? {});
      res.status(201).json(await service.generate(principal(req), body));
    }),
    pay: wrap(async (req, res) => {
      const body = invoicePaymentSchema.parse(req.body ?? {});
      res.status(201).json(
        await service.recordPayment(principal(req), String(req.params['invoiceId']), {
          utr: body.utr,
          amountPaise: body.amount.amount,
          paidOn: body.paidOn,
        }),
      );
    }),
  };
}

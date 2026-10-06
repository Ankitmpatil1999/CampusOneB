import type { Request, RequestHandler } from 'express';
import {
  planChangeSchema,
  planRequestInputSchema,
  reasonSchema,
  transferReportSchema,
} from '../schemas/subscription.schema';
import type { SubscriptionService } from '../services/subscription.service';
import { AuthenticationError } from '../utils/CustomAPIError';

export function subscriptionController(service: SubscriptionService) {
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
  const param = (req: Request, name: string) => String(req.params[name]);

  return {
    changePlan: wrap(async (req, res) => {
      const body = planChangeSchema.parse(req.body ?? {});
      res.json(await service.changePlan(principal(req), param(req, 'institutionId'), body));
    }),
    cancelScheduled: wrap(async (req, res) => {
      const body = reasonSchema.parse(req.body ?? {});
      await service.cancelScheduled(principal(req), param(req, 'institutionId'), body);
      res.status(204).end();
    }),
    decline: wrap(async (req, res) => {
      const body = reasonSchema.parse(req.body ?? {});
      res.json(await service.declineRequest(principal(req), param(req, 'requestId'), body));
    }),
    pdf: wrap(async (req, res) => {
      const out = await service.document(principal(req), param(req, 'invoiceId'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
    summary: wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.consoleSummary(principal(req)));
    }),
    request: wrap(async (req, res) => {
      const body = planRequestInputSchema.parse(req.body ?? {});
      res.status(201).json(await service.requestChange(principal(req), body));
    }),
    withdraw: wrap(async (req, res) => {
      await service.withdrawRequest(principal(req), param(req, 'requestId'));
      res.status(204).end();
    }),
    reportTransfer: wrap(async (req, res) => {
      const body = transferReportSchema.parse(req.body ?? {});
      res.json(await service.reportTransfer(principal(req), param(req, 'invoiceId'), body));
    }),
  };
}

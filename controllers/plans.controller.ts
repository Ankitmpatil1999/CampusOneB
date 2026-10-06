import type { Request, RequestHandler } from 'express';
import { planInputSchema } from '../schemas/plans.schema';
import type { PlansService } from '../services/plans.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function plansController(service: PlansService) {
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
  const input = (req: Request) => {
    const b = planInputSchema.parse(req.body ?? {});
    return {
      name: b.name,
      description: b.description,
      cycle: b.cycle,
      pricePaise: b.price.amount,
      trialDays: b.trialDays,
      modules: b.modules,
      allowances: b.allowances,
      platformFee: {
        flatPaise: b.platformFee.flat.amount,
        upToPaise: b.platformFee.upTo.amount,
        percentBp: b.platformFee.percent,
      },
    };
  };

  return {
    list: wrap(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.list());
    }),
    create: wrap(async (req, res) => {
      const out = await service.create(principal(req), input(req));
      setEtag(res, out.etag);
      res.status(201).json(out);
    }),
    change: wrap(async (req, res) => {
      const out = await service.change(
        principal(req),
        String(req.params['planId']),
        expectedVersion(req),
        input(req),
      );
      setEtag(res, out.etag);
      res.json(out);
    }),
  };
}

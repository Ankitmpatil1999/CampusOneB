import type { Request, RequestHandler } from 'express';
import {
  bankSchema,
  editSchema,
  feeAccountSchema,
  featureChangeSchema,
  featureLogQuerySchema,
  consoleUpdateSchema,
  lifecycleSchema,
  logoSchema,
  registerSchema,
  stepSchema,
} from '../schemas/institutions.schema';
import type { InstitutionsService } from '../services/institutions.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function institutionsController(service: InstitutionsService) {
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
  const id = (req: Request) => String(req.params['institutionId']);
  const fresh = (res: Parameters<RequestHandler>[1]) => res.setHeader('Cache-Control', 'no-store');

  return {
    list: wrap(async (_req, res) => {
      fresh(res);
      res.json(await service.list());
    }),
    register: wrap(async (req, res) => {
      const body = registerSchema.parse(req.body ?? {});
      const out = await service.register(principal(req), body);
      // Shown once: an idempotent replay of this request answers without it.
      res.locals['idempotencyOmit'] = ['administrator.temporaryPassword'];
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
    detail: wrap(async (req, res) => {
      const out = await service.detail(id(req));
      fresh(res);
      setEtag(res, out.version);
      res.json(out);
    }),
    edit: wrap(async (req, res) => {
      const body = editSchema.parse(req.body ?? {});
      const out = await service.edit(principal(req), id(req), expectedVersion(req), body);
      setEtag(res, out.version);
      res.json(out);
    }),
    lifecycle: wrap(async (req, res) => {
      const body = lifecycleSchema.parse(req.body ?? {});
      const out = await service.lifecycle(principal(req), id(req), body);
      setEtag(res, out.version);
      res.json(out);
    }),
    bank: wrap(async (req, res) => {
      const body = bankSchema.parse(req.body ?? {});
      const out = await service.bankArrangement(
        principal(req),
        id(req),
        expectedVersion(req),
        body,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
    step: wrap(async (req, res) => {
      const body = stepSchema.parse(req.body ?? {});
      res.json(await service.markStep(principal(req), id(req), String(req.params['step']), body));
    }),
    features: wrap(async (req, res) => {
      const out = await service.features(id(req));
      fresh(res);
      setEtag(res, out.version);
      res.json(out);
    }),
    changeFeatures: wrap(async (req, res) => {
      const body = featureChangeSchema.parse(req.body ?? {});
      const out = await service.changeFeatures(principal(req), id(req), expectedVersion(req), body);
      setEtag(res, out.version);
      res.json(out);
    }),
    featureLog: wrap(async (req, res) => {
      const { institutionId } = featureLogQuerySchema.parse(req.query);
      fresh(res);
      res.json(await service.featureLog(institutionId));
    }),

    consoleView: wrap(async (req, res) => {
      const out = await service.consoleView(principal(req));
      fresh(res);
      setEtag(res, out.version);
      res.json(out);
    }),
    consoleUpdate: wrap(async (req, res) => {
      const body = consoleUpdateSchema.parse(req.body ?? {});
      const out = await service.updateConsole(principal(req), expectedVersion(req), body);
      setEtag(res, out.version);
      res.json(out);
    }),
    logo: wrap(async (req, res) => {
      const body = logoSchema.parse(req.body ?? {});
      const out = await service.setLogo(principal(req), body);
      setEtag(res, out.version);
      res.json(out);
    }),
    feeAccount: wrap(async (req, res) => {
      const body = feeAccountSchema.parse(req.body ?? {});
      const out = await service.setFeeAccount(principal(req), expectedVersion(req), body);
      setEtag(res, out.version);
      res.json(out);
    }),

    branding: wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(await service.branding(String(req.params['slug'])));
    }),
  };
}

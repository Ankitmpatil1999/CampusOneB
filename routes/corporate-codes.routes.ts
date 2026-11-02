/**
 * A school's corporate codes and the classes each one serves (INS-043…048; client 2026-10-13/14):
 * the Institution Administrator in the console (task "corpcodes"), and the CampusOne back office for
 * any school (inst.register, as the bank arrangement).
 */
import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import {
  corporateCodeCreateSchema,
  corporateCodeListSchema,
  corporateCodeSchema,
  corporateCodeUpdateSchema,
} from '../schemas/corporate-codes.schema';
import type { CorporateCodesService } from '../services/corporate-codes.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Corporate codes'] });

const listSummary =
  "The school's corporate codes (bank, IFSC, code, pool account, default, status) with their classes, and every class with the code it is mapped to; a VAN is the code of the holder's class (or the default) + the wallet number";
const createSummary =
  "Add a corporate code (allotted by a bank) and, optionally, the classes it serves; the school's first code is its default";
const updateSummary =
  "Change a code's bank, IFSC, code, pool account or classes, make it the default, or disable it (not the default). If-Match";

doc({
  id: 'INS-043',
  method: 'get',
  path: '/api/v1/console/corporate-codes',
  summary: listSummary,
  auth: 'corpcodes.view',
  responses: { 200: { description: 'Codes', schema: corporateCodeListSchema } },
});
doc({
  id: 'INS-044',
  method: 'post',
  path: '/api/v1/console/corporate-codes',
  summary: createSummary,
  auth: 'corpcodes.edit',
  idempotent: 'required',
  request: corporateCodeCreateSchema,
  responses: { 201: { description: 'Added', schema: corporateCodeSchema } },
});
doc({
  id: 'INS-045',
  method: 'patch',
  path: '/api/v1/console/corporate-codes/{codeId}',
  summary: updateSummary,
  auth: 'corpcodes.edit',
  request: corporateCodeUpdateSchema,
  responses: { 200: { description: 'Changed', schema: corporateCodeSchema } },
});
doc({
  id: 'INS-046',
  method: 'get',
  path: '/api/v1/ops/institutions/{institutionId}/corporate-codes',
  summary: `Back office: ${listSummary}`,
  auth: 'inst.register',
  responses: { 200: { description: 'Codes', schema: corporateCodeListSchema } },
});
doc({
  id: 'INS-047',
  method: 'post',
  path: '/api/v1/ops/institutions/{institutionId}/corporate-codes',
  summary: `Back office: ${createSummary}`,
  auth: 'inst.register',
  idempotent: 'required',
  request: corporateCodeCreateSchema,
  responses: { 201: { description: 'Added', schema: corporateCodeSchema } },
});
doc({
  id: 'INS-048',
  method: 'patch',
  path: '/api/v1/ops/institutions/{institutionId}/corporate-codes/{codeId}',
  summary: `Back office: ${updateSummary}`,
  auth: 'inst.register',
  request: corporateCodeUpdateSchema,
  responses: { 200: { description: 'Changed', schema: corporateCodeSchema } },
});

export function corporateCodesRoutes(deps: {
  db: Kysely<Database>;
  corporateCodes: CorporateCodesService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const C = deps.corporateCodes;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const ops = requireSurface(L, 'ops');
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
  const param = (req: Request, k: string) => String(req.params[k]);
  /** The console's own school, or the back office's school from the path. */
  const schoolOf = (req: Request) =>
    req.params['institutionId'] ? param(req, 'institutionId') : C.institutionOf(principal(req));

  const list: RequestHandler = wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await C.list(schoolOf(req)));
  });
  const create: RequestHandler = wrap(async (req, res) => {
    const out = await C.create(
      principal(req),
      schoolOf(req),
      corporateCodeCreateSchema.parse(req.body ?? {}),
    );
    setEtag(res, out.version);
    res.status(201).json(out);
  });
  const update: RequestHandler = wrap(async (req, res) => {
    const out = await C.update(
      principal(req),
      schoolOf(req),
      param(req, 'codeId'),
      expectedVersion(req),
      corporateCodeUpdateSchema.parse(req.body ?? {}),
    );
    setEtag(res, out.version);
    res.json(out);
  });

  router.get('/console/corporate-codes', ...console, authorize('corpcodes.view', L), list);
  router.post('/console/corporate-codes', ...console, authorize('corpcodes.edit', L), once, create);
  router.patch(
    '/console/corporate-codes/:codeId',
    ...console,
    authorize('corpcodes.edit', L),
    update,
  );
  const back = [ops, authorize('inst.register', L)];
  router.get('/ops/institutions/:institutionId/corporate-codes', ...back, list);
  router.post('/ops/institutions/:institutionId/corporate-codes', ...back, once, create);
  router.patch('/ops/institutions/:institutionId/corporate-codes/:codeId', ...back, update);
  return router;
}

import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireAuth, requireSurface } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import { XI_FIGURES, type CrossInstitutionService } from '../services/cross-institution.service';
import type { ReportExportsService } from '../services/report-exports.service';
import { AuthenticationError } from '../utils/CustomAPIError';

const uuid = z.string().max(40);
const day = z.string().max(10);
const reason = z.string({ message: 'RPT.XI_REASON' }).max(300, { message: 'RPT.XI_REASON' });
export const comparisonSchema = z
  .strictObject({
    selection: z.strictObject({
      institutionIds: z.array(uuid).max(500).optional(),
      status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CANCELLED']).optional(),
    }),
    period: z.strictObject({ from: day, to: day }),
    figures: z
      .array(z.enum(XI_FIGURES, { message: 'VALIDATION.FORMAT' }))
      .max(8)
      .optional(),
    reason,
  })
  .meta({ id: 'CrossInstitutionComparison' });
export const drillSchema = z
  .strictObject({ institutionId: uuid, reason })
  .meta({ id: 'CrossInstitutionDrillThrough' });
const recordFilters = z.strictObject({
  actor: uuid.optional(),
  outcome: z.enum(['Returned', 'Refused']).optional(),
  from: day.optional(),
  to: day.optional(),
});
const recordsQuery = recordFilters.extend({
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const accessExportSchema = z
  .strictObject({ filters: recordFilters })
  .meta({ id: 'AccessRecordExport' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Reporting'] });
doc({
  id: 'RPT-009',
  method: 'post',
  path: '/api/v1/ops/cross-institution-reports',
  summary:
    'Aggregated figures side by side for a stated selection (named institutions or a status, at most 25 — setting) and period, with a reason; totals and averages; every access recorded, refusals included (CR-18)',
  auth: 'xi.aggregate',
  request: comparisonSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Comparison' } },
});
doc({
  id: 'RPT-010',
  method: 'post',
  path: '/api/v1/ops/cross-institution-reports/{accessId}/drill-throughs',
  summary:
    'One institution of a comparison: its breakdowns for the same period, with its own reason; a separate recorded access (xi.drill, the platform administrator)',
  auth: 'xi.drill',
  request: drillSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Drill-through' } },
});
doc({
  id: 'RPT-011',
  method: 'get',
  path: '/api/v1/ops/access-records',
  summary: 'The cross-institution access record as a report, refusals included (RNG-GOV-035)',
  auth: 'access.view',
  query: recordsQuery,
  responses: { 200: { description: 'Access record' } },
});
doc({
  id: 'RPT-012',
  method: 'post',
  path: '/api/v1/ops/access-records/exports',
  summary: 'Export the access record (CSV), prepared off the request; read it through RPT-005',
  auth: 'access.view',
  request: accessExportSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Requested' } },
});

export function crossInstitutionRoutes(deps: {
  db: Kysely<Database>;
  xi: CrossInstitutionService;
  exports: ReportExportsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
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
  const json = (fn: (req: Request) => Promise<unknown>, code = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(code).json(await fn(req));
    });

  // Any signed-in session reaches the service, which refuses all but entitled operators and records
  // the refusal (RNG-GOV-033, RNG-RPT-125).
  router.post(
    '/ops/cross-institution-reports',
    requireAuth(),
    once,
    json(async (req) => {
      await deps.xi.guard(principal(req), 'Comparison', req.body);
      return deps.xi.compare(principal(req), comparisonSchema.parse(req.body ?? {}));
    }, 201),
  );
  router.post(
    '/ops/cross-institution-reports/:accessId/drill-throughs',
    requireAuth(),
    once,
    json(async (req) => {
      await deps.xi.guard(principal(req), 'Drill-through', req.body);
      return deps.xi.drill(
        principal(req),
        String(req.params['accessId']),
        drillSchema.parse(req.body ?? {}),
      );
    }, 201),
  );
  const access = [requireSurface(L, 'ops'), authorize('access.view', L)];
  router.get(
    '/ops/access-records',
    ...access,
    json((req) => deps.xi.records(recordsQuery.parse(req.query))),
  );
  router.post(
    '/ops/access-records/exports',
    ...access,
    once,
    json(async (req) => {
      const { filters } = accessExportSchema.parse(req.body ?? {});
      return deps.exports.request(principal(req), null, 'access-record', filters);
    }, 202),
  );
  return router;
}

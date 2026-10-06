import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { ReportExportsService } from '../services/report-exports.service';
import type { ReportsService } from '../services/reports.service';
import { AuthenticationError } from '../utils/CustomAPIError';

const uuid = z.string().max(40);
const day = z.string().max(10);
const runQuery = z.object({
  yearId: uuid.optional(),
  from: day.optional(),
  to: day.optional(),
  cursor: z.string().max(40).optional(),
});
export const reportExportSchema = z
  .strictObject({ yearId: uuid.optional(), from: day.optional(), to: day.optional() })
  .meta({ id: 'ReportExport' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Reporting'] });
doc({
  id: 'RPT-001',
  method: 'get',
  path: '/api/v1/console/home',
  summary:
    'The home figures of the signed-in user’s role (administrator, management, accountant, counsellor, coordinator, transport, grievance, front desk), read live from the institution’s records',
  auth: 'home.view',
  responses: { 200: { description: 'Home' } },
});
doc({
  id: 'RPT-002',
  method: 'get',
  path: '/api/v1/console/reports',
  summary:
    'The reports the role may open (each needs its module’s view task), by area, with the screen that owns each (CR-17)',
  auth: 'console',
  responses: { 200: { description: 'Catalogue' } },
});
doc({
  id: 'RPT-003',
  method: 'get',
  path: '/api/v1/console/reports/{reportId}',
  summary:
    'Run a report for the year in context (CR-13) or a date range (default the last 30 days, at most a year): columns and rows, paged',
  auth: 'console',
  query: runQuery,
  responses: { 200: { description: 'Report' } },
});
doc({
  id: 'RPT-004',
  method: 'post',
  path: '/api/v1/console/reports/{reportId}/exports',
  summary:
    'Export every row of the report (CSV, standard file name), prepared off the request; read it through RPT-005',
  auth: 'console',
  request: reportExportSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Requested' } },
});

export function reportsRoutes(deps: {
  db: Kysely<Database>;
  reports: ReportsService;
  exports: ReportExportsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const console = [requireSurface(L, 'console'), requireTenant(L)];
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
  const id = (req: Request) => String(req.params['reportId']);

  router.get(
    '/console/home',
    ...console,
    authorize('home.view', L),
    json((req) => deps.reports.home(principal(req))),
  );
  router.get(
    '/console/reports',
    ...console,
    json((req) => deps.reports.catalogue(principal(req))),
  );
  router.get(
    '/console/reports/:reportId',
    ...console,
    json((req) => deps.reports.run(principal(req), id(req), runQuery.parse(req.query))),
  );
  router.post(
    '/console/reports/:reportId/exports',
    ...console,
    once,
    json(async (req) => {
      const p = principal(req);
      const x = await deps.reports.exportRequest(
        p,
        id(req),
        reportExportSchema.parse(req.body ?? {}),
      );
      return deps.exports.request(p, x.institutionId, 'console-report', x.params);
    }, 202),
  );
  return router;
}

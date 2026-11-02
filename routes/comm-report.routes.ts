import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import {
  COMM_CHANNELS,
  COMM_KINDS,
  COMM_OUTCOMES,
  type CommReportService,
} from '../services/comm-report.service';
import type { ReportExportsService } from '../services/report-exports.service';
import { institutionOf } from '../services/academic-year';
import { AuthenticationError } from '../utils/CustomAPIError';

const day = z.string().max(10);
export const commReportFilters = z
  .strictObject({
    from: day.optional(),
    to: day.optional(),
    kind: z.enum(COMM_KINDS, { message: 'VALIDATION.FORMAT' }).optional(),
    channel: z.enum(COMM_CHANNELS, { message: 'VALIDATION.FORMAT' }).optional(),
    outcome: z.enum(COMM_OUTCOMES, { message: 'VALIDATION.FORMAT' }).optional(),
    raiser: z.string().max(40).optional(),
    recipient: z.string().max(40).optional(),
  })
  .meta({ id: 'CommReportFilters' });
const reportQuery = commReportFilters.extend({
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const commExportSchema = z
  .strictObject({ filters: commReportFilters })
  .meta({ id: 'CommReportExport' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Communication'] });
doc({
  id: 'COM-007',
  method: 'get',
  path: '/api/v1/console/communication-log',
  summary:
    'The communication report (CR-16): every message sent for the institution — kind, channel, who raised it, recipient, subject, outcome and reason, never a direct message’s body or a code — with totals over the filtered set and the date from which the record is complete',
  auth: 'commreport.view',
  query: reportQuery,
  responses: { 200: { description: 'Report' } },
});
doc({
  id: 'COM-008',
  method: 'post',
  path: '/api/v1/console/communication-log/exports',
  summary:
    'Export exactly the rows the filters select with the report’s columns (CSV), prepared off the request',
  auth: 'commreport.view',
  request: commExportSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Requested' } },
});
defineRoute({
  id: 'RPT-005',
  method: 'get',
  path: '/api/v1/exports/{exportId}',
  tags: ['Reporting'],
  summary:
    'An export the caller asked for: its state and, once ready, a short-lived signed download link; expired after its download window',
  auth: 'console | ops (the requester)',
  responses: { 200: { description: 'Export' } },
});

export function commReportRoutes(deps: {
  db: Kysely<Database>;
  commReport: CommReportService;
  exports: ReportExportsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const view = authorize('commreport.view', L);
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

  router.get(
    '/console/communication-log',
    ...console,
    view,
    json((req) => deps.commReport.report(principal(req), reportQuery.parse(req.query))),
  );
  router.post(
    '/console/communication-log/exports',
    ...console,
    view,
    once,
    json(async (req) => {
      const p = principal(req);
      const { filters } = commExportSchema.parse(req.body ?? {});
      return deps.exports.request(
        p,
        await deps.commReport.institutionFor(p),
        'communication-log',
        filters,
      );
    }, 202),
  );
  router.get(
    '/exports/:exportId',
    requireSurface(L, 'console', 'ops'),
    json(async (req) => {
      const p = principal(req);
      const institutionId = p.surface === 'ops' ? null : (await institutionOf(deps.db, p)).id;
      return deps.exports.get(p, String(req.params['exportId']), institutionId);
    }),
  );
  return router;
}

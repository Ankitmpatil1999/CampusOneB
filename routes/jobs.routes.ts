import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { jobsController } from '../controllers/jobs.controller';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { AuthenticationError } from '../utils/CustomAPIError';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import {
  jobCatalogueSchema,
  jobRunLogSchema,
  jobRunRequestSchema,
  jobRunsSchema,
} from '../schemas/jobs.schema';
import type { JobsService } from '../services/jobs.service';

const tags = ['Scheduled processing'];
defineRoute({
  id: 'GOV-001',
  method: 'get',
  path: '/api/v1/ops/jobs',
  summary:
    'Job catalogue: schedule and time zone, window, catch-up, re-run behaviour, the phase that brings each runner, last run',
  tags,
  auth: 'jobs.view',
  responses: { 200: { description: 'Catalogue', schema: jobCatalogueSchema } },
});
defineRoute({
  id: 'GOV-002',
  method: 'get',
  path: '/api/v1/ops/jobs/{jobId}/runs',
  summary: 'Run history of a process, newest first',
  tags,
  auth: 'jobs.view',
  responses: { 200: { description: 'Runs', schema: jobRunsSchema } },
});
defineRoute({
  id: 'GOV-003',
  method: 'get',
  path: '/api/v1/ops/job-runs/{runId}',
  summary: 'Run log with per-institution items processed / failed / skipped',
  tags,
  auth: 'jobs.view',
  responses: { 200: { description: 'Run log', schema: jobRunLogSchema } },
});
defineRoute({
  id: 'GOV-004',
  method: 'post',
  path: '/api/v1/ops/jobs/{jobId}/runs',
  summary:
    'Run a process now for a stated period under its lock (refused until its module registers the runner, or while a run is in progress; re-runs never double-post)',
  tags,
  auth: 'jobs.run',
  request: jobRunRequestSchema,
  responses: { 202: { description: 'The run and its log', schema: jobRunLogSchema } },
});

defineRoute({
  id: 'GOV-006',
  method: 'get',
  path: '/api/v1/console/job-runs',
  summary:
    "The institution's view of the scheduled runs that touched it (allowance credit, coupon expiry, event status…), for the jobs whose task the user holds",
  auth: 'console',
  tags,
  responses: { 200: { description: 'Runs' } },
});

defineRoute({
  id: 'GOV-007',
  method: 'post',
  path: '/api/v1/console/jobs/{jobId}/runs',
  summary:
    'Run an institution-scoped job now for this institution only (tuition auto-debit: fees.collect); same lock, run log and re-run safety as the schedule',
  auth: 'console',
  tags,
  request: jobRunRequestSchema,
  idempotent: 'required',
  responses: {
    202: {
      description: 'The run and this institution’s line',
      schema: z
        .object({
          runId: z.uuid(),
          job: z.object({ id: z.string(), name: z.string() }),
          periodKey: z.string(),
          runStatus: z.enum(['SUCCESS', 'PARTIAL_FAILURE', 'FAILED']),
          status: z.string(),
          processed: z.number(),
          failed: z.number(),
          note: z.string().nullable(),
        })
        .meta({ id: 'InstitutionJobRun' }),
    },
  },
});

/** Mounted under /api/v1. Back-office sessions, and the console's GOV-006/007. */
export function jobsRoutes(deps: {
  db: Kysely<Database>;
  service: JobsService;
  loggers: Loggers;
}): Router {
  const c = jobsController(deps.service);
  const router = Router();
  const ops = requireSurface(deps.loggers, 'ops');
  const view = authorize('jobs.view', deps.loggers);
  router.get('/ops/jobs', ops, view, c.catalogue);
  router.get('/ops/jobs/:jobId/runs', ops, view, c.runs);
  router.get('/ops/job-runs/:runId', ops, view, c.runLog);
  router.get(
    '/console/job-runs',
    requireSurface(deps.loggers, 'console'),
    requireTenant(deps.loggers),
    async (req, res, next) => {
      try {
        if (!req.principal) throw new AuthenticationError();
        res.json(
          await deps.service.institutionRuns(req.principal, {
            jobId: typeof req.query['jobId'] === 'string' ? req.query['jobId'] : undefined,
            cursor: typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined,
          }),
        );
      } catch (e) {
        next(e);
      }
    },
  );
  router.post(
    '/ops/jobs/:jobId/runs',
    ops,
    authorize('jobs.run', deps.loggers),
    idempotency({ db: deps.db, mode: 'required' }),
    c.runNow,
  );
  // GOV-007: the owning task's sub-task is checked by the service (it depends on the job).
  router.post(
    '/console/jobs/:jobId/runs',
    requireSurface(deps.loggers, 'console'),
    requireTenant(deps.loggers),
    idempotency({ db: deps.db, mode: 'required' }),
    c.institutionRun,
  );
  return router;
}

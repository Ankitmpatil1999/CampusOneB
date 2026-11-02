import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { plansController } from '../controllers/plans.controller';
import { authorize, requireSurface } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import { planSchema } from '../schemas/institutions.schema';
import { planChangedSchema, planInputSchema, plansListSchema } from '../schemas/plans.schema';
import type { PlansService } from '../services/plans.service';

const tags = ['Plans & billing'];

defineRoute({
  id: 'SAS-027',
  method: 'get',
  path: '/api/v1/ops/plans',
  summary:
    'Plans with their current terms (version, modules, allowances, price, trial, platform fee) and the institutions on each',
  tags,
  auth: 'home.view',
  responses: { 200: { description: 'Plans', schema: plansListSchema } },
});
defineRoute({
  id: 'SAS-028',
  method: 'post',
  path: '/api/v1/ops/plans',
  summary: 'New plan: modules, allowances, price and cycle, trial, platform fee (version 1)',
  tags,
  auth: 'plans.edit',
  request: planInputSchema,
  responses: { 201: { description: 'Created', schema: planSchema } },
});
defineRoute({
  id: 'SAS-029',
  method: 'patch',
  path: '/api/v1/ops/plans/{planId}',
  summary:
    'Change a plan; changed terms become a new version that applies to each institution from its next renewal; If-Match',
  tags,
  auth: 'plans.edit',
  request: planInputSchema,
  responses: { 200: { description: 'Saved', schema: planChangedSchema } },
});

/** Mounted under /api/v1. Back-office sessions. */
export function plansRoutes(deps: {
  db: Kysely<Database>;
  service: PlansService;
  loggers: Loggers;
}): Router {
  const c = plansController(deps.service);
  const router = Router();
  const op = requireSurface(deps.loggers, 'ops');
  const once = idempotency({ db: deps.db, mode: 'required' });
  router.get('/ops/plans', op, authorize('home.view', deps.loggers), c.list);
  router.post('/ops/plans', op, authorize('plans.edit', deps.loggers), once, c.create);
  router.patch('/ops/plans/:planId', op, authorize('plans.edit', deps.loggers), c.change);
  return router;
}

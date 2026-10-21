import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { institutionsController } from '../controllers/institutions.controller';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  bankResultSchema,
  bankSchema,
  brandingSchema,
  consoleInstitutionSchema,
  consoleUpdateSchema,
  editSchema,
  feeAccountSchema,
  featureChangeSchema,
  featureLogSchema,
  featuresSchema,
  institutionDetailSchema,
  institutionListSchema,
  lifecycleResultSchema,
  lifecycleSchema,
  logoSchema,
  registeredSchema,
  registerSchema,
  stepResultSchema,
  stepSchema,
  versionSchema,
} from '../schemas/institutions.schema';
import type { InstitutionsService } from '../services/institutions.service';

const tags = ['Institutions'];
const ops = '/api/v1/ops/institutions';

defineRoute({
  id: 'INS-001',
  method: 'get',
  path: ops,
  summary: 'Every tenant with plan, onboarding progress and lifecycle state, newest first',
  tags,
  auth: 'task.tenants',
  responses: { 200: { description: 'Institutions', schema: institutionListSchema } },
});
defineRoute({
  id: 'INS-002',
  method: 'post',
  path: ops,
  summary:
    'Register an institution in one transaction: identifier (RNG-ONB-035), contacts, the Staff user type with Administration, the administrator profile and role, features off, plan; welcome e-mail → Pending activation',
  tags,
  auth: 'inst.register',
  request: registerSchema,
  responses: { 201: { description: 'Registered', schema: registeredSchema } },
});
defineRoute({
  id: 'INS-003',
  method: 'get',
  path: `${ops}/{institutionId}`,
  summary:
    'Tenant detail: plan, contacts, onboarding checklist, lifecycle actions and history; ETag',
  tags,
  auth: 'task.tenants',
  responses: { 200: { description: 'Institution', schema: institutionDetailSchema } },
});
defineRoute({
  id: 'INS-004',
  method: 'patch',
  path: `${ops}/{institutionId}`,
  summary: 'Edit master data and contacts (recorded); choose the plan before activation; If-Match',
  tags,
  auth: 'inst.register',
  request: editSchema,
  responses: { 200: { description: 'Saved', schema: versionSchema } },
});
defineRoute({
  id: 'INS-005',
  method: 'post',
  path: `${ops}/{institutionId}/lifecycle-events`,
  summary:
    'Activate (required checklist steps complete), suspend, reactivate or cancel, with a reason; recorded, e-mailed to the contacts; suspension and cancellation end open sessions',
  tags,
  auth: 'inst.lifecycle',
  request: lifecycleSchema,
  responses: { 200: { description: 'Changed', schema: lifecycleResultSchema } },
});
defineRoute({
  id: 'INS-006',
  method: 'put',
  path: `${ops}/{institutionId}/bank-arrangement`,
  summary:
    'Sponsor-bank corporate code (unique) and pool / shadow account references; completes the bank step; If-Match',
  tags,
  auth: 'inst.register',
  request: bankSchema,
  responses: { 200: { description: 'Saved', schema: bankResultSchema } },
});
defineRoute({
  id: 'INS-036',
  method: 'post',
  path: `${ops}/{institutionId}/checklist/{step}`,
  summary:
    'Mark an onboarding step done (RC-10 Pending → Complete); institution-owned steps after confirming with the institution',
  tags,
  auth: 'inst.register',
  request: stepSchema,
  responses: { 200: { description: 'Step complete', schema: stepResultSchema } },
});
defineRoute({
  id: 'INS-007',
  method: 'get',
  path: `${ops}/{institutionId}/features`,
  summary: 'Feature toggles and channels with plan locks; ETag',
  tags,
  auth: 'task.tenants',
  responses: { 200: { description: 'Feature permissions', schema: featuresSchema } },
});
defineRoute({
  id: 'INS-008',
  method: 'patch',
  path: `${ops}/{institutionId}/features`,
  summary:
    'Per-toggle change (omitted toggles untouched); refused outside the plan; switching off also switches off what needs it; recorded; If-Match',
  tags,
  auth: 'features.edit',
  request: featureChangeSchema,
  responses: { 200: { description: 'Feature permissions', schema: featuresSchema } },
});
defineRoute({
  id: 'INS-009',
  method: 'get',
  path: '/api/v1/ops/feature-change-log',
  summary: 'Feature change record (who, when, from → to, why), newest first (?institutionId)',
  tags,
  auth: 'task.tenants',
  responses: { 200: { description: 'Changes', schema: featureLogSchema } },
});
defineRoute({
  id: 'INS-010',
  method: 'get',
  path: '/api/v1/console/institution',
  summary:
    "The session's institution: details, contacts, logo, fee account, features (read-only) and channels; ETag",
  tags,
  auth: 'config.view',
  responses: { 200: { description: 'Institution', schema: consoleInstitutionSchema } },
});
defineRoute({
  id: 'INS-011',
  method: 'patch',
  path: '/api/v1/console/institution',
  summary:
    'Edit details and contacts (name and address stay unique), consent validity and the channels the plan allows; If-Match',
  tags,
  auth: 'config.edit',
  request: consoleUpdateSchema,
  responses: { 200: { description: 'Institution', schema: consoleInstitutionSchema } },
});
defineRoute({
  id: 'INS-012',
  method: 'put',
  path: '/api/v1/console/institution/logo',
  summary: 'Replace the logo with an uploaded file (purpose logo: PNG/JPEG, ≤ 2 MB, scanned)',
  tags,
  auth: 'config.edit',
  request: logoSchema,
  responses: { 200: { description: 'Institution', schema: consoleInstitutionSchema } },
});
defineRoute({
  id: 'INS-013',
  method: 'put',
  path: '/api/v1/console/institution/fee-account',
  summary: 'Designate the fee account (an active merchant profile of the institution); If-Match',
  tags,
  auth: 'config.edit',
  request: feeAccountSchema,
  responses: { 200: { description: 'Institution', schema: consoleInstitutionSchema } },
});
defineRoute({
  id: 'INS-035',
  method: 'get',
  path: '/api/v1/public/institutions/{slug}/branding',
  summary:
    'Public branding for sign-in and admission pages by the institution identifier: name, logo link, colour (minimum data)',
  tags,
  auth: 'public',
  responses: { 200: { description: 'Branding', schema: brandingSchema } },
});
defineRoute({
  id: 'INS-049',
  method: 'get',
  path: '/api/v1/public/institutions/{institutionId}/logo',
  summary:
    "The institution's logo (PNG or JPEG) at a stable address for the console's menu, the admission pages and the apps; `?v=` changes when the logo is replaced (client 2026-10-15)",
  tags,
  auth: 'public',
  responses: { 200: { description: 'The logo image' } },
});

/** Mounted under /api/v1. */
export function institutionsRoutes(deps: {
  db: Kysely<Database>;
  service: InstitutionsService;
  loggers: Loggers;
}): Router {
  const c = institutionsController(deps.service);
  const router = Router();
  const L = deps.loggers;
  const op = requireSurface(L, 'ops');
  const con = [requireSurface(L, 'console'), requireTenant(L)];
  const can = (subTask: string) => authorize(subTask, L);
  const once = idempotency({ db: deps.db, mode: 'required' });

  router.get('/ops/institutions', op, can('task.tenants'), c.list);
  router.post('/ops/institutions', op, can('inst.register'), once, c.register);
  router.get('/ops/institutions/:institutionId', op, can('task.tenants'), c.detail);
  router.patch('/ops/institutions/:institutionId', op, can('inst.register'), c.edit);
  router.post(
    '/ops/institutions/:institutionId/lifecycle-events',
    op,
    can('inst.lifecycle'),
    once,
    c.lifecycle,
  );
  router.put('/ops/institutions/:institutionId/bank-arrangement', op, can('inst.register'), c.bank);
  router.post('/ops/institutions/:institutionId/checklist/:step', op, can('inst.register'), c.step);
  router.get('/ops/institutions/:institutionId/features', op, can('task.tenants'), c.features);
  router.patch(
    '/ops/institutions/:institutionId/features',
    op,
    can('features.edit'),
    c.changeFeatures,
  );
  router.get('/ops/feature-change-log', op, can('task.tenants'), c.featureLog);

  router.get('/console/institution', ...con, can('config.view'), c.consoleView);
  router.patch('/console/institution', ...con, can('config.edit'), c.consoleUpdate);
  router.put('/console/institution/logo', ...con, can('config.edit'), c.logo);
  router.put('/console/institution/fee-account', ...con, can('config.edit'), c.feeAccount);

  router.get('/public/institutions/:slug/branding', c.branding);
  router.get('/public/institutions/:institutionId/logo', c.publicLogo);
  return router;
}

import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { subscriptionController } from '../controllers/subscription.controller';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import { invoiceSchema } from '../schemas/billing.schema';
import {
  consoleSubscriptionSchema,
  planChangeResultSchema,
  planChangeSchema,
  planRequestCreatedSchema,
  planRequestInputSchema,
  reasonSchema,
  transferReportSchema,
} from '../schemas/subscription.schema';
import type { SubscriptionService } from '../services/subscription.service';

const tags = ['Plans & billing'];

defineRoute({
  id: 'SAS-026',
  method: 'get',
  path: '/api/v1/console/subscription',
  summary:
    'Plan & billing in the console: plan in force, modules, period and renewal, scheduled change, usage against the allowances, invoices and plan change requests',
  tags,
  auth: 'config.view',
  responses: { 200: { description: 'Subscription', schema: consoleSubscriptionSchema } },
});
defineRoute({
  id: 'SAS-034',
  method: 'post',
  path: '/api/v1/ops/institutions/{institutionId}/plan-changes',
  summary:
    'Change the plan of a running subscription: a trial changes at once; an upgrade now (prorated invoice for the days left) or at renewal; a lower-priced plan at renewal. Features outside the plan are switched off when it applies; contacts e-mailed',
  tags,
  auth: 'inst.lifecycle',
  request: planChangeSchema,
  responses: { 200: { description: 'Changed or scheduled', schema: planChangeResultSchema } },
});
defineRoute({
  id: 'SAS-035',
  method: 'post',
  path: '/api/v1/ops/institutions/{institutionId}/plan-changes/scheduled/cancel',
  summary: 'Cancel a plan change scheduled for renewal (reason recorded in the lifecycle history)',
  tags,
  auth: 'inst.lifecycle',
  request: reasonSchema,
  responses: { 204: { description: 'Cancelled' } },
});
defineRoute({
  id: 'SAS-036',
  method: 'post',
  path: '/api/v1/ops/plan-change-requests/{requestId}/decline',
  summary: "Decline an institution's plan change request with a reason (primary contact e-mailed)",
  tags,
  auth: 'inst.lifecycle',
  request: reasonSchema,
  responses: { 200: { description: 'Declined' } },
});
defineRoute({
  id: 'SAS-037',
  method: 'post',
  path: '/api/v1/console/subscription/plan-change-requests',
  summary:
    'Request a plan change (now or at renewal) — a platform administrator confirms the prorated amount; one pending request at a time',
  tags,
  auth: 'config.edit',
  request: planRequestInputSchema,
  responses: { 201: { description: 'Requested', schema: planRequestCreatedSchema } },
});
defineRoute({
  id: 'SAS-038',
  method: 'delete',
  path: '/api/v1/console/subscription/plan-change-requests/{requestId}',
  summary: 'Withdraw a pending plan change request',
  tags,
  auth: 'config.edit',
  responses: { 204: { description: 'Withdrawn' } },
});
defineRoute({
  id: 'SAS-039',
  method: 'post',
  path: '/api/v1/console/invoices/{invoiceId}/transfer-reports',
  summary:
    'Report a bank transfer for an unpaid invoice (UTR, date); a platform administrator confirms it and marks the invoice paid (SAS-032)',
  tags,
  auth: 'config.edit',
  request: transferReportSchema,
  responses: { 200: { description: 'Invoice with the reported transfer', schema: invoiceSchema } },
});

defineRoute({
  id: 'SAS-042',
  method: 'get',
  path: '/api/v1/console/invoices/{invoiceId}/pdf',
  summary: "The institution's GST invoice as a PDF (another institution's invoice → 404)",
  tags,
  auth: 'config.view',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});

/** Mounted under /api/v1. Back-office and console sessions. */
export function subscriptionRoutes(deps: {
  db: Kysely<Database>;
  service: SubscriptionService;
  loggers: Loggers;
}): Router {
  const c = subscriptionController(deps.service);
  const router = Router();
  const L = deps.loggers;
  const op = requireSurface(L, 'ops');
  const con = [requireSurface(L, 'console'), requireTenant(L)];
  const can = (subTask: string) => authorize(subTask, L);
  const once = idempotency({ db: deps.db, mode: 'required' });
  router.post(
    '/ops/institutions/:institutionId/plan-changes',
    op,
    can('inst.lifecycle'),
    once,
    c.changePlan,
  );
  router.post(
    '/ops/institutions/:institutionId/plan-changes/scheduled/cancel',
    op,
    can('inst.lifecycle'),
    c.cancelScheduled,
  );
  router.post('/ops/plan-change-requests/:requestId/decline', op, can('inst.lifecycle'), c.decline);
  router.get('/console/subscription', ...con, can('config.view'), c.summary);
  router.get('/console/invoices/:invoiceId/pdf', ...con, can('config.view'), c.pdf);
  router.post(
    '/console/subscription/plan-change-requests',
    ...con,
    can('config.edit'),
    once,
    c.request,
  );
  router.delete(
    '/console/subscription/plan-change-requests/:requestId',
    ...con,
    can('config.edit'),
    c.withdraw,
  );
  router.post(
    '/console/invoices/:invoiceId/transfer-reports',
    ...con,
    can('config.edit'),
    c.reportTransfer,
  );
  return router;
}

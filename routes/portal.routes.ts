import { Router, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { portalController } from '../controllers/portal.controller';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import { invoiceSchema, invoicesSchema } from '../schemas/billing.schema';
import { challengeSchema } from '../schemas/member-auth.schema';
import {
  cancellationCreatedSchema,
  cancellationRequestSchema,
  cancellationSchema,
  contactsSchema,
  declineSchema,
  detailsChangeResultSchema,
  detailsChangeSchema,
  detailsSchema,
  exportRequestSchema,
  exportSchema,
  exportsSchema,
  goLiveResultSchema,
  goLiveSchema,
  noticesSchema,
  onboardingSchema,
  portalAccountSchema,
  portalPaymentSchema,
  portalPlanChangeSchema,
  portalPlansSchema,
  signedUpSchema,
  signupOtpSchema,
  signupSchema,
  signupVerifiedSchema,
  signupVerifySchema,
  stepBodySchema,
} from '../schemas/portal.schema';
import { consoleSubscriptionSchema } from '../schemas/subscription.schema';
import type { PortalDataService } from '../services/portal-data.service';
import type { PortalService } from '../services/portal.service';
import type { FieldCipher } from '../utils/fieldEncryption';

const tags = ['Customer portal'];
const p = '/api/v1/portal';
const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) => defineRoute({ ...d, tags });

doc({
  id: 'SAS-001',
  method: 'get',
  path: `${p}/plans`,
  summary: 'The plans one can sign up for (terms in force), with the invoice due and grace days',
  auth: 'public',
  responses: { 200: { description: 'Plans', schema: portalPlansSchema } },
});
doc({
  id: 'SAS-002',
  method: 'post',
  path: `${p}/signup/otp`,
  summary:
    "Sign-up step 1: the administrator's own RingPe account by its mobile; a 4-digit code by SMS. Refused when no account uses the number or it already belongs to an institution (BR-01), without naming it",
  auth: 'public',
  request: signupOtpSchema,
  responses: { 202: { description: 'Code sent', schema: challengeSchema } },
});
doc({
  id: 'SAS-003',
  method: 'post',
  path: `${p}/signup/otp/verify`,
  summary: 'Sign-up step 2: the code gives a sign-up token (30 minutes) and the account summary',
  auth: 'public',
  request: signupVerifySchema,
  responses: { 200: { description: 'Verified', schema: signupVerifiedSchema } },
});
doc({
  id: 'SAS-004',
  method: 'post',
  path: `${p}/signup`,
  summary:
    'Registers the institution (name + address unique) with the account as its first administrator, the chosen plan and how to start (trial or pay); terms accepted; opens the portal session',
  auth: 'public (sign-up token)',
  request: signupSchema,
  responses: { 201: { description: 'Registered and signed in', schema: signedUpSchema } },
});
doc({
  id: 'SAS-007',
  method: 'get',
  path: `${p}/account`,
  summary: 'Overview: status, plan and period, usage, invoices, checklist progress, recent notices',
  auth: 'portal',
  responses: { 200: { description: 'Account', schema: portalAccountSchema } },
});
doc({
  id: 'SAS-008',
  method: 'get',
  path: `${p}/onboarding`,
  summary: 'The onboarding checklist: who does each step, done or not, and what was done',
  auth: 'portal',
  responses: { 200: { description: 'Checklist', schema: onboardingSchema } },
});
doc({
  id: 'SAS-009',
  method: 'put',
  path: `${p}/onboarding/steps/{stepKey}`,
  summary:
    'Complete a step: toggles (features within the plan), usertypes, year, feeacct (recorded masked until the fee merchant exists), branding (logo), firstusers',
  auth: 'portal',
  request: stepBodySchema,
  responses: { 200: { description: 'Checklist', schema: onboardingSchema } },
});
doc({
  id: 'SAS-010',
  method: 'post',
  path: `${p}/go-live`,
  summary:
    "Go live once the required steps are done: a free trial for the plan's days, or Active with the first invoice (due in the set days)",
  auth: 'portal',
  request: goLiveSchema,
  responses: { 200: { description: 'Live', schema: goLiveResultSchema } },
});
doc({
  id: 'SAS-011',
  method: 'get',
  path: `${p}/subscription`,
  summary: 'Plan, period, renewal, scheduled change, usage and invoices (as the console)',
  auth: 'portal',
  responses: { 200: { description: 'Subscription', schema: consoleSubscriptionSchema } },
});
doc({
  id: 'SAS-012',
  method: 'post',
  path: `${p}/subscription/plan-changes`,
  summary:
    'Change plan: before go-live the plan is replaced; afterwards an upgrade applies now (prorated invoice) or at renewal, a lower plan at renewal',
  auth: 'portal',
  request: portalPlanChangeSchema,
  responses: { 200: { description: 'Subscription', schema: consoleSubscriptionSchema } },
});
doc({
  id: 'SAS-013',
  method: 'delete',
  path: `${p}/subscription/scheduled-change`,
  summary: 'Undo the change scheduled for renewal',
  auth: 'portal',
  responses: { 204: { description: 'Undone' } },
});
doc({
  id: 'SAS-014',
  method: 'get',
  path: `${p}/invoices`,
  summary: 'Invoices with lines, GST, status (grace and overdue) and reported transfers',
  auth: 'portal',
  responses: { 200: { description: 'Invoices', schema: invoicesSchema } },
});
doc({
  id: 'SAS-015',
  method: 'get',
  path: `${p}/invoices/{invoiceId}`,
  summary: 'One invoice',
  auth: 'portal',
  responses: { 200: { description: 'Invoice', schema: invoiceSchema } },
});
doc({
  id: 'SAS-016',
  method: 'get',
  path: `${p}/invoices/{invoiceId}/pdf`,
  summary: 'The GST invoice as a PDF',
  auth: 'portal',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});
doc({
  id: 'SAS-017',
  method: 'post',
  path: `${p}/invoices/{invoiceId}/payments`,
  summary:
    'Pay an invoice: a bank transfer is reported (UTR, date) and RingPe confirms it; online payment arrives with the gateway (Q17)',
  auth: 'portal',
  request: portalPaymentSchema,
  responses: { 200: { description: 'Invoice', schema: invoiceSchema } },
});
doc({
  id: 'SAS-019',
  method: 'get',
  path: `${p}/notices`,
  summary: 'Lifecycle history: what happened, who did it and why (FR-SAS-11)',
  auth: 'portal',
  responses: { 200: { description: 'Notices', schema: noticesSchema } },
});
doc({
  id: 'SAS-020',
  method: 'get',
  path: `${p}/institution-details`,
  summary: 'Institution details, contacts, administrator, bank references and change requests',
  auth: 'portal',
  responses: { 200: { description: 'Details', schema: detailsSchema } },
});
doc({
  id: 'SAS-047',
  method: 'put',
  path: `${p}/institution-details/contacts`,
  summary: 'Save the primary and secondary contacts (If-Match); both are told by e-mail',
  auth: 'portal',
  request: contactsSchema,
  responses: { 200: { description: 'Details', schema: detailsSchema } },
});
doc({
  id: 'SAS-021',
  method: 'post',
  path: `${p}/institution-details/change-requests`,
  summary:
    'Ask RingPe to change the name, address or board; RingPe checks name and address stay unique, then applies it (platform approvals)',
  auth: 'portal',
  request: detailsChangeSchema,
  responses: { 202: { description: 'Sent', schema: detailsChangeResultSchema } },
});
doc({
  id: 'SAS-048',
  method: 'get',
  path: `${p}/data-exports`,
  summary: 'Exports with their status and, while valid, a signed download link',
  auth: 'portal',
  responses: { 200: { description: 'Exports', schema: exportsSchema } },
});
doc({
  id: 'SAS-022',
  method: 'post',
  path: `${p}/data-exports`,
  summary:
    'Export the chosen data classes as CSV files in a ZIP (one at a time; kept for sas.export.keepDays); personal numbers are never exported',
  auth: 'portal',
  request: exportRequestSchema,
  responses: { 201: { description: 'Export', schema: exportSchema } },
});
doc({
  id: 'SAS-023',
  method: 'get',
  path: `${p}/data-exports/{exportId}`,
  summary: 'One export: status and download link',
  auth: 'portal',
  responses: { 200: { description: 'Export', schema: exportSchema } },
});
doc({
  id: 'SAS-049',
  method: 'get',
  path: `${p}/cancellation`,
  summary: 'What stands in the way of cancelling (unpaid invoices) and the latest request',
  auth: 'portal',
  responses: { 200: { description: 'Cancellation', schema: cancellationSchema } },
});
doc({
  id: 'SAS-024',
  method: 'post',
  path: `${p}/cancellation-requests`,
  summary:
    'Ask to cancel (end of cycle, as soon as possible or a date); unpaid invoices first; RingPe confirms with the lifecycle action Cancel or declines',
  auth: 'portal',
  request: cancellationRequestSchema,
  responses: { 202: { description: 'Requested', schema: cancellationCreatedSchema } },
});
doc({
  id: 'SAS-025',
  method: 'delete',
  path: `${p}/cancellation-requests/{requestId}`,
  summary: 'Withdraw a pending cancellation request',
  auth: 'portal',
  responses: { 204: { description: 'Withdrawn' } },
});
defineRoute({
  id: 'SAS-050',
  method: 'post',
  path: '/api/v1/ops/institutions/{institutionId}/cancellation-requests/decline',
  summary: "Decline an institution's pending cancellation request with a reason",
  tags,
  auth: 'inst.lifecycle',
  request: declineSchema,
  responses: { 204: { description: 'Declined' } },
});

/** Mounted under /api/v1. Public sign-up, then the portal session (any institution status). */
export function portalRoutes(deps: {
  db: Kysely<Database>;
  portal: PortalService;
  data: PortalDataService;
  cipher: FieldCipher;
  loggers: Loggers;
  authLimiter: RequestHandler;
}): Router {
  const c = portalController(deps.portal, deps.data, deps.cipher);
  const router = Router();
  const L = deps.loggers;
  const sess = [requireSurface(L, 'portal'), requireTenant(L)];
  const once = idempotency({ db: deps.db, mode: 'required' });
  const limit = deps.authLimiter;

  router.get('/portal/plans', c.plans);
  router.post('/portal/signup/otp', limit, c.signupOtp);
  router.post('/portal/signup/otp/verify', limit, c.signupVerify);
  router.post('/portal/signup', limit, c.signup);

  router.get('/portal/account', ...sess, c.account);
  router.get('/portal/onboarding', ...sess, c.onboarding);
  router.put('/portal/onboarding/steps/:stepKey', ...sess, c.step);
  router.post('/portal/go-live', ...sess, once, c.goLive);
  router.get('/portal/subscription', ...sess, c.subscription);
  router.post('/portal/subscription/plan-changes', ...sess, once, c.changePlan);
  router.delete('/portal/subscription/scheduled-change', ...sess, c.cancelScheduled);
  router.get('/portal/invoices', ...sess, c.invoices);
  router.get('/portal/invoices/:invoiceId', ...sess, c.invoice);
  router.get('/portal/invoices/:invoiceId/pdf', ...sess, c.invoicePdf);
  router.post('/portal/invoices/:invoiceId/payments', ...sess, once, c.pay);
  router.get('/portal/notices', ...sess, c.notices);
  router.get('/portal/institution-details', ...sess, c.details);
  router.put('/portal/institution-details/contacts', ...sess, c.contacts);
  router.post('/portal/institution-details/change-requests', ...sess, once, c.detailsChange);
  router.get('/portal/data-exports', ...sess, c.exports);
  router.post('/portal/data-exports', ...sess, once, c.requestExport);
  router.get('/portal/data-exports/:exportId', ...sess, c.exportStatus);
  router.get('/portal/cancellation', ...sess, c.cancellation);
  router.post('/portal/cancellation-requests', ...sess, once, c.requestCancellation);
  router.delete('/portal/cancellation-requests/:requestId', ...sess, c.withdrawCancellation);
  router.post(
    '/ops/institutions/:institutionId/cancellation-requests/decline',
    requireSurface(L, 'ops'),
    authorize('inst.lifecycle', L),
    c.declineCancellation,
  );
  return router;
}

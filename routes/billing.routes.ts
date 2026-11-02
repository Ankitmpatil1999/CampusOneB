import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import { billingController } from '../controllers/billing.controller';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import {
  billingProfileInputSchema,
  billingProfileSchema,
  invoiceGenerateSchema,
  invoicePaidSchema,
  invoicePaymentSchema,
  invoiceSchema,
  invoicesSchema,
} from '../schemas/billing.schema';
import type { BillingService } from '../services/billing.service';

const tags = ['Plans & billing'];

defineRoute({
  id: 'SAS-030',
  method: 'get',
  path: '/api/v1/ops/invoices',
  summary: 'Invoices across institutions with lines, payment and status (Grace / Overdue by date)',
  tags,
  auth: 'home.view',
  responses: { 200: { description: 'Invoices', schema: invoicesSchema } },
});
defineRoute({
  id: 'SAS-031',
  method: 'post',
  path: '/api/v1/ops/invoices',
  summary:
    'Generate an invoice (renewal, plan activation or usage overage) from the plan terms, GST and due date settings; one per institution, trigger and period; e-mailed to the primary contact',
  tags,
  auth: 'billing.invoice',
  request: invoiceGenerateSchema,
  responses: { 201: { description: 'Issued', schema: invoiceSchema } },
});
defineRoute({
  id: 'SAS-032',
  method: 'post',
  path: '/api/v1/ops/invoices/{invoiceId}/payments',
  summary:
    'Record a bank transfer (UTR, amount equal to the total, date) → Paid; restores a suspended institution when nothing else is past due',
  tags,
  auth: 'billing.paid',
  request: invoicePaymentSchema,
  responses: { 201: { description: 'Paid', schema: invoicePaidSchema } },
});

defineRoute({
  id: 'SAS-040',
  method: 'get',
  path: '/api/v1/ops/billing-profile',
  summary:
    "CampusOne's invoice and bank details (legal name, GSTIN, address, SAC, payee account); example values until the client supplies them",
  tags,
  auth: 'home.view',
  responses: { 200: { description: 'Profile', schema: billingProfileSchema } },
});
defineRoute({
  id: 'SAS-041',
  method: 'put',
  path: '/api/v1/ops/billing-profile',
  summary:
    'Change the invoice and bank details (If-Match; GSTIN, SAC, IFSC and account number checked); the example marker is removed',
  tags,
  auth: 'plans.edit',
  request: billingProfileInputSchema,
  responses: { 200: { description: 'Profile', schema: billingProfileSchema } },
});
defineRoute({
  id: 'SAS-043',
  method: 'get',
  path: '/api/v1/ops/invoices/{invoiceId}/pdf',
  summary: 'The GST invoice as a PDF (CGST + SGST within the state, IGST otherwise)',
  tags,
  auth: 'home.view',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});

/** Mounted under /api/v1. Back-office sessions. */
export function billingRoutes(deps: {
  db: Kysely<Database>;
  service: BillingService;
  loggers: Loggers;
}): Router {
  const c = billingController(deps.service);
  const router = Router();
  const op = requireSurface(deps.loggers, 'ops');
  const once = idempotency({ db: deps.db, mode: 'required' });
  router.get('/ops/invoices', op, authorize('home.view', deps.loggers), c.list);
  router.get('/ops/invoices/:invoiceId/pdf', op, authorize('home.view', deps.loggers), c.pdf);
  router.get('/ops/billing-profile', op, authorize('home.view', deps.loggers), c.profile);
  router.put('/ops/billing-profile', op, authorize('plans.edit', deps.loggers), c.updateProfile);
  router.post('/ops/invoices', op, authorize('billing.invoice', deps.loggers), once, c.generate);
  router.post(
    '/ops/invoices/:invoiceId/payments',
    op,
    authorize('billing.paid', deps.loggers),
    once,
    c.pay,
  );
  return router;
}

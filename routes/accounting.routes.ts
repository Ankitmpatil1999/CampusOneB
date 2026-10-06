import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { AccountingService } from '../services/accounting.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const event = z.enum(['TUITION', 'EVENT', 'ALLOWANCE_CREDIT', 'REFUND'], {
  message: 'VALIDATION.FORMAT',
});
const status = z.enum(['PENDING', 'TRANSFERRED', 'FAILED'], { message: 'VALIDATION.FORMAT' });

export const mappingsSchema = z
  .strictObject({
    companyName: z.string({ message: 'ACC.COMPANY' }).max(100, { message: 'ACC.COMPANY' }),
    enabled: z.boolean({ message: 'VALIDATION.FORMAT' }),
    mappings: z
      .array(
        z.strictObject({
          event,
          debitLedger: z.string({ message: 'ACC.LEDGER' }).max(100, { message: 'ACC.LEDGER' }),
          creditLedger: z.string({ message: 'ACC.LEDGER' }).max(100, { message: 'ACC.LEDGER' }),
        }),
      )
      .max(4),
  })
  .meta({ id: 'AccountingMappings' });
const listQuery = z.object({
  status: status.optional(),
  from: z.iso.date({ message: 'VALIDATION.DATE' }).optional(),
  to: z.iso.date({ message: 'VALIDATION.DATE' }).optional(),
  cursor: z.string().max(40).optional(),
});
const voucher = z
  .object({
    id: z.uuid(),
    reference: z.string(),
    event,
    eventLabel: z.string(),
    date: z.string(),
    amount: money,
    company: z.string(),
    debitLedger: z.string(),
    creditLedger: z.string(),
    narration: z.string().nullable(),
    status,
    statusLabel: z.string(),
    attempts: z.number(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
    externalRef: z.string().nullable(),
    transferredAt: z.string().nullable(),
    createdAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'AccountingVoucher' });
const mappingsView = z
  .object({
    mode: z.enum(['test', 'off']).describe('test: the package is simulated (OQ-04 open)'),
    company: z.string().nullable(),
    enabled: z.boolean(),
    enabledAt: z.string().nullable(),
    events: z.array(
      z.object({
        event,
        label: z.string(),
        debitLedger: z.string().nullable(),
        creditLedger: z.string().nullable(),
      }),
    ),
    version: z.number().int(),
  })
  .meta({ id: 'AccountingMappingsView' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Accounting'] });
doc({
  id: 'FEE-034',
  method: 'get',
  path: '/api/v1/console/accounting/vouchers',
  summary:
    'Accounting vouchers (one per mapped ledger posting): Pending Transfer, Transferred or Failed with the reason and the next try; counts',
  auth: 'vouchers.view',
  query: listQuery,
  responses: { 200: { description: 'Vouchers' } },
});
doc({
  id: 'FEE-035',
  method: 'post',
  path: '/api/v1/console/accounting/vouchers/{voucherId}/retries',
  summary: 'Send a failed voucher to the accounting package again now',
  auth: 'vouchers.edit',
  idempotent: 'required',
  responses: { 202: { description: 'Sent again', schema: voucher } },
});
doc({
  id: 'FEE-036',
  method: 'get',
  path: '/api/v1/console/accounting/mappings',
  summary:
    'The accounting company, whether transfers are on, and each posting’s debit and credit ledger (ETag)',
  auth: 'vouchers.view',
  responses: { 200: { description: 'Mappings', schema: mappingsView } },
});
doc({
  id: 'FEE-037',
  method: 'put',
  path: '/api/v1/console/accounting/mappings',
  summary:
    'Set the company, the postings and their ledgers, and turn transfers on or off (postings from then on get vouchers); If-Match',
  auth: 'vouchers.edit',
  request: mappingsSchema,
  responses: { 200: { description: 'Saved', schema: mappingsView } },
});

/** Mounted under /api/v1. */
export function accountingRoutes(deps: {
  db: Kysely<Database>;
  accounting: AccountingService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const A = deps.accounting;
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
  const console = [requireSurface(L, 'console'), requireTenant(L)];

  router.get(
    '/console/accounting/vouchers',
    ...console,
    authorize('vouchers.view', L),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await A.list(principal(req), listQuery.parse(req.query)));
    }),
  );
  router.post(
    '/console/accounting/vouchers/:voucherId/retries',
    ...console,
    authorize('vouchers.edit', L),
    once,
    wrap(async (req, res) => {
      res.status(202).json(await A.retry(principal(req), String(req.params['voucherId'])));
    }),
  );
  router.get(
    '/console/accounting/mappings',
    ...console,
    authorize('vouchers.view', L),
    wrap(async (req, res) => {
      const out = await A.mappings(principal(req));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.put(
    '/console/accounting/mappings',
    ...console,
    authorize('vouchers.edit', L),
    wrap(async (req, res) => {
      const b = mappingsSchema.parse(req.body ?? {});
      const out = await A.saveMappings(principal(req), expectedVersion(req), b);
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  return router;
}

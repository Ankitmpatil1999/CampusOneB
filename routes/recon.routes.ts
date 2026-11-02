import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import { singleFileUpload, uploadErrors } from '../controllers/file.controller';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import type { ReconReportsService } from '../services/recon-reports.service';
import type { ReconciliationService } from '../services/reconciliation.service';
import type { RefundsService } from '../services/refunds.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const signedMoney = money.extend({ negative: z.boolean() });
const date = z.iso.date({ message: 'VALIDATION.DATE' });
const cursor = z.string().max(40).optional();
const statementKind = z.enum(['VA_CREDITS', 'PAYOUTS', 'GATEWAY'], {
  message: 'VALIDATION.FORMAT',
});
const amountIn = z
  .object({
    amount: z
      .string({ message: 'VALIDATION.AMOUNT' })
      .regex(/^\d{1,11}(\.\d{1,2})?$/, { message: 'VALIDATION.AMOUNT' }),
    currency: z.literal('INR', { message: 'VALIDATION.FORMAT' }),
  })
  .optional();
const remarks = z.string({ message: 'REC.REMARKS' }).max(500, { message: 'REC.REMARKS' });
const reference = z
  .string({ message: 'REC.REFERENCE_REQUIRED' })
  .trim()
  .max(35, { message: 'REC.TXN_UNKNOWN' });

export const resolutionSchema = z
  .strictObject({
    action: z.enum(['EXPLAINED', 'REFUND', 'CHARGEBACK', 'ADJUSTED'], {
      message: 'VALIDATION.FORMAT',
    }),
    remarks,
    transactionRef: reference.optional(),
    amount: amountIn,
    reasonCode: z.string().max(20, { message: 'REC.REASON_CODE' }).optional(),
  })
  .meta({ id: 'ReconResolution' });
export const refundRequestSchema = z
  .strictObject({ transactionRef: reference, amount: amountIn, reason: remarks })
  .meta({ id: 'RefundRequest' });
export const refundDecisionSchema = z
  .strictObject({
    decision: z.enum(['PROCESS', 'REJECT'], { message: 'VALIDATION.FORMAT' }).default('PROCESS'),
    remarks,
  })
  .meta({ id: 'RefundDecision' });
export const chargebackSchema = z
  .strictObject({
    transactionRef: reference,
    reasonCode: z.string({ message: 'REC.REASON_CODE' }).max(20, { message: 'REC.REASON_CODE' }),
    amount: amountIn,
  })
  .meta({ id: 'ChargebackRaise' });
export const chargebackDecisionSchema = z
  .strictObject({
    decision: z.enum(['ACCEPT', 'DISPUTE'], { message: 'VALIDATION.FORMAT' }),
    remarks,
  })
  .meta({ id: 'ChargebackDecision' });
export const chargebackCompletionSchema = z
  .strictObject({
    outcome: z.enum(['REVERSED', 'UPHELD'], { message: 'VALIDATION.FORMAT' }),
    remarks,
  })
  .meta({ id: 'ChargebackCompletion' });

const uploadsQuery = z.object({ type: statementKind.optional(), cursor });
const mismatchQuery = z.object({
  status: z.enum(['OPEN', 'RESOLVED'], { message: 'VALIDATION.FORMAT' }).optional(),
  kind: z
    .enum(['MISSING_ON_PLATFORM', 'MISSING_IN_STATEMENT', 'AMOUNT', 'STATUS'], {
      message: 'VALIDATION.FORMAT',
    })
    .optional(),
  type: statementKind.optional(),
  institutionId: z.string().max(40).optional(),
  cursor,
});
const refundQuery = z.object({
  status: z
    .enum(['REQUESTED', 'PROCESSED', 'REJECTED'], { message: 'VALIDATION.FORMAT' })
    .optional(),
  cursor,
});
const chargebackQuery = z.object({
  status: z
    .enum(['RAISED', 'ACCEPTED', 'DISPUTED', 'COMPLETED'], { message: 'VALIDATION.FORMAT' })
    .optional(),
  cursor,
});
const rangeQuery = z.object({ from: date.optional(), to: date.optional() });
const misQuery = rangeQuery.extend({ institutionId: z.string().max(40).optional() });
const poolQuery = z.object({ date: date.optional(), institutionId: z.string().max(40).optional() });
const attemptStatus = z.enum(['SUCCESS', 'FAILURE', 'PENDING'], { message: 'VALIDATION.FORMAT' });
const txnQuery = rangeQuery.extend({
  status: attemptStatus.optional(),
  channel: z.string().max(24).optional(),
  q: z.string().max(35).optional(),
  format: z.enum(['json', 'csv'], { message: 'VALIDATION.FORMAT' }).optional(),
  cursor,
});
const consoleMisQuery = rangeQuery.extend({
  status: attemptStatus.optional(),
  view: z.enum(['matched', 'unmatched', 'mismatched'], { message: 'VALIDATION.FORMAT' }).optional(),
  cursor,
});
const statementQuery = rangeQuery.extend({ merchantId: z.string().max(40).optional(), cursor });
const merchantReportQuery = rangeQuery.extend({ merchantId: z.string().max(40).optional() });

const who = z.object({ by: z.string().nullable(), at: z.string().nullable() });
const statement = z
  .object({
    id: z.uuid(),
    kind: statementKind,
    fileName: z.string(),
    rows: z.number(),
    matched: z.number(),
    mismatchedRows: z.number(),
    mismatches: z.number(),
    openMismatches: z.number(),
    periodFrom: z.string().nullable(),
    periodTo: z.string().nullable(),
    uploadedBy: z.string().nullable(),
    uploadedAt: z.string().nullable(),
  })
  .meta({ id: 'ReconStatement' });
const mismatch = z
  .object({
    id: z.uuid(),
    kind: z.enum(['MISSING_ON_PLATFORM', 'MISSING_IN_STATEMENT', 'AMOUNT', 'STATUS']),
    status: z.enum(['OPEN', 'RESOLVED']),
    statement: z.object({
      id: z.uuid(),
      kind: statementKind,
      fileName: z.string(),
      rowNo: z.number().nullable(),
      key: z.string().nullable(),
      date: z.string().nullable(),
      status: z.string().nullable(),
      amount: money.nullable(),
    }),
    platform: z
      .object({
        type: z.string(),
        reference: z.string().nullable(),
        ledgerReference: z
          .string()
          .nullable()
          .describe('The wallet movement (a bank credit’s) to refund or charge back'),
        amount: money.nullable(),
      })
      .nullable(),
    institution: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
    resolution: z.enum(['EXPLAINED', 'REFUND', 'CHARGEBACK', 'ADJUSTED']).nullable(),
    remarks: z.string().nullable(),
    refundId: z.uuid().nullable(),
    chargebackId: z.uuid().nullable(),
    resolved: who.nullable(),
    createdAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'ReconMismatch' });
const party = z.object({ walletNo: z.string(), name: z.string() });
const refund = z
  .object({
    id: z.uuid(),
    institution: z.object({ id: z.uuid(), name: z.string() }),
    originalReference: z.string(),
    from: party,
    to: party,
    amount: money,
    status: z.enum(['REQUESTED', 'PROCESSED', 'REJECTED']),
    source: z.enum(['MISMATCH', 'GRIEVANCE', 'MANUAL']),
    reason: z.string(),
    requested: who,
    decided: who.extend({ remarks: z.string().nullable() }).nullable(),
    refundReference: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Refund' });
const chargeback = z
  .object({
    id: z.uuid(),
    institution: z.object({ id: z.uuid(), name: z.string() }),
    originalReference: z.string(),
    wallet: party,
    amount: money,
    reasonCode: z.string(),
    status: z.enum(['RAISED', 'ACCEPTED', 'DISPUTED', 'COMPLETED']),
    outcome: z.enum(['REVERSED', 'UPHELD']).nullable(),
    remarks: z.string().nullable(),
    raised: who,
    decided: who.nullable(),
    completed: who.nullable(),
    reversalReference: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Chargeback' });
const page = <T extends z.ZodType>(item: T, id: string) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }).meta({ id });
const pool = z
  .object({
    institution: z.object({ id: z.uuid(), name: z.string() }),
    received: signedMoney,
    paidOut: signedMoney,
    chargebacks: signedMoney,
    poolExpected: signedMoney.describe('What the pool account should hold per the ledger'),
    wallets: signedMoney
      .nullable()
      .describe('Stored wallet balances (the day’s closing for a date)'),
    walletsPerLedger: signedMoney,
    otherAccounts: z.array(z.object({ kind: z.string(), balance: signedMoney })),
    heldFor: signedMoney,
    difference: signedMoney.describe('Zero unless stored balances drifted from the ledger'),
    bankReported: signedMoney
      .nullable()
      .describe('The bank’s own balance: needs its balance feed (OI-REC-05, Q17)'),
  })
  .meta({ id: 'PoolBalance' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Reconciliation'] });
doc({
  id: 'REC-001',
  method: 'post',
  path: '/api/v1/ops/recon/statement-uploads',
  summary:
    'Upload a statement (CSV, 2 MB) — type VA_CREDITS (Date, UTR, Bank Txn ID, VA Number, Amount, Mode, Sender), PAYOUTS (Date, UTR, Amount, Status, Beneficiary) or GATEWAY (Date, Payment ID, Order ID, Amount, Status): all rows or none, a file or row seen before refused; each row matched to the bank credit, settlement payout or admission payment; differences and the platform records of those days missing from the statement become mismatches',
  auth: 'recon.upload',
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 201: { description: 'Uploaded and matched', schema: statement } },
});
doc({
  id: 'REC-002',
  method: 'get',
  path: '/api/v1/ops/recon/statement-uploads',
  summary: 'Uploads, newest first, with rows matched and open mismatches; the layouts',
  auth: 'recon.upload',
  query: uploadsQuery,
  responses: { 200: { description: 'Uploads' } },
});
doc({
  id: 'REC-003',
  method: 'get',
  path: '/api/v1/ops/recon/mismatches',
  summary:
    'Mismatches (missing on the platform, missing in the statement, amount, status), newest first',
  auth: 'recon.resolve',
  query: mismatchQuery,
  responses: { 200: { description: 'Mismatches', schema: page(mismatch, 'ReconMismatches') } },
});
doc({
  id: 'REC-004',
  method: 'post',
  path: '/api/v1/ops/recon/mismatches/{mismatchId}/resolution',
  summary:
    'Resolve with remarks: explained, adjusted, or a refund or chargeback request for a transaction reference (money moves only when that request is decided, through the ledger); If-Match',
  auth: 'recon.resolve',
  request: resolutionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Resolved', schema: mismatch } },
});
doc({
  id: 'REC-005',
  method: 'get',
  path: '/api/v1/ops/recon/chargebacks',
  summary: 'Chargebacks (Raised → Accepted / Disputed → Completed), newest first',
  auth: 'recon.chargeback',
  query: chargebackQuery,
  responses: { 200: { description: 'Chargebacks', schema: page(chargeback, 'Chargebacks') } },
});
doc({
  id: 'REC-006',
  method: 'post',
  path: '/api/v1/ops/recon/chargebacks',
  summary:
    'Raise a chargeback against a movement that credited a wallet (reason code; at most its amount), once per movement',
  auth: 'recon.chargeback',
  request: chargebackSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Raised', schema: chargeback } },
});
doc({
  id: 'REC-019',
  method: 'post',
  path: '/api/v1/ops/recon/chargebacks/{chargebackId}/decision',
  summary: 'Accept or dispute a raised chargeback, with remarks; If-Match',
  auth: 'recon.chargeback',
  request: chargebackDecisionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Decided', schema: chargeback } },
});
doc({
  id: 'REC-007',
  method: 'post',
  path: '/api/v1/ops/recon/chargebacks/{chargebackId}/completion',
  summary:
    'Complete: reversed — the credited wallet is debited to the chargeback clearing account (a new ledger pair referencing the original) — or upheld (a won dispute; nothing moves); If-Match',
  auth: 'recon.chargeback',
  request: chargebackCompletionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Completed', schema: chargeback } },
});
doc({
  id: 'REC-008',
  method: 'get',
  path: '/api/v1/ops/recon/refunds',
  summary: 'Refunds (Requested → Processed / Rejected), newest first',
  auth: 'recon.resolve',
  query: refundQuery,
  responses: { 200: { description: 'Refunds', schema: page(refund, 'Refunds') } },
});
doc({
  id: 'REC-018',
  method: 'post',
  path: '/api/v1/ops/recon/refunds',
  summary:
    'Request a refund of a payment or transfer between two wallets (at most its amount; one per movement)',
  auth: 'recon.resolve',
  request: refundRequestSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Requested', schema: refund } },
});
doc({
  id: 'REC-009',
  method: 'post',
  path: '/api/v1/ops/recon/refunds/{refundId}/processing',
  summary:
    'Process (the ledger refund pair: the credited wallet back to the payer; the payer told) or reject, by an officer other than the requester; If-Match',
  auth: 'recon.resolve',
  request: refundDecisionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Decided', schema: refund } },
});
doc({
  id: 'REC-010',
  method: 'get',
  path: '/api/v1/ops/recon/mis',
  summary:
    'MIS by institution for a date range (default the month so far): transactions by status, merchant collections, bank credits, settlements, refunds and chargebacks',
  auth: 'recon.upload',
  query: misQuery,
  responses: { 200: { description: 'MIS' } },
});
doc({
  id: 'REC-011',
  method: 'get',
  path: '/api/v1/ops/recon/pool-balances',
  summary:
    'Per institution: what the pool account should hold per the ledger against what is held for wallets and the platform (now, or a date’s closing balances)',
  auth: 'recon.upload',
  query: poolQuery,
  responses: { 200: { description: 'Pool balances' } },
});
doc({
  id: 'REC-013',
  method: 'get',
  path: '/api/v1/console/recon/transactions',
  summary:
    'The institution’s payments and transfers for a date range with counts and shares by status (format=csv exports them)',
  auth: 'recon.view',
  query: txnQuery,
  responses: { 200: { description: 'Transactions' } },
});
doc({
  id: 'REC-014',
  method: 'get',
  path: '/api/v1/console/recon/mis',
  summary:
    'Payer ↔ merchant matching of the institution’s payments: matched, unmatched and mismatched (amount or status) with counts; settled flag',
  auth: 'recon.view',
  query: consoleMisQuery,
  responses: { 200: { description: 'MIS' } },
});
doc({
  id: 'REC-015',
  method: 'get',
  path: '/api/v1/console/recon/merchant-statement',
  summary:
    'A merchant’s statement: collections, adjustments and payouts, with the fee and net of the settlement line (none while not settled)',
  auth: 'recon.view',
  query: statementQuery,
  responses: { 200: { description: 'Statement' } },
});
doc({
  id: 'REC-016',
  method: 'get',
  path: '/api/v1/console/recon/pool-balance',
  summary: 'The institution’s pool against its wallet balances (now, or a date’s closing)',
  auth: 'recon.view',
  query: z.object({ date: date.optional() }),
  responses: { 200: { description: 'Pool balance', schema: pool } },
});
doc({
  id: 'PAY-025',
  method: 'get',
  path: '/api/v1/console/merchants/reports',
  summary:
    'Merchant reports: successful collections by merchant and date, settled and unsettled, with the fee',
  auth: 'merchants.report',
  query: merchantReportQuery,
  responses: { 200: { description: 'Report' } },
});

/** Mounted under /api/v1. */
export function reconRoutes(deps: {
  db: Kysely<Database>;
  reconciliation: ReconciliationService;
  refunds: RefundsService;
  reports: ReconReportsService;
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
  const param = (req: Request, k: string) => String(req.params[k]);
  const paise = (a: { amount: string } | undefined) => {
    if (!a) return undefined;
    try {
      return parseAmount(a.amount);
    } catch (e) {
      if (e instanceof MoneyError) {
        throw new ValidationError([{ field: 'amount', code: 'VALIDATION.AMOUNT' }]);
      }
      throw e;
    }
  };
  const ops = requireSurface(L, 'ops');
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  // --- statements and mismatches -----------------------------------------------------------------------
  router.post(
    '/ops/recon/statement-uploads',
    ops,
    authorize('recon.upload', L),
    once,
    singleFileUpload,
    uploadErrors,
    wrap(async (req, res) => {
      const kind = statementKind.safeParse(
        (req.body as Record<string, unknown> | undefined)?.['type'],
      );
      if (!kind.success) throw new ValidationError([{ field: 'type', code: 'VALIDATION.FORMAT' }]);
      if (!req.file) throw new ValidationError([{ field: 'file', code: 'UPL.FILE_REQUIRED' }]);
      res.status(201).json(
        await deps.reconciliation.upload(principal(req), {
          kind: kind.data,
          fileName: req.file.originalname || 'statement.csv',
          content: req.file.buffer,
        }),
      );
    }),
  );
  router.get(
    '/ops/recon/statement-uploads',
    ops,
    authorize('recon.upload', L),
    noStore,
    wrap(async (req, res) => {
      const q = uploadsQuery.parse(req.query);
      res.json(await deps.reconciliation.statements({ kind: q.type, cursor: q.cursor }));
    }),
  );
  router.get(
    '/ops/recon/mismatches',
    ops,
    authorize('recon.resolve', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await deps.reconciliation.mismatches(mismatchQuery.parse(req.query)));
    }),
  );
  router.post(
    '/ops/recon/mismatches/:mismatchId/resolution',
    ops,
    authorize('recon.resolve', L),
    once,
    wrap(async (req, res) => {
      const b = resolutionSchema.parse(req.body ?? {});
      const out = await deps.reconciliation.resolve(
        principal(req),
        param(req, 'mismatchId'),
        expectedVersion(req),
        { ...b, amountPaise: paise(b.amount) },
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );

  // --- chargebacks -----------------------------------------------------------------------------------------
  router.get(
    '/ops/recon/chargebacks',
    ops,
    authorize('recon.chargeback', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await deps.refunds.chargebacks(chargebackQuery.parse(req.query)));
    }),
  );
  router.post(
    '/ops/recon/chargebacks',
    ops,
    authorize('recon.chargeback', L),
    once,
    wrap(async (req, res) => {
      const b = chargebackSchema.parse(req.body ?? {});
      const out = await deps.refunds.raiseChargeback(principal(req), {
        transactionRef: b.transactionRef,
        reasonCode: b.reasonCode,
        amountPaise: paise(b.amount),
      });
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.post(
    '/ops/recon/chargebacks/:chargebackId/decision',
    ops,
    authorize('recon.chargeback', L),
    once,
    wrap(async (req, res) => {
      const b = chargebackDecisionSchema.parse(req.body ?? {});
      const out = await deps.refunds.decideChargeback(
        principal(req),
        param(req, 'chargebackId'),
        expectedVersion(req),
        b,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/ops/recon/chargebacks/:chargebackId/completion',
    ops,
    authorize('recon.chargeback', L),
    once,
    wrap(async (req, res) => {
      const b = chargebackCompletionSchema.parse(req.body ?? {});
      const out = await deps.refunds.completeChargeback(
        principal(req),
        param(req, 'chargebackId'),
        expectedVersion(req),
        b,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );

  // --- refunds ---------------------------------------------------------------------------------------------
  router.get(
    '/ops/recon/refunds',
    ops,
    authorize('recon.resolve', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await deps.refunds.refunds(refundQuery.parse(req.query)));
    }),
  );
  router.post(
    '/ops/recon/refunds',
    ops,
    authorize('recon.resolve', L),
    once,
    wrap(async (req, res) => {
      const b = refundRequestSchema.parse(req.body ?? {});
      const out = await deps.refunds.requestRefund(principal(req), {
        transactionRef: b.transactionRef,
        amountPaise: paise(b.amount),
        reason: b.reason,
      });
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.post(
    '/ops/recon/refunds/:refundId/processing',
    ops,
    authorize('recon.resolve', L),
    once,
    wrap(async (req, res) => {
      const b = refundDecisionSchema.parse(req.body ?? {});
      const out = await deps.refunds.decideRefund(
        principal(req),
        param(req, 'refundId'),
        expectedVersion(req),
        b,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );

  // --- reports ---------------------------------------------------------------------------------------------
  router.get(
    '/ops/recon/mis',
    ops,
    authorize('recon.upload', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await deps.reports.mis(misQuery.parse(req.query)));
    }),
  );
  router.get(
    '/ops/recon/pool-balances',
    ops,
    authorize('recon.upload', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await deps.reports.pool(poolQuery.parse(req.query)));
    }),
  );
  router.get(
    '/console/recon/transactions',
    ...console,
    authorize('recon.view', L),
    noStore,
    wrap(async (req, res) => {
      const q = txnQuery.parse(req.query);
      if (q.format === 'csv') {
        const out = await deps.reports.transactionsCsv(principal(req), q);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
        res.send(String.fromCharCode(0xfeff) + out.csv);
        return;
      }
      res.json(await deps.reports.transactions(principal(req), q));
    }),
  );
  router.get(
    '/console/recon/mis',
    ...console,
    authorize('recon.view', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await deps.reports.consoleMis(principal(req), consoleMisQuery.parse(req.query)));
    }),
  );
  router.get(
    '/console/recon/merchant-statement',
    ...console,
    authorize('recon.view', L),
    noStore,
    wrap(async (req, res) => {
      res.json(
        await deps.reports.merchantStatement(principal(req), statementQuery.parse(req.query)),
      );
    }),
  );
  router.get(
    '/console/recon/pool-balance',
    ...console,
    authorize('recon.view', L),
    noStore,
    wrap(async (req, res) => {
      res.json(
        await deps.reports.consolePool(
          principal(req),
          z.object({ date: date.optional() }).parse(req.query),
        ),
      );
    }),
  );
  router.get(
    '/console/merchants/reports',
    ...console,
    authorize('merchants.report', L),
    noStore,
    wrap(async (req, res) => {
      res.json(
        await deps.reports.merchantReport(principal(req), merchantReportQuery.parse(req.query)),
      );
    }),
  );
  return router;
}

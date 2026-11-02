import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import {
  authorize,
  memberOrConsole,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import type { SettlementService } from '../services/settlement.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const status = z.enum(['PENDING', 'APPROVAL_STAGE_1', 'APPROVED', 'FAILED'], {
  message: 'VALIDATION.FORMAT',
});
const date = z.iso.date({ message: 'VALIDATION.DATE' });

export const remarksSchema = z
  .strictObject({
    remarks: z.string({ message: 'STL.REMARKS' }).max(500, { message: 'STL.REMARKS' }),
  })
  .meta({ id: 'SettlementRemarks' });
export const payoutSchema = z
  .strictObject({
    utr: z.string({ message: 'STL.UTR_FORMAT' }).trim().max(22, { message: 'STL.UTR_FORMAT' }),
    amount: z.object({
      amount: z
        .string({ message: 'VALIDATION.AMOUNT' })
        .regex(/^\d{1,11}(\.\d{1,2})?$/, { message: 'VALIDATION.AMOUNT' }),
      currency: z.literal('INR', { message: 'VALIDATION.FORMAT' }),
    }),
  })
  .meta({ id: 'SettlementPayout' });
const amountIn = z.object({
  amount: z
    .string({ message: 'VALIDATION.AMOUNT' })
    .regex(/^\d{1,11}(\.\d{1,2})?$/, { message: 'VALIDATION.AMOUNT' }),
  currency: z.literal('INR', { message: 'VALIDATION.FORMAT' }),
});
export const planRuleSchema = z
  .strictObject({
    flatFee: amountIn,
    threshold: amountIn,
    boundary: z.enum(['INCLUSIVE', 'EXCLUSIVE'], { message: 'VALIDATION.FORMAT' }),
    basisPoints: z.number({ message: 'VALIDATION.FORMAT' }).int().min(0).max(1000),
    appliesTo: z.array(z.string().max(30)).max(10),
    effectiveFrom: date,
    remarks: z.string({ message: 'STL.REMARKS' }).max(500, { message: 'STL.REMARKS' }),
  })
  .meta({ id: 'PlatformFeeRule' });
export const listQuerySchema = z.object({
  status: status.optional(),
  institutionId: z.string().max(40).optional(),
  from: date.optional(),
  to: date.optional(),
  cursor: z.string().max(40).optional(),
});

const person = z.object({
  by: z.string(),
  at: z.string().nullable(),
  remarks: z.string().nullable(),
});
const settlement = z
  .object({
    id: z.uuid(),
    settlementNo: z.string(),
    institution: z.object({ id: z.uuid(), name: z.string(), identifier: z.string() }),
    date: z.string(),
    windowTo: z.string().nullable(),
    status,
    lines: z.number(),
    merchants: z.number(),
    gross: money,
    fee: money,
    adjustments: money.describe('Refunds and chargebacks deducted (Q14 M3)'),
    net: money.describe('Gross − fee − adjustments; may be negative'),
    recollected: z.number().describe('Lines of a rejected settlement collected again (Q14 M17)'),
    stage1: person.nullable(),
    final: person.nullable(),
    rejection: person.nullable(),
    payout: z
      .object({ utr: z.string(), amount: money, at: z.string().nullable(), by: z.string() })
      .nullable(),
    createdAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Settlement' });
const settlementDetail = settlement
  .extend({
    payableNow: money.describe(
      'Net of the merchants paid at payout (suspended ones carried forward)',
    ),
    merchantsList: z.array(
      z.object({
        id: z.uuid(),
        uniqueId: z.string().nullable(),
        name: z.string(),
        lines: z.number(),
        gross: money,
        fee: money,
        adjustments: money,
        net: money,
        suspended: z.boolean(),
        carried: z.boolean(),
        paid: z.boolean(),
      }),
    ),
    linesList: z.array(
      z.object({
        id: z.uuid(),
        reference: z.string(),
        merchantId: z.uuid(),
        type: z.string(),
        adjustment: z.boolean().describe('A refund or chargeback deducted (Q14 M3)'),
        amount: money,
        fee: money,
        net: money,
        remarks: z.string().nullable(),
        at: z.string().nullable(),
        recollected: z.boolean(),
        carried: z.boolean(),
        payoutReference: z.string().nullable(),
      }),
    ),
    statements: z.array(z.object({ fileNo: z.number(), kind: z.string(), name: z.string() })),
  })
  .meta({ id: 'SettlementDetail' });
const list = z
  .object({ items: z.array(settlement), nextCursor: z.string().nullable() })
  .meta({ id: 'Settlements' });
const link = z
  .object({ name: z.string(), url: z.string(), expiresAt: z.string() })
  .meta({ id: 'SettlementStatementLink' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Settlement'] });
doc({
  id: 'STL-001',
  method: 'get',
  path: '/api/v1/ops/settlements',
  summary: 'Settlement queue across institutions, newest first',
  auth: 'settle.view',
  query: listQuerySchema,
  responses: { 200: { description: 'Settlements', schema: list } },
});
doc({
  id: 'STL-002',
  method: 'get',
  path: '/api/v1/ops/settlements/{settlementId}',
  summary:
    'A settlement with its merchants (gross, fee, net, suspended, carried), lines, approvals, payout and statements (ETag)',
  auth: 'settle.view',
  responses: { 200: { description: 'Settlement', schema: settlementDetail } },
});
doc({
  id: 'STL-003',
  method: 'post',
  path: '/api/v1/ops/settlements/{settlementId}/stage1-approval',
  summary: 'Stage-1 approval by the maker, with remarks (3–500); If-Match',
  auth: 'settle.stage1',
  request: remarksSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Stage-1 approved', schema: settlementDetail } },
});
doc({
  id: 'STL-004',
  method: 'post',
  path: '/api/v1/ops/settlements/{settlementId}/final-approval',
  summary: 'Final approval by a checker other than the stage-1 maker, with remarks; If-Match',
  auth: 'settle.final',
  request: remarksSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Approved', schema: settlementDetail } },
});
doc({
  id: 'STL-005',
  method: 'post',
  path: '/api/v1/ops/settlements/{settlementId}/rejection',
  summary:
    'Reject from Pending or Stage-1 approved, with remarks, by someone who approved neither; its lines go to the next run once (Q14 M17); If-Match',
  auth: 'settle.reject',
  request: remarksSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Rejected', schema: settlementDetail } },
});
doc({
  id: 'STL-006',
  method: 'post',
  path: '/api/v1/ops/settlements/{settlementId}/payout',
  summary:
    'Record the bank payout (UTR 16–22 characters, write-once, the net payable now) on an approved settlement: each merchant’s wallet is debited — the net to the payout clearing, the fee to the platform fee account (ledger); a merchant suspended by now is carried forward (Q14 M4)',
  auth: 'settle.payout',
  request: payoutSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Paid out', schema: settlementDetail } },
});
doc({
  id: 'STL-007',
  method: 'get',
  path: '/api/v1/ops/settlements/{settlementId}/statements/{fileNo}',
  summary:
    'A statement file (1 transactions, 2 merchant summary, 3 summary report, 4 settlement report) as a signed link',
  auth: 'settle.view',
  responses: { 200: { description: 'Link', schema: link } },
});
doc({
  id: 'STL-008',
  method: 'get',
  path: '/api/v1/ops/platform-fee-rules',
  summary:
    'Platform fee rules: flat up to the threshold, a percentage above; tuition per stl.fee.chargeTuition (Q14 M1/M2); per plan',
  auth: 'plans.edit',
  responses: { 200: { description: 'Rules' } },
});
doc({
  id: 'STL-009',
  method: 'put',
  path: '/api/v1/ops/platform-fee-rules/{planId}',
  summary:
    'A new version of a plan’s fee rule: flat fee up to the threshold (inclusive or exclusive, OQ-06), basis points above, the collections it applies to, effective from tomorrow or later; versions are kept; If-Match (the plan’s latest version, "v0" for the first)',
  auth: 'plans.edit',
  request: planRuleSchema,
  responses: { 200: { description: 'The plan’s rules' } },
});
doc({
  id: 'STL-010',
  method: 'get',
  path: '/api/v1/console/settlements',
  summary: 'The institution’s settlements (read-only)',
  auth: 'settlements.view',
  query: listQuerySchema.omit({ institutionId: true }),
  responses: { 200: { description: 'Settlements', schema: list } },
});
doc({
  id: 'STL-011',
  method: 'get',
  path: '/api/v1/console/settlements/{settlementId}',
  summary: 'An institution settlement with its merchants, lines and statements',
  auth: 'settlements.view',
  responses: { 200: { description: 'Settlement', schema: settlementDetail } },
});
doc({
  id: 'STL-014',
  method: 'get',
  path: '/api/v1/console/settlements/{settlementId}/statements/{fileNo}',
  summary: 'A statement file of the institution’s settlement as a signed link',
  auth: 'settlements.view',
  responses: { 200: { description: 'Link', schema: link } },
});
doc({
  id: 'STL-012',
  method: 'get',
  path: '/api/v1/merchant/settlements',
  summary:
    'My settlements: date, status as the merchant statement shows it, gross, fee, net, paid out with UTR, carried forward',
  auth: 'member|business.view',
  responses: { 200: { description: 'Settlements' } },
});
doc({
  id: 'STL-013',
  method: 'get',
  path: '/api/v1/merchant/settlements/{settlementId}',
  summary: 'My lines of a settlement with their transactions',
  auth: 'member|business.view',
  responses: { 200: { description: 'Settlement' } },
});

/** Mounted under /api/v1. */
export function settlementRoutes(deps: {
  db: Kysely<Database>;
  settlement: SettlementService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  // The app's member, or the web console with one of the sub-tasks (merchants and vendor merchants; client 2026-10-13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, L);
  const S = deps.settlement;
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
  // The settlement first (another institution's is a 404); an unknown file number is a 404 too.
  const fileNo = (req: Request) => Number(req.params['fileNo']);
  const ops = requireSurface(L, 'ops');
  const console = [requireSurface(L, 'console'), requireTenant(L)];

  router.get(
    '/ops/settlements',
    ops,
    authorize('settle.view', L),
    wrap(async (req, res) => {
      res.json(await S.list(listQuerySchema.parse(req.query)));
    }),
  );
  router.get(
    '/ops/platform-fee-rules',
    ops,
    authorize('plans.edit', L),
    wrap(async (_req, res) => {
      res.json(await S.feeRules());
    }),
  );
  router.put(
    '/ops/platform-fee-rules/:planId',
    ops,
    authorize('plans.edit', L),
    wrap(async (req, res) => {
      const b = planRuleSchema.parse(req.body ?? {});
      let flatPaise: number;
      let thresholdPaise: number;
      try {
        flatPaise = parseAmount(b.flatFee.amount, { allowZero: true });
        thresholdPaise = parseAmount(b.threshold.amount, { allowZero: true });
      } catch (e) {
        if (e instanceof MoneyError) {
          throw new ValidationError([{ field: 'flatFee', code: 'VALIDATION.AMOUNT' }]);
        }
        throw e;
      }
      const out = await S.setPlanRule(principal(req), param(req, 'planId'), expectedVersion(req), {
        flatPaise,
        thresholdPaise,
        boundary: b.boundary,
        basisPoints: b.basisPoints,
        appliesTo: b.appliesTo,
        effectiveFrom: b.effectiveFrom,
        remarks: b.remarks,
      });
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/ops/settlements/:settlementId',
    ops,
    authorize('settle.view', L),
    wrap(async (req, res) => {
      const out = await S.detail(param(req, 'settlementId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/ops/settlements/:settlementId/statements/:fileNo',
    ops,
    authorize('settle.view', L),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await S.statement(param(req, 'settlementId'), fileNo(req)));
    }),
  );
  const decision = (step: 'stage1' | 'final' | 'reject'): RequestHandler =>
    wrap(async (req, res) => {
      const b = remarksSchema.parse(req.body ?? {});
      const out = await S[step](
        principal(req),
        param(req, 'settlementId'),
        expectedVersion(req),
        b,
      );
      setEtag(res, out.version);
      res.json(out);
    });
  router.post(
    '/ops/settlements/:settlementId/stage1-approval',
    ops,
    authorize('settle.stage1', L),
    once,
    decision('stage1'),
  );
  router.post(
    '/ops/settlements/:settlementId/final-approval',
    ops,
    authorize('settle.final', L),
    once,
    decision('final'),
  );
  router.post(
    '/ops/settlements/:settlementId/rejection',
    ops,
    authorize('settle.reject', L),
    once,
    decision('reject'),
  );
  router.post(
    '/ops/settlements/:settlementId/payout',
    ops,
    authorize('settle.payout', L),
    once,
    wrap(async (req, res) => {
      const b = payoutSchema.parse(req.body ?? {});
      let amountPaise: number;
      try {
        // An approved settlement with nothing payable (every merchant carried) records ₹0.00.
        amountPaise = parseAmount(b.amount.amount, { allowZero: true });
      } catch (e) {
        if (e instanceof MoneyError) {
          throw new ValidationError([{ field: 'amount', code: 'VALIDATION.AMOUNT' }]);
        }
        throw e;
      }
      const out = await S.payout(principal(req), param(req, 'settlementId'), {
        utr: b.utr,
        amountPaise,
      });
      setEtag(res, out.version);
      res.json(out);
    }),
  );

  router.get(
    '/console/settlements',
    ...console,
    authorize('settlements.view', L),
    wrap(async (req, res) => {
      res.json(
        await S.consoleList(
          principal(req),
          listQuerySchema.omit({ institutionId: true }).parse(req.query),
        ),
      );
    }),
  );
  router.get(
    '/console/settlements/:settlementId',
    ...console,
    authorize('settlements.view', L),
    wrap(async (req, res) => {
      const out = await S.consoleDetail(principal(req), param(req, 'settlementId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/settlements/:settlementId/statements/:fileNo',
    ...console,
    authorize('settlements.view', L),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await S.consoleStatement(principal(req), param(req, 'settlementId'), fileNo(req)));
    }),
  );

  router.get(
    '/merchant/settlements',
    either('business.view'),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await S.merchantList(principal(req)));
    }),
  );
  router.get(
    '/merchant/settlements/:settlementId',
    either('business.view'),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await S.merchantDetail(principal(req), param(req, 'settlementId')));
    }),
  );
  return router;
}

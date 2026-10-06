import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { AllowancesService } from '../services/allowances.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const moneyIn = z.object({
  amount: z
    .string({ message: 'VALIDATION.AMOUNT' })
    .regex(/^\d{1,9}(\.\d{1,2})?$/, { message: 'VALIDATION.AMOUNT' }),
  currency: z.literal('INR', { message: 'VALIDATION.FORMAT' }),
});
const date = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'VALIDATION.DATE' });
const state = z.enum(['SCHEDULED', 'ACTIVE', 'EXPIRED', 'CANCELLED'], {
  message: 'VALIDATION.FORMAT',
});
const dailyLimitsIn = z.strictObject({
  count: z
    .number({ message: 'VALIDATION.FORMAT' })
    .int({ message: 'VALIDATION.FORMAT' })
    .min(1, { message: 'VALIDATION.FORMAT' })
    .max(1000, { message: 'VALIDATION.FORMAT' }),
  amount: moneyIn,
});

export const issueSchema = z
  .strictObject({
    studentIds: z
      .array(z.string().trim().max(40), { message: 'VALIDATION.REQUIRED' })
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(2000, { message: 'VALIDATION.FORMAT' }),
    name: z
      .string()
      .trim()
      .max(40, { message: 'VALIDATION.FORMAT' })
      .regex(/^[A-Za-z0-9 ]*$/, { message: 'VALIDATION.FORMAT' })
      .nullish(),
    amount: moneyIn,
    startDate: date,
    expiryDate: date,
    dailyLimits: dailyLimitsIn.nullish(),
  })
  .meta({ id: 'AllowanceIssueInput' });
export const patchSchema = z
  .strictObject({
    dailyLimits: dailyLimitsIn.nullable().optional(),
    status: z.literal('INACTIVE', { message: 'VALIDATION.FORMAT' }).optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .meta({ id: 'AllowancePatch' });

const limitsOut = z
  .object({ count: z.number().int().nullable(), amount: money.nullable() })
  .nullable();
const grant = z
  .object({
    id: z.uuid(),
    student: z.object({
      id: z.uuid(),
      name: z.string(),
      grade: z.string().nullable(),
      admissionNo: z.string().nullable(),
    }),
    name: z.string().nullable(),
    amount: money,
    startDate: z.string(),
    expiryDate: z.string(),
    dailyLimits: limitsOut,
    status: z.enum(['ACTIVE', 'INACTIVE']),
    state,
    walletNo: z.string(),
    walletStatus: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
    balance: money.nullable(),
    spent: money,
    today: z.object({ spent: money, count: z.number().int() }),
    issuedBy: z.object({ name: z.string() }).nullable(),
    issuedAt: z.string(),
    expired: money.nullable(),
    creditedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    cancelReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'AllowanceGrant' });
const listOut = z
  .object({
    items: z.array(grant),
    kpis: z.object({
      active: z.number().int(),
      scheduled: z.number().int(),
      issuedThisYear: money,
      balanceHeld: money,
    }),
    defaults: z.object({ dailyCount: z.number().int(), dailyAmount: money }),
  })
  .meta({ id: 'Allowances' });
const issued = z
  .object({
    created: z.array(z.object({ studentId: z.string(), grantId: z.uuid(), name: z.string() })),
    duplicates: z.array(z.object({ studentId: z.string(), name: z.string() })),
    refused: z.array(z.object({ studentId: z.string(), code: z.string() })),
  })
  .meta({ id: 'AllowancesIssued' });
const reports = z
  .object({
    from: z.string(),
    to: z.string(),
    kpis: z.object({ issued: money, spent: money, expired: money, scheduled: money }),
    byDay: z.array(z.object({ date: z.string(), spent: money })),
    byMerchant: z.array(z.object({ merchant: z.string(), spent: money })),
    byClass: z.array(z.object({ class: z.string(), issued: money, spent: money })),
    perStudent: z.array(
      z.object({
        student: z.object({ id: z.uuid(), name: z.string(), grade: z.string().nullable() }),
        issued: money,
        spent: money,
        balance: money,
        expired: money,
      }),
    ),
  })
  .meta({ id: 'AllowanceReports' });
const mine = z
  .object({
    profile: z.object({ id: z.uuid(), name: z.string() }),
    wallet: z
      .object({
        walletNo: z.string(),
        status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
        balance: money,
      })
      .nullable(),
    grant: z
      .object({
        id: z.uuid(),
        name: z.string().nullable(),
        amount: money,
        startDate: z.string(),
        expiryDate: z.string(),
        state,
        creditedAt: z.string().nullable(),
      })
      .nullable(),
    limits: limitsOut,
    today: z.object({
      count: z.number().int(),
      spent: money,
      countLeft: z.number().int().nullable(),
      amountLeft: money.nullable(),
    }),
    periodSpent: money,
    merchants: z.array(z.object({ id: z.uuid(), name: z.string() })),
    history: z.array(
      z.object({
        kind: z.enum(['CREDIT', 'PAYMENT', 'EXPIRY']),
        reference: z.string(),
        title: z.string(),
        amount: money,
        direction: z.enum(['IN', 'OUT']),
        at: z.string(),
      }),
    ),
  })
  .meta({ id: 'MyAllowance' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Allowances'] });
doc({
  id: 'ALW-001',
  method: 'get',
  path: '/api/v1/me/allowance',
  summary:
    "My allowance (or a child's with `for`): balance, the grant, daily limits, today's spend and count, where it can be spent, history",
  auth: 'member',
  responses: { 200: { description: 'Allowance', schema: mine } },
});
doc({
  id: 'ALW-002',
  method: 'get',
  path: '/api/v1/console/allowances',
  summary:
    'Allowance grants: student, amount, period, daily limits, balance, spent, state (scheduled, active, expired, cancelled)',
  auth: 'allowances.view',
  responses: { 200: { description: 'Grants', schema: listOut } },
});
doc({
  id: 'ALW-003',
  method: 'post',
  path: '/api/v1/console/allowances',
  summary:
    'Issue allowances to active students: start on the 1st of a coming month, expiry after it, optional daily limits; one allowance per student at a time (BR-40); per-student results',
  auth: 'allowances.issue',
  request: issueSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Results', schema: issued } },
});
doc({
  id: 'ALW-004',
  method: 'patch',
  path: '/api/v1/console/allowances/{grantId}',
  summary: 'Change the daily limits, or cancel an allowance not yet credited (If-Match)',
  auth: 'allowances.issue',
  request: patchSchema,
  responses: { 200: { description: 'Grant', schema: grant } },
});
doc({
  id: 'ALW-005',
  method: 'get',
  path: '/api/v1/console/allowances/reports',
  summary:
    'Issued, spent and expired: totals, spend by day and merchant, by class and per student (from, to)',
  auth: 'allowances.view',
  responses: { 200: { description: 'Reports', schema: reports } },
});

const paise = (field: string, v: { amount: string }) => {
  try {
    return parseAmount(v.amount);
  } catch (e) {
    if (e instanceof MoneyError) throw new ValidationError([{ field, code: 'VALIDATION.AMOUNT' }]);
    throw e;
  }
};
const limitsIn = (v: z.infer<typeof dailyLimitsIn> | null | undefined) =>
  v === undefined
    ? undefined
    : v === null
      ? null
      : { count: v.count, amountPaise: paise('dailyLimits.amount', v.amount) };

/** Mounted under /api/v1. */
export function allowancesRoutes(deps: {
  db: Kysely<Database>;
  allowances: AllowancesService;
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
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;

  router.get(
    '/me/allowance',
    requireSurface(L, 'member'),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.allowances.mine(principal(req), q(req, 'for')));
    }),
  );
  router.get(
    '/console/allowances',
    ...console,
    authorize('allowances.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.allowances.list(principal(req), {
          state: state.optional().parse(q(req, 'state')),
          classId: q(req, 'classId'),
          q: q(req, 'q'),
        }),
      );
    }),
  );
  router.get(
    '/console/allowances/reports',
    ...console,
    authorize('allowances.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.allowances.reports(principal(req), {
          from: date.optional().parse(q(req, 'from')),
          to: date.optional().parse(q(req, 'to')),
        }),
      );
    }),
  );
  router.post(
    '/console/allowances',
    ...console,
    authorize('allowances.issue', L),
    once,
    wrap(async (req, res) => {
      const body = issueSchema.parse(req.body ?? {});
      res.status(201).json(
        await deps.allowances.issue(principal(req), {
          studentIds: body.studentIds,
          name: body.name,
          amountPaise: paise('amount', body.amount),
          startDate: body.startDate,
          expiryDate: body.expiryDate,
          dailyLimits: limitsIn(body.dailyLimits),
        }),
      );
    }),
  );
  router.patch(
    '/console/allowances/:grantId',
    ...console,
    authorize('allowances.issue', L),
    wrap(async (req, res) => {
      const body = patchSchema.parse(req.body ?? {});
      const out = await deps.allowances.update(
        principal(req),
        String(req.params['grantId']),
        expectedVersion(req),
        {
          dailyLimits: limitsIn(body.dailyLimits),
          status: body.status,
          reason: body.reason,
        },
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  return router;
}

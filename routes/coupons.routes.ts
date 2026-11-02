import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import type { CouponsService } from '../services/coupons.service';
import type { TerminalsService } from '../services/terminals.service';
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
const time = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'VALIDATION.FORMAT' });
const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const ids = (max: number) =>
  z
    .array(z.string().trim().max(40), { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const count = z
  .number({ message: 'VALIDATION.FORMAT' })
  .int({ message: 'VALIDATION.FORMAT' })
  .min(1, { message: 'VALIDATION.FORMAT' })
  .max(1000, { message: 'VALIDATION.FORMAT' });
const kind = z.enum(['MEAL', 'NUTRITION', 'EVENT', 'OTHER'], { message: 'VALIDATION.FORMAT' });
const period = z.enum(['DAY', 'WEEK', 'MONTH'], { message: 'VALIDATION.FORMAT' });
const window = z.object({ start: time, end: time });

export const typeInputSchema = z
  .strictObject({
    name: text(40),
    kind,
    description: z.string().trim().max(200).nullish(),
    slotId: z.string().trim().max(40).nullish(),
    window: window.nullish(),
    value: moneyIn.optional(),
    holdMax: count,
    redeemMax: count,
    period: period.optional(),
    merchantIds: ids(200).nullish().describe('Empty or absent: every regular merchant'),
    issueFrom: date.nullish(),
    issueTo: date.nullish(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'CouponTypeInput' });
export const typePatchSchema = typeInputSchema.partial().meta({ id: 'CouponTypePatch' });
export const slotsSchema = z
  .strictObject({
    slots: z
      .array(
        z.strictObject({
          id: z.string().trim().max(40).optional(),
          name: text(40),
          start: time,
          end: time,
        }),
      )
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(20, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'CouponSlotsInput' });
export const issueSchema = z
  .strictObject({
    typeIds: ids(20).min(1, { message: 'VALIDATION.REQUIRED' }),
    from: date,
    to: date,
    excludedDates: z.array(date).max(400).optional(),
    studentIds: ids(5000).min(1, { message: 'VALIDATION.REQUIRED' }),
  })
  .meta({ id: 'CouponIssueInput' });
export const cancelSchema = z
  .strictObject({
    studentIds: ids(5000).min(1, { message: 'VALIDATION.REQUIRED' }),
    from: date,
    to: date,
    typeIds: ids(20).optional(),
    reason: text(200),
  })
  .meta({ id: 'CouponCancelInput' });
export const redeemSchema = z
  .strictObject({ merchantQrPayload: text(200), couponTypeId: text(40) })
  .meta({ id: 'CouponRedeemInput' });
export const tapSchema = z
  .strictObject({ cardToken: text(128), tapId: text(64) })
  .meta({ id: 'CouponTapInput' });
export const tapRedeemSchema = z
  .strictObject({ tapId: text(64), couponTypeId: text(40) })
  .meta({ id: 'CouponTapRedeemInput' });

const typeOut = z
  .object({
    id: z.uuid(),
    name: z.string(),
    kind,
    description: z.string().nullable(),
    slot: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    window: z.object({ start: z.string(), end: z.string() }),
    value: money,
    holdMax: z.number().int(),
    redeemMax: z.number().int(),
    period,
    acceptsAll: z.boolean(),
    merchants: z.array(z.object({ id: z.uuid(), name: z.string() })),
    issueFrom: z.string().nullable(),
    issueTo: z.string().nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    version: z.number().int(),
  })
  .meta({ id: 'CouponType' });
const couponOut = z
  .object({
    id: z.uuid(),
    student: z.object({ id: z.uuid(), name: z.string() }),
    type: z.object({ id: z.uuid(), name: z.string(), kind }),
    validOn: z.string(),
    window: z.object({ start: z.string(), end: z.string() }),
    status: z.enum(['ACTIVE', 'USED', 'EXPIRED']),
    state: z.enum(['ACTIVE', 'USED', 'EXPIRED', 'CANCELLED']),
    usedAt: z.string().nullable(),
    merchant: z.string().nullable(),
    endedAt: z.string().nullable(),
    cancelReason: z.string().nullable(),
  })
  .meta({ id: 'Coupon' });
const redemptionOut = z
  .object({
    id: z.uuid(),
    coupon: z.object({ id: z.uuid(), type: z.string() }),
    merchant: z.object({ id: z.uuid(), name: z.string() }),
    holder: z.object({ id: z.uuid(), name: z.string() }),
    redeemedAt: z.string(),
  })
  .meta({ id: 'CouponRedemption' });
const tally = {
  issued: z.number().int(),
  used: z.number().int(),
  expired: z.number().int(),
  active: z.number().int(),
};

const doc = (tags: string[]) => (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags });
const cpn = doc(['Coupons']);
cpn({
  id: 'CPN-001',
  method: 'get',
  path: '/api/v1/me/coupons',
  summary:
    "My coupons (or a child's with `for`): today's with whether each can be used now, upcoming, history, the school's coupon types",
  auth: 'member',
  responses: {
    200: {
      description: 'Coupons',
      schema: z
        .object({
          date: z.string(),
          time: z.string(),
          today: z.array(couponOut.extend({ usableNow: z.boolean() })),
          upcoming: z.array(couponOut),
          history: z.array(couponOut),
          types: z.array(typeOut),
        })
        .meta({ id: 'MyCoupons' }),
    },
  },
});
cpn({
  id: 'CPN-002',
  method: 'post',
  path: '/api/v1/me/coupons/redemptions',
  summary:
    "Redeem my coupon of a type by scanning a merchant's coupon QR: today, inside the window, at a regular merchant the type accepts, within the type's maximum",
  auth: 'member',
  request: redeemSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Redeemed', schema: redemptionOut } },
});
cpn({
  id: 'CPN-003',
  method: 'get',
  path: '/api/v1/console/coupon-types',
  summary:
    'Coupon types: slot or window, value, holding and redemption maxima, accepting merchants, issue dates, status (the four meal types are created the first time)',
  auth: 'coupons.view',
  responses: {
    200: {
      description: 'Types',
      schema: z.object({ items: z.array(typeOut) }).meta({ id: 'CouponTypes' }),
    },
  },
});
cpn({
  id: 'CPN-004',
  method: 'post',
  path: '/api/v1/console/coupon-types',
  summary: 'Define a coupon type (name unique; a value above ₹0 only when cpn.valueTypes.enabled)',
  auth: 'coupons.edit',
  request: typeInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created', schema: typeOut } },
});
cpn({
  id: 'CPN-005',
  method: 'patch',
  path: '/api/v1/console/coupon-types/{typeId}',
  summary: 'Amend or deactivate a type; issued coupons keep their terms (If-Match)',
  auth: 'coupons.edit',
  request: typePatchSchema,
  responses: { 200: { description: 'Type', schema: typeOut } },
});
const slotsOut = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        start: z.string(),
        end: z.string(),
        types: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'CouponSlots' });
cpn({
  id: 'CPN-006',
  method: 'get',
  path: '/api/v1/console/coupon-slots',
  summary: "The institution's meal slots (one master; meal types point at a slot)",
  auth: 'coupons.view',
  responses: { 200: { description: 'Slots', schema: slotsOut } },
});
cpn({
  id: 'CPN-007',
  method: 'put',
  path: '/api/v1/console/coupon-slots',
  summary: 'Set the slots (a slot a type uses cannot be removed)',
  auth: 'coupons.edit',
  request: slotsSchema,
  responses: { 200: { description: 'Slots', schema: slotsOut } },
});
cpn({
  id: 'CPN-008',
  method: 'post',
  path: '/api/v1/console/coupon-issuances',
  summary:
    'Issue coupons: types × days of the range less excluded days × active students; duplicates skipped; a student over a holding maximum refused; more than cpn.issue.maxPerStudent new coupons for anyone refuses all',
  auth: 'coupons.issue',
  request: issueSchema,
  idempotent: 'required',
  responses: {
    201: {
      description: 'Issued',
      schema: z
        .object({
          issuanceId: z.uuid(),
          created: z.number().int(),
          skipped: z.number().int(),
          perStudent: z.array(
            z.object({
              studentId: z.string(),
              name: z.string(),
              created: z.number().int(),
              skipped: z.number().int(),
              refused: z.string().nullable(),
            }),
          ),
        })
        .meta({ id: 'CouponIssuance' }),
    },
  },
});
cpn({
  id: 'CPN-009',
  method: 'get',
  path: '/api/v1/console/coupon-issuances',
  summary: 'The issuance log',
  auth: 'coupons.view',
  responses: { 200: { description: 'Issuances' } },
});
cpn({
  id: 'CPN-010',
  method: 'get',
  path: '/api/v1/console/coupons',
  summary: 'Issued coupons by student, type, date and state (keyset cursor)',
  auth: 'coupons.view',
  responses: {
    200: {
      description: 'Coupons',
      schema: z
        .object({ items: z.array(couponOut), nextCursor: z.string().nullable() })
        .meta({ id: 'Coupons' }),
    },
  },
});
cpn({
  id: 'CPN-011',
  method: 'get',
  path: '/api/v1/console/coupons/reports',
  summary: 'Issued, used, expired and active by day, type, merchant and student (from, to)',
  auth: 'coupons.view',
  responses: {
    200: {
      description: 'Reports',
      schema: z
        .object({
          from: z.string(),
          to: z.string(),
          kpis: z.object({ ...tally, cancelled: z.number().int() }),
          byDay: z.array(z.object({ date: z.string(), ...tally })),
          byType: z.array(z.object({ type: z.string(), ...tally })),
          byMerchant: z.array(z.object({ merchant: z.string(), used: z.number().int() })),
          perStudent: z.array(
            z.object({ student: z.object({ id: z.uuid(), name: z.string() }), ...tally }),
          ),
        })
        .meta({ id: 'CouponReports' }),
    },
  },
});
cpn({
  id: 'CPN-012',
  method: 'post',
  path: '/api/v1/console/coupons/cancellations',
  summary:
    "Cancel students' future coupons in a date range (optionally of some types), with a reason",
  auth: 'coupons.issue',
  request: cancelSchema,
  idempotent: 'required',
  responses: {
    200: {
      description: 'Cancelled',
      schema: z.object({ cancelled: z.number().int() }).meta({ id: 'CouponsCancelled' }),
    },
  },
});
cpn({
  id: 'CPN-013',
  method: 'post',
  path: '/api/v1/terminal/reader/coupon-taps',
  summary:
    "Coupon counter tap: the card's holder (masked) and the types they can use now at this counter, to choose within cpn.tap.chooseSeconds",
  auth: 'terminal: coupon',
  request: tapSchema,
  idempotent: 'required',
  responses: {
    200: {
      description: 'Eligible types',
      schema: z
        .object({
          holder: z.object({
            maskedName: z.string(),
            classSection: z.string().nullable(),
            admissionNo: z.string().nullable(),
          }),
          eligibleTypes: z.array(
            z.object({
              id: z.uuid(),
              name: z.string(),
              window: z.object({ start: z.string(), end: z.string() }),
            }),
          ),
          chooseWithinSec: z.number().int(),
        })
        .meta({ id: 'CouponTap' }),
    },
  },
});
cpn({
  id: 'CPN-014',
  method: 'post',
  path: '/api/v1/terminal/reader/coupon-redemptions',
  summary: 'Redeem the chosen type for a tap, before it lapses; a repeat answers the first',
  auth: 'terminal: coupon',
  request: tapRedeemSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Redeemed', schema: redemptionOut } },
});

const paise = (field: string, v: { amount: string } | undefined) => {
  if (!v) return undefined;
  try {
    return v.amount.match(/^0+(\.0+)?$/) ? 0 : parseAmount(v.amount);
  } catch (e) {
    if (e instanceof MoneyError) throw new ValidationError([{ field, code: 'VALIDATION.AMOUNT' }]);
    throw e;
  }
};
const typeIn = (b: z.infer<typeof typePatchSchema>) => ({
  ...(b.name !== undefined ? { name: b.name } : {}),
  ...(b.kind !== undefined ? { kind: b.kind } : {}),
  ...(b.description !== undefined ? { description: b.description } : {}),
  ...(b.slotId !== undefined ? { slotId: b.slotId } : {}),
  ...(b.window !== undefined ? { window: b.window } : {}),
  ...(b.value !== undefined ? { valuePaise: paise('value', b.value) } : {}),
  ...(b.holdMax !== undefined ? { holdMax: b.holdMax } : {}),
  ...(b.redeemMax !== undefined ? { redeemMax: b.redeemMax } : {}),
  ...(b.period !== undefined ? { period: b.period } : {}),
  ...(b.merchantIds !== undefined ? { merchantIds: b.merchantIds ?? [] } : {}),
  ...(b.issueFrom !== undefined ? { issueFrom: b.issueFrom } : {}),
  ...(b.issueTo !== undefined ? { issueTo: b.issueTo } : {}),
  ...(b.active !== undefined ? { active: b.active } : {}),
});

/** Mounted under /api/v1. */
export function couponsRoutes(deps: {
  db: Kysely<Database>;
  coupons: CouponsService;
  terminals: TerminalsService;
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
  const member = requireSurface(L, 'member');
  const terminal = requireSurface(L, 'terminal');
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;

  // --- member -----------------------------------------------------------------------------------
  router.get(
    '/me/coupons',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.coupons.mine(principal(req), q(req, 'for')));
    }),
  );
  router.post(
    '/me/coupons/redemptions',
    member,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.coupons.redeemQr(principal(req), redeemSchema.parse(req.body ?? {})));
    }),
  );

  // --- console: types and slots ---------------------------------------------------------------------
  router.get(
    '/console/coupon-types',
    ...console,
    authorize('coupons.view', L),
    wrap(async (req, res) => {
      res.json(await deps.coupons.types(principal(req)));
    }),
  );
  router.post(
    '/console/coupon-types',
    ...console,
    authorize('coupons.edit', L),
    once,
    wrap(async (req, res) => {
      const b = typeInputSchema.parse(req.body ?? {});
      res.status(201).json(
        await deps.coupons.createType(principal(req), {
          ...typeIn(b),
          name: b.name,
          kind: b.kind,
          holdMax: b.holdMax,
          redeemMax: b.redeemMax,
        }),
      );
    }),
  );
  router.patch(
    '/console/coupon-types/:typeId',
    ...console,
    authorize('coupons.edit', L),
    wrap(async (req, res) => {
      const out = await deps.coupons.updateType(
        principal(req),
        String(req.params['typeId']),
        expectedVersion(req),
        typeIn(typePatchSchema.parse(req.body ?? {})),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/coupon-slots',
    ...console,
    authorize('coupons.view', L),
    wrap(async (req, res) => {
      res.json(await deps.coupons.slots(principal(req)));
    }),
  );
  router.put(
    '/console/coupon-slots',
    ...console,
    authorize('coupons.edit', L),
    wrap(async (req, res) => {
      res.json(await deps.coupons.setSlots(principal(req), slotsSchema.parse(req.body ?? {})));
    }),
  );

  // --- console: issuing and records -----------------------------------------------------------------
  router.post(
    '/console/coupon-issuances',
    ...console,
    authorize('coupons.issue', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.coupons.issue(principal(req), issueSchema.parse(req.body ?? {})));
    }),
  );
  router.get(
    '/console/coupon-issuances',
    ...console,
    authorize('coupons.view', L),
    wrap(async (req, res) => {
      res.json(await deps.coupons.issuances(principal(req)));
    }),
  );
  router.get(
    '/console/coupons/reports',
    ...console,
    authorize('coupons.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.coupons.reports(principal(req), {
          from: date.optional().parse(q(req, 'from')),
          to: date.optional().parse(q(req, 'to')),
        }),
      );
    }),
  );
  router.get(
    '/console/coupons',
    ...console,
    authorize('coupons.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.coupons.coupons(principal(req), {
          studentId: q(req, 'studentId'),
          typeId: q(req, 'typeId'),
          date: date.optional().parse(q(req, 'date')),
          from: date.optional().parse(q(req, 'from')),
          to: date.optional().parse(q(req, 'to')),
          state: z
            .enum(['ACTIVE', 'USED', 'EXPIRED', 'CANCELLED'], { message: 'VALIDATION.FORMAT' })
            .optional()
            .parse(q(req, 'state')),
          cursor: q(req, 'cursor'),
        }),
      );
    }),
  );
  router.post(
    '/console/coupons/cancellations',
    ...console,
    authorize('coupons.issue', L),
    once,
    wrap(async (req, res) => {
      res.json(await deps.coupons.cancel(principal(req), cancelSchema.parse(req.body ?? {})));
    }),
  );

  // --- terminal: coupon counter (21.20.1) ------------------------------------------------------------
  router.post(
    '/terminal/reader/coupon-taps',
    terminal,
    once,
    wrap(async (req, res) => {
      const t = await deps.terminals.caller(req, ['COUPON']);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.coupons.tap(t, tapSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/terminal/reader/coupon-redemptions',
    terminal,
    once,
    wrap(async (req, res) => {
      const t = await deps.terminals.caller(req, ['COUPON']);
      res.status(201).json(await deps.coupons.tapRedeem(t, tapRedeemSchema.parse(req.body ?? {})));
    }),
  );
  return router;
}

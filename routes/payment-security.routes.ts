import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { challengeSchema } from '../schemas/member-auth.schema';
import type { PaymentSecurityService } from '../services/payment-security.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';
import { PATTERNS } from '../utils/validators';

const pin = z
  .string({ message: 'IDN.TPIN_FORMAT' })
  .regex(PATTERNS.tpin, { message: 'IDN.TPIN_FORMAT' });
const money = z.object({ amount: z.string(), currency: z.literal('INR') });

export const setPinSchema = z.strictObject({ pin }).meta({ id: 'TpinSet' });
export const tpinResetStartSchema = challengeSchema
  .extend({
    question: z
      .object({ code: z.string(), labelKey: z.string(), text: z.string() })
      .nullable()
      .describe('The security question to answer with the code'),
  })
  .meta({ id: 'TpinResetStart' });
export const changePinSchema = z
  .strictObject({ currentPin: pin, newPin: pin })
  .meta({ id: 'TpinChange' });
export const resetPinSchema = z
  .strictObject({
    securityAnswer: z.string({ message: 'VALIDATION.REQUIRED' }).min(1).max(100),
    challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }),
    otp: z.string({ message: 'VALIDATION.REQUIRED' }).regex(/^\d{4,8}$/, {
      message: 'AUTH.OTP_INVALID',
    }),
    newPin: pin,
  })
  .meta({ id: 'TpinReset' });
export const capSchema = z
  .strictObject({
    enabled: z.boolean({ message: 'VALIDATION.REQUIRED' }),
    amount: z.string().max(14).optional().describe('Rupees, e.g. "500.00"'),
    count: z.number().int().optional(),
  })
  .meta({ id: 'SpendingCapInput' });
const capResult = z
  .object({
    enabled: z.boolean(),
    amount: money.nullable(),
    count: z.number().nullable(),
    version: z.number(),
  })
  .meta({ id: 'SpendingCap' });
export const paymentSecuritySchema = z
  .object({
    tpin: z.object({ set: z.boolean(), lockedUntil: z.string().nullable() }),
    cap: capResult,
  })
  .meta({ id: 'PaymentSecurity' });
export const permissionSchema = z
  .strictObject({
    enabled: z.boolean({ message: 'VALIDATION.REQUIRED' }),
    reason: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(300),
  })
  .meta({ id: 'TransactionPermissionInput' });
const permissionResult = z
  .object({ enabled: z.boolean(), reason: z.string(), changedAt: z.string(), version: z.number() })
  .meta({ id: 'TransactionPermission' });

const tags = ['Payment security'];
const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) => defineRoute({ ...d, tags });
doc({
  id: 'IDN-084',
  method: 'get',
  path: '/api/v1/me/payment-security',
  summary: 'Whether the transaction PIN is set (and locked until when) and the daily spending cap',
  auth: 'member',
  responses: { 200: { description: 'Status', schema: paymentSecuritySchema } },
});
doc({
  id: 'IDN-025',
  method: 'post',
  path: '/api/v1/me/tpin',
  summary: 'Set the 4-digit transaction PIN once (Argon2id; an easy combination is refused)',
  auth: 'member',
  request: setPinSchema,
  responses: { 201: { description: 'Set' } },
});
doc({
  id: 'IDN-026',
  method: 'put',
  path: '/api/v1/me/tpin',
  summary:
    'Change the PIN after the current one; the new PIN differs from the current and previous',
  auth: 'member',
  request: changePinSchema,
  responses: { 204: { description: 'Changed' } },
});
doc({
  id: 'IDN-085',
  method: 'post',
  path: '/api/v1/me/tpin/reset/otp',
  summary: 'Forgot PIN, step 1: a code to the account mobile',
  auth: 'member',
  responses: { 202: { description: 'Code sent', schema: tpinResetStartSchema } },
});
doc({
  id: 'IDN-027',
  method: 'post',
  path: '/api/v1/me/tpin/reset',
  summary: 'Forgot PIN, step 2: the security answer and the code, then a new PIN',
  auth: 'member',
  request: resetPinSchema,
  responses: { 204: { description: 'Reset' } },
});
doc({
  id: 'IDN-028',
  method: 'put',
  path: '/api/v1/me/spending-cap',
  summary:
    'Daily spending cap (amount and number of payments) checked by the payment engine (If-Match)',
  auth: 'member',
  request: capSchema,
  responses: { 200: { description: 'Cap', schema: capResult } },
});
doc({
  id: 'IDN-056',
  method: 'put',
  path: '/api/v1/console/members/{memberId}/transaction-permission',
  summary: "Grant or revoke a member's transaction permission with a reason (BR-13; If-Match)",
  auth: 'members.status',
  request: permissionSchema,
  responses: { 200: { description: 'Permission', schema: permissionResult } },
});

/** Mounted under /api/v1. */
export function paymentSecurityRoutes(deps: {
  service: PaymentSecurityService;
  loggers: Loggers;
  authLimiter: RequestHandler;
}): Router {
  const router = Router();
  const s = deps.service;
  const L = deps.loggers;
  const member = requireSurface(L, 'member');
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

  router.get(
    '/me/payment-security',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await s.status(principal(req)));
    }),
  );
  router.post(
    '/me/tpin',
    member,
    deps.authLimiter,
    wrap(async (req, res) => {
      await s.setPin(principal(req), setPinSchema.parse(req.body ?? {}));
      res.status(201).end();
    }),
  );
  router.put(
    '/me/tpin',
    member,
    deps.authLimiter,
    wrap(async (req, res) => {
      await s.changePin(principal(req), changePinSchema.parse(req.body ?? {}));
      res.status(204).end();
    }),
  );
  router.post(
    '/me/tpin/reset/otp',
    member,
    deps.authLimiter,
    wrap(async (req, res) => {
      const out = await s.resetStart(principal(req));
      res.status(202).json(out);
    }),
  );
  router.post(
    '/me/tpin/reset',
    member,
    deps.authLimiter,
    wrap(async (req, res) => {
      await s.reset(principal(req), resetPinSchema.parse(req.body ?? {}));
      res.status(204).end();
    }),
  );
  router.put(
    '/me/spending-cap',
    member,
    wrap(async (req, res) => {
      const body = capSchema.parse(req.body ?? {});
      let amountPaise: number | undefined;
      if (body.enabled && body.amount !== undefined) {
        try {
          amountPaise = parseAmount(body.amount);
        } catch (e) {
          if (e instanceof MoneyError) {
            throw new ValidationError([{ field: 'amount', code: 'VALIDATION.FORMAT' }]);
          }
          throw e;
        }
      }
      const out = await s.setCap(principal(req), expectedVersion(req), {
        enabled: body.enabled,
        amountPaise,
        count: body.count,
      });
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.put(
    '/console/members/:memberId/transaction-permission',
    requireSurface(L, 'console'),
    requireTenant(L),
    authorize('members.status', L),
    wrap(async (req, res) => {
      const out = await s.setPermission(
        principal(req),
        String(req.params['memberId']),
        expectedVersion(req),
        permissionSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  return router;
}

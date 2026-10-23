import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { requireSurface } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { FeeDuesService } from '../services/fee-dues.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { PATTERNS } from '../utils/validators';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const recordStatus = z.enum(['DUE', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']);

export const consentInputSchema = z
  .strictObject({
    studentProfileId: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe('The child on the account (CR-04); default the active profile'),
    templateVersion: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(20),
    accept: z.literal(true, { message: 'VALIDATION.REQUIRED' }),
  })
  .meta({ id: 'FeeConsentInput' });
export const feePaymentSchema = z
  .strictObject({
    pin: z
      .string({ message: 'IDN.TPIN_FORMAT' })
      .regex(PATTERNS.tpin, { message: 'IDN.TPIN_FORMAT' }),
  })
  .meta({ id: 'FeePaymentInput' });

const due = z
  .object({
    id: z.uuid(),
    label: z.string(),
    seq: z.number(),
    share: z
      .string()
      .nullable()
      .describe('Percent of the year’s fee, e.g. "40"; null for a manual record'),
    year: z.object({ id: z.uuid(), label: z.string() }),
    structure: z.string().nullable(),
    dueDate: z.string(),
    amount: money,
    lateFine: money,
    fine: money.describe('The late fine once applied (overdue)'),
    amountDue: money.describe('What is collected now: amount + fine − paid'),
    paid: money,
    status: recordStatus,
    financed: z.boolean(),
    pending: z
      .object({
        tries: z.number(),
        reasonCode: z.string().nullable(),
        lastTriedAt: z.string().nullable(),
      })
      .nullable()
      .describe('Waiting for a top-up: collected automatically after one'),
    paidAt: z.string().nullable(),
    receipt: z.string().nullable(),
    settlement: z.enum(['COLLECTED', 'SETTLED']).nullable(),
    settlementRef: z.string().nullable(),
  })
  .meta({ id: 'MemberFeeRecord' });
const dueDetail = due
  .extend({
    student: z.object({ id: z.uuid(), name: z.string(), classSection: z.string().nullable() }),
    heads: z.array(z.object({ name: z.string(), amount: money })),
    collection: z.enum(['WALLET', 'FINANCING']),
  })
  .meta({ id: 'MemberFeeRecordDetail' });
const collected = z.union([
  z.object({
    collected: z.literal(true),
    receipt: z.object({ reference: z.string(), amount: money }),
  }),
  z.object({
    collected: z.literal(false),
    pendingAttempt: z.object({ id: z.uuid(), tries: z.number(), reasonCode: z.string() }),
  }),
]);

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Fees'] });
doc({
  id: 'FEE-019',
  method: 'get',
  path: '/api/v1/me/fees',
  summary:
    'School fees (?for a child on the account, ?yearId): the year’s heads, paid so far, the next due with its late fine, every instalment, consent state with the text to accept, financing and the wallet balance',
  auth: 'member',
  responses: {
    200: {
      description: 'Dues',
      schema: z
        .object({
          student: z.object({
            id: z.uuid(),
            name: z.string(),
            classSection: z.string().nullable(),
            admissionNo: z.string().nullable(),
          }),
          year: z.object({ id: z.uuid(), label: z.string() }).nullable(),
          structure: z.string().nullable(),
          summary: z.object({
            annual: money,
            paid: money,
            outstanding: money,
            paidPercent: z.number(),
          }),
          heads: z.array(z.object({ name: z.string(), amount: money })),
          next: due.nullable(),
          records: z.array(due),
          consent: z.object({
            required: z.boolean(),
            valid: z.boolean(),
            validUntil: z.string().nullable(),
            template: z.object({ version: z.string(), months: z.number(), text: z.string() }),
          }),
          financing: z.object({
            status: z.enum(['NOT_REGISTERED', 'PENDING', 'SUCCESS', 'FAILED']),
            partnerName: z.string().nullable(),
          }),
          wallet: z.object({ balance: money }),
        })
        .meta({ id: 'MemberFees' }),
    },
  },
});
doc({
  id: 'FEE-020',
  method: 'get',
  path: '/api/v1/me/fees/{recordId}',
  summary: 'A fee with its heads, receipt and settlement (?for)',
  auth: 'member',
  responses: { 200: { description: 'Fee', schema: dueDetail } },
});
doc({
  id: 'FEE-021',
  method: 'post',
  path: '/api/v1/me/fee-consents',
  summary:
    'Accept the fee consent shown in FEE-019 (its version); the exact text is kept with the date (FR-FEE-06) and lasts fee.consent.validityMonths. The due fee is then tried once: collected, or kept pending for a top-up',
  auth: 'member',
  request: consentInputSchema,
  idempotent: 'required',
  responses: {
    201: {
      description: 'Consent recorded',
      schema: z
        .object({
          consent: z.object({
            id: z.uuid(),
            version: z.string(),
            agreedAt: z.string().nullable(),
            validUntil: z.string().nullable(),
          }),
          collection: z.intersection(z.object({ recordId: z.uuid() }), collected).nullable(),
        })
        .meta({ id: 'FeeConsentRecorded' }),
    },
  },
});
doc({
  id: 'FEE-022',
  method: 'post',
  path: '/api/v1/me/fees/{recordId}/payments',
  summary:
    'Pay a due fee now from the campus wallet, confirmed with the PIN (engine, TUITION); a short balance is refused with what to add',
  auth: 'member',
  request: feePaymentSchema,
  idempotent: 'required',
  responses: {
    201: {
      description: 'Paid',
      schema: z
        .object({
          collected: z.literal(true),
          receipt: z.object({ reference: z.string(), amount: money }),
          record: dueDetail,
        })
        .meta({ id: 'MemberFeePaid' }),
    },
  },
});
doc({
  id: 'FEE-058',
  method: 'post',
  path: '/api/v1/me/fees/{recordId}/online-payments',
  summary:
    "Pay online (client 2026-10-22): a link to the school's payment page (its gateway: UPI, cards, net banking) for what is outstanding on one of the family's own instalments, for the app to open in the browser; nothing is sent",
  auth: 'member',
  responses: {
    201: {
      description: 'The payment page',
      schema: z
        .object({
          id: z.uuid(),
          link: z.string(),
          amount: money,
          expiresAt: z.iso.datetime(),
        })
        .meta({ id: 'MemberFeeOnlinePayment' }),
    },
  },
});
doc({
  id: 'FEE-023',
  method: 'get',
  path: '/api/v1/me/fees/{recordId}/receipt.pdf',
  summary: 'The fee receipt of a paid fee (PDF)',
  auth: 'member',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});

/** Mounted under /api/v1. */
export function feeDuesRoutes(deps: {
  db: Kysely<Database>;
  dues: FeeDuesService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const member = requireSurface(deps.loggers, 'member');
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
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;
  const param = (req: Request, k: string) => String(req.params[k]);

  router.get(
    '/me/fees',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.dues.dues(principal(req), q(req, 'for'), q(req, 'yearId')));
    }),
  );
  router.get(
    '/me/fees/:recordId/receipt.pdf',
    member,
    wrap(async (req, res) => {
      const out = await deps.dues.receiptPdf(principal(req), param(req, 'recordId'), q(req, 'for'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
  );
  router.post(
    '/me/fees/:recordId/online-payments',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(await deps.dues.payOnline(principal(req), param(req, 'recordId'), q(req, 'for')));
    }),
  );
  router.get(
    '/me/fees/:recordId',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.dues.detail(principal(req), param(req, 'recordId'), q(req, 'for')));
    }),
  );
  router.post(
    '/me/fee-consents',
    member,
    once,
    wrap(async (req, res) => {
      const b = consentInputSchema.parse(req.body ?? {});
      res
        .status(201)
        .json(
          await deps.dues.consent(
            principal(req),
            { studentProfileId: b.studentProfileId, templateVersion: b.templateVersion },
            String(req.get('Idempotency-Key')),
          ),
        );
    }),
  );
  router.post(
    '/me/fees/:recordId/payments',
    member,
    once,
    wrap(async (req, res) => {
      const b = feePaymentSchema.parse(req.body ?? {});
      res
        .status(201)
        .json(
          await deps.dues.pay(
            principal(req),
            param(req, 'recordId'),
            { pin: b.pin },
            String(req.get('Idempotency-Key')),
            q(req, 'for'),
          ),
        );
    }),
  );
  return router;
}

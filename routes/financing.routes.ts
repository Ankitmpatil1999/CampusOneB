import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { FinancingService } from '../services/financing.service';
import type { PartnersService } from '../services/partners.service';
import { AuthenticationError } from '../utils/CustomAPIError';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const status = z.enum(['PENDING', 'SUCCESS', 'FAILED']);
const id = z.string({ message: 'VALIDATION.REQUIRED' }).trim().max(40);

export const financingInputSchema = z
  .strictObject({
    studentProfileId: id,
    recordIds: z
      .array(id)
      .max(24)
      .optional()
      .describe('The records to finance; default every unpaid one of the current year'),
  })
  .meta({ id: 'FinancingRegistrationInput' });
export const financingWebhookSchema = z
  .strictObject({
    eventId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe('Unique per event: a repeat answers the first result'),
    partnerRef: z.string().trim().min(1).max(40),
    event: z.enum(['APPROVED', 'REJECTED', 'PAID']),
    reason: z.string().trim().max(300).optional(),
    recordIds: z.array(z.uuid()).max(24).optional(),
    paidOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .meta({ id: 'FinancingWebhook' });

const record = z.object({
  id: z.uuid(),
  label: z.string(),
  dueDate: z.string(),
  amount: money,
  outstanding: money,
  status: z.string(),
  financed: z.boolean(),
});
const registration = z
  .object({
    id: z.uuid(),
    partnerRef: z.string(),
    partnerName: z.string(),
    status,
    requestedBy: z.enum(['STAFF', 'MEMBER']),
    failureReason: z.string().nullable(),
    student: z.object({ id: z.uuid(), name: z.string(), admissionNo: z.string().nullable() }),
    records: z.array(record),
    total: money,
    createdAt: z.string().nullable(),
    decidedAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'FinancingRegistration' });
const mine = z
  .object({
    status: z.enum(['NOT_REGISTERED', 'PENDING', 'SUCCESS', 'FAILED']),
    partnerName: z.string(),
    partnerRef: z.string().nullable(),
    failureReason: z.string().nullable(),
    registeredAt: z.string().nullable(),
    decidedAt: z.string().nullable(),
    records: z.array(record),
    canRegister: z.boolean().describe('fee.financing.memberRegisters on and no live registration'),
    sharedData: z.array(z.string()),
  })
  .meta({ id: 'MemberFinancing' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Fee financing'] });
doc({
  id: 'FEE-024',
  method: 'get',
  path: '/api/v1/console/financing-applications',
  summary:
    'Financing registrations of the institution (?status) with their records and the partner',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'Registrations',
      schema: z
        .object({
          items: z.array(registration),
          partner: z.object({ name: z.string(), mode: z.enum(['test', 'live']) }),
        })
        .meta({ id: 'FinancingRegistrations' }),
    },
  },
});
doc({
  id: 'FEE-025',
  method: 'post',
  path: '/api/v1/console/financing-applications',
  summary:
    'Register a student with the financing partner (unpaid records of the current year; one live registration per student); the partner receives the minimum data',
  auth: 'fees.edit',
  request: financingInputSchema,
  idempotent: 'required',
  responses: {
    201: {
      description: 'Registered (Pending)',
      schema: registration
        .extend({
          sent: z.boolean().describe('false: the partner is not connected yet; it stays pending'),
          test: z.boolean().describe('Sent to the test partner (never in production)'),
        })
        .meta({ id: 'FinancingRegistered' }),
    },
  },
});
doc({
  id: 'FEE-026',
  method: 'post',
  path: '/api/v1/partners/financing/webhooks',
  summary:
    'The partner’s decision or payment (HMAC-signed, timestamped, IP allow-list, once per eventId): APPROVED — the records become financed and are no longer debited; REJECTED — with its reason; PAID — financed records marked paid with the partner’s reference (no wallet debit, no posting)',
  auth: 'partner (signed): fee.webhook',
  request: financingWebhookSchema,
  responses: {
    200: {
      description: 'Applied',
      schema: z
        .object({ partnerRef: z.string(), status, recordsPaid: z.number() })
        .meta({ id: 'FinancingWebhookResult' }),
    },
  },
});
doc({
  id: 'FEE-027',
  method: 'get',
  path: '/api/v1/partners/financing/students/{partnerRef}/fees',
  summary:
    'A registered student’s fee details for the partner — the minimum data: name, class, admission number, the financed records (RNG-GOV-007)',
  auth: 'partner (signed): fee.read',
  responses: {
    200: {
      description: 'Fees',
      schema: z
        .object({
          partnerRef: z.string(),
          status,
          institution: z.string(),
          student: z.object({
            name: z.string(),
            admissionNo: z.string().nullable(),
            classSection: z.string().nullable(),
          }),
          records: z.array(record),
        })
        .meta({ id: 'FinancingStudentFees' }),
    },
  },
});
doc({
  id: 'FEE-038',
  method: 'get',
  path: '/api/v1/me/financing',
  summary:
    'Fee financing for the student in context (?for): status, partner, records, and whether the family may register here',
  auth: 'member',
  responses: { 200: { description: 'Financing', schema: mine } },
});
doc({
  id: 'FEE-042',
  method: 'post',
  path: '/api/v1/me/financing',
  summary:
    'Ask to register with the financing partner from the app (?for), while fee.financing.memberRegisters is on (prototype m.financing; OQ-03 example)',
  auth: 'member',
  idempotent: 'required',
  responses: {
    201: {
      description: 'Registered (Pending)',
      schema: mine
        .extend({
          sent: z.boolean().describe('false: the partner is not connected yet; it stays pending'),
          test: z.boolean().describe('Sent to the test partner (never in production)'),
        })
        .meta({ id: 'MemberFinancingRegistered' }),
    },
  },
});

/** Mounted under /api/v1. */
export function financingRoutes(deps: {
  db: Kysely<Database>;
  financing: FinancingService;
  partners: PartnersService;
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
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const member = requireSurface(L, 'member');

  router.get(
    '/console/financing-applications',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.financing.list(principal(req), {
          status: status.optional().parse(q(req, 'status')),
        }),
      );
    }),
  );
  router.post(
    '/console/financing-applications',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      const b = financingInputSchema.parse(req.body ?? {});
      res.status(201).json(await deps.financing.registerByInstitution(principal(req), b));
    }),
  );
  router.get(
    '/me/financing',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.financing.mine(principal(req), q(req, 'for')));
    }),
  );
  router.post(
    '/me/financing',
    member,
    once,
    wrap(async (req, res) => {
      res.status(201).json(await deps.financing.registerByMember(principal(req), q(req, 'for')));
    }),
  );

  // --- the partner (signed calls) --------------------------------------------------------------------
  router.post(
    '/partners/financing/webhooks',
    wrap(async (req, res) => {
      const c = await deps.partners.verifySigned(req, 'fee.webhook');
      const b = financingWebhookSchema.parse(req.body ?? {});
      const out = await deps.partners.once(
        c.clientRowId,
        'fee.webhook',
        b.eventId,
        req.rawBody,
        () => deps.financing.webhook(b),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    }),
  );
  router.get(
    '/partners/financing/students/:partnerRef/fees',
    wrap(async (req, res) => {
      await deps.partners.verifySigned(req, 'fee.read');
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.financing.partnerFees(String(req.params['partnerRef'])));
    }),
  );
  return router;
}

import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import type { EventsService } from '../services/events.service';
import type { PassesService } from '../services/passes.service';
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
const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const head = z.strictObject({ name: text(60), amount: moneyIn });

export const eventInputSchema = z
  .strictObject({
    title: text(80),
    description: z.string().trim().max(500, { message: 'VALIDATION.FORMAT' }).nullish(),
    startDate: date,
    endDate: date,
    heads: z
      .array(head, { message: 'VALIDATION.REQUIRED' })
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(20, { message: 'VALIDATION.FORMAT' }),
    audienceClassIds: z.array(z.string().trim().max(40)).max(100).nullish(),
  })
  .meta({ id: 'EventInput' });
export const eventPatchSchema = eventInputSchema
  .partial()
  .extend({ status: z.enum(['ACTIVE', 'INACTIVE'], { message: 'VALIDATION.FORMAT' }).optional() })
  .meta({ id: 'EventPatch' });
export const passIssueSchema = z
  .strictObject({
    type: text(30),
    purpose: text(120),
    description: text(300),
    holderIds: z
      .array(z.string().trim().max(40), { message: 'VALIDATION.REQUIRED' })
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(500, { message: 'VALIDATION.FORMAT' }),
    validOn: date,
    maxScans: z
      .number({ message: 'VALIDATION.FORMAT' })
      .int({ message: 'VALIDATION.FORMAT' })
      .min(1, { message: 'VALIDATION.FORMAT' })
      .max(100, { message: 'VALIDATION.FORMAT' })
      .optional(),
    transferAllowed: z.boolean().optional(),
    comments: z.string().trim().max(300, { message: 'VALIDATION.FORMAT' }).nullish(),
  })
  .meta({ id: 'PassIssueInput' });
export const passCancelSchema = z
  .strictObject({
    reason: text(200).refine((v) => v.length >= 5, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'PassCancelInput' });
export const passScanSchema = z.strictObject({ qrToken: text(80) }).meta({ id: 'PassScanInput' });

const eventOut = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    startDate: z.string(),
    endDate: z.string(),
    heads: z.array(z.object({ name: z.string(), amount: money })),
    total: money,
    merchant: z.string(),
    audience: z.array(z.object({ id: z.string(), name: z.string() })).nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    payments: z.object({ count: z.number().int(), collected: money }),
    createdAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'Event' });
const myEvent = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    startDate: z.string(),
    endDate: z.string(),
    heads: z.array(z.object({ name: z.string(), amount: money })),
    total: money,
    open: z.boolean(),
    paid: z.boolean(),
    receipt: z.string().nullable(),
  })
  .meta({ id: 'MyEvent' });
const passStatus = z.enum(['ACTIVE', 'AUTHORIZED', 'USED', 'EXPIRED', 'CANCELLED']);
const passOut = z
  .object({
    id: z.uuid(),
    type: z.object({ code: z.string(), label: z.string() }),
    purpose: z.string(),
    description: z.string(),
    holder: z.object({ id: z.uuid(), name: z.string(), admissionNo: z.string().nullable() }),
    validOn: z.string(),
    maxScans: z.number().int(),
    usedScans: z.number().int(),
    transferAllowed: z.boolean(),
    comments: z.string().nullable(),
    status: passStatus,
    visibility: z.enum(['VALID_TODAY', 'VALID_IN_FUTURE', 'EXPIRED', 'USED', 'CANCELLED']),
    authorisedUntil: z.string().nullable(),
    cancelReason: z.string().nullable(),
    createdAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'EntryPass' });

const doc = (tags: string[]) => (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags });
const ev = doc(['Events']);
const ps = doc(['Entry passes']);
ev({
  id: 'FEE-028',
  method: 'get',
  path: '/api/v1/console/events',
  summary: 'Paid events with their heads, period, audience, status and payments collected',
  auth: 'events.view',
  responses: {
    200: {
      description: 'Events',
      schema: z
        .object({
          items: z.array(eventOut),
          kpis: z.object({
            live: z.number().int(),
            upcoming: z.number().int(),
            collected: money,
            payments: z.number().int(),
          }),
        })
        .meta({ id: 'Events' }),
    },
  },
});
ev({
  id: 'FEE-029',
  method: 'post',
  path: '/api/v1/console/events',
  summary:
    'Create an event: heads (the total is their sum), period (end inclusive), audience; the fee account is the payee',
  auth: 'events.edit',
  request: eventInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Event', schema: eventOut } },
});
ev({
  id: 'FEE-030',
  method: 'patch',
  path: '/api/v1/console/events/{eventId}',
  summary:
    'Edit, activate or deactivate an event (heads and start date only before the first payment; If-Match)',
  auth: 'events.edit',
  request: eventPatchSchema,
  responses: { 200: { description: 'Event', schema: eventOut } },
});
ev({
  id: 'FEE-031',
  method: 'get',
  path: '/api/v1/console/events/{eventId}/report',
  summary: 'The event’s payments (from, to, status); format=csv exports them',
  auth: 'events.view',
  responses: { 200: { description: 'Report' } },
});
ev({
  id: 'FEE-032',
  method: 'get',
  path: '/api/v1/me/events',
  summary:
    'Events of my institution open to me (or a child with `for`): heads, total, open now, paid',
  auth: 'member',
  responses: {
    200: {
      description: 'Events',
      schema: z.object({ items: z.array(myEvent) }).meta({ id: 'MyEvents' }),
    },
  },
});
ev({
  id: 'FEE-033',
  method: 'get',
  path: '/api/v1/me/events/{eventId}',
  summary: 'One event and whether it is paid (pay with PAY-002 `eventId`)',
  auth: 'member',
  responses: { 200: { description: 'Event', schema: myEvent } },
});
ps({
  id: 'PAY-003',
  method: 'get',
  path: '/api/v1/me/passes',
  summary: 'My entry passes (or a child’s with `for`) with their visibility today',
  auth: 'member',
  responses: {
    200: {
      description: 'Passes',
      schema: z.object({ items: z.array(passOut) }).meta({ id: 'MyPasses' }),
    },
  },
});
ps({
  id: 'PAY-004',
  method: 'get',
  path: '/api/v1/me/passes/{passId}',
  summary: 'A pass and its scans',
  auth: 'member',
  responses: { 200: { description: 'Pass' } },
});
ps({
  id: 'PAY-005',
  method: 'post',
  path: '/api/v1/me/passes/{passId}/authorisations',
  summary:
    'Authorise my pass on its day, on the phone it is bound to: a fresh QR token for pas.authorise.minutes',
  auth: 'member',
  idempotent: 'required',
  responses: {
    201: {
      description: 'Authorised',
      schema: z
        .object({ authorisedUntil: z.string(), minutes: z.number().int(), qrToken: z.string() })
        .meta({ id: 'PassAuthorisation' }),
    },
  },
});
ps({
  id: 'PAY-006',
  method: 'post',
  path: '/api/v1/passes/scans',
  summary:
    'A staff member scans an authorised pass: not their own, not from the holder’s phone, within its window, day and scans; every scan is recorded',
  auth: 'member',
  request: passScanSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Accepted' } },
});
ps({
  id: 'PAY-026',
  method: 'get',
  path: '/api/v1/console/passes',
  summary: 'Entry passes with scans and status, the counts and the pass types',
  auth: 'passes.view',
  responses: { 200: { description: 'Passes' } },
});
ps({
  id: 'PAY-027',
  method: 'post',
  path: '/api/v1/console/passes',
  summary:
    'Issue passes: type, purpose, description, a future day, holders (students and visitors with a registered phone), scans ≥ 1; one live pass per holder, phone and day',
  auth: 'passes.edit',
  request: passIssueSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Issued' } },
});
ps({
  id: 'PAY-028',
  method: 'post',
  path: '/api/v1/console/passes/{passId}/cancellation',
  summary: 'Cancel a live pass with a reason',
  auth: 'passes.edit',
  request: passCancelSchema,
  responses: { 200: { description: 'Pass', schema: passOut } },
});

const paise = (field: string, v: { amount: string }) => {
  try {
    return parseAmount(v.amount);
  } catch (e) {
    if (e instanceof MoneyError) throw new ValidationError([{ field, code: 'VALIDATION.AMOUNT' }]);
    throw e;
  }
};
const headsIn = (heads: readonly { name: string; amount: { amount: string } }[]) =>
  heads.map((h, i) => ({ name: h.name, amountPaise: paise(`heads.${i}.amount`, h.amount) }));

/** Mounted under /api/v1. */
export function eventsRoutes(deps: {
  db: Kysely<Database>;
  events: EventsService;
  passes: PassesService;
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
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const member = requireSurface(L, 'member');
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;

  // --- console: events ---------------------------------------------------------------------------
  router.get(
    '/console/events',
    ...console,
    authorize('events.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.events.list(principal(req), {
          status: z.enum(['ACTIVE', 'INACTIVE']).optional().parse(q(req, 'status')),
        }),
      );
    }),
  );
  router.post(
    '/console/events',
    ...console,
    authorize('events.edit', L),
    once,
    wrap(async (req, res) => {
      const b = eventInputSchema.parse(req.body ?? {});
      res.status(201).json(
        await deps.events.create(principal(req), {
          title: b.title,
          description: b.description,
          startDate: b.startDate,
          endDate: b.endDate,
          heads: headsIn(b.heads),
          audienceClassIds: b.audienceClassIds,
        }),
      );
    }),
  );
  router.patch(
    '/console/events/:eventId',
    ...console,
    authorize('events.edit', L),
    wrap(async (req, res) => {
      const b = eventPatchSchema.parse(req.body ?? {});
      const out = await deps.events.update(
        principal(req),
        param(req, 'eventId'),
        expectedVersion(req),
        {
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.startDate !== undefined ? { startDate: b.startDate } : {}),
          ...(b.endDate !== undefined ? { endDate: b.endDate } : {}),
          ...(b.heads !== undefined ? { heads: headsIn(b.heads) } : {}),
          ...(b.audienceClassIds !== undefined ? { audienceClassIds: b.audienceClassIds } : {}),
          ...(b.status !== undefined ? { status: b.status } : {}),
        },
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/events/:eventId/report',
    ...console,
    authorize('events.view', L),
    wrap(async (req, res) => {
      const f = {
        from: date.optional().parse(q(req, 'from')),
        to: date.optional().parse(q(req, 'to')),
      };
      if (q(req, 'format') === 'csv') {
        const out = await deps.events.reportCsv(principal(req), param(req, 'eventId'), f);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
        res.send(out.csv);
        return;
      }
      res.json(
        await deps.events.report(principal(req), param(req, 'eventId'), {
          ...f,
          status: z.enum(['SUCCESS', 'FAILURE']).optional().parse(q(req, 'status')),
        }),
      );
    }),
  );

  // --- member: events --------------------------------------------------------------------------------
  router.get(
    '/me/events',
    member,
    wrap(async (req, res) => {
      res.json(await deps.events.mine(principal(req), q(req, 'for')));
    }),
  );
  router.get(
    '/me/events/:eventId',
    member,
    wrap(async (req, res) => {
      res.json(await deps.events.detail(principal(req), param(req, 'eventId'), q(req, 'for')));
    }),
  );

  // --- passes -------------------------------------------------------------------------------------
  router.get(
    '/me/passes',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.passes.mine(principal(req), q(req, 'for')));
    }),
  );
  router.get(
    '/me/passes/:passId',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.passes.detail(principal(req), param(req, 'passId'), q(req, 'for')));
    }),
  );
  router.post(
    '/me/passes/:passId/authorisations',
    member,
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(await deps.passes.authorise(principal(req), param(req, 'passId')));
    }),
  );
  router.post(
    '/passes/scans',
    member,
    once,
    wrap(async (req, res) => {
      res.json(await deps.passes.scan(principal(req), passScanSchema.parse(req.body ?? {})));
    }),
  );
  router.get(
    '/console/passes',
    ...console,
    authorize('passes.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.passes.list(principal(req), {
          status: z
            .enum(['ACTIVE', 'AUTHORIZED', 'USED', 'EXPIRED', 'CANCELLED'])
            .optional()
            .parse(q(req, 'status')),
          type: q(req, 'type'),
          date: date.optional().parse(q(req, 'date')),
        }),
      );
    }),
  );
  router.post(
    '/console/passes',
    ...console,
    authorize('passes.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.passes.issue(principal(req), passIssueSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/console/passes/:passId/cancellation',
    ...console,
    authorize('passes.edit', L),
    wrap(async (req, res) => {
      res.json(
        await deps.passes.cancel(
          principal(req),
          param(req, 'passId'),
          passCancelSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  return router;
}

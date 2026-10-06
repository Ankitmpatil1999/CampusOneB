import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { GrievancesService } from '../services/grievances.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const cursor = z.string().max(40).optional();
const ticketStatus = z.enum(
  ['OPEN', 'ESCALATED_VENDOR', 'ESCALATED_INTERNAL', 'RESOLVED', 'CLOSED'],
  {
    message: 'GRV.STATUS_REQUIRED',
  },
);
const channel = z.enum(['APP', 'WEB'], { message: 'VALIDATION.FORMAT' }).optional();
const attachmentId = z.string().max(40).nullable().optional();
const direction = z.enum(['INBOUND', 'OUTBOUND'], { message: 'VALIDATION.FORMAT' });

export const raiseSchema = z
  .strictObject({
    transactionRef: z.string({ message: 'GRV.TXN_NOT_FOUND' }).trim().min(4).max(35),
    category: z.string({ message: 'GRV.CATEGORY' }).max(40, { message: 'GRV.CATEGORY' }),
    issue: z.string({ message: 'GRV.ISSUE_FORMAT' }).max(2000, { message: 'GRV.ISSUE_FORMAT' }),
    channel,
  })
  .meta({ id: 'TicketRaise' });
export const feedbackSchema = z
  .strictObject({
    kind: z
      .enum(['FEEDBACK', 'GRIEVANCE', 'SUGGESTION'], { message: 'VALIDATION.FORMAT' })
      .optional(),
    text: z.string({ message: 'GRV.ISSUE_FORMAT' }).max(2000, { message: 'GRV.ISSUE_FORMAT' }),
    attachmentId,
    channel,
  })
  .meta({ id: 'Feedback' });
export const fraudSchema = z
  .strictObject({
    category: z.string({ message: 'GRV.CATEGORY' }).max(40, { message: 'GRV.CATEGORY' }),
    details: z.string({ message: 'GRV.ISSUE_FORMAT' }).max(2000, { message: 'GRV.ISSUE_FORMAT' }),
    happenedOn: z.iso.date({ message: 'VALIDATION.DATE' }).optional(),
    location: z.string().max(200).optional(),
    transactionRef: z.string().trim().max(35).optional(),
    attachmentId,
    channel,
  })
  .meta({ id: 'FraudReport' });
export const ticketUpdateSchema = z
  .strictObject({
    status: ticketStatus,
    priority: z.number({ message: 'VALIDATION.FORMAT' }).int().min(1).max(3),
    reasonCode: z.string().max(40).nullable().optional(),
    resolution: z.string().max(500, { message: 'GRV.OTHER_COMMENT' }).nullable().optional(),
    comment: z.string({ message: 'GRV.COMMENT' }).max(400, { message: 'GRV.COMMENT' }),
    refund: z
      .strictObject({
        amount: z
          .object({
            amount: z
              .string({ message: 'VALIDATION.AMOUNT' })
              .regex(/^\d{1,11}(\.\d{1,2})?$/, { message: 'VALIDATION.AMOUNT' }),
            currency: z.literal('INR', { message: 'VALIDATION.FORMAT' }),
          })
          .optional(),
      })
      .nullable()
      .optional()
      .describe('A refund resolution: Priority 1 only; the whole transaction when no amount'),
  })
  .meta({ id: 'TicketUpdate' });
const callBase = {
  direction,
  caller: z.string({ message: 'GRV.CALL_CALLER' }).max(100, { message: 'GRV.CALL_CALLER' }),
  minutes: z.number({ message: 'GRV.CALL_MINUTES' }).int({ message: 'GRV.CALL_MINUTES' }),
  summary: z.string({ message: 'GRV.CALL_NOTES' }).max(400, { message: 'GRV.CALL_NOTES' }),
};
export const callSchema = z
  .strictObject({ ticketId: z.string().max(40).nullable().optional(), ...callBase })
  .meta({ id: 'CallLog' });
export const supportCallSchema = z
  .strictObject({
    institutionId: z.string().max(40),
    ticketId: z.string().max(40).nullable().optional(),
    ...callBase,
  })
  .meta({ id: 'SupportCallLog' });

const myQuery = z.object({
  status: z.enum(['open', 'closed'], { message: 'VALIDATION.FORMAT' }).optional(),
  transactionRef: z.string().max(40).optional(),
  cursor,
});
const consoleQuery = z.object({
  status: z
    .enum(
      [
        'OPEN',
        'ESCALATED_VENDOR',
        'ESCALATED_INTERNAL',
        'RESOLVED',
        'CLOSED',
        'ESCALATED',
        'AWAITING_APPROVAL',
      ],
      { message: 'VALIDATION.FORMAT' },
    )
    .optional(),
  priority: z.coerce.number().int().min(1).max(3).optional(),
  kind: z.enum(['TRANSACTION', 'FEEDBACK', 'FRAUD'], { message: 'VALIDATION.FORMAT' }).optional(),
  q: z.string().max(60).optional(),
  cursor,
});
const callsQuery = z.object({ ticketId: z.string().max(40).optional(), cursor });
const supportQuery = z.object({
  ticketNo: z.string().max(20).optional(),
  mobile: z.string().max(15).optional(),
  institutionId: z.string().max(40).optional(),
  reason: z.string().max(200).optional(),
});
const reasonQuery = z.object({ reason: z.string().max(200).optional() });

const ticket = z
  .object({
    id: z.uuid(),
    ticketNo: z.string(),
    kind: z.enum(['TRANSACTION', 'FEEDBACK', 'FRAUD']),
    category: z.string().nullable(),
    categoryLabel: z.string().nullable(),
    issue: z.string(),
    channel: z.enum(['APP', 'WEB', 'PHONE']),
    status: ticketStatus,
    statusLabel: z.string(),
    priority: z.number(),
    awaitingApproval: z.uuid().nullable().describe('The pending Priority-1 request, if any'),
    reasonCode: z.string().nullable(),
    resolution: z.string().nullable(),
    member: z.object({ id: z.uuid(), name: z.string(), mobile: z.string().nullable() }),
    transaction: z
      .object({
        reference: z.string(),
        type: z.string().nullable(),
        amount: money.nullable(),
        at: z.string().nullable(),
      })
      .nullable(),
    fraud: z
      .object({ happenedOn: z.string().nullable(), location: z.string().nullable() })
      .nullable(),
    hasAttachment: z.boolean(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    ageDays: z.number(),
    old: z.boolean().describe('Not resolved and older than grv.ageing.days'),
    version: z.number().int(),
  })
  .meta({ id: 'Ticket' });
const historyRow = z.object({
  status: ticketStatus,
  statusLabel: z.string(),
  priority: z.number(),
  reasonCode: z.string().nullable(),
  resolution: z.string().nullable(),
  comment: z.string().nullable(),
  by: z.string(),
  byType: z.enum(['MEMBER', 'STAFF', 'OPERATOR', 'SYSTEM']),
  approved: z.boolean(),
  at: z.string().nullable(),
});
const myTicket = ticket.extend({ history: z.array(historyRow) }).meta({ id: 'MyTicket' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Grievances'] });
doc({
  id: 'GRV-001',
  method: 'post',
  path: '/api/v1/me/tickets',
  summary:
    'Raise a ticket against a transaction of my own wallet (a failed payment included): category, issue (15–500, letters, numbers and basic punctuation); one ticket that is not closed per transaction',
  auth: 'member',
  request: raiseSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Raised', schema: myTicket } },
});
doc({
  id: 'GRV-002',
  method: 'get',
  path: '/api/v1/me/tickets',
  summary: 'My tickets, newest first, with counts (all, open, resolved or closed)',
  auth: 'member',
  query: myQuery,
  responses: { 200: { description: 'Tickets' } },
});
doc({
  id: 'GRV-003',
  method: 'get',
  path: '/api/v1/me/tickets/{ticketId}',
  summary: 'One of my tickets with its history (newest first)',
  auth: 'member',
  responses: { 200: { description: 'Ticket', schema: myTicket } },
});
doc({
  id: 'GRV-014',
  method: 'post',
  path: '/api/v1/me/tickets/{ticketId}/closure',
  summary: 'Close a resolved ticket ("I’m satisfied"); closed tickets are read-only',
  auth: 'member',
  idempotent: 'required',
  responses: { 200: { description: 'Closed', schema: myTicket } },
});
doc({
  id: 'GRV-004',
  method: 'post',
  path: '/api/v1/me/feedback',
  summary:
    'Feedback, a general grievance or a suggestion (10–1000 characters, an optional screenshot) to my institution',
  auth: 'member',
  request: feedbackSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Received' } },
});
doc({
  id: 'GRV-005',
  method: 'post',
  path: '/api/v1/me/fraud-reports',
  summary:
    'Report suspected fraud with its own number: what happened, when, details (15–800), an optional transaction and screenshot',
  auth: 'member',
  request: fraudSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Reported' } },
});
doc({
  id: 'GRV-006',
  method: 'get',
  path: '/api/v1/console/tickets',
  summary:
    'The institution’s tickets with the summary tiles (open, escalated, awaiting approval, resolved, closed, Priority 1 open, older than grv.ageing.days from creation) and the reasons per status',
  auth: 'grievances.view',
  query: consoleQuery,
  responses: { 200: { description: 'Tickets' } },
});
doc({
  id: 'GRV-007',
  method: 'get',
  path: '/api/v1/console/tickets/{ticketId}',
  summary:
    'A ticket with its transaction, the member’s last five transactions and total, history and calls (ETag)',
  auth: 'grievances.view',
  responses: { 200: { description: 'Ticket' } },
});
doc({
  id: 'GRV-008',
  method: 'patch',
  path: '/api/v1/console/tickets/{ticketId}',
  summary:
    'Update status, priority, reason, resolution and a comment for the history (Closed is read-only; RC-20 moves). Priority 1 — and every refund resolution — waits for a checker (202); the checker’s approval posts the refund through the ledger (Q14 M16). The member is told; If-Match',
  auth: 'grievances.edit',
  request: ticketUpdateSchema,
  idempotent: 'required',
  responses: {
    200: { description: 'Updated' },
    202: { description: 'Sent for checker approval' },
  },
});
doc({
  id: 'GRV-009',
  method: 'get',
  path: '/api/v1/console/call-logs',
  summary: 'Calls logged by the institution, newest first (optionally for one ticket)',
  auth: 'grievances.view',
  query: callsQuery,
  responses: { 200: { description: 'Calls' } },
});
doc({
  id: 'GRV-010',
  method: 'post',
  path: '/api/v1/console/call-logs',
  summary:
    'Log a call, with or without a ticket: direction, caller, minutes (1–180), notes (5–400; never a PIN, password or code)',
  auth: 'grievances.edit',
  request: callSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Logged' } },
});
doc({
  id: 'GRV-011',
  method: 'get',
  path: '/api/v1/ops/support/tickets',
  summary:
    'Support desk: tickets by number or mobile across institutions (at most 20); the reason is required and every look-up is recorded',
  auth: 'support.lookup',
  query: supportQuery,
  responses: { 200: { description: 'Tickets' } },
});
doc({
  id: 'GRV-012',
  method: 'get',
  path: '/api/v1/ops/support/members/{institutionId}/{memberId}/transactions',
  summary: 'A member’s last five transactions and total count (reason required; recorded)',
  auth: 'support.lookup',
  query: reasonQuery,
  responses: { 200: { description: 'Transactions' } },
});
doc({
  id: 'GRV-013',
  method: 'post',
  path: '/api/v1/ops/support/call-logs',
  summary: 'Log a support call for an institution, with or without a ticket',
  auth: 'support.calls',
  request: supportCallSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Logged' } },
});

/** Mounted under /api/v1. */
export function grievancesRoutes(deps: {
  db: Kysely<Database>;
  grievances: GrievancesService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const G = deps.grievances;
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
  const member = requireSurface(L, 'member');
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const ops = requireSurface(L, 'ops');
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  // --- the member ----------------------------------------------------------------------------------------
  router.post(
    '/me/tickets',
    member,
    once,
    wrap(async (req, res) => {
      const out = await G.raise(principal(req), raiseSchema.parse(req.body ?? {}));
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.get(
    '/me/tickets',
    member,
    noStore,
    wrap(async (req, res) => {
      res.json(await G.myTickets(principal(req), myQuery.parse(req.query)));
    }),
  );
  router.get(
    '/me/tickets/:ticketId',
    member,
    noStore,
    wrap(async (req, res) => {
      res.json(await G.myTicket(principal(req), param(req, 'ticketId')));
    }),
  );
  router.post(
    '/me/tickets/:ticketId/closure',
    member,
    once,
    wrap(async (req, res) => {
      res.json(await G.closeMine(principal(req), param(req, 'ticketId')));
    }),
  );
  router.post(
    '/me/feedback',
    member,
    once,
    wrap(async (req, res) => {
      res.status(201).json(await G.feedback(principal(req), feedbackSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/me/fraud-reports',
    member,
    once,
    wrap(async (req, res) => {
      res.status(201).json(await G.fraud(principal(req), fraudSchema.parse(req.body ?? {})));
    }),
  );

  // --- the console ---------------------------------------------------------------------------------------
  router.get(
    '/console/tickets',
    ...console,
    authorize('grievances.view', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await G.list(principal(req), consoleQuery.parse(req.query)));
    }),
  );
  router.get(
    '/console/tickets/:ticketId',
    ...console,
    authorize('grievances.view', L),
    noStore,
    wrap(async (req, res) => {
      const out = await G.detail(principal(req), param(req, 'ticketId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.patch(
    '/console/tickets/:ticketId',
    ...console,
    authorize('grievances.edit', L),
    once,
    wrap(async (req, res) => {
      // The ticket first: another institution's id is a 404 before the body is looked at.
      const p = principal(req);
      const id = param(req, 'ticketId');
      await G.detail(p, id);
      const b = ticketUpdateSchema.parse(req.body ?? {});
      let refund: { amountPaise?: number } | null = null;
      if (b.refund) {
        try {
          refund = b.refund.amount ? { amountPaise: parseAmount(b.refund.amount.amount) } : {};
        } catch (e) {
          if (e instanceof MoneyError) {
            throw new ValidationError([{ field: 'refund.amount', code: 'VALIDATION.AMOUNT' }]);
          }
          throw e;
        }
      }
      const out = await G.update(p, id, expectedVersion(req), {
        status: b.status,
        priority: b.priority,
        reasonCode: b.reasonCode ?? null,
        resolution: b.resolution ?? null,
        comment: b.comment,
        refund,
      });
      setEtag(res, out.ticket.version);
      res.status(out.approvalId && !out.appliedDirectly ? 202 : 200).json(out);
    }),
  );
  router.get(
    '/console/call-logs',
    ...console,
    authorize('grievances.view', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await G.calls(principal(req), callsQuery.parse(req.query)));
    }),
  );
  router.post(
    '/console/call-logs',
    ...console,
    authorize('grievances.edit', L),
    once,
    wrap(async (req, res) => {
      res.status(201).json(await G.logCall(principal(req), callSchema.parse(req.body ?? {})));
    }),
  );

  // --- the support desk ----------------------------------------------------------------------------------
  router.get(
    '/ops/support/tickets',
    ops,
    authorize('support.lookup', L),
    noStore,
    wrap(async (req, res) => {
      res.json(await G.supportTickets(principal(req), supportQuery.parse(req.query)));
    }),
  );
  router.get(
    '/ops/support/members/:institutionId/:memberId/transactions',
    ops,
    authorize('support.lookup', L),
    noStore,
    wrap(async (req, res) => {
      res.json(
        await G.supportTransactions(
          principal(req),
          param(req, 'institutionId'),
          param(req, 'memberId'),
          reasonQuery.parse(req.query).reason,
        ),
      );
    }),
  );
  router.post(
    '/ops/support/call-logs',
    ops,
    authorize('support.calls', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await G.supportCall(principal(req), supportCallSchema.parse(req.body ?? {})));
    }),
  );
  return router;
}

import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { memberOrConsole } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import { DM_GROUPS, type MessagingService } from '../services/messaging.service';
import { AuthenticationError } from '../utils/CustomAPIError';

const uuid = z.string().max(40);
const text = z.string({ message: 'COM.DM_BODY' }).max(16000, { message: 'COM.DM_BODY' });
export const startConversationSchema = z
  .strictObject({ recipientProfileId: uuid, text })
  .meta({ id: 'ConversationStart' });
export const directMessageSchema = z.strictObject({ text }).meta({ id: 'DirectMessageInput' });
export const archiveSchema = z
  .strictObject({ archived: z.boolean() })
  .meta({ id: 'ConversationArchive' });

const forQuery = z.object({ for: uuid.optional() });
const contactsQuery = forQuery.extend({
  q: z.string().max(60).optional(),
  group: z.enum(DM_GROUPS).optional(),
});
const listQuery = forQuery.extend({
  archived: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const messagesQuery = forQuery.extend({
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Communication'] });
doc({
  id: 'COM-016',
  method: 'get',
  path: '/api/v1/me/contacts',
  summary:
    'People the member may start a conversation with, by group, under the role matrix (BR-71): a teacher’s own students, a student’s own teachers (for: a child on the account); the groups the role may not address',
  auth: 'member|teaching.view,principal.view',
  query: contactsQuery,
  responses: { 200: { description: 'Contacts' } },
});
doc({
  id: 'COM-017',
  method: 'get',
  path: '/api/v1/me/conversations',
  summary:
    'Conversations, newest message first, active or archived, with unread counts and whether the member may still send',
  auth: 'member|teaching.view,principal.view',
  query: listQuery,
  responses: { 200: { description: 'Conversations' } },
});
doc({
  id: 'COM-018',
  method: 'post',
  path: '/api/v1/me/conversations',
  summary:
    'Start (or continue) the conversation with a member and send the first message; the role matrix and, for students and teachers, the relationship apply; 30 messages a minute',
  auth: 'member|teaching.view,principal.view',
  query: forQuery,
  request: startConversationSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Sent' } },
});
doc({
  id: 'COM-019',
  method: 'get',
  path: '/api/v1/me/conversations/{conversationId}/messages',
  summary:
    'Messages, oldest first within the newest page (before: older); opening marks the other side’s messages read',
  auth: 'member|teaching.view,principal.view',
  query: messagesQuery,
  responses: { 200: { description: 'Messages' } },
});
doc({
  id: 'COM-020',
  method: 'post',
  path: '/api/v1/me/conversations/{conversationId}/messages',
  summary: 'Send a message (1 to 4,000 characters; 30 a minute per member, shared by every server)',
  auth: 'member|teaching.view,principal.view',
  query: forQuery,
  request: directMessageSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Sent' } },
});
doc({
  id: 'COM-021',
  method: 'post',
  path: '/api/v1/me/conversations/{conversationId}/archive',
  summary: 'Archive or restore the conversation for the member only',
  auth: 'member|teaching.view,principal.view',
  query: forQuery,
  request: archiveSchema,
  responses: { 204: { description: 'Done' } },
});

export function messagingRoutes(deps: {
  db: Kysely<Database>;
  messaging: MessagingService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const once = idempotency({ db: deps.db, mode: 'required' });
  // The app's member, or a teacher or the principal on the web console (client 2026-10-12/13).
  const teacherOrMember = memberOrConsole(['teaching.view', 'principal.view'], deps.loggers);
  const M = deps.messaging;
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
  const param = (req: Request) => String(req.params['conversationId']);
  const json = (fn: (req: Request) => Promise<unknown>, code = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(code).json(await fn(req));
    });

  router.get(
    '/me/contacts',
    teacherOrMember,
    json((req) => M.contacts(principal(req), contactsQuery.parse(req.query))),
  );
  router.get(
    '/me/conversations',
    teacherOrMember,
    json((req) => {
      const q = listQuery.parse(req.query);
      return M.conversations(principal(req), { ...q, archived: q.archived === 'true' });
    }),
  );
  router.post(
    '/me/conversations',
    teacherOrMember,
    once,
    json((req) => {
      const q = forQuery.parse(req.query);
      const b = startConversationSchema.parse(req.body ?? {});
      return M.start(principal(req), { ...b, ...q });
    }, 201),
  );
  router.get(
    '/me/conversations/:conversationId/messages',
    teacherOrMember,
    json((req) => M.messages(principal(req), param(req), messagesQuery.parse(req.query))),
  );
  router.post(
    '/me/conversations/:conversationId/messages',
    teacherOrMember,
    once,
    json(async (req) => {
      const q = forQuery.parse(req.query);
      await M.lookup(principal(req), param(req), q.for);
      const b = directMessageSchema.parse(req.body ?? {});
      return M.send(principal(req), param(req), { ...b, ...q });
    }, 201),
  );
  router.post(
    '/me/conversations/:conversationId/archive',
    teacherOrMember,
    wrap(async (req, res) => {
      const q = forQuery.parse(req.query);
      await M.lookup(principal(req), param(req), q.for);
      await M.archive(principal(req), param(req), {
        ...archiveSchema.parse(req.body ?? {}),
        ...q,
      });
      res.status(204).end();
    }),
  );
  return router;
}

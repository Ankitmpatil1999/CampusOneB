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
  teacherAccess,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import { TARGET_GROUPS, type AnnouncementsService } from '../services/announcements.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const uuid = z.string().max(40);
const channel = z.enum(['IN_APP', 'SMS', 'EMAIL', 'WHATSAPP', 'PUSH'], {
  message: 'VALIDATION.FORMAT',
});
export const targetsSchema = z
  .strictObject({
    groups: z.array(z.enum(TARGET_GROUPS, { message: 'COM.TARGETS' })).max(5),
    classIds: z.array(uuid).max(60).optional(),
    sectionIds: z.array(uuid).max(200).optional(),
    userTypeIds: z.array(uuid).max(30).optional(),
  })
  .meta({ id: 'AnnouncementTargets' });
export const announcementSchema = z
  .strictObject({
    title: z.string({ message: 'VALIDATION.FORMAT' }).max(200, { message: 'VALIDATION.FORMAT' }),
    text: z.string({ message: 'VALIDATION.FORMAT' }).max(10000, { message: 'VALIDATION.FORMAT' }),
    category: z.string({ message: 'COM.CATEGORY' }).max(8, { message: 'COM.CATEGORY' }),
    important: z.boolean().optional(),
    ackRequired: z.boolean().optional(),
    targets: targetsSchema,
    channels: z.array(channel).max(5),
    sendAt: z.string().max(40).nullable().optional(),
    attachmentFileId: uuid.nullable().optional(),
  })
  .meta({ id: 'AnnouncementInput' });
export const announcementEditSchema = announcementSchema
  .partial()
  .extend({ withdrawn: z.boolean().optional(), reason: z.string().max(300).optional() })
  .meta({ id: 'AnnouncementEdit' });
export const remindSchema = z
  .strictObject({ channels: z.array(channel).max(5) })
  .meta({ id: 'AnnouncementReminder' });
export const classAnnouncementSchema = z
  .strictObject({
    classSectionId: uuid,
    title: z.string({ message: 'VALIDATION.FORMAT' }).max(200, { message: 'VALIDATION.FORMAT' }),
    text: z.string({ message: 'VALIDATION.FORMAT' }).max(10000, { message: 'VALIDATION.FORMAT' }),
    ackRequired: z.boolean().optional(),
  })
  .meta({ id: 'ClassAnnouncementInput' });

const listQuery = z.object({
  yearId: uuid.optional(),
  category: z.string().max(8).optional(),
  importantOnly: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(20).optional(),
});
const ackQuery = z.object({
  acked: z.enum(['true', 'false']).optional(),
  classSection: uuid.optional(),
  cursor: z.string().max(20).optional(),
});
const forQuery = z.object({ for: uuid.optional(), cursor: z.string().max(20).optional() });
const principalListQuery = listQuery.omit({ yearId: true });
const classAckQuery = ackQuery.omit({ classSection: true });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Communication'] });
doc({
  id: 'COM-001',
  method: 'get',
  path: '/api/v1/console/announcements',
  summary:
    'Announcements with their dispatch outcome and acknowledgements; the categories and the channels the school can use now',
  auth: 'comms.view',
  query: listQuery,
  responses: { 200: { description: 'Announcements' } },
});
doc({
  id: 'COM-002',
  method: 'post',
  path: '/api/v1/console/announcements',
  summary:
    'Create and send (now or at a time within 30 days): category, high-importance flag, target groups narrowed to classes, sections or user types, channels the platform and the school have on (in-app always), acknowledgement optional; recipients resolved and kept; sent off the request',
  auth: 'comms.send',
  request: announcementSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Accepted' } },
});
doc({
  id: 'COM-003',
  method: 'get',
  path: '/api/v1/console/announcements/{announcementId}',
  summary: 'One announcement with its outcome per channel',
  auth: 'comms.view',
  responses: { 200: { description: 'Announcement' } },
});
doc({
  id: 'COM-004',
  method: 'patch',
  path: '/api/v1/console/announcements/{announcementId}',
  summary: 'Edit until it is sent; afterwards only withdraw with a reason; If-Match',
  auth: 'comms.send',
  request: announcementEditSchema,
  responses: { 200: { description: 'Announcement' } },
});
doc({
  id: 'COM-005',
  method: 'get',
  path: '/api/v1/console/announcements/{announcementId}/acknowledgements',
  summary: 'Recipients who have and haven’t acknowledged (CR-09 columns for students)',
  auth: 'comms.view',
  query: ackQuery,
  responses: { 200: { description: 'Acknowledgements' } },
});
doc({
  id: 'COM-006',
  method: 'post',
  path: '/api/v1/console/announcements/{announcementId}/reminders',
  summary: 'Remind those who haven’t acknowledged, in the app and the chosen channels',
  auth: 'comms.send',
  request: remindSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Reminded' } },
});
doc({
  id: 'COM-011',
  method: 'get',
  path: '/api/v1/me/announcements',
  summary:
    'Announcements sent to the member (for: a child on the account) with their own acknowledgement',
  auth: 'member|teaching.view,principal.view,business.view',
  query: forQuery,
  responses: { 200: { description: 'Announcements' } },
});
doc({
  id: 'COM-012',
  method: 'get',
  path: '/api/v1/me/announcements/{announcementId}',
  summary: 'One announcement sent to the member, with their own acknowledgement',
  auth: 'member|teaching.view,principal.view,business.view',
  query: forQuery,
  responses: { 200: { description: 'Announcement' } },
});
doc({
  id: 'COM-013',
  method: 'post',
  path: '/api/v1/me/announcements/{announcementId}/acknowledgement',
  summary: 'Acknowledge for oneself (or a child on the account); once',
  auth: 'member|teaching.view,principal.view,business.view',
  query: forQuery,
  idempotent: 'required',
  responses: { 200: { description: 'Announcement' } },
});
doc({
  id: 'COM-022',
  method: 'post',
  path: '/api/v1/teacher/class-announcements',
  summary:
    'A class announcement from a teacher of the class to its students and their families, in the app; acknowledgement optional',
  auth: 'member|teaching.announce',
  request: classAnnouncementSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Accepted' } },
});
doc({
  id: 'COM-023',
  method: 'get',
  path: '/api/v1/teacher/class-announcements',
  summary: 'The teacher’s class announcements with acknowledgement counts',
  auth: 'member|teaching.announce',
  responses: { 200: { description: 'Announcements' } },
});
doc({
  id: 'COM-024',
  method: 'post',
  path: '/api/v1/principal/announcements',
  summary: 'The principal’s announcement (the console’s rules)',
  auth: 'member|principal.announce',
  request: announcementSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Accepted' } },
});

doc({
  id: 'COM-026',
  method: 'get',
  path: '/api/v1/principal/announcements',
  summary:
    'The school’s announcements for the principal in the app: dispatch outcome and acknowledgement counts (COM-001’s view)',
  auth: 'member|principal.view',
  query: principalListQuery,
  responses: { 200: { description: 'Announcements' } },
});
doc({
  id: 'COM-027',
  method: 'get',
  path: '/api/v1/me/announcement-options',
  summary:
    'For a teacher’s or the principal’s new announcement: categories, the channels the school has on (a class announcement: in the app), target groups and the title and text limits (settings)',
  auth: 'member|teaching.announce,principal.announce',
  responses: { 200: { description: 'Options' } },
});
doc({
  id: 'COM-028',
  method: 'get',
  path: '/api/v1/teacher/class-announcements/{announcementId}/acknowledgements',
  summary: 'Who has and hasn’t acknowledged the teacher’s own class announcement',
  auth: 'member|teaching.announce',
  query: classAckQuery,
  responses: { 200: { description: 'Acknowledgements' } },
});
doc({
  id: 'COM-029',
  method: 'post',
  path: '/api/v1/teacher/class-announcements/{announcementId}/reminders',
  summary: 'Remind those who haven’t acknowledged the teacher’s own class announcement, in the app',
  auth: 'member|teaching.announce',
  idempotent: 'required',
  responses: { 202: { description: 'Reminded' } },
});

doc({
  id: 'COM-030',
  method: 'get',
  path: '/api/v1/principal/announcements/{announcementId}/acknowledgements',
  summary:
    'The principal in the app: who has and hasn’t acknowledged one of the school’s announcements (COM-005’s view)',
  auth: 'member|principal.view',
  query: ackQuery,
  responses: { 200: { description: 'Acknowledgements' } },
});
doc({
  id: 'COM-031',
  method: 'post',
  path: '/api/v1/principal/announcements/{announcementId}/reminders',
  summary:
    'The principal in the app reminds those who haven’t acknowledged, in the app and the channels chosen (the school’s channels only; COM-006’s rules)',
  auth: 'member|principal.announce',
  request: remindSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Reminded' } },
});

export function announcementsRoutes(deps: {
  db: Kysely<Database>;
  announcements: AnnouncementsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  // The app's member, or the web console with one of the sub-tasks (teachers, Phase 10; the
  // principal, merchants and vendor merchants, client 2026-10-13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, L);
  const once = idempotency({ db: deps.db, mode: 'required' });
  const teaching = (sub: string) => teacherAccess(`teaching.${sub}`, L);
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const view = authorize('comms.view', L);
  const send = authorize('comms.send', L);
  const A = deps.announcements;
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
  const json = (fn: (req: Request) => Promise<unknown>, code = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const out = await fn(req);
      const v = (out as { version?: unknown } | null)?.version;
      if (typeof v === 'number') setEtag(res, v);
      res.status(code).json(out);
    });

  router.get(
    '/console/announcements',
    ...console,
    view,
    json((req) => {
      const q = listQuery.parse(req.query);
      return A.list(principal(req), { ...q, importantOnly: q.importantOnly === 'true' });
    }),
  );
  router.post(
    '/console/announcements',
    ...console,
    send,
    once,
    json(
      (req) => A.createFromConsole(principal(req), announcementSchema.parse(req.body ?? {})),
      202,
    ),
  );
  router.get(
    '/console/announcements/:announcementId',
    ...console,
    view,
    json((req) => A.detail(principal(req), param(req, 'announcementId'))),
  );
  router.patch(
    '/console/announcements/:announcementId',
    ...console,
    send,
    json(async (req) => {
      await A.lookup(principal(req), param(req, 'announcementId'));
      return A.update(
        principal(req),
        param(req, 'announcementId'),
        expectedVersion(req),
        announcementEditSchema.parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/console/announcements/:announcementId/acknowledgements',
    ...console,
    view,
    json((req) => {
      const q = ackQuery.parse(req.query);
      return A.acknowledgements(principal(req), param(req, 'announcementId'), {
        acked: q.acked === undefined ? undefined : q.acked === 'true',
        sectionId: q.classSection,
        cursor: q.cursor,
      });
    }),
  );
  router.post(
    '/console/announcements/:announcementId/reminders',
    ...console,
    send,
    once,
    json(async (req) => {
      await A.lookup(principal(req), param(req, 'announcementId'));
      return A.remind(
        principal(req),
        param(req, 'announcementId'),
        remindSchema.parse(req.body ?? {}),
      );
    }, 202),
  );

  router.get(
    '/me/announcements',
    either('teaching.view', 'principal.view', 'business.view'),
    json((req) => A.mine(principal(req), forQuery.parse(req.query))),
  );
  router.get(
    '/me/announcements/:announcementId',
    either('teaching.view', 'principal.view', 'business.view'),
    json((req) =>
      A.mineOne(principal(req), param(req, 'announcementId'), forQuery.parse(req.query)),
    ),
  );
  router.post(
    '/me/announcements/:announcementId/acknowledgement',
    either('teaching.view', 'principal.view', 'business.view'),
    once,
    json((req) =>
      A.acknowledge(principal(req), param(req, 'announcementId'), forQuery.parse(req.query)),
    ),
  );
  router.post(
    '/teacher/class-announcements',
    teaching('announce'),
    once,
    json((req) => {
      const b = classAnnouncementSchema.parse(req.body ?? {});
      return A.createForClass(principal(req), {
        sectionId: b.classSectionId,
        title: b.title,
        text: b.text,
        ackRequired: b.ackRequired,
      });
    }, 202),
  );
  router.get(
    '/teacher/class-announcements',
    teaching('announce'),
    json((req) => A.mineAsTeacher(principal(req))),
  );
  router.get(
    '/teacher/class-announcements/:announcementId/acknowledgements',
    teaching('announce'),
    json((req) => {
      const q = classAckQuery.parse(req.query);
      return A.classAcknowledgements(principal(req), param(req, 'announcementId'), {
        acked: q.acked === undefined ? undefined : q.acked === 'true',
        cursor: q.cursor,
      });
    }),
  );
  router.post(
    '/teacher/class-announcements/:announcementId/reminders',
    teaching('announce'),
    once,
    json((req) => A.classRemind(principal(req), param(req, 'announcementId')), 202),
  );
  router.get(
    '/principal/announcements',
    either('principal.view'),
    json((req) => {
      const q = principalListQuery.parse(req.query);
      return A.principalList(principal(req), { ...q, importantOnly: q.importantOnly === 'true' });
    }),
  );
  router.get(
    '/principal/announcements/:announcementId/acknowledgements',
    either('principal.view'),
    json((req) => {
      const q = ackQuery.parse(req.query);
      return A.principalAcknowledgements(principal(req), param(req, 'announcementId'), {
        acked: q.acked === undefined ? undefined : q.acked === 'true',
        sectionId: q.classSection,
        cursor: q.cursor,
      });
    }),
  );
  router.post(
    '/principal/announcements/:announcementId/reminders',
    either('principal.announce'),
    once,
    json(
      (req) =>
        A.principalRemind(
          principal(req),
          param(req, 'announcementId'),
          remindSchema.parse(req.body ?? {}),
        ),
      202,
    ),
  );
  router.get(
    '/me/announcement-options',
    either('teaching.announce', 'principal.announce'),
    json((req) => A.composeOptions(principal(req))),
  );
  router.post(
    '/principal/announcements',
    either('principal.announce'),
    once,
    json(
      (req) => A.createFromPrincipal(principal(req), announcementSchema.parse(req.body ?? {})),
      202,
    ),
  );
  return router;
}

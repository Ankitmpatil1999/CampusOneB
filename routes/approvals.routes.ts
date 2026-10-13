import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import { approvalsController } from '../controllers/approvals.controller';
import type { Loggers } from '../controllers/logger';
import {
  authorize,
  memberOrConsole,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  approvalDetailSchema,
  approvalListSchema,
  auditListSchema,
  correctionResultSchema,
  correctionSchema,
  decisionSchema,
  markReadSchema,
  notificationListSchema,
} from '../schemas/approvals.schema';
import type { ApprovalsService } from '../services/approvals.service';
import type { AuditEventsService } from '../services/audit-events.service';
import type { NotificationsService } from '../services/notifications.service';

const mkr = ['Approvals'];
const com = ['Notifications'];
const doc = (d: Parameters<typeof defineRoute>[0]) => defineRoute(d);

doc({
  id: 'MKR-001',
  method: 'get',
  path: '/api/v1/console/approvals',
  summary:
    'Approvals queue (Pending / Approved / Rejected) with counts, filters by module and maker, and search; numbered APR-0001 per institution',
  tags: mkr,
  auth: 'approvals.view',
  responses: { 200: { description: 'Requests', schema: approvalListSchema } },
});
doc({
  id: 'MKR-002',
  method: 'get',
  path: '/api/v1/console/approvals/{approvalId}',
  summary: 'A request with its before → after rows, reason and evidence link',
  tags: mkr,
  auth: 'approvals.view',
  responses: { 200: { description: 'Request', schema: approvalDetailSchema } },
});
doc({
  id: 'MKR-003',
  method: 'post',
  path: '/api/v1/console/approvals/{approvalId}/decision',
  summary:
    'Approve or reject with remarks (If-Match; Idempotency-Key). Never your own request; the change is applied in the same transaction, or the request stays pending with the reason',
  tags: mkr,
  auth: 'approvals.decide',
  request: decisionSchema,
  responses: { 200: { description: 'Decided', schema: approvalDetailSchema } },
});
doc({
  id: 'MKR-004',
  method: 'get',
  path: '/api/v1/ops/approvals',
  summary:
    'Platform approvals: corrections from members whose account has no institution (ADR-0015 point 5)',
  tags: mkr,
  auth: 'home.view',
  responses: { 200: { description: 'Requests', schema: approvalListSchema } },
});
doc({
  id: 'MKR-006',
  method: 'get',
  path: '/api/v1/ops/approvals/{approvalId}',
  summary: 'A platform request with its before → after rows, reason and evidence link',
  tags: mkr,
  auth: 'home.view',
  responses: { 200: { description: 'Request', schema: approvalDetailSchema } },
});
doc({
  id: 'MKR-005',
  method: 'post',
  path: '/api/v1/ops/approvals/{approvalId}/decision',
  summary: 'Decide a platform approval (Platform Administrator; If-Match; Idempotency-Key)',
  tags: mkr,
  auth: 'mkr.decide',
  request: decisionSchema,
  responses: { 200: { description: 'Decided', schema: approvalDetailSchema } },
});
doc({
  id: 'IDN-057',
  method: 'post',
  path: '/api/v1/console/members/{memberId}/pii-corrections',
  summary:
    "Request a correction of a member's display-only field (name, date of birth, gender, admission number, employee ID) with reason and evidence; it waits for an Institution Administrator, or applies at once when the maker is one (ADR-0015)",
  tags: ['Members'],
  auth: 'members.edit',
  request: correctionSchema,
  responses: {
    200: { description: 'Applied directly', schema: correctionResultSchema },
    202: { description: 'Waiting for approval', schema: correctionResultSchema },
  },
});
doc({
  id: 'COM-009',
  method: 'get',
  path: '/api/v1/console/notifications',
  summary: 'Console bell: approvals and their decisions, newest first, with the unread count',
  tags: com,
  auth: 'console',
  responses: { 200: { description: 'Notifications', schema: notificationListSchema } },
});
doc({
  id: 'COM-010',
  method: 'post',
  path: '/api/v1/console/notifications/read',
  summary: 'Mark console notifications read (ids, or all)',
  tags: com,
  auth: 'console',
  request: markReadSchema,
  responses: { 204: { description: 'Marked' } },
});
doc({
  id: 'COM-014',
  method: 'get',
  path: '/api/v1/me/notifications',
  summary: 'Member app notifications (for example a correction decided), newest first',
  tags: com,
  auth: 'member|teaching.view,principal.view,business.view',
  responses: { 200: { description: 'Notifications', schema: notificationListSchema } },
});
doc({
  id: 'COM-015',
  method: 'post',
  path: '/api/v1/me/notifications/read',
  summary: 'Mark member notifications read (ids, or all)',
  tags: com,
  auth: 'member|teaching.view,principal.view,business.view',
  request: markReadSchema,
  responses: { 204: { description: 'Marked' } },
});
doc({
  id: 'GOV-005',
  method: 'get',
  path: '/api/v1/console/audit-events',
  summary:
    "The institution's audit trail: action, record, who, when, why, before and after; newest first",
  tags: ['Governance'],
  auth: 'config.view',
  responses: { 200: { description: 'Audit events', schema: auditListSchema } },
});

/** Mounted under /api/v1. */
export function approvalsRoutes(deps: {
  db: Kysely<Database>;
  approvals: ApprovalsService;
  notifications: NotificationsService;
  audit: AuditEventsService;
  loggers: Loggers;
}): Router {
  const c = approvalsController(deps.approvals, deps.notifications, deps.audit);
  const router = Router();
  const L = deps.loggers;
  const con = [requireSurface(L, 'console'), requireTenant(L)];
  const op = requireSurface(L, 'ops');
  // The app's member, or on the web console a teacher, the principal or a merchant (client
  // 2026-10-12/13): their own notifications.
  const teacherOrMember = memberOrConsole(['teaching.view', 'principal.view', 'business.view'], L);
  const can = (subTask: string) => authorize(subTask, L);
  const once = idempotency({ db: deps.db, mode: 'required' });

  router.get('/console/approvals', ...con, can('approvals.view'), c.console.list);
  router.get('/console/approvals/:approvalId', ...con, can('approvals.view'), c.console.detail);
  router.post(
    '/console/approvals/:approvalId/decision',
    ...con,
    can('approvals.decide'),
    once,
    c.console.decide,
  );
  router.get('/ops/approvals', op, can('home.view'), c.ops.list);
  router.get('/ops/approvals/:approvalId', op, can('home.view'), c.ops.detail);
  router.post('/ops/approvals/:approvalId/decision', op, can('mkr.decide'), once, c.ops.decide);
  router.post(
    '/console/members/:memberId/pii-corrections',
    ...con,
    can('members.edit'),
    once,
    c.correction,
  );
  router.get('/console/notifications', ...con, c.consoleBell.list);
  router.post('/console/notifications/read', ...con, c.consoleBell.read);
  router.get('/me/notifications', teacherOrMember, c.memberBell.list);
  router.post('/me/notifications/read', teacherOrMember, c.memberBell.read);
  router.get('/console/audit-events', ...con, can('config.view'), c.audit);
  return router;
}

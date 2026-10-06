/**
 * Maker-checker, correction, notification and audit-view DTOs (MKR-001…005, IDN-057,
 * COM-009/010/014/015, GOV-005; prototype c.approvals and the console bell).
 */
import { z } from 'zod';

const uuid = z.uuid({ message: 'VALIDATION.FORMAT' });
const state = z.enum(['PENDING', 'APPROVED', 'REJECTED'], { message: 'VALIDATION.FORMAT' });

export const approvalsQuerySchema = z
  .object({
    status: state.optional(),
    module: z.string().trim().max(40).optional(),
    maker: uuid.optional(),
    q: z.string().trim().max(80).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .meta({ id: 'ApprovalsQuery' });

const row = {
  id: z.uuid(),
  no: z.string().describe('APR-0001, numbered per institution'),
  module: z.string(),
  area: z.string(),
  action: z.string(),
  cr: z.string().nullable(),
  summary: z.string(),
  status: state,
  maker: z.object({
    id: z.uuid(),
    name: z.string(),
    you: z.boolean(),
    type: z.string(),
  }),
  raisedAt: z.string(),
  checker: z.object({ name: z.string() }).nullable(),
  decidedAt: z.string().nullable(),
  remarks: z.string().nullable(),
  appliedDirectly: z.boolean().describe('ADR-0015: an administrator applied their own request'),
  canDecide: z.boolean(),
  lastError: z.string().nullable(),
  version: z.number().int(),
};

export const approvalRowSchema = z.object(row).meta({ id: 'ApprovalRow' });

export const approvalListSchema = z
  .object({
    counts: z.object({
      tabs: z.object({
        PENDING: z.number().int(),
        APPROVED: z.number().int(),
        REJECTED: z.number().int(),
      }),
      canDecide: z.number().int(),
      mine: z.number().int(),
      decided30: z.number().int(),
    }),
    canDecide: z.boolean(),
    modules: z.array(z.object({ code: z.string(), label: z.string() })),
    makers: z.array(z.object({ id: z.uuid(), name: z.string(), you: z.boolean() })),
    items: z.array(approvalRowSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'ApprovalList' });

export const approvalDetailSchema = z
  .object({
    ...row,
    reason: z.string().nullable(),
    changes: z.array(z.object({ label: z.string(), from: z.string(), to: z.string() })),
    evidence: z.object({ name: z.string(), url: z.string() }).nullable(),
    subject: z.object({ type: z.enum(['member', 'account']), id: z.uuid().nullable() }).nullable(),
  })
  .meta({ id: 'ApprovalDetail' });

export const decisionSchema = z
  .strictObject({
    decision: z.enum(['APPROVE', 'REJECT'], { message: 'VALIDATION.FORMAT' }),
    remarks: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(500, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'ApprovalDecision' });

export const correctionSchema = z
  .strictObject({
    field: z.enum(['FULL_NAME', 'DOB', 'GENDER', 'ADMISSION_NO', 'EMPLOYEE_NO'], {
      message: 'VALIDATION.FORMAT',
    }),
    proposedValue: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .max(60, { message: 'VALIDATION.FORMAT' }),
    reason: z.string({ message: 'VALIDATION.REQUIRED' }).max(300, { message: 'VALIDATION.FORMAT' }),
    evidenceFileId: uuid,
  })
  .meta({ id: 'MemberCorrection' });

export const correctionResultSchema = z
  .object({ approvalId: z.uuid(), no: z.string(), applied: z.boolean() })
  .meta({ id: 'MemberCorrectionRaised' });

export const notificationsQuerySchema = z
  .object({
    unread: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .meta({ id: 'NotificationsQuery' });

export const notificationListSchema = z
  .object({
    unread: z.number().int(),
    items: z.array(
      z.object({
        id: z.uuid(),
        category: z.string(),
        titleKey: z.string().describe('Message register key; translate with the language bundle'),
        params: z.record(z.string(), z.union([z.string(), z.number()])),
        title: z.string().describe('The title in English'),
        body: z.string(),
        link: z.string().nullable(),
        read: z.boolean(),
        at: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'NotificationList' });

export const markReadSchema = z
  .strictObject({
    ids: z.array(uuid).max(100).optional(),
    all: z.boolean().optional(),
  })
  .meta({ id: 'NotificationsRead' });

export const auditQuerySchema = z
  .object({
    entity: z.string().trim().max(40).optional(),
    entityId: uuid.optional(),
    actor: uuid.optional(),
    from: z.iso.date({ message: 'VALIDATION.DATE' }).optional(),
    to: z.iso.date({ message: 'VALIDATION.DATE' }).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .meta({ id: 'AuditEventsQuery' });

export const auditListSchema = z
  .object({
    items: z.array(
      z.object({
        action: z.string(),
        entity: z.object({ type: z.string(), id: z.uuid().nullable() }),
        actor: z.object({ type: z.string(), name: z.string() }),
        at: z.string(),
        before: z.unknown(),
        after: z.unknown(),
        reason: z.string().nullable(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'AuditEvents' });

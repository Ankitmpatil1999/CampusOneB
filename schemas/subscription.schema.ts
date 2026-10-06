/**
 * Subscription DTOs (SAS-026, SAS-034…039; FR-SAS-05…08; prototype c.subscription and
 * o.institutions "Change plan"). Money as {amount, currency}.
 */
import { z } from 'zod';
import { invoiceSchema } from './billing.schema';
import { planRequestSchema, planSchema } from './institutions.schema';

export { planRequestSchema };

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const reason = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .trim()
  .min(1, { message: 'VALIDATION.REQUIRED' })
  .max(300, { message: 'VALIDATION.FORMAT' });
const timing = z
  .enum(['NOW', 'RENEWAL'], { message: 'VALIDATION.FORMAT' })
  .describe(
    'NOW: an upgrade billed prorated (a trial changes at once); RENEWAL: from the renewal date',
  );

export const planChangeSchema = z
  .strictObject({
    planId: z.uuid({ message: 'VALIDATION.REQUIRED' }),
    timing,
    reason: reason.describe('Recorded in the lifecycle history and e-mailed to the contacts'),
  })
  .meta({ id: 'PlanChange' });

export const planChangeResultSchema = z
  .object({
    plan: z.string(),
    effective: z.enum(['NOW', 'RENEWAL']),
    effectiveOn: z.string(),
    switchedOff: z.array(z.string()).describe('Features outside the new plan, switched off'),
    invoice: z
      .object({ id: z.uuid(), invoiceNo: z.string(), total: money, dueOn: z.string() })
      .nullable()
      .describe('The prorated invoice of an upgrade'),
  })
  .meta({ id: 'PlanChangeResult' });

export const reasonSchema = z.strictObject({ reason }).meta({ id: 'SubscriptionReason' });

export const planRequestInputSchema = z
  .strictObject({
    planId: z.uuid({ message: 'VALIDATION.REQUIRED' }),
    timing,
    note: z.string().trim().max(300, { message: 'VALIDATION.FORMAT' }).nullish(),
  })
  .meta({ id: 'PlanChangeRequestInput' });

export const planRequestCreatedSchema = z
  .object({ id: z.uuid(), status: z.literal('PENDING') })
  .meta({ id: 'PlanChangeRequestCreated' });

export const transferReportSchema = z
  .strictObject({
    utr: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(22, { message: 'SAS.UTR_FORMAT' })
      .describe('Bank reference of the transfer'),
    paidOn: z.iso.date({ message: 'VALIDATION.DATE' }),
  })
  .meta({ id: 'TransferReport' });

export const consoleSubscriptionSchema = z
  .object({
    institution: z.object({ name: z.string(), status: z.string() }),
    subscription: z
      .object({
        status: z.enum(['TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELLED']).nullable(),
        since: z.iso.datetime().nullable(),
        periodStart: z.string().nullable(),
        periodEnd: z.string().nullable(),
        renewsOn: z.string().nullable(),
        trialEndsOn: z.string().nullable(),
      })
      .nullable(),
    plan: planSchema.nullable().describe('The terms in force'),
    modules: z.array(z.object({ module: z.string(), included: z.boolean() })),
    scheduledChange: z.object({ plan: z.string(), on: z.string() }).nullable(),
    usage: z.object({
      members: z.number().int().describe('Active members'),
      sms: z.number().int().nullable().describe('Counted from the communication log (Phase 8)'),
      whatsapp: z.number().int().nullable(),
      storageBytes: z.number().int(),
    }),
    billing: z.object({
      renewalBillDaysBefore: z.number().int(),
      dueDays: z.number().int(),
      graceDays: z.number().int(),
      gstPercent: z.string(),
      smsOverage: money,
      whatsappOverage: money,
    }),
    payee: z
      .object({
        name: z.string(),
        bank: z.string(),
        accountNo: z.string(),
        ifsc: z.string(),
        example: z.boolean(),
      })
      .describe("RingPe's bank account for invoices paid by transfer"),
    plans: z.array(planSchema).describe('Plans the institution may ask for'),
    invoices: z.array(invoiceSchema),
    requests: z.array(planRequestSchema),
  })
  .meta({ id: 'ConsoleSubscription' });

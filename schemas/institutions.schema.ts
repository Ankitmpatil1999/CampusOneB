/**
 * Institution DTOs (INS-001…013, INS-035, INS-036, SAS-027; SRS 7.2–7.5; prototype o.institutions,
 * o.features, c.institution). Field refusals carry the 7.4.4 messages of the old system (K).
 */
import { z } from 'zod';
import { BOARDS } from '../config/registers';
import { PATTERNS } from '../utils/validators';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });

const req = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });

const email = (code: string) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .toLowerCase()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(254, { message: code })
    .regex(PATTERNS.email, { message: code });

const contact = (who: 'PRIMARY' | 'SECONDARY') =>
  z.strictObject({
    name: req(100).regex(PATTERNS.institutionText, { message: `INS.${who}_NAME_FORMAT` }),
    email: email(`INS.${who}_EMAIL_FORMAT`),
    mobile: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .regex(PATTERNS.mobile, { message: `INS.${who}_PHONE_FORMAT` }),
  });

const institutionName = req(150).regex(PATTERNS.institutionName, { message: 'INS.NAME_FORMAT' });
const address = req(200).regex(PATTERNS.institutionName, { message: 'INS.ADDRESS_FORMAT' });
const city = req(80).regex(/^[A-Za-z][A-Za-z .'-]*$/, { message: 'VALIDATION.FORMAT' });
const reason = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .trim()
  .min(1, { message: 'VALIDATION.REQUIRED' })
  .max(500, { message: 'VALIDATION.FORMAT' });

export const registerSchema = z
  .strictObject({
    name: institutionName.describe('Name and address together must be unique (RNG-ONB-033)'),
    address,
    city,
    board: z.enum(BOARDS, { message: 'VALIDATION.FORMAT' }).optional(),
    primaryContact: contact('PRIMARY'),
    secondaryContact: contact('SECONDARY').optional(),
    adminEmail: email('INS.ADMIN_EMAIL_FORMAT').describe(
      'The administrator: an existing CampusOne account in no institution, or a new e-mail (client 2026-10-06/07)',
    ),
    adminName: z
      .string()
      .trim()
      .max(60, { message: 'VALIDATION.FORMAT' })
      .regex(/^[A-Za-z][A-Za-z .'-]*$/, { message: 'IDN.NAME_LETTERS_ONLY' })
      .optional()
      .describe("For a new e-mail; the primary contact's name when it is the same e-mail"),
    adminMobile: z
      .string()
      .trim()
      .regex(PATTERNS.mobile, { message: 'VALIDATION.MOBILE' })
      .optional()
      .describe("For a new e-mail; the primary contact's mobile when it is the same e-mail"),
    planId: z.uuid({ message: 'VALIDATION.FORMAT' }).optional().describe('Can be chosen later'),
  })
  .meta({ id: 'InstitutionRegister' });

export const registeredSchema = z
  .object({
    id: z.uuid(),
    identifier: z.string(),
    version: z.number().int(),
    administrator: z.object({
      email: z.string(),
      pending: z.boolean().describe('Waits for the account to be made on the customer site'),
      accountCreated: z.boolean().describe('A new CampusOne account was made for the e-mail'),
      temporaryPassword: z
        .string()
        .optional()
        .describe(
          'Shown once (setting ins.admin.passwordShownOnce; never stored, not in a replay); changed at first sign-in',
        ),
    }),
  })
  .meta({ id: 'InstitutionRegistered' });

const detailsFields = {
  name: institutionName.optional(),
  address: address.optional(),
  city: city.optional(),
  pinCode: z.string().regex(PATTERNS.postalCode, { message: 'VALIDATION.PIN_CODE' }).optional(),
  board: z.string().trim().max(40, { message: 'VALIDATION.FORMAT' }).nullable().optional(),
  shortName: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,6}$/, { message: 'VALIDATION.FORMAT' })
    .optional()
    .describe('Shown on cards and receipts'),
  officePhone: z
    .string()
    .trim()
    .regex(/^[0-9+ -]{6,15}$/, { message: 'VALIDATION.FORMAT' })
    .nullable()
    .optional(),
  officeEmail: email('VALIDATION.EMAIL').optional(),
  primaryContact: contact('PRIMARY').optional(),
  secondaryContact: contact('SECONDARY').nullable().optional(),
};

export const editSchema = z
  .strictObject({
    ...detailsFields,
    planId: z
      .uuid({ message: 'VALIDATION.FORMAT' })
      .optional()
      .describe('Only before activation; plan changes with billing come with SAS'),
    reason: z
      .string()
      .trim()
      .max(300, { message: 'VALIDATION.FORMAT' })
      .optional()
      .describe('Why the plan is changing (lifecycle history)'),
  })
  .meta({ id: 'InstitutionEdit' });

export const versionSchema = z
  .object({ id: z.uuid(), version: z.number().int() })
  .meta({ id: 'InstitutionVersion' });

export const lifecycleSchema = z
  .strictObject({
    action: z.enum(['START_TRIAL', 'ACTIVATE', 'SUSPEND', 'REACTIVATE', 'CANCEL'], {
      message: 'VALIDATION.FORMAT',
    }),
    reason: reason.describe('Recorded in the lifecycle history and e-mailed to the contacts'),
  })
  .meta({ id: 'InstitutionLifecycleEvent' });

export const lifecycleResultSchema = z
  .object({
    status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CANCELLED']),
    version: z.number().int(),
    notified: z.array(z.string()).describe('Contacts e-mailed'),
    invoice: z
      .object({ id: z.uuid(), invoiceNo: z.string(), total: money, dueOn: z.string() })
      .nullable()
      .describe('The first-cycle invoice raised on activation'),
  })
  .meta({ id: 'InstitutionLifecycleResult' });

export const bankSchema = z
  .strictObject({
    corporateCode: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(10, { message: 'INS.CORPORATE_CODE_FORMAT' }),
    poolAccountRef: req(40).regex(PATTERNS.alphanumeric, { message: 'INS.POOL_ACCOUNT_FORMAT' }),
    shadowAccountRef: z
      .string()
      .trim()
      .max(40, { message: 'VALIDATION.FORMAT' })
      .regex(PATTERNS.alphanumeric, { message: 'VALIDATION.FORMAT' })
      .nullable()
      .optional(),
  })
  .meta({ id: 'InstitutionBankArrangement' });

export const bankResultSchema = z
  .object({ corporateCode: z.string(), version: z.number().int() })
  .meta({ id: 'InstitutionBankArrangementSaved' });

export const stepSchema = z
  .strictObject({ note: z.string().trim().max(300, { message: 'VALIDATION.FORMAT' }).optional() })
  .meta({ id: 'OnboardingStepDone' });

export const stepResultSchema = z
  .object({ step: z.string(), done: z.number().int(), total: z.number().int() })
  .meta({ id: 'OnboardingStepResult' });

export const planSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    cycle: z.enum(['MONTHLY', 'ANNUAL']),
    price: money,
    trialDays: z.number().int(),
    modules: z.array(z.string()),
    allowances: z.object({
      members: z.number().int(),
      sms: z.number().int(),
      whatsapp: z.number().int(),
      storageGb: z.number().int(),
    }),
    version: z.number().int().describe('Version of the terms'),
    platformFee: z
      .object({ flat: money, upTo: money, percent: z.string() })
      .describe('Flat fee up to and including upTo, the percentage above it'),
    institutions: z.number().int().optional().describe('Institutions on the plan (not cancelled)'),
    etag: z.number().int().describe('Send as If-Match "v<n>" to change the plan'),
  })
  .meta({ id: 'Plan' });

/** A plan change request (SAS-037), as the back office and the console show it. */
export const planRequestSchema = z
  .object({
    id: z.uuid(),
    plan: z.object({ id: z.uuid(), name: z.string() }),
    timing: z.enum(['NOW', 'RENEWAL']),
    note: z.string().nullable(),
    status: z.enum(['PENDING', 'APPLIED', 'DECLINED', 'WITHDRAWN']),
    requestedAt: z.iso.datetime(),
    requestedBy: z.string().nullable(),
    resolvedAt: z.iso.datetime().nullable(),
    resolution: z.string().nullable(),
  })
  .meta({ id: 'PlanChangeRequest' });

export const plansSchema = z.object({ items: z.array(planSchema) }).meta({ id: 'Plans' });

const statusEnum = z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CANCELLED']);

export const institutionListSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        identifier: z.string(),
        name: z.string(),
        shortName: z.string(),
        city: z.string(),
        status: statusEnum,
        statusSince: z.iso.datetime().nullable(),
        plan: z
          .object({
            id: z.uuid(),
            code: z.string(),
            name: z.string(),
            cycle: z.enum(['MONTHLY', 'ANNUAL']),
          })
          .nullable(),
        subscriptionStatus: z.string().nullable(),
        trialEndsOn: z.string().nullable(),
        members: z.number().int(),
        checklist: z.object({ done: z.number().int(), total: z.number().int() }),
        registeredAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'InstitutionList' });

const contactOut = z
  .object({ name: z.string(), email: z.string().nullable(), mobile: z.string().nullable() })
  .nullable();

export const institutionDetailSchema = z
  .object({
    id: z.uuid(),
    identifier: z.string(),
    name: z.string(),
    shortName: z.string(),
    city: z.string(),
    address: z.string(),
    pinCode: z.string().nullable(),
    board: z.string().nullable(),
    status: statusEnum,
    suspendedAt: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    registeredAt: z.iso.datetime(),
    corporateCode: z.string().nullable(),
    poolAccountRef: z.string().nullable(),
    plan: planSchema.nullable(),
    subscription: z
      .object({
        status: z.string().nullable(),
        trialEndsOn: z.string().nullable(),
        renewsOn: z.string().nullable(),
        scheduledChange: z
          .object({ plan: z.string(), on: z.string() })
          .nullable()
          .describe('A plan change waiting for renewal (SAS-034)'),
      })
      .nullable(),
    planRequests: z.array(planRequestSchema).describe("The institution's plan change requests"),
    contacts: z.object({ primary: contactOut, secondary: contactOut }),
    administrator: z
      .object({ name: z.string().nullable(), email: z.string().nullable() })
      .nullable(),
    members: z.number().int(),
    checklist: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        owner: z.enum(['Operator', 'Institution']),
        required: z.boolean(),
        ref: z.string(),
        done: z.boolean(),
        doneAt: z.iso.datetime().nullable(),
        note: z.string().nullable(),
      }),
    ),
    missing: z.array(z.string()).describe('Required steps still pending'),
    actions: z.array(
      z.object({
        action: z.enum(['START_TRIAL', 'ACTIVATE', 'SUSPEND', 'REACTIVATE', 'CANCEL']),
        label: z.string(),
        blocked: z.boolean(),
      }),
    ),
    history: z.array(
      z.object({
        action: z.string(),
        step: z.string().nullable(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        reason: z.string().nullable(),
        at: z.iso.datetime(),
        by: z.string(),
      }),
    ),
    version: z.number().int(),
  })
  .meta({ id: 'InstitutionDetail' });

const lock = z
  .object({ kind: z.enum(['PLAN', 'NEEDS', 'ALWAYS_ON']), text: z.string() })
  .nullable();

export const featureRow = z.object({
  key: z.string(),
  label: z.string(),
  sub: z.string(),
  consoleLabel: z.string(),
  consoleSub: z.string(),
  icon: z.string(),
  module: z.string().nullable(),
  group: z.enum(['Money', 'Campus']),
  cr: z.string().nullable(),
  enabled: z.boolean(),
  lock,
});

const channelRow = z.object({
  key: z.enum(['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP']),
  label: z.string(),
  consoleSub: z.string(),
  icon: z.string(),
  allowance: z.number().int().nullable(),
  enabled: z.boolean(),
  lock,
});

export const planRef = z.object({ id: z.uuid(), name: z.string(), code: z.string() }).nullable();

export const featuresSchema = z
  .object({
    institution: z.object({
      id: z.uuid(),
      name: z.string(),
      shortName: z.string(),
      status: statusEnum,
    }),
    plan: planRef,
    features: z.array(featureRow),
    channels: z.array(channelRow),
    version: z.number().int(),
  })
  .meta({ id: 'FeaturePermissions' });

export const featureChangeSchema = z
  .strictObject({
    changes: z
      .array(
        z.strictObject({
          key: z
            .string({ message: 'VALIDATION.REQUIRED' })
            .max(40, { message: 'VALIDATION.FORMAT' })
            .describe('A feature key, or channel.EMAIL / channel.SMS / channel.WHATSAPP'),
          enabled: z.boolean({ message: 'VALIDATION.REQUIRED' }),
        }),
      )
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(20, { message: 'VALIDATION.FORMAT' }),
    reason: z.string().trim().max(300, { message: 'VALIDATION.FORMAT' }).optional(),
  })
  .meta({ id: 'FeaturePermissionChange' });

export const featureLogQuerySchema = z
  .object({ institutionId: z.uuid({ message: 'VALIDATION.FORMAT' }).optional() })
  .meta({ id: 'FeatureLogQuery' });

export const featureLogSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        institutionId: z.uuid(),
        institution: z.string(),
        key: z.string(),
        label: z.string(),
        from: z.boolean(),
        to: z.boolean(),
        reason: z.string().nullable(),
        by: z.string(),
        at: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'FeatureChangeLog' });

export const consoleInstitutionSchema = z
  .object({
    id: z.uuid(),
    identifier: z.string(),
    name: z.string(),
    shortName: z.string(),
    address: z.string(),
    city: z.string(),
    pinCode: z.string().nullable(),
    board: z.string().nullable(),
    officePhone: z.string().nullable(),
    officeEmail: z.string().nullable(),
    status: statusEnum,
    contacts: z.object({ primary: contactOut, secondary: contactOut }),
    administrator: z
      .object({ name: z.string().nullable(), email: z.string().nullable() })
      .nullable(),
    corporateCode: z.string().nullable(),
    consentValidityMonths: z.number().int(),
    logo: z.object({ fileId: z.uuid(), name: z.string(), sizeBytes: z.number().int() }).nullable(),
    feeAccount: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    plan: planRef,
    features: z
      .array(featureRow)
      .describe('Switched by the Institution Administrator within the plan (client 2026-10-03)'),
    channels: z.array(channelRow),
    version: z.number().int(),
  })
  .meta({ id: 'ConsoleInstitution' });

export const consoleUpdateSchema = z
  .strictObject({
    ...detailsFields,
    consentValidityMonths: z
      .number({ message: 'VALIDATION.FORMAT' })
      .int({ message: 'VALIDATION.FORMAT' })
      .min(1, { message: 'VALIDATION.RANGE' })
      .max(12, { message: 'VALIDATION.RANGE' })
      .optional(),
    channels: z
      .partialRecord(z.enum(['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP']), z.boolean())
      .optional()
      .describe('Channel switches the plan allows; in-app is always on'),
    features: z
      .record(z.string().max(30, { message: 'VALIDATION.FORMAT' }), z.boolean())
      .optional()
      .describe(
        'Feature switches within the plan (the Institution Administrator, client 2026-10-03)',
      ),
  })
  .meta({ id: 'ConsoleInstitutionUpdate' });

export const logoSchema = z
  .strictObject({ fileId: z.uuid({ message: 'VALIDATION.FORMAT' }) })
  .meta({ id: 'InstitutionLogo' });

export const feeAccountSchema = z
  .strictObject({ merchantId: z.uuid({ message: 'VALIDATION.FORMAT' }) })
  .meta({ id: 'InstitutionFeeAccount' });

export const brandingSchema = z
  .object({
    name: z.string(),
    shortName: z.string(),
    city: z.string(),
    logoUrl: z.string().nullable().describe('Signed, short-lived link'),
    colors: z.object({ brand: z.string().nullable() }),
  })
  .meta({ id: 'InstitutionBranding' });

/**
 * Customer-portal DTOs (SAS-001…025, SAS-044…050; prototype s.*).
 */
import { z } from 'zod';
import { PATTERNS } from '../utils/validators';
import { featureRow, planRef } from './institutions.schema';

const required = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const mobile = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^[6-9]\d{9}$/, { message: 'VALIDATION.MOBILE' });
const email = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .trim()
  .max(254, { message: 'VALIDATION.EMAIL' })
  .regex(PATTERNS.email, { message: 'VALIDATION.EMAIL' });
const person = required(60).regex(/^[A-Za-z][A-Za-z .'-]*$/, {
  message: 'IDN.NAME_LETTERS_ONLY',
});
const contact = z.strictObject({ name: person, email, mobile });
const date = z.iso.date({ message: 'VALIDATION.DATE' });
const money = z.object({ amount: z.string(), currency: z.literal('INR') });

export const portalPlansSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        code: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        cycle: z.string(),
        price: money,
        trialDays: z.number().int(),
        modules: z.array(z.string()),
        allowances: z.object({
          members: z.number().int(),
          sms: z.number().int(),
          whatsapp: z.number().int(),
          storageGb: z.number().int(),
        }),
        platformFee: z.object({ flat: money, upTo: money, percent: z.string() }),
      }),
    ),
    graceDays: z.number().int(),
    dueDays: z.number().int(),
  })
  .meta({ id: 'PortalPlans' });

export const signupOtpSchema = z.strictObject({ mobile }).meta({ id: 'PortalSignupOtp' });

export const signupVerifySchema = z
  .strictObject({
    challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }),
    otp: z.string({ message: 'VALIDATION.REQUIRED' }).regex(/^\d{4,8}$/, {
      message: 'AUTH.OTP_INVALID',
    }),
    /** The mobile the code went to, for a number without an account (client 2026-10-06). */
    mobile: mobile.optional(),
  })
  .meta({ id: 'PortalSignupVerify' });

const signupToken = z.string({ message: 'SAS.SIGNUP_EXPIRED' }).min(1).max(2000);
const code = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^\d{4,8}$/, { message: 'AUTH.OTP_INVALID' });

/** SAS-051: the administrator's RingPe account made on the customer site. */
export const signupAccountSchema = z
  .strictObject({
    signupToken,
    firstName: person,
    lastName: z.string().trim().max(60, { message: 'VALIDATION.FORMAT' }).nullable().optional(),
    email,
    password: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .max(128, { message: 'VALIDATION.PASSWORD' }),
  })
  .meta({ id: 'PortalSignupAccount' });

/** SAS-052 / SAS-053: the account's e-mail confirmed with a code. */
export const signupEmailCodeSchema = z
  .strictObject({ signupToken })
  .meta({ id: 'PortalSignupEmailCode' });
export const signupEmailVerifySchema = z
  .strictObject({ signupToken, challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }), otp: code })
  .meta({ id: 'PortalSignupEmailVerify' });
export const signupEmailVerifiedSchema = z
  .object({
    emailVerified: z.boolean(),
    joined: z.object({ institution: z.string(), identifier: z.string() }).nullable(),
  })
  .meta({ id: 'PortalSignupEmailVerified' });

export const signupVerifiedSchema = z
  .object({
    signupToken: z.string(),
    expiresAt: z.string(),
    newAccount: z.boolean().describe('A number without a RingPe account: create it next (SAS-051)'),
    account: z
      .object({ name: z.string(), email: z.string().nullable(), mobile: z.string() })
      .nullable(),
    invited: z
      .boolean()
      .describe('An institution registered in the back office waits for this e-mail (SAS-052/053)'),
  })
  .meta({ id: 'PortalSignupVerified' });

export const signupSchema = z
  .strictObject({
    signupToken: z.string({ message: 'SAS.SIGNUP_EXPIRED' }).min(1).max(2000),
    institution: z.strictObject({
      name: required(80).regex(/^[A-Za-z0-9 .,'&()-]+$/, { message: 'VALIDATION.FORMAT' }),
      address: required(200).min(10, { message: 'VALIDATION.FORMAT' }),
      city: required(60).regex(/^[A-Za-z][A-Za-z .'-]*$/, { message: 'VALIDATION.FORMAT' }),
      pinCode: z.string({ message: 'VALIDATION.REQUIRED' }).regex(/^[1-9]\d{5}$/, {
        message: 'VALIDATION.PIN_CODE',
      }),
      board: required(40),
      students: z
        .number({ message: 'VALIDATION.REQUIRED' })
        .int({ message: 'VALIDATION.FORMAT' })
        .min(10, { message: 'VALIDATION.RANGE' })
        .max(20000, { message: 'VALIDATION.RANGE' }),
    }),
    primaryContact: contact,
    secondaryContact: contact.nullish(),
    planId: z.uuid({ message: 'VALIDATION.REQUIRED' }),
    start: z.enum(['TRIAL', 'PAY'], { message: 'VALIDATION.FORMAT' }),
    accept: z.strictObject({
      subscription: z.boolean(),
      dataProcessing: z.boolean(),
      authorised: z.boolean(),
    }),
  })
  .meta({ id: 'PortalSignup' });

export const signedUpSchema = z
  .object({
    institutionId: z.uuid(),
    identifier: z.string(),
    name: z.string(),
    sessionId: z.uuid(),
    csrfToken: z.string(),
  })
  .meta({ id: 'PortalSignedUp' });

export const onboardingSchema = z
  .object({
    status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CANCELLED']),
    startPreference: z.enum(['TRIAL', 'PAY']).nullable(),
    steps: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        required: z.boolean(),
        byRingPe: z.boolean(),
        done: z.boolean(),
        doneAt: z.string().nullable(),
        summary: z.string(),
      }),
    ),
    done: z.number().int(),
    total: z.number().int(),
    canGoLive: z.boolean(),
    missing: z.array(z.string()),
    plan: planRef,
    features: z.array(featureRow).describe('The toggles step: features within the plan'),
    version: z.number().int(),
  })
  .meta({ id: 'PortalOnboarding' });

const category = z.enum(['STUDENT', 'PARENT', 'TEACHER', 'STAFF', 'MANAGEMENT', 'CREW', 'OTHER'], {
  message: 'VALIDATION.FORMAT',
});

export const stepBodySchema = z
  .object({
    features: z.record(z.string().max(30), z.boolean()).optional().describe('toggles'),
    userTypes: z
      .array(
        z.strictObject({
          name: required(40),
          category,
          departments: z.array(required(40)).min(1, { message: 'INS.DEPARTMENT_REQUIRED' }).max(30),
        }),
      )
      .max(30)
      .optional()
      .describe('usertypes'),
    label: z
      .string()
      .regex(/^\d{4}-\d{2}$/, { message: 'VALIDATION.FORMAT' })
      .optional(),
    startsOn: date.optional(),
    endsOn: date.optional(),
    name: z.string().trim().max(80).optional().describe('feeacct: account name'),
    bank: z.string().trim().max(80).optional(),
    ifsc: z.string().trim().max(11).optional(),
    accountNo: z.string().trim().max(24).optional(),
    logoFileId: z.uuid({ message: 'VALIDATION.FORMAT' }).optional().describe('branding'),
  })
  .meta({ id: 'PortalStep' });

export const goLiveSchema = z
  .strictObject({ mode: z.enum(['TRIAL', 'PAY'], { message: 'VALIDATION.FORMAT' }) })
  .meta({ id: 'PortalGoLive' });

export const goLiveResultSchema = z
  .object({
    status: z.string(),
    invoice: z
      .object({ id: z.uuid(), invoiceNo: z.string(), total: money, dueOn: z.string() })
      .nullable(),
  })
  .meta({ id: 'PortalGoLiveResult' });

export const portalPlanChangeSchema = z
  .strictObject({
    planId: z.uuid({ message: 'VALIDATION.REQUIRED' }),
    timing: z.enum(['NOW', 'RENEWAL'], { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'PortalPlanChange' });

export const portalPaymentSchema = z
  .strictObject({
    method: z.enum(['BANK_TRANSFER', 'GATEWAY'], { message: 'VALIDATION.FORMAT' }),
    utr: z.string().trim().max(22, { message: 'SAS.UTR_FORMAT' }).optional(),
    paidOn: date.optional(),
  })
  .meta({ id: 'PortalPayment' });

export const noticesSchema = z
  .object({
    items: z.array(
      z.object({
        action: z.string(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        reason: z.string(),
        at: z.string(),
        by: z.string(),
      }),
    ),
  })
  .meta({ id: 'PortalNotices' });

export const portalAccountSchema = z
  .object({
    institution: z.object({
      id: z.uuid(),
      identifier: z.string(),
      name: z.string(),
      city: z.string(),
      status: z.string(),
      signupSource: z.enum(['OPERATOR', 'PORTAL']),
      startPreference: z.enum(['TRIAL', 'PAY']).nullable(),
      since: z.string().nullable(),
    }),
    billing: z.unknown().describe('As the console Plan & billing (ConsoleSubscription)'),
    onboarding: z.object({
      done: z.number().int(),
      total: z.number().int(),
      canGoLive: z.boolean(),
      missing: z.array(z.string()),
    }),
    notices: noticesSchema.shape.items,
  })
  .meta({ id: 'PortalAccount' });

export const detailsSchema = z
  .object({
    id: z.uuid(),
    identifier: z.string(),
    name: z.string(),
    address: z.string(),
    city: z.string(),
    pinCode: z.string().nullable(),
    board: z.string().nullable(),
    status: z.string(),
    registeredAt: z.string().nullable(),
    signupSource: z.enum(['OPERATOR', 'PORTAL']),
    contacts: z.unknown(),
    administrator: z
      .object({ name: z.string().nullable(), email: z.string().nullable() })
      .nullable(),
    bank: z.object({
      corporateCode: z.string().nullable(),
      poolAccount: z.string().nullable(),
      feeAccount: z.string().nullable(),
    }),
    changeRequests: z.array(
      z.object({
        id: z.uuid(),
        no: z.string(),
        summary: z.string(),
        status: z.string(),
        remarks: z.string().nullable(),
        at: z.string(),
        decidedAt: z.string().nullable(),
      }),
    ),
    version: z.number().int(),
  })
  .meta({ id: 'PortalInstitutionDetails' });

export const contactsSchema = z
  .strictObject({ primaryContact: contact, secondaryContact: contact.nullish() })
  .meta({ id: 'PortalContacts' });

export const detailsChangeSchema = z
  .strictObject({
    field: z.enum(['NAME', 'ADDRESS', 'BOARD'], { message: 'VALIDATION.FORMAT' }),
    value: required(200),
    reason: required(200),
  })
  .meta({ id: 'PortalDetailsChange' });

export const detailsChangeResultSchema = z
  .object({ approvalId: z.uuid(), no: z.string() })
  .meta({ id: 'PortalDetailsChangeRaised' });

export const exportRequestSchema = z
  .strictObject({
    classes: z
      .array(z.enum(['members', 'financial', 'academic', 'attendance', 'communication']))
      .min(1, { message: 'VALIDATION.REQUIRED' }),
  })
  .meta({ id: 'PortalExportRequest' });

export const exportSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['REQUESTED', 'RUNNING', 'READY', 'EXPIRED', 'FAILED']),
    counts: z.record(z.string(), z.number()).nullable(),
    requestedAt: z.string(),
    readyAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    file: z.object({ name: z.string(), sizeBytes: z.number(), url: z.string() }).nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'PortalExport' });

export const exportsSchema = z
  .object({ items: z.array(exportSchema) })
  .meta({ id: 'PortalExports' });

export const cancellationSchema = z
  .object({
    status: z.string(),
    renewsOn: z.string().nullable(),
    unpaid: z.array(z.object({ invoiceNo: z.string(), total: z.string(), status: z.string() })),
    walletsToRefund: z.object({
      count: z.number().int(),
      amount: z.object({ amount: z.string(), currency: z.literal('INR') }),
    }),
    request: z
      .object({
        id: z.uuid(),
        status: z.enum(['PENDING', 'CONFIRMED', 'DECLINED', 'WITHDRAWN']),
        effectiveOn: z.string(),
        reason: z.string(),
        requestedAt: z.string(),
        resolvedAt: z.string().nullable(),
        resolution: z.string().nullable(),
        version: z.number().int(),
      })
      .nullable(),
  })
  .meta({ id: 'PortalCancellation' });

export const cancellationRequestSchema = z
  .strictObject({
    when: z.enum(['END_OF_CYCLE', 'ASAP', 'DATE'], { message: 'VALIDATION.FORMAT' }),
    effectiveOn: date.optional(),
    reason: required(300),
  })
  .meta({ id: 'PortalCancellationRequest' });

export const cancellationCreatedSchema = z
  .object({ id: z.uuid(), effectiveOn: z.string(), status: z.literal('PENDING') })
  .meta({ id: 'PortalCancellationCreated' });

export const declineSchema = z
  .strictObject({ reason: required(300) })
  .meta({ id: 'CancellationDecline' });

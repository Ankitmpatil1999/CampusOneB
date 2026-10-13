/**
 * Admission application input (SRS 19.2, 19.3; prototype p.form steps): one model for the public
 * form and the counsellor's form. Every section is optional while drafting; completeness is checked
 * at submission (ADM-009). The identity number is only its last 6 digits (Q16 e).
 */
import { z } from 'zod';
import { PATTERNS, isAadhaar, pan } from '../utils/validators';

/**
 * An Aadhaar number (client 2026-10-12): twelve digits, not starting with 0 or 1 (the Verhoeff check
 * digit is not enforced for now); spaces and hyphens between the groups are dropped. Write-only: the
 * application shows it masked.
 */
const aadhaar = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine(isAadhaar, { message: 'ADM.ID_INVALID' });

const id = z.string({ message: 'VALIDATION.REQUIRED' }).trim().max(40);
const date = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'VALIDATION.DATE' });
const name = (max = 50) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .max(max, { message: 'VALIDATION.FORMAT' })
    .regex(PATTERNS.personName, { message: 'VALIDATION.FORMAT' });
const optText = (max: number) =>
  z.string().trim().max(max, { message: 'VALIDATION.FORMAT' }).nullish();
/**
 * The country codes the admission form offers for a mobile number (client 2026-10-13), India first.
 * An Indian number is kept as its 10 digits (as before); another as +<code><number>, 6 to 12 digits.
 */
export const DIAL_CODES = [
  '+91',
  '+971',
  '+966',
  '+974',
  '+968',
  '+965',
  '+973',
  '+65',
  '+60',
  '+1',
  '+44',
  '+61',
  '+64',
  '+977',
  '+94',
  '+880',
] as const;
const INTERNATIONAL = new RegExp(
  `^(${DIAL_CODES.filter((c) => c !== '+91')
    .map((c) => `\\${c}`)
    .join('|')})\\d{6,12}$`,
);
/** An Indian mobile (10 digits) or one with another listed country code. */
export const isAdmissionMobile = (v: string) => PATTERNS.mobile.test(v) || INTERNATIONAL.test(v);
const mobile = z
  .string({ message: 'ADM.MOBILE_INVALID' })
  .trim()
  // "+91 98450 12345" is the Indian number 9845012345.
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^\+91(?=\d{10}$)/, ''))
  .superRefine((v, ctx) => {
    if (isAdmissionMobile(v)) return;
    ctx.addIssue({
      code: 'custom',
      message: v.startsWith('+') ? 'ADM.MOBILE_INTL_INVALID' : 'ADM.MOBILE_INVALID',
    });
  });
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, { message: 'VALIDATION.EMAIL' })
  .regex(PATTERNS.email, { message: 'VALIDATION.EMAIL' });

export const addressSchema = z.strictObject({
  line1: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(120),
  // The area or locality is required (client 2026-10-13).
  line2: z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(120, { message: 'VALIDATION.FORMAT' }),
  city: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(60),
  state: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(60),
  pin: z
    .string({ message: 'VALIDATION.REQUIRED' })
    .regex(PATTERNS.postalCode, { message: 'VALIDATION.FORMAT' }),
});
/**
 * A person's Aadhaar number and PAN (client 2026-10-13): required to submit for the father and the
 * mother, a guardian who is the primary contact and the local guardian of a hostel student. Omitted:
 * what is stored stays (the numbers are never read back in full); null clears it.
 */
const ids = {
  aadhaar: aadhaar.nullish().describe('Aadhaar number; kept encrypted, shown masked'),
  pan: pan().nullish().describe('PAN; kept encrypted, shown masked'),
};
const person = z.strictObject({
  name: name(100),
  mobile: mobile.nullish(),
  email: email.nullish(),
  occupation: optText(80),
  ...ids,
});

export const classSectionSchema = z.strictObject({
  yearId: id,
  classId: id,
  joiningDate: date.nullish().describe('Required for the current year (a mid-term admission)'),
  midTermReason: optText(300),
});
export const studentSectionSchema = z.strictObject({
  firstName: name(),
  middleName: name().nullish(),
  lastName: name(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER'], { message: 'VALIDATION.FORMAT' }),
  dob: date,
  // Optional (client 2026-10-12). Omitted: what is stored stays (the numbers are never read back
  // in full); null clears it.
  aadhaar: aadhaar
    .nullish()
    .describe("The student's Aadhaar number, if given; kept encrypted, shown masked"),
  // Optional; null clears it.
  pan: pan().nullish().describe("The student's PAN, if any; kept encrypted, shown masked"),
  category: z
    .enum(['GENERAL', 'OBC', 'SC', 'ST', 'OTHER'], { message: 'VALIDATION.FORMAT' })
    .nullish(),
  medium: optText(30),
  bloodGroup: z
    .enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'UNKNOWN'], {
      message: 'VALIDATION.FORMAT',
    })
    .nullish(),
  allergies: optText(300),
  health: optText(300),
});
export const addressesSectionSchema = z.strictObject({
  residential: addressSchema,
  sameAsResidential: z.boolean({ message: 'VALIDATION.FORMAT' }),
  correspondence: addressSchema.nullish(),
});
export const previousSectionSchema = z.strictObject({
  school: optText(120),
  lastClass: optText(40),
  result: optText(40),
  board: z
    .enum(['CBSE', 'ICSE', 'STATE', 'IB', 'OTHER'], { message: 'VALIDATION.FORMAT' })
    .nullish(),
  otherBoard: optText(60),
  // Mid-term (client 2026-10-13): the family's own answer on the transfer certificate — they have it
  // (uploaded with the documents), or it will follow by a date (an undertaking), so the application
  // can be submitted online. Omitted: what is recorded stays.
  tc: z
    .strictObject({
      mode: z.enum(['TC', 'UNDERTAKING'], { message: 'VALIDATION.FORMAT' }),
      dueDate: date
        .nullish()
        .describe('With UNDERTAKING: the date the certificate will be handed in'),
    })
    .optional(),
});
export const parentsSectionSchema = z.strictObject({
  // The father's and the mother's name and mobile are required (client 2026-10-12, 2026-10-13); a
  // guardian is not. The primary contact's e-mail is required too (checked with the section).
  father: person.extend({ mobile }),
  mother: person.extend({ mobile }),
  guardian: person.extend({ relation: z.string().trim().min(1).max(40) }).nullish(),
  primary: z.enum(['FATHER', 'MOTHER', 'GUARDIAN'], { message: 'VALIDATION.REQUIRED' }),
  children: z
    .enum(['SINGLE', 'MORE'], { message: 'VALIDATION.REQUIRED' })
    .describe('Whether the parents have a single child or more (client 2026-10-12)'),
  // School transport (client 2026-10-12): opted for, and the pick-up stop preferred, if any.
  transport: z.boolean().optional().describe('The family opts for school transport'),
  transportStopId: id
    .nullish()
    .describe("The preferred pick-up stop: one of the landing's transportStops"),
  hostel: z.boolean().optional(),
  localGuardian: z
    .strictObject({
      name: name(100),
      relation: z.string().trim().min(1).max(40),
      mobile,
      address: z.string().trim().min(1).max(200),
      ...ids,
    })
    .nullish(),
});

/** The people whose Aadhaar and PAN the form takes, besides the student's (client 2026-10-13). */
export const ID_HOLDERS = ['father', 'mother', 'guardian', 'localGuardian'] as const;
export type IdHolder = (typeof ID_HOLDERS)[number];

/** The student's Aadhaar and PAN cards, front and back: optional, like the numbers. */
export const STUDENT_CARDS = [
  'STUDENT_AADHAAR_FRONT',
  'STUDENT_AADHAAR_BACK',
  'STUDENT_PAN_FRONT',
  'STUDENT_PAN_BACK',
] as const;
/** Each person's Aadhaar and PAN cards, front and back (migration 0072). */
export const PERSON_CARDS = {
  father: ['FATHER_AADHAAR_FRONT', 'FATHER_AADHAAR_BACK', 'FATHER_PAN_FRONT', 'FATHER_PAN_BACK'],
  mother: ['MOTHER_AADHAAR_FRONT', 'MOTHER_AADHAAR_BACK', 'MOTHER_PAN_FRONT', 'MOTHER_PAN_BACK'],
  guardian: [
    'GUARDIAN_AADHAAR_FRONT',
    'GUARDIAN_AADHAAR_BACK',
    'GUARDIAN_PAN_FRONT',
    'GUARDIAN_PAN_BACK',
  ],
  localGuardian: [
    'LOCAL_GUARDIAN_AADHAAR_FRONT',
    'LOCAL_GUARDIAN_AADHAAR_BACK',
    'LOCAL_GUARDIAN_PAN_FRONT',
    'LOCAL_GUARDIAN_PAN_BACK',
  ],
} as const satisfies Record<IdHolder, readonly string[]>;
/** Every document an application can carry (migrations 0071, 0072). */
export const ADMISSION_DOC_TYPES = [
  'PHOTO',
  'BIRTH',
  'ADDRESS',
  'REPORT',
  'TC',
  'OTHER',
  ...STUDENT_CARDS,
  ...PERSON_CARDS.father,
  ...PERSON_CARDS.mother,
  ...PERSON_CARDS.guardian,
  ...PERSON_CARDS.localGuardian,
] as const;

export const SECTIONS = {
  class: classSectionSchema,
  student: studentSectionSchema,
  addresses: addressesSectionSchema,
  previous: previousSectionSchema,
  parents: parentsSectionSchema,
  customFields: z.record(z.string(), z.unknown()),
} as const;
export type SectionName = keyof typeof SECTIONS;

export const applicationInputSchema = z
  .strictObject({
    class: classSectionSchema,
    student: studentSectionSchema.partial().optional(),
    addresses: addressesSectionSchema.optional(),
    previous: previousSectionSchema.optional(),
    parents: parentsSectionSchema.optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
    step: z.number().int().min(0).max(7).optional(),
  })
  .meta({ id: 'AdmissionApplicationInput' });
export type ApplicationInput = z.infer<typeof applicationInputSchema>;

export const sectionUpdateSchema = z
  .strictObject({
    section: z.enum(['class', 'student', 'addresses', 'previous', 'parents', 'customFields'], {
      message: 'VALIDATION.FORMAT',
    }),
    data: z.unknown(),
    step: z.number().int().min(0).max(7).optional(),
  })
  .meta({ id: 'AdmissionSectionUpdate' });

export const referenceInputSchema = z
  .strictObject({
    name: name(100),
    relation: optText(60),
    mobile,
    email: email.nullish(),
  })
  .meta({ id: 'AdmissionReferenceInput' });

export const submissionSchema = z
  .strictObject({
    declarationAccepted: z.literal(true, { message: 'ADM.DECLARATION' }),
    registrationConsent: z
      .literal(true, { message: 'ADM.CONSENT_REQUIRED' })
      .describe(
        'The family agrees that what is collected registers their RingPe account (client 2026-10-12)',
      ),
    payLater: z.boolean().optional(),
  })
  .meta({ id: 'AdmissionSubmission' });

// The family finds its applications by the primary contact's mobile (client 2026-10-12): the
// identity number is no longer asked for.
export const resumeAskSchema = z.strictObject({ mobile }).meta({ id: 'AdmissionResumeAsk' });
export const resumeVerifySchema = z
  .strictObject({
    challengeId: z.string().trim().max(40),
    requestToken: z.string().trim().max(2000),
    otp: z.string().regex(/^\d{4,8}$/, { message: 'AUTH.OTP_INVALID' }),
  })
  .meta({ id: 'AdmissionResumeVerify' });
export const statusLookupSchema = z
  .strictObject({
    applicationNo: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,5}\/\d{4}\/\d{6}$/, { message: 'VALIDATION.FORMAT' }),
    mobile: mobile.optional(),
    dob: date.optional(),
  })
  .meta({ id: 'AdmissionStatusLookup' });
export const feePaymentStartSchema = z
  .strictObject({
    feeType: z.enum(['APPLICATION', 'ADMISSION']).optional(),
    withAdmission: z
      .boolean()
      .optional()
      .describe(
        'With the application fee: the admission fee too, in the same order (the family chose to pay it now)',
      ),
  })
  .meta({ id: 'AdmissionPaymentStart' });
export const feePaymentVerifySchema = z
  .strictObject({
    gatewayPaymentId: z.string().trim().min(1).max(64),
    signature: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'AdmissionPaymentVerify' });

// --- console ------------------------------------------------------------------------------------------
export const consoleApplicationSchema = applicationInputSchema
  .extend({
    submit: z.boolean().optional(),
    // Submitting at once carries the family's consent, as ADM-030 does (client 2026-10-12).
    registrationConsent: z
      .literal(true, { message: 'ADM.CONSENT_REQUIRED' })
      .optional()
      .describe('Required with submit: true'),
  })
  .refine((v) => !v.submit || v.registrationConsent === true, {
    message: 'ADM.CONSENT_REQUIRED',
    path: ['registrationConsent'],
  })
  .meta({ id: 'CounsellorApplicationInput' });
export const tcSchema = z
  .strictObject({
    mode: z.enum(['TC', 'UNDERTAKING'], { message: 'VALIDATION.FORMAT' }),
    number: optText(40),
    date: date.nullish(),
    dueDate: date.nullish(),
  })
  .meta({ id: 'AdmissionTransferCertificate' });
export const approvalSchema = z
  .strictObject({
    userTypeId: id,
    departmentId: id.nullish(),
    sectionId: id,
    admissionNo: z
      .string({ message: 'IDN.ADMISSION_NO_REQUIRED' })
      .trim()
      .min(1, { message: 'IDN.ADMISSION_NO_REQUIRED' })
      .max(40, { message: 'VALIDATION.FORMAT' }),
    joiningDate: date.nullish(),
  })
  .meta({ id: 'AdmissionApproval' });
export const rejectionSchema = z
  .strictObject({
    reasonCode: z.enum(
      ['AGE_BAND', 'SEATS_FULL', 'DOCUMENTS', 'INTERACTION', 'DUPLICATE', 'WITHDRAWN', 'OTHER'],
      { message: 'VALIDATION.FORMAT' },
    ),
    remarks: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(5, { message: 'VALIDATION.REQUIRED' })
      .max(500),
  })
  .meta({ id: 'AdmissionRejection' });
export const cashSchema = z
  .strictObject({
    feeType: z.enum(['APPLICATION', 'ADMISSION']).optional(),
    receivedAt: date,
    receiptNo: z.string().trim().min(1).max(30).nullish(),
    paidBy: name(100),
  })
  .meta({ id: 'AdmissionCashCollection' });
export const linkInputSchema = z
  .strictObject({
    yearId: id.nullish(),
    expiresAt: z.iso.datetime({ message: 'VALIDATION.DATE' }).nullish(),
  })
  .meta({ id: 'AdmissionLinkInput' });
export const linkEmailSchema = z
  .strictObject({ emails: z.array(email).min(1, { message: 'VALIDATION.REQUIRED' }).max(20) })
  .meta({ id: 'AdmissionLinkEmail' });

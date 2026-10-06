/**
 * Admission application input (SRS 19.2, 19.3; prototype p.form steps): one model for the public
 * form and the counsellor's form. Every section is optional while drafting; completeness is checked
 * at submission (ADM-009). The identity number is only its last 6 digits (Q16 e).
 */
import { z } from 'zod';
import { PATTERNS } from '../utils/validators';

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
const mobile = z
  .string({ message: 'ADM.MOBILE_INVALID' })
  .trim()
  .regex(PATTERNS.mobile, { message: 'ADM.MOBILE_INVALID' });
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, { message: 'VALIDATION.EMAIL' })
  .regex(PATTERNS.email, { message: 'VALIDATION.EMAIL' });

export const addressSchema = z.strictObject({
  line1: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(120),
  line2: optText(120),
  city: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(60),
  state: z.string({ message: 'VALIDATION.REQUIRED' }).trim().min(1).max(60),
  pin: z
    .string({ message: 'VALIDATION.REQUIRED' })
    .regex(PATTERNS.postalCode, { message: 'VALIDATION.FORMAT' }),
});
const person = z.strictObject({
  name: name(100),
  mobile: mobile.nullish(),
  email: email.nullish(),
  occupation: optText(80),
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
  idNumber: z
    .string()
    .regex(/^\d{6}$/, { message: 'ADM.ID_INVALID' })
    .nullish()
    .describe('The last 6 digits of the identity number (Q16 e); kept encrypted'),
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
});
export const parentsSectionSchema = z.strictObject({
  father: person.nullish(),
  mother: person.nullish(),
  guardian: person.extend({ relation: z.string().trim().min(1).max(40) }).nullish(),
  primary: z.enum(['FATHER', 'MOTHER', 'GUARDIAN'], { message: 'VALIDATION.REQUIRED' }),
  hostel: z.boolean().optional(),
  localGuardian: z
    .strictObject({
      name: name(100),
      relation: z.string().trim().min(1).max(40),
      mobile,
      address: z.string().trim().min(1).max(200),
    })
    .nullish(),
});

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
    payLater: z.boolean().optional(),
  })
  .meta({ id: 'AdmissionSubmission' });

export const resumeAskSchema = z
  .strictObject({
    identityNumber: z
      .string()
      .regex(/^\d{6}$/, { message: 'ADM.ID_INVALID' })
      .optional(),
    mobile: mobile.optional(),
  })
  .meta({ id: 'AdmissionResumeAsk' });
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
  .strictObject({ feeType: z.enum(['APPLICATION', 'ADMISSION']).optional() })
  .meta({ id: 'AdmissionPaymentStart' });
export const feePaymentVerifySchema = z
  .strictObject({
    gatewayPaymentId: z.string().trim().min(1).max(64),
    signature: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'AdmissionPaymentVerify' });

// --- console ------------------------------------------------------------------------------------------
export const consoleApplicationSchema = applicationInputSchema
  .extend({ submit: z.boolean().optional() })
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

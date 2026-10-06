/**
 * Personal details DTOs (IDN-015…017, IDN-020…023). Shape and presence here; the SRS field rules
 * (PIN code, IFSC, names, dates, relations) are checked in the service so each refusal carries its
 * 27.5 message.
 */
import { z } from 'zod';

const req = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const opt = (max: number) => z.string().max(max, { message: 'VALIDATION.FORMAT' }).optional();

const choice = z.object({ code: z.string(), labelKey: z.string() });

export const personalDetailsSchema = z
  .object({
    identity: z.object({
      fullName: z.string(),
      dob: z.string().nullable(),
      gender: z.string().nullable(),
      pan: z.string().nullable().describe('Masked'),
      idDocument: z.object({ type: z.string(), number: z.string().nullable() }).nullable(),
      mobile: z.string(),
    }),
    contact: z.object({ email: z.string().nullable(), emailVerified: z.boolean() }),
    address: z
      .object({
        line1: z.string(),
        line2: z.string().nullable(),
        city: z.string(),
        state: z.string().nullable(),
        pinCode: z.string(),
        proofType: z.string().nullable(),
        proofFile: z.object({ fileId: z.uuid(), name: z.string() }),
        version: z.number().int(),
      })
      .nullable(),
    bankAccount: z
      .object({
        holderName: z.string(),
        bankName: z.string().nullable(),
        accountNumber: z.string().nullable().describe('Masked'),
        ifsc: z.string(),
        verified: z.boolean(),
        verifiedAt: z.iso.datetime().nullable(),
        testVerification: z
          .boolean()
          .describe('Checked by the test provider (never in production)'),
        version: z.number().int(),
      })
      .nullable(),
    nominee: z
      .object({
        name: z.string(),
        relation: z.string(),
        dob: z.string().nullable(),
        sharePct: z.number().int(),
        version: z.number().int(),
      })
      .nullable(),
    income: z
      .object({ occupation: z.string(), band: z.string(), version: z.number().int() })
      .nullable(),
    pendingCorrections: z.array(z.object({ requestId: z.uuid(), field: z.string() })),
    options: z.object({
      relations: z.array(choice),
      incomeBands: z.array(choice),
      occupations: z.array(choice),
      addressProofTypes: z.array(choice),
      bankChangeReasons: z.array(choice),
    }),
  })
  .meta({ id: 'PersonalDetails' });

export const addressSchema = z
  .strictObject({
    line1: req(200),
    line2: opt(200),
    city: req(80),
    state: opt(80),
    pinCode: req(6),
    proofType: opt(24).describe(
      'Document type of the proof (optional; the prototype does not ask)',
    ),
    proofFileId: z
      .uuid()
      .optional()
      .describe('Required the first time (uploaded with PLT-010, purpose "document")'),
  })
  .meta({ id: 'AddressInput' });

export const bankAccountSchema = z
  .strictObject({
    holderName: req(120),
    bankName: opt(120),
    accountNumber: req(18),
    confirmAccountNumber: opt(18).describe('When sent, must equal the account number'),
    ifsc: req(11),
    changeReason: opt(24).describe('Optional reason when an account is replaced'),
  })
  .meta({ id: 'BankAccountInput' });

export const nomineeSchema = z
  .strictObject({
    name: req(100),
    relation: req(24),
    dob: opt(10).describe('YYYY-MM-DD (optional)'),
    sharePct: z.number({ message: 'VALIDATION.REQUIRED' }).int(),
  })
  .meta({ id: 'NomineeInput' });

export const incomeSchema = z
  .strictObject({
    occupation: req(100).describe('Free text, as the prototype asks'),
    band: req(24),
  })
  .meta({ id: 'IncomeInput' });

export const savedSchema = z
  .object({
    version: z.number().int(),
    verified: z.boolean().optional(),
    testVerification: z.boolean().optional(),
  })
  .meta({ id: 'PersonalSaved' });

export const correctionSchema = z
  .strictObject({
    field: req(20).describe('FULL_NAME, DOB, GENDER, PAN or ID_NUMBER'),
    proposedValue: req(100),
    reason: req(300),
    evidenceFileId: z
      .uuid({ message: 'VALIDATION.REQUIRED' })
      .describe('PLT-010, purpose "evidence"'),
  })
  .meta({ id: 'CorrectionRequest' });

export const correctionCreatedSchema = z
  .object({ requestId: z.uuid(), status: z.literal('PENDING') })
  .meta({ id: 'CorrectionCreated' });

export const correctionsSchema = z
  .object({
    items: z.array(
      z.object({
        requestId: z.uuid(),
        field: z.string(),
        current: z.string(),
        reason: z.string(),
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
        remarks: z.string().nullable(),
        createdAt: z.iso.datetime().nullable(),
        decidedAt: z.iso.datetime().nullable(),
        appliedAt: z.iso.datetime().nullable(),
      }),
    ),
  })
  .meta({ id: 'Corrections' });

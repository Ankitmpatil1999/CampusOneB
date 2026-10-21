/** A school's corporate codes and their classes (INS-043…048; client 2026-10-13/14). */
import { z } from 'zod';

const classIds = z
  .array(z.string().max(40), { message: 'CC.CLASS_UNKNOWN' })
  .max(100)
  .describe('The classes whose VANs use this code; replaces its classes (a class moves here)');

const fields = {
  bankName: z.string({ message: 'CC.BANK_NAME_REQUIRED' }).max(100).describe('e.g. Axis Bank'),
  ifsc: z.string().max(11).nullable().optional().describe('e.g. UTIB0CCH274'),
  corporateCode: z
    .string({ message: 'INS.CORPORATE_CODE_FORMAT' })
    .max(10)
    .describe(
      'Allotted by the bank: capital letters and digits, up to ins.corporateCode.maxLength',
    ),
  poolAccountRef: z.string().max(40).nullable().optional(),
};

export const corporateCodeCreateSchema = z
  .strictObject({
    ...fields,
    isDefault: z.boolean().optional().describe('The first code is the default anyway'),
    classIds: classIds.optional(),
  })
  .meta({ id: 'CorporateCodeInput' });

export const corporateCodeUpdateSchema = z
  .strictObject({
    bankName: fields.bankName.optional(),
    ifsc: fields.ifsc,
    corporateCode: fields.corporateCode.optional(),
    poolAccountRef: fields.poolAccountRef,
    isDefault: z
      .literal(true)
      .optional()
      .describe('Make this the default (another code stops being it)'),
    status: z.enum(['ACTIVE', 'DISABLED'], { message: 'VALIDATION.FORMAT' }).optional(),
    classIds: classIds.optional(),
  })
  .meta({ id: 'CorporateCodePatch' });

export const corporateCodeSchema = z
  .object({
    id: z.uuid(),
    bankName: z.string().nullable(),
    ifsc: z.string().nullable(),
    corporateCode: z.string(),
    poolAccountRef: z.string().nullable(),
    isDefault: z.boolean(),
    status: z.enum(['ACTIVE', 'DISABLED']),
    classes: z.array(z.object({ id: z.uuid(), name: z.string() })),
    version: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: 'CorporateCode' });

export const corporateCodeListSchema = z
  .object({
    maxLength: z.number().int(),
    items: z.array(corporateCodeSchema),
    classes: z
      .array(z.object({ id: z.uuid(), name: z.string(), codeId: z.uuid().nullable() }))
      .describe('Every class of the school, with the code it is mapped to (null: the default)'),
  })
  .meta({ id: 'CorporateCodes' });

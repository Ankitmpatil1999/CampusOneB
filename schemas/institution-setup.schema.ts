/** Institution set-up DTOs (INS-014…019; SRS 7.3, 7.12.1; prototype c.roles, c.fields). */
import { z } from 'zod';

const CATEGORIES = [
  'STUDENT',
  'PARENT',
  'TEACHER',
  'STAFF',
  'MERCHANT',
  'PRINCIPAL',
  'MANAGEMENT',
  'CREW',
  'OTHER',
] as const;
const ENTITIES = ['MEMBER', 'FEE_STRUCTURE', 'ADMISSION_APPLICATION', 'MERCHANT'] as const;
const TYPES = [
  'TEXT',
  'LONG_TEXT',
  'NUMBER',
  'DATE',
  'DROPDOWN',
  'MULTI_SELECT',
  'YES_NO',
  'EMAIL',
  'PHONE',
] as const;

const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });

export const userTypesSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        category: z.enum(CATEGORIES),
        status: z.enum(['ACTIVE', 'INACTIVE']),
        members: z.number().int(),
        departments: z.array(
          z.object({ id: z.uuid(), name: z.string(), members: z.number().int() }),
        ),
        version: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'UserTypes' });

export const userTypeCreateSchema = z
  .strictObject({
    name: text(40),
    category: z
      .enum(CATEGORIES, { message: 'VALIDATION.FORMAT' })
      .optional()
      .describe('Decides behaviour (OI-ONB-04); default OTHER'),
    departments: z.array(text(40)).max(50, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'UserTypeCreate' });

export const userTypeChangeSchema = z
  .strictObject({
    name: text(40).optional().describe('Fixed once members use the type'),
    addDepartments: z.array(text(40)).max(50, { message: 'VALIDATION.FORMAT' }).optional(),
    removeDepartments: z
      .array(z.uuid({ message: 'VALIDATION.FORMAT' }))
      .max(50, { message: 'VALIDATION.FORMAT' })
      .optional()
      .describe('Department ids; refused while members are in them'),
  })
  .meta({ id: 'UserTypeChange' });

const field = z.object({
  id: z.uuid(),
  entity: z.enum(ENTITIES),
  entityLabel: z.string(),
  label: z.string(),
  type: z.enum(TYPES),
  typeLabel: z.string(),
  options: z.array(z.string()),
  required: z.boolean(),
  unique: z.boolean(),
  listColumn: z.boolean(),
  filter: z.boolean(),
  position: z.number().int(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  values: z.number().int().describe('Values captured against the field'),
  definedBy: z.string().nullable(),
  definedAt: z.iso.datetime(),
  version: z.number().int(),
});

export const customFieldSchema = field.meta({ id: 'CustomField' });

export const customFieldsSchema = z
  .object({ maxActivePerEntity: z.number().int(), items: z.array(field) })
  .meta({ id: 'CustomFields' });

export const customFieldsQuerySchema = z
  .object({ entity: z.enum(ENTITIES, { message: 'VALIDATION.FORMAT' }).optional() })
  .meta({ id: 'CustomFieldsQuery' });

const flags = {
  required: z.boolean({ message: 'VALIDATION.FORMAT' }),
  unique: z.boolean({ message: 'VALIDATION.FORMAT' }),
  listColumn: z.boolean({ message: 'VALIDATION.FORMAT' }),
  filter: z.boolean({ message: 'VALIDATION.FORMAT' }),
  active: z.boolean({ message: 'VALIDATION.FORMAT' }),
};

export const customFieldCreateSchema = z
  .strictObject({
    entity: z.enum(ENTITIES, { message: 'VALIDATION.REQUIRED' }),
    label: text(40),
    type: z.enum(TYPES, { message: 'VALIDATION.REQUIRED' }),
    options: z.array(text(60)).max(50, { message: 'VALIDATION.FORMAT' }).optional(),
    ...flags,
    noIdDocAck: z
      .boolean({ message: 'CF.ACK_REQUIRED' })
      .describe('The field will not capture identity-document numbers (RNG-ONB-114)'),
  })
  .meta({ id: 'CustomFieldCreate' });

export const customFieldChangeSchema = z
  .strictObject({
    entity: z.enum(ENTITIES, { message: 'VALIDATION.FORMAT' }).optional(),
    label: text(40).optional(),
    type: z.enum(TYPES, { message: 'VALIDATION.FORMAT' }).optional(),
    options: z.array(text(60)).max(50, { message: 'VALIDATION.FORMAT' }).optional(),
    required: flags.required.optional(),
    unique: flags.unique.optional(),
    listColumn: flags.listColumn.optional(),
    filter: flags.filter.optional(),
    active: flags.active.optional().describe('Deactivate / reactivate (values kept)'),
    noIdDocAck: z
      .boolean({ message: 'CF.ACK_REQUIRED' })
      .optional()
      .describe('Required for every change except deactivate / reactivate'),
  })
  .meta({ id: 'CustomFieldChange' });

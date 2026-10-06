import { z } from 'zod';

export const settingSchema = z
  .object({
    key: z.string().describe('Limits-register key, e.g. auth.session.memberMobileDays'),
    value: z.number().describe('Value in force'),
    defaultValue: z.number().describe('Register default'),
    unit: z.string(),
    scope: z.string().describe('P platform · I institution · L plan'),
    basis: z.enum(['register', 'adopted', 'proposed']),
    srsValue: z.string().nullable().describe('The SRS 27.4 value when the default differs'),
    adjustable: z.object({ min: z.number(), max: z.number() }).nullable(),
    overridden: z.boolean(),
    reason: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
    updatedBy: z.uuid().nullable(),
    version: z.number().int(),
    refs: z.array(z.string()),
  })
  .meta({ id: 'PlatformSetting' });

export const settingListSchema = z
  .object({ items: z.array(settingSchema) })
  .meta({ id: 'PlatformSettingList' });

export const settingChangeSchema = z
  .strictObject({
    value: z
      .number({ message: 'VALIDATION.FORMAT' })
      .int({ message: 'VALIDATION.FORMAT' })
      .nullable()
      .describe('New value; null resets to the register default'),
    reason: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(3, { message: 'VALIDATION.REQUIRED' })
      .max(500, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'PlatformSettingChange' });

export const settingHistorySchema = z
  .object({
    items: z.array(
      z.object({
        from: z.number().nullable(),
        to: z.number().nullable(),
        reason: z.string(),
        changedAt: z.iso.datetime(),
        changedBy: z.uuid().nullable(),
      }),
    ),
  })
  .meta({ id: 'PlatformSettingHistory' });

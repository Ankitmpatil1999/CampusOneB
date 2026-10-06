/** Plan DTOs (SAS-027…029; FR-SAS-05; prototype o.plans). Money as {amount, currency} (ADR-0004). */
import { z } from 'zod';
import { MODULES } from '../config/registers';
import { money } from '../utils/validators';
import { planSchema } from './institutions.schema';

const whole = (max: number) =>
  z
    .number({ message: 'VALIDATION.REQUIRED' })
    .int({ message: 'VALIDATION.FORMAT' })
    .min(0, { message: 'VALIDATION.RANGE' })
    .max(max, { message: 'VALIDATION.RANGE' });

/** "0.50" (per cent, two decimals, 0–5) → basis points. */
const percent = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^\d(\.\d{1,2})?$/, { message: 'VALIDATION.FORMAT' })
  .transform((v) => Math.round(Number(v) * 100))
  .refine((bp) => bp <= 500, { message: 'VALIDATION.RANGE' });

export const planInputSchema = z
  .strictObject({
    name: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(3, { message: 'VALIDATION.FORMAT' })
      .max(40, { message: 'VALIDATION.FORMAT' }),
    description: z.string().trim().max(140, { message: 'VALIDATION.FORMAT' }).nullable().optional(),
    cycle: z.enum(['MONTHLY', 'ANNUAL'], { message: 'VALIDATION.FORMAT' }),
    price: money({ minPaise: 100 }).describe('Price per cycle, before GST'),
    trialDays: whole(365).describe('Free trial before the first invoice'),
    modules: z
      .array(z.enum(MODULES as unknown as [string, ...string[]], { message: 'VALIDATION.FORMAT' }))
      .max(MODULES.length, { message: 'VALIDATION.FORMAT' }),
    allowances: z.strictObject({
      members: whole(10_000_000),
      sms: whole(10_000_000),
      whatsapp: whole(10_000_000),
      storageGb: whole(100_000),
    }),
    platformFee: z
      .strictObject({
        flat: money({ maxPaise: 10_000, allowZero: true }),
        upTo: money({ minPaise: 100, maxPaise: 10_000_000 }),
        percent,
      })
      .describe('Flat fee up to and including the threshold, a percentage above it (BR-17, OQ-06)'),
  })
  .meta({ id: 'PlanInput' });

export const plansListSchema = z
  .object({
    modules: z.array(z.string()).describe('Every module a plan can include'),
    items: z.array(planSchema),
  })
  .meta({ id: 'PlanList' });

export const planChangedSchema = planSchema
  .extend({
    removedModules: z
      .array(z.string())
      .describe('Modules taken out: those features switch off for each institution at renewal'),
  })
  .meta({ id: 'PlanChanged' });

/** Scheduled-processing DTOs (GOV-001…004; SRS 26.6; prototype o.jobs). */
import { z } from 'zod';

const runSchema = z.object({
  id: z.uuid(),
  jobId: z.string(),
  period: z.string(),
  trigger: z.enum(['SCHEDULE', 'MANUAL', 'CATCH_UP']),
  status: z.enum(['STARTED', 'SUCCESS', 'PARTIAL_FAILURE', 'FAILED']),
  processed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

export const jobCatalogueSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        module: z.string(),
        ref: z.string(),
        time: z.string().nullable().describe('Daily time in IST'),
        scheduleNote: z.string().nullable(),
        scheduleLabel: z.string().nullable(),
        scheduleDetail: z.string().nullable(),
        scheduled: z.boolean(),
        money: z.boolean(),
        phase: z.number().int().describe('Delivery phase that brings the runner'),
        unit: z.string(),
        does: z.string(),
        window: z.string(),
        previous: z.string(),
        twice: z.string(),
        available: z.boolean().describe('A runner is registered; manual runs are possible'),
        lastRun: runSchema.nullable(),
      }),
    ),
  })
  .meta({ id: 'JobCatalogue' });

export const jobRunsSchema = z.object({ items: z.array(runSchema) }).meta({ id: 'JobRuns' });

export const jobRunLogSchema = runSchema
  .extend({
    items: z.array(
      z.object({
        institution: z.string().nullable(),
        status: z.enum(['SUCCESS', 'FAILED', 'SKIPPED']),
        processed: z.number().int(),
        failed: z.number().int(),
        note: z.string().nullable(),
        errorCode: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'JobRunLog' });

export const jobRunRequestSchema = z
  .strictObject({
    period: z.string().max(32).optional().describe('Period key; default the current period'),
    reason: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(200, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'JobRunRequest' });

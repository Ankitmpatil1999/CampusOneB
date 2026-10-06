import { z } from 'zod';

export const liveResponseSchema = z.object({ status: z.literal('ok') }).meta({ id: 'HealthLive' });

export const dependencyStatusSchema = z
  .object({
    name: z.enum(['mysql', 'redis', 'objectStorage', 'kms']),
    status: z.enum(['up', 'down', 'not_configured']),
    required: z.boolean(),
    latencyMs: z.number().optional(),
  })
  .meta({ id: 'DependencyStatus' });

export const readyResponseSchema = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    checks: z.array(dependencyStatusSchema),
  })
  .meta({ id: 'HealthReady' });

export const startupResponseSchema = z
  .object({ status: z.enum(['started', 'starting']) })
  .meta({ id: 'HealthStartup' });

export const detailedResponseSchema = readyResponseSchema
  .extend({ version: z.string(), commit: z.string(), uptimeSeconds: z.number().int() })
  .meta({ id: 'HealthDetailed' });

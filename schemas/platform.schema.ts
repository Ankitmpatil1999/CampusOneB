import { z } from 'zod';

export const statusValueSchema = z.object({
  code: z.string(),
  labelKey: z.string(),
  label: z.string(),
  tone: z.string(),
  terminal: z.boolean(),
});

export const registersResponseSchema = z
  .object({
    version: z.string().describe('Content hash; also the ETag'),
    statuses: z.array(
      z.object({
        domain: z.string(),
        values: z.array(statusValueSchema),
        transitions: z.array(z.object({ from: z.string(), to: z.string() })),
      }),
    ),
    messages: z.array(
      z.object({
        key: z.string(),
        type: z.enum(['error', 'warning', 'info', 'success']),
        text: z.string(),
        placeholders: z.array(z.string()),
      }),
    ),
  })
  .meta({ id: 'Registers' });

export const limitsResponseSchema = z
  .object({
    limits: z.record(z.string(), z.object({ value: z.number(), unit: z.string() })),
  })
  .meta({ id: 'Limits' });

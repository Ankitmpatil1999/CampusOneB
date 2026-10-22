/** Notification settings per event (COM-032/033; client 2026-10-16). */
import { z } from 'zod';

export const commEventSchema = z
  .object({
    event: z.string().describe('FEE_ASSIGNED, FEE_DUE, ATTENDANCE, HOMEWORK, … (comm-events register)'),
    label: z.string(),
    description: z.string().describe('What it is and who gets it'),
    email: z.boolean().describe('The in-app notice is also e-mailed'),
    alert: z.boolean().describe('The notice raises the phone alert'),
    version: z.number().int().describe('Send back with a change (0: never changed)'),
  })
  .meta({ id: 'CommEvent' });

export const commEventListSchema = z
  .object({
    emailChannel: z
      .boolean()
      .describe("Whether e-mail can go at all: the platform's and the school's e-mail channels"),
    items: z.array(commEventSchema),
  })
  .meta({ id: 'CommEventList' });

export const commEventUpdateSchema = z
  .strictObject({
    changes: z
      .array(
        z.strictObject({
          event: z.string().max(30),
          version: z.number().int().min(0),
          email: z.boolean().optional(),
          alert: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(40),
  })
  .meta({ id: 'CommEventUpdate' });

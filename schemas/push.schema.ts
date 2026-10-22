/** The phone's push token for its signed-in session (COM-034/037; client 2026-10-19). */
import { z } from 'zod';

export const pushTokenSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(20)
      .max(1024)
      .regex(/^[\w:.-]+$/, 'not a push token')
      .describe("The phone's Firebase Cloud Messaging registration token"),
    platform: z.enum(['ANDROID', 'IOS']),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'a language code such as en or kn')
      .default('en')
      .describe(
        "The app's language: the push is worded in it (English when it has no translation)",
      ),
  })
  .meta({ id: 'PushTokenRequest' });

export type PushTokenRequest = z.infer<typeof pushTokenSchema>;

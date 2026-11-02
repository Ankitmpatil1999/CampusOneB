/** A school's own payment gateways (INS-038…041; client 2026-10-09). */
import { z } from 'zod';

const text = (max: number) => z.string({ message: 'VALIDATION.REQUIRED' }).trim().max(max);

export const gatewayCreateSchema = z
  .strictObject({
    provider: z.string().trim().max(20).optional().describe('RAZORPAY (default)'),
    label: text(80).describe('A name the school recognises, e.g. "School fees account"'),
    keyId: text(64).describe('Stored encrypted; shown masked'),
    keySecret: text(128).describe('Stored encrypted; never shown again'),
    webhookSecret: z
      .string()
      .trim()
      .max(128)
      .nullable()
      .optional()
      .describe('Stored encrypted; the same text as the webhook set in the gateway dashboard'),
    merchantId: z.string().trim().max(64).nullable().optional().describe('Stored encrypted'),
    isDefault: z.boolean().optional().describe('The first gateway of a school is the default'),
  })
  .meta({ id: 'PaymentGatewayCreate' });

export const gatewayUpdateSchema = z
  .strictObject({
    label: text(80).optional(),
    keyId: text(64).optional(),
    keySecret: text(128).optional().describe('Leave out to keep the current secret'),
    webhookSecret: z.string().trim().max(128).nullable().optional().describe('null removes it'),
    merchantId: z.string().trim().max(64).nullable().optional(),
    isDefault: z.literal(true).optional().describe('Makes this the default for new payments'),
    status: z.enum(['ACTIVE', 'DISABLED'], { message: 'VALIDATION.FORMAT' }).optional(),
  })
  .meta({ id: 'PaymentGatewayUpdate' });

export const gatewaySchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    providerName: z.string(),
    label: z.string(),
    keyIdHint: z.string().describe('Masked, e.g. rzp_test_••••eK0'),
    environment: z.enum(['TEST', 'LIVE']),
    status: z.enum(['ACTIVE', 'DISABLED']),
    isDefault: z.boolean(),
    hasWebhookSecret: z.boolean(),
    hasMerchantId: z.boolean(),
    webhookUrl: z.string().describe("The address to enter in the gateway dashboard's webhooks"),
    lastCheck: z
      .object({ at: z.string(), ok: z.boolean(), note: z.string().nullable() })
      .nullable(),
    version: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: 'PaymentGateway' });

export const gatewayListSchema = z
  .object({
    providers: z.array(z.object({ code: z.string(), name: z.string() })),
    items: z.array(gatewaySchema),
    platform: z
      .object({ provider: z.string(), inUse: z.boolean() })
      .describe(
        "inUse: no gateway of the school's own yet — payments use CampusOne's Razorpay account",
      ),
  })
  .meta({ id: 'PaymentGatewayList' });

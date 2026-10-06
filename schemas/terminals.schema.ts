/** Terminal, reader and campus-card DTOs (IDN-040/041, INS-030…034, ATT-003…007, ATT-024/025, PAY-012). */
import { z } from 'zod';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const uuid = z.uuid({ message: 'VALIDATION.FORMAT' });
/** Every terminal purpose (RC-16 + POS). */
export const TERMINAL_PURPOSES = [
  'ATTENDANCE',
  'PERIOD_ATTENDANCE',
  'LOCATION',
  'COUPON',
  'BALANCE_CHECK',
  'CARD_ISSUE',
  'POS',
] as const;
const purpose = z.enum(TERMINAL_PURPOSES, { message: 'VALIDATION.FORMAT' });

export const terminalSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    location: z.string().nullable(),
    purpose,
    merchant: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    section: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    locationType: z.string().nullable(),
    status: z.enum(['ACTIVE', 'DISABLED']),
    statusReason: z.string().nullable(),
    paired: z.boolean(),
    pairedAt: z.string().nullable(),
    device: z.string().nullable().describe('The last characters of the device fingerprint'),
    lastSeenAt: z.string().nullable(),
    online: z.boolean().describe('Seen within trm.online.minutes'),
    version: z.number().int(),
  })
  .meta({ id: 'Terminal' });
export const terminalsSchema = z
  .object({ items: z.array(terminalSchema) })
  .meta({ id: 'Terminals' });
export const terminalsQuerySchema = z.object({
  purpose: purpose.optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

export const terminalInputSchema = z
  .strictObject({
    name: text(60),
    location: z.string().trim().max(100).nullish(),
    purpose,
    merchantId: uuid.nullish().describe('Coupon counter and POS: the merchant'),
    sectionId: uuid.nullish().describe('Period attendance: the class section'),
    locationType: z
      .string()
      .trim()
      .max(40)
      .nullish()
      .describe('Location attendance: gate, library …'),
  })
  .meta({ id: 'TerminalInput' });
export const terminalPatchSchema = terminalInputSchema.partial().meta({ id: 'TerminalPatch' });
export const terminalStatusSchema = z
  .strictObject({ enabled: z.boolean(), reason: z.string().trim().max(300).nullish() })
  .meta({ id: 'TerminalStatusInput' });
export const pairingCodeSchema = z
  .object({ code: z.string().describe('Shown once, e.g. "ABCD-EFGH"'), expiresAt: z.string() })
  .meta({ id: 'PairingCode' });

export const pairSchema = z
  .strictObject({
    pairingCode: text(20),
    deviceFingerprint: text(128),
    devicePublicKey: z
      .string()
      .max(2000)
      .optional()
      .describe('Recorded for a later key-based sign-in'),
  })
  .meta({ id: 'TerminalPair' });
export const pairedSchema = z
  .object({
    terminalId: z.uuid(),
    credential: z.string().describe('The device secret, shown once; signs every sign-in'),
    purpose,
    institution: z.string(),
  })
  .meta({ id: 'TerminalPaired' });
export const terminalSignInSchema = z
  .strictObject({
    terminalId: uuid,
    deviceFingerprint: text(128),
    nonce: text(80).describe('"<unix seconds>.<random>", used once'),
    signature: text(64).describe('hex HMAC-SHA256(credential, "<terminalId>.<nonce>")'),
  })
  .meta({ id: 'TerminalSignIn' });
export const terminalSessionSchema = z
  .object({ accessToken: z.string(), purpose, expiresAt: z.string() })
  .meta({ id: 'TerminalSession' });

// --- cards ----------------------------------------------------------------------------------------------
export const cardTokenSchema = z.strictObject({ cardToken: text(32) }).meta({ id: 'CardTap' });
export const kioskSchema = z
  .object({
    member: z.object({ id: z.uuid(), name: z.string() }),
    campus: z.object({ balance: money, status: z.string() }).nullable(),
    allowance: z.object({ balance: money, status: z.string() }).nullable(),
  })
  .meta({ id: 'KioskBalance' });
export const cardWriteSchema = z
  .strictObject({ memberId: uuid, hardwareUid: text(32) })
  .meta({ id: 'CardWrite' });
export const cardWrittenSchema = z
  .object({ cardId: z.uuid(), cardToken: z.string().describe('Written to the card by the reader') })
  .meta({ id: 'CardWritten' });

export const cardSchema = z
  .object({
    id: z.uuid(),
    member: z.object({ id: z.uuid(), name: z.string() }),
    token: z.string().describe('Masked'),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    issueReason: z.string(),
    reissueCount: z.number().int(),
    statusReason: z.string().nullable(),
    blockedAt: z.string().nullable(),
    issuedAt: z.string(),
    lastTapAt: z.string().nullable(),
  })
  .meta({ id: 'Card' });
export const cardsSchema = z
  .object({ items: z.array(cardSchema), nextCursor: z.string().nullable() })
  .meta({ id: 'Cards' });
export const cardsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(200).optional(),
});
export const cardStatusSchema = z
  .strictObject({ action: z.enum(['BLOCK', 'REACTIVATE']), reason: text(300) })
  .meta({ id: 'CardStatusInput' });
export const reissueSchema = z
  .strictObject({
    reasonCode: z.enum(['LOST', 'DAMAGED', 'STOLEN', 'DEFECTIVE', 'EXPIRED'], {
      message: 'VALIDATION.FORMAT',
    }),
  })
  .meta({ id: 'CardReissue' });
export const reissuedSchema = z
  .object({ pairingForWrite: z.object({ code: z.string(), expiresAt: z.string() }) })
  .meta({ id: 'CardReissued' });
export const myCardSchema = z
  .object({
    card: z
      .object({
        id: z.uuid(),
        token: z.string(),
        status: z.enum(['ACTIVE', 'INACTIVE']),
        issueReason: z.string(),
        reissueCount: z.number().int(),
        statusReason: z.string().nullable(),
        issuedAt: z.string(),
        lastTapAt: z.string().nullable(),
        blockedAt: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'MyCard' });
export const lossSchema = z
  .strictObject({ for: uuid.optional(), reason: z.string().trim().max(300).nullish() })
  .meta({ id: 'CardLossReport' });

export const nfcTapSchema = z
  .strictObject({
    cardToken: text(32),
    nonce: text(64),
    readerSignature: z.string().max(200).optional(),
  })
  .meta({ id: 'NfcTap' });

export const terminalConfigSchema = z
  .object({
    terminal: z.object({
      id: z.uuid(),
      name: z.string(),
      location: z.string().nullable(),
      purpose: z.enum(TERMINAL_PURPOSES),
      locationType: z.string().nullable(),
      fingerprint: z.string().nullable().describe('The last characters of the bound device'),
      pairedAt: z.string().nullable(),
      registeredAt: z.string(),
      registeredBy: z.string().nullable(),
    }),
    institution: z.object({
      id: z.uuid(),
      name: z.string(),
      code: z.string(),
      city: z.string(),
      board: z.string().nullable(),
      status: z.string(),
    }),
    merchant: z.string().nullable(),
    section: z.string().nullable(),
  })
  .meta({ id: 'TerminalConfig' });

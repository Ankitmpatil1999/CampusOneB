/**
 * Partner API, bank credits and reconciliation DTOs (IDN-043, INT-001…008, WAL-010…013, REC-012/017).
 * The bank's request and response fields are an example contract until the sponsor bank's API is
 * known (C-11).
 */
import { z } from 'zod';
import { PARTNER_SCOPES } from '../config/registers';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });

// --- IDN-043 ------------------------------------------------------------------------------------------
export const tokenRequestSchema = z
  .strictObject({
    grant_type: text(40),
    client_id: text(40),
    client_secret: text(200),
    scope: z
      .string()
      .max(200)
      .optional()
      .describe('Space-separated; defaults to all the client holds'),
  })
  .meta({ id: 'PartnerTokenRequest' });

export const tokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    scope: z.string(),
  })
  .meta({ id: 'PartnerToken' });

// --- WAL-012 / WAL-013 --------------------------------------------------------------------------------
export const bankCreditSchema = z
  .strictObject({
    requestId: text(64).describe(
      'Unique per call; a repeat with the same body returns the first answer',
    ),
    corporateCode: text(10),
    vaNumber: text(30),
    amount: text(20).describe('Rupees, e.g. "500.00"'),
    utr: text(32),
    bankTxnId: text(40),
    mode: z.enum(['UPI', 'IMPS', 'NEFT', 'RTGS', 'OTHER']).optional(),
    sender: z
      .strictObject({
        name: z.string().max(120).optional(),
        accountLast4: z.string().max(4).optional(),
        ifsc: z.string().max(11).optional(),
      })
      .optional(),
    timestamp: z.string().max(40).optional(),
    creditedAt: z.string().max(40).optional(),
  })
  .meta({ id: 'BankCreditCall' });

export const bankAnswerSchema = z
  .object({
    code: z
      .string()
      .describe('000 accepted · 002 invalid virtual account · 003 invalid amount · 004 duplicate'),
    message: z.string(),
    creditRef: z.string().optional().describe('notify: the RPBC… ledger reference'),
    replayed: z.boolean().optional(),
  })
  .meta({ id: 'BankAnswer' });

// --- INT-001…008 ----------------------------------------------------------------------------------------
const scopes = z.array(z.enum(PARTNER_SCOPES, { message: 'INT.SCOPE_UNKNOWN' })).min(1, {
  message: 'VALIDATION.REQUIRED',
});
const allow = z.array(z.string().max(45)).max(50).describe('Addresses or IPv4 CIDR blocks');

const apiClient = z
  .object({
    id: z.uuid(),
    clientId: z.string(),
    name: z.string(),
    partner: z.string(),
    institutionId: z.uuid().nullable(),
    scopes: z.array(z.string()),
    ipAllowlist: z.array(z.string()),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    statusReason: z.string().nullable(),
    secretRotatedAt: z.string(),
    previousSecretValidUntil: z.string().nullable(),
    secretKind: z
      .enum(['ENCRYPTED', 'HASH'])
      .describe('HASH: imported with a bcrypt hash of its secret; bearer-only bank calls'),
    createdAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'ApiClient' });

export const apiClientsSchema = z
  .object({ items: z.array(apiClient.extend({ lastTokenAt: z.string().nullable() })) })
  .meta({ id: 'ApiClients' });
export { apiClient as apiClientSchema };

export const apiClientInputSchema = z
  .strictObject({
    name: text(100),
    partner: z.enum(['SPONSOR_BANK', 'PAYMENT_GATEWAY', 'POS_VENDOR', 'FINANCING', 'OTHER']),
    institutionId: z
      .uuid({ message: 'VALIDATION.FORMAT' })
      .optional()
      .describe('Required with the pos.* scopes: the institution whose counters the client serves'),
    scopes,
    ipAllowlist: allow,
  })
  .meta({ id: 'ApiClientInput' });

export const apiClientImportSchema = z
  .strictObject({
    name: text(100),
    partner: z.enum(['SPONSOR_BANK', 'PAYMENT_GATEWAY', 'POS_VENDOR', 'FINANCING', 'OTHER']),
    clientId: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .max(40)
      .describe('The client id the partner already holds, e.g. AXISBANKEC_6BBFE1A3'),
    secretHash: z
      .string({ message: 'INT.SECRET_HASH_FORMAT' })
      .max(100)
      .describe('The bcrypt hash of the secret the partner holds ($2b$12$…)'),
    scopes,
    ipAllowlist: allow,
  })
  .meta({ id: 'ApiClientImport' });

export const apiClientCreatedSchema = z
  .object({ id: z.uuid(), clientId: z.string(), secret: z.string().describe('Shown once') })
  .meta({ id: 'ApiClientCreated' });

export const apiClientPatchSchema = z
  .strictObject({
    name: text(100).optional(),
    scopes: scopes.optional(),
    ipAllowlist: allow.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    reason: z.string().trim().max(300).nullish(),
  })
  .meta({ id: 'ApiClientPatch' });

export const rotationSchema = z
  .strictObject({ overlapHours: z.number().int().optional() })
  .meta({ id: 'SecretRotation' });
export const rotatedSchema = z
  .object({ secret: z.string(), previousSecretValidUntil: z.string().nullable() })
  .meta({ id: 'SecretRotated' });

export const tokensSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        outcome: z.enum(['ISSUED', 'REFUSED']),
        reason: z.string().nullable(),
        scopes: z.array(z.string()),
        issuedAt: z.string(),
        expiresAt: z.string().nullable(),
        revokedAt: z.string().nullable(),
        live: z.boolean(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'ApiClientTokens' });

export const revokeSchema = z.strictObject({ reason: text(300) }).meta({ id: 'TokenRevocation' });

export const tokenPolicySchema = z
  .object({
    minutes: z.number().int(),
    min: z.number().int(),
    max: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'TokenPolicy' });
export const tokenPolicyInputSchema = z
  .strictObject({ minutes: z.number().int(), reason: text(300) })
  .meta({ id: 'TokenPolicyInput' });

// --- WAL-010 / WAL-011 ---------------------------------------------------------------------------------
export const heldQuerySchema = z.object({
  status: z.enum(['HELD', 'PROCESSED', 'RETURNED']).optional(),
  cursor: z.string().max(200).optional(),
});
export const heldCreditsSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        amount: money,
        member: z.object({ id: z.uuid(), name: z.string() }),
        wallet: z.object({ number: z.string(), status: z.string() }),
        vaNumber: z.string(),
        utr: z.string(),
        mode: z.string(),
        sender: z.string().nullable(),
        creditedAt: z.string(),
        status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'HELD', 'RETURNED']),
        reason: z.string().nullable(),
        resolvedAt: z.string().nullable(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'HeldCredits' });
export const returnSchema = z
  .strictObject({ reason: text(300), instructionRef: text(60) })
  .meta({ id: 'HeldCreditReturn' });
export const returnRaisedSchema = z
  .object({ approvalId: z.uuid(), no: z.string() })
  .meta({ id: 'HeldCreditReturnRaised' });

// --- REC-012 / REC-017 ---------------------------------------------------------------------------------
export const reconQuerySchema = z.object({
  institutionId: z.uuid().optional(),
  onlyDifferences: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});
export const balanceCheckSchema = z
  .object({
    checkedAt: z.string(),
    checked: z.number().int(),
    differences: z.array(
      z.object({
        walletId: z.uuid(),
        walletNo: z.string(),
        kind: z.string(),
        institution: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
        stored: money,
        ledger: money,
        ledgerNegative: z.boolean(),
        difference: money,
        differenceSign: z.number().int(),
        entries: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'BalanceCheck' });

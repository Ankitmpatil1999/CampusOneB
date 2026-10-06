/**
 * Payment, merchant and QR DTOs (PAY-001/002, PAY-007…011, PAY-013/014, PAY-016…024, PAY-029/030;
 * prototype m.scan, m.pay, m.mer.*, c.merchants). Money is a string of rupees with `"currency": "INR"`.
 */
import { z } from 'zod';
import { PAYMENT_STAGES } from '../config/registers';
import { PATTERNS } from '../utils/validators';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const moneyIn = z
  .object({
    amount: z.string({ message: 'VALIDATION.AMOUNT' }).regex(/^\d{1,9}(\.\d{1,2})?$/, {
      message: 'VALIDATION.AMOUNT',
    }),
    currency: z.literal('INR', { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'MoneyInput' });
const required = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const uuid = z.uuid({ message: 'VALIDATION.FORMAT' });
const pin = z
  .string({ message: 'IDN.TPIN_FORMAT' })
  .regex(PATTERNS.tpin, { message: 'IDN.TPIN_FORMAT' });
const stage = z.enum(PAYMENT_STAGES);
const kind = z.enum(['PAYMENT', 'ALLOWANCE', 'COUPON']);

// --- member -----------------------------------------------------------------------------------------
export const resolveSchema = z
  .strictObject({ qrPayload: required(200).describe('The scanned text, e.g. ringpe://pay/s/…') })
  .meta({ id: 'QrResolve' });

export const resolvedSchema = z
  .object({
    kind: z.enum(['PAYMENT', 'ALLOWANCE', 'COUPON', 'DYNAMIC', 'NFC']),
    merchant: z.object({
      name: z.string(),
      code: z.string().describe('The last 9 characters of the merchant code'),
      subType: z.enum(['REGULAR', 'VENDOR']),
    }),
    request: z
      .object({ id: z.uuid(), amount: money, expiresAt: z.string() })
      .nullable()
      .describe('A dynamic request: the amount set by the counter and when it expires'),
    instruments: z.array(z.enum(['WALLET', 'ALLOWANCE'])),
    vendor: z.object({ assetRequired: z.boolean(), invoiceRequired: z.boolean() }).nullable(),
    maxAmount: money.nullable().describe('Static QR: the channel maximum (pay.staticQr.maxPaise)'),
    stages: z.array(stage).describe('The stages the processing screen shows, in order'),
  })
  .meta({ id: 'QrResolved' });

export const payInputSchema = z
  .strictObject({
    qrPayload: required(200).optional().describe('A scanned code (or eventId)'),
    eventId: z.uuid({ message: 'VALIDATION.FORMAT' }).optional().describe('A paid event (13.10)'),
    amount: moneyIn.optional().describe('Static QR only: the amount typed by the payer'),
    vendor: z
      .strictObject({
        assetId: required(40),
        invoiceNo: z
          .string({ message: 'VALIDATION.REQUIRED' })
          .trim()
          .regex(/^[A-Za-z0-9]{1,40}$/, { message: 'VALIDATION.FORMAT' }),
      })
      .optional()
      .describe('Vendor merchants: the approved asset and the invoice number (BR-20)'),
    pin,
  })
  .refine((b) => !!b.qrPayload !== !!b.eventId, {
    message: 'VALIDATION.REQUIRED',
    path: ['qrPayload'],
  })
  .meta({ id: 'PaymentInput' });

export const paymentResultSchema = z
  .object({
    receipt: z.object({
      id: z.uuid(),
      reference: z.string().describe('RPEP… (35 characters)'),
      status: z.enum(['PENDING', 'SUCCESS', 'FAILURE']),
      channel: z.string(),
      amount: money,
      merchant: z.object({ name: z.string(), code: z.string() }),
      paidFrom: z.literal('CAMPUS_WALLET'),
      paidAt: z.string(),
      balanceAfter: money.nullable(),
    }),
    stages: z.array(stage),
    replayed: z.boolean(),
  })
  .meta({ id: 'PaymentResult' });

// --- merchant (own app) ------------------------------------------------------------------------------
export const qrCode = z
  .object({
    id: z.uuid(),
    kind,
    status: z.enum(['ACTIVE', 'INACTIVE']),
    statusReason: z.string().nullable(),
    createdAt: z.string(),
    statusChangedAt: z.string().nullable(),
    payload: z.string(),
    svg: z.string().describe('The code as a scalable SVG'),
    version: z.number().int(),
  })
  .meta({ id: 'MerchantQr' });
export const qrListSchema = z.object({ items: z.array(qrCode) }).meta({ id: 'MerchantQrList' });

const merchantView = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    uniqueId: z.string(),
    subType: z.enum(['REGULAR', 'VENDOR']),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
    statusReason: z.string().nullable(),
    department: z.string().nullable(),
    operator: z.string(),
    mobile: z.string().nullable(),
    email: z.string().nullable(),
    accepts: z.object({ wallet: z.boolean(), allowance: z.boolean(), coupon: z.boolean() }),
    channels: z.object({ dynamicQr: z.boolean(), nfc: z.boolean() }),
    isFeeAccount: z.boolean(),
    today: z.object({ amount: money, count: z.number().int() }),
    onboardedAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Merchant' });

const wallet = z.object({ walletNo: z.string(), status: z.string(), balance: money }).nullable();

export const merchantHomeSchema = z
  .object({
    merchant: merchantView,
    today: z.object({ gross: money, count: z.number().int() }),
    pendingSettlement: money.nullable().describe('Settlement runs arrive in Phase 6'),
    wallet,
    qr: z.array(z.object({ id: z.uuid(), kind, status: z.enum(['ACTIVE', 'INACTIVE']) })),
    openRequests: z.number().int(),
  })
  .meta({ id: 'MerchantHome' });

export const emailQrSchema = z
  .strictObject({
    email: z
      .string()
      .trim()
      .max(254, { message: 'VALIDATION.EMAIL' })
      .regex(PATTERNS.email, { message: 'VALIDATION.EMAIL' })
      .nullish()
      .describe('Defaults to the merchant e-mail'),
  })
  .meta({ id: 'QrEmail' });

export const collectionsQuerySchema = z.object({
  from: z.iso.date({ message: 'VALIDATION.DATE' }).optional(),
  to: z.iso.date({ message: 'VALIDATION.DATE' }).optional(),
  status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']).optional(),
  channel: z.string().max(24).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const collectionsSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        reference: z.string(),
        channel: z.string(),
        amount: money,
        status: z.enum(['PENDING', 'SUCCESS', 'FAILURE']),
        failureCode: z.string().nullable(),
        payer: z.string(),
        at: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
    totals: z.object({ amount: money, count: z.number().int() }),
  })
  .meta({ id: 'MerchantCollections' });

export const requestInputSchema = z
  .strictObject({
    kind: z.enum(['DYNAMIC_QR', 'NFC'], { message: 'VALIDATION.FORMAT' }),
    amount: moneyIn,
    instrument: z.literal('WALLET', { message: 'VALIDATION.FORMAT' }).default('WALLET'),
  })
  .meta({ id: 'PaymentRequestInput' });

export const requestCreatedSchema = z
  .object({
    requestId: z.uuid(),
    kind: z.enum(['DYNAMIC_QR', 'NFC']),
    amount: money,
    qrPayload: z.string().nullable(),
    svg: z.string().nullable(),
    nonce: z.string().nullable().describe('NFC: the one-time nonce the reader presents (once)'),
    expiresAt: z.string(),
    ttlSeconds: z.number().int(),
  })
  .meta({ id: 'PaymentRequestCreated' });

export const requestStatusSchema = z
  .object({
    requestId: z.uuid(),
    kind: z.enum(['DYNAMIC_QR', 'NFC']),
    amount: money,
    status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED']),
    failureCode: z.string().nullable(),
    expiresAt: z.string(),
    payer: z.string().nullable(),
    receipt: z.object({ reference: z.string() }).nullable(),
  })
  .meta({ id: 'PaymentRequestStatus' });

// --- console -----------------------------------------------------------------------------------------
export const merchantsQuerySchema = z.object({
  q: z.string().max(100).optional(),
  subType: z.enum(['REGULAR', 'VENDOR']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const merchantListSchema = z
  .object({
    items: z.array(merchantView),
    nextCursor: z.string().nullable(),
    kpis: z.object({
      total: z.number().int(),
      active: z.number().int(),
      collectionsToday: money,
      paymentsToday: z.number().int(),
    }),
  })
  .meta({ id: 'MerchantList' });

export const merchantDetailSchema = merchantView
  .extend({
    bank: z
      .object({
        holderName: z.string().nullable(),
        bankName: z.string().nullable(),
        accountNumber: z.string().nullable().describe('Masked: the last four digits only'),
        ifsc: z.string(),
        chequeFileId: z.uuid().nullable(),
      })
      .nullable(),
    wallet,
    qrCodes: z.array(qrCode),
  })
  .meta({ id: 'MerchantDetail' });

const bankIn = z.strictObject({
  holderName: required(120),
  bankName: z.string().trim().max(120).nullish(),
  accountNumber: required(18),
  ifsc: required(11),
});

const displayName = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .trim()
  .min(3, { message: 'VALIDATION.FORMAT' })
  .max(40, { message: 'VALIDATION.FORMAT' });

export const merchantInputSchema = z
  .strictObject({
    displayName,
    operatorFirstName: required(60),
    operatorLastName: z.string().trim().max(60).nullish(),
    subType: z.enum(['REGULAR', 'VENDOR'], { message: 'VALIDATION.FORMAT' }),
    departmentId: uuid.nullish(),
    mobile: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .regex(/^[6-9]\d{9}$/, { message: 'VALIDATION.MOBILE' }),
    email: z
      .string()
      .trim()
      .max(254, { message: 'VALIDATION.EMAIL' })
      .regex(PATTERNS.email, { message: 'VALIDATION.EMAIL' })
      .nullish(),
    acceptsAllowance: z.boolean().optional(),
    acceptsCoupon: z.boolean().optional(),
    bank: bankIn.nullish(),
    chequeFileId: uuid.nullish(),
    logoFileId: uuid.nullish(),
  })
  .meta({ id: 'MerchantInput' });

export const merchantCreatedSchema = z
  .object({ merchantId: z.uuid(), uniqueId: z.string() })
  .meta({ id: 'MerchantCreated' });

export const merchantPatchSchema = z
  .strictObject({
    displayName: displayName.optional(),
    acceptsAllowance: z.boolean().optional(),
    acceptsCoupon: z.boolean().optional(),
    bank: bankIn.optional(),
    chequeFileId: uuid.nullish(),
    logoFileId: uuid.nullish(),
  })
  .meta({ id: 'MerchantPatch' });

export const merchantStatusSchema = z
  .strictObject({
    to: z.enum(['ACTIVE', 'INACTIVE'], { message: 'VALIDATION.FORMAT' }),
    reason: z.string().trim().max(300).nullish(),
  })
  .meta({ id: 'MerchantStatusInput' });

export const channelsSchema = z
  .strictObject({
    dynamicQr: z.boolean({ message: 'VALIDATION.REQUIRED' }),
    nfc: z.boolean({ message: 'VALIDATION.REQUIRED' }),
  })
  .meta({ id: 'MerchantChannels' });

export const qrGenerateSchema = z
  .strictObject({ kind: kind.describe('Each kind is generated once per merchant') })
  .meta({ id: 'QrGenerate' });

export const qrStatusSchema = z
  .strictObject({
    status: z.enum(['ACTIVE', 'INACTIVE'], { message: 'VALIDATION.FORMAT' }),
    reason: z.string().trim().max(300).nullish().describe('Required to deactivate'),
  })
  .meta({ id: 'QrStatusInput' });

export const qrEmailsSchema = z
  .strictObject({
    merchantIds: z.array(uuid).max(500).optional(),
    all: z.boolean().optional(),
  })
  .meta({ id: 'QrEmails' });

export const qrEmailsResultSchema = z
  .object({ sent: z.number().int(), skipped: z.number().int() })
  .meta({ id: 'QrEmailsResult' });

// --- transfers (WAL-006/007) ----------------------------------------------------------------------
export const recipientLookupSchema = z
  .strictObject({
    mobile: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .regex(/^[6-9]\d{9}$/, { message: 'VALIDATION.MOBILE' }),
  })
  .meta({ id: 'RecipientLookup' });

export const recipientsSchema = z
  .object({
    candidates: z.array(
      z.object({
        profileId: z.uuid(),
        name: z.string().describe('First name and initial, e.g. "Aarav H."'),
        userType: z.string(),
        grade: z.string().nullable(),
        wallet: z.string().nullable().describe('Masked campus wallet number'),
      }),
    ),
  })
  .meta({ id: 'Recipients' });

export const transferInputSchema = z
  .strictObject({
    toProfileId: uuid,
    amount: moneyIn,
    note: z.string().trim().max(60, { message: 'VALIDATION.FORMAT' }).nullish(),
    pin,
  })
  .meta({ id: 'TransferInput' });

export const transferResultSchema = z
  .object({
    receipt: z.object({
      id: z.uuid(),
      reference: z.string().describe('RPET… (35 characters)'),
      status: z.enum(['PENDING', 'SUCCESS', 'FAILURE']),
      amount: money,
      to: z.object({ name: z.string() }),
      note: z.string().nullable(),
      paidAt: z.string(),
      balanceAfter: money.nullable(),
    }),
    stages: z.array(stage),
    replayed: z.boolean(),
  })
  .meta({ id: 'TransferResult' });

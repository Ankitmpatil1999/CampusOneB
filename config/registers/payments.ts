/**
 * Payment channels and transaction references (27.4 §8–§10; RNG-PAY-128/129; docs/01 §5
 * `pay.reference`; docs/03 §8).
 *
 * - A ledger transaction carries the channel it came from. The legacy numeric payment modes
 *   1–8 (RNG-PAY-129) are kept for the engine record; the other channels are this build's.
 * - A reference is 35 characters: a 4-letter prefix, 23 random [A-Z0-9], the last digit of the
 *   year, the day of the year (3) and HHmm (IST). RPEP / RPET / RPAW are 27.4's; the prefixes of
 *   the other movement types are a register addition (Q21, client standing approval 2026-10-03).
 */
import { randomBytes } from 'node:crypto';
import type { LedgerTxnType } from '../../models/ringpe_models';

export interface PaymentChannelDefinition {
  readonly code: string;
  /** Legacy numeric payment mode (RNG-PAY-129), when the channel is one of the eight. */
  readonly mode: number | null;
  readonly label: string;
}

/**
 * Payment gateways a school can add (client 2026-10-09). Each needs its credentials (all stored
 * encrypted) and an implementation in integrations/; only the ones listed here are accepted.
 */
export const PAYMENT_GATEWAY_PROVIDERS = [
  {
    code: 'RAZORPAY',
    name: 'Razorpay',
    /** The key id's form: rzp_test_… (test mode) or rzp_live_… (live). */
    keyIdPattern: /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/,
    testPrefix: 'rzp_test_',
  },
] as const;
export type PaymentGatewayProvider = (typeof PAYMENT_GATEWAY_PROVIDERS)[number]['code'];

export const PAYMENT_CHANNELS = [
  { code: 'TRANSFER', mode: 1, label: 'Transfer' },
  { code: 'STATIC_QR', mode: 2, label: 'Static QR' },
  { code: 'ALLOWANCE', mode: 3, label: 'Allowance' },
  { code: 'TUITION', mode: 4, label: 'Tuition' },
  { code: 'POS_QR', mode: 5, label: 'POS QR' },
  { code: 'DYNAMIC_QR', mode: 6, label: 'Dynamic QR' },
  { code: 'NFC', mode: 7, label: 'NFC' },
  { code: 'EVENT', mode: 8, label: 'Event' },
  { code: 'BANK_VA', mode: null, label: 'Bank transfer to the virtual account' },
  { code: 'JOB', mode: null, label: 'Scheduled processing' },
  { code: 'CONSOLE', mode: null, label: 'Institution console' },
  { code: 'BACK_OFFICE', mode: null, label: 'Back office' },
  { code: 'PARTNER', mode: null, label: 'Partner' },
] as const satisfies readonly PaymentChannelDefinition[];

export type PaymentChannelCode = (typeof PAYMENT_CHANNELS)[number]['code'];

/**
 * Reference prefix per movement type: RPEP, RPET, RPAW from 27.4; RPEB, RPER, RPEV, RPES approved by
 * the client (Q24); the rest Q21 additions in the same pattern (event payments RPEE, as RPEV is the
 * reversal).
 */
export const REFERENCE_PREFIX: Readonly<Record<LedgerTxnType, string>> = {
  PAYMENT: 'RPEP',
  TRANSFER: 'RPET',
  ALLOWANCE_PAYMENT: 'RPAW',
  ALLOWANCE_CREDIT: 'RPAC',
  BANK_CREDIT: 'RPEB',
  TUITION: 'RPTF',
  COUPON_REDEMPTION: 'RPCR',
  EVENT: 'RPEE',
  REFUND: 'RPER',
  REVERSAL: 'RPEV',
  CHARGEBACK: 'RPCB',
  SETTLEMENT_PAYOUT: 'RPES',
  PLATFORM_FEE: 'RPPF',
  ADJUSTMENT: 'RPAD',
  HOLD_RELEASE: 'RPHR',
  ALLOWANCE_EXPIRY: 'RPAE',
};

/** Entry pass types (9.7, RNG-PAY-078: the configured types). */
export const PASS_TYPES = [
  { code: 'FEST-ENTRY', label: 'Fest entry' },
  { code: 'COLLEGE-ENTRY', label: 'College entry' },
] as const;
export type PassType = (typeof PASS_TYPES)[number]['code'];

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A 35-character reference for a movement posted at `at` (IST parts). */
export function newReference(type: LedgerTxnType, at: Date): string {
  const bytes = randomBytes(23);
  let random = '';
  for (const b of bytes) random += ALPHABET[b % ALPHABET.length];
  const ist = new Date(at.getTime() + 330 * 60_000);
  const year = ist.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const day =
    Math.floor((Date.UTC(year, ist.getUTCMonth(), ist.getUTCDate()) - start) / 86_400_000) + 1;
  const hhmm = `${String(ist.getUTCHours()).padStart(2, '0')}${String(ist.getUTCMinutes()).padStart(2, '0')}`;
  return `${REFERENCE_PREFIX[type]}${random}${String(year).slice(-1)}${String(day).padStart(3, '0')}${hhmm}`;
}

/**
 * QR payloads (9.2, 9.3). A RingPe link so a phone camera opens the app; the code is an opaque random
 * token (26 characters, base32) — a static merchant code (`s`) or a dynamic request (`d`). The token
 * identifies the payee only; the payer confirms with the PIN.
 */
export const QR_TOKEN_PATTERN = /^[A-Z2-7]{26}$/;
export const QR_PAYLOAD_PATTERN = /^ringpe:\/\/pay\/([sd])\/([A-Z2-7]{26})$/;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new 26-character token (130 bits). */
export function newQrToken(): string {
  const bytes = randomBytes(26);
  let out = '';
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

export const qrPayload = (kind: 's' | 'd', token: string) => `ringpe://pay/${kind}/${token}`;

/** The kind and token of a scanned payload, or null when it isn't a RingPe payment code. */
export function parseQrPayload(payload: string): { kind: 's' | 'd'; token: string } | null {
  const m = QR_PAYLOAD_PATTERN.exec(payload.trim());
  return m ? { kind: m[1] as 's' | 'd', token: m[2]! } : null;
}

/**
 * The engine's steps (docs/03 §8.2): caller guards G2–G6, pre-checks P1–P8 (no record on refusal),
 * validations V1–V13 (the record is kept as a failure).
 */
export type PaymentCheck =
  | 'G2'
  | 'G3'
  | 'G4'
  | 'G5'
  | 'G6'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'P4'
  | 'P5'
  | 'P6'
  | 'P7'
  | 'P8'
  | 'V1'
  | 'V2'
  | 'V3'
  | 'V4'
  | 'V5'
  | 'V6'
  | 'V7'
  | 'V8'
  | 'V9'
  | 'V10'
  | 'V11'
  | 'V12'
  | 'V13';

/**
 * The stages a member sees on the processing screen, in order (prototype `E.PAY_STEPS`). The apps
 * translate the keys; `vendor`, `request`, `nfc`, `event` and `order` appear only when they apply.
 */
export const PAYMENT_STAGES = [
  'identify',
  'institution',
  'permission',
  'amount',
  'walletsActive',
  'balance',
  'vendor',
  'request',
  'nfc',
  'event',
  'order',
  'post',
] as const;
export type PaymentStage = (typeof PAYMENT_STAGES)[number];

export const STAGE_OF_CHECK: Readonly<Record<PaymentCheck, PaymentStage>> = {
  G2: 'amount',
  G3: 'request',
  G4: 'walletsActive',
  G5: 'walletsActive',
  G6: 'balance',
  P1: 'identify',
  P2: 'event',
  P3: 'order',
  P4: 'vendor',
  P5: 'vendor',
  P6: 'request',
  P7: 'request',
  P8: 'vendor',
  V1: 'identify',
  V2: 'identify',
  V3: 'identify',
  V4: 'institution',
  V5: 'permission',
  V6: 'permission',
  V7: 'amount',
  V8: 'amount',
  V9: 'identify',
  V10: 'walletsActive',
  V11: 'walletsActive',
  V12: 'amount',
  V13: 'balance',
};

/** The stages of a transfer (8.7; prototype `E.transferSteps`). */
export const TRANSFER_STAGES: readonly PaymentStage[] = [
  'amount',
  'identify',
  'walletsActive',
  'permission',
  'balance',
  'post',
];

/** The stages shown for a payment: the six base stages, those that apply, then the posting. */
export function stagesFor(o: {
  readonly vendor?: boolean;
  readonly request?: 'DYNAMIC_QR' | 'NFC' | null;
  readonly event?: boolean;
  readonly order?: boolean;
}): PaymentStage[] {
  const out: PaymentStage[] = [
    'identify',
    'institution',
    'permission',
    'amount',
    'walletsActive',
    'balance',
  ];
  if (o.vendor) out.push('vendor');
  if (o.request) out.push(o.request === 'NFC' ? 'nfc' : 'request');
  if (o.event) out.push('event');
  if (o.order) out.push('order');
  out.push('post');
  return out;
}

/** Scopes a partner client may hold (INT-002; WAL-012/013). */
export const PARTNER_SCOPES = [
  'va.validate',
  'va.notify',
  // A POS partner's counters (9.10, 12.10; MER-014…016); the client serves one institution.
  'pos.qr-create',
  'pos.qr-status',
  'pos.offline-sync',
  // The fee-financing partner (13.12; FEE-026/027): its webhook and the minimum fee data it reads.
  'fee.webhook',
  'fee.read',
] as const;
/** Scopes that bind a client to one institution. */
export const INSTITUTION_SCOPES: readonly PartnerScope[] = [
  'pos.qr-create',
  'pos.qr-status',
  'pos.offline-sync',
];
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

/**
 * Response codes of the virtual-account calls (WAL-012/013). An example contract until the sponsor
 * bank's API is known (C-11): 000 accepted, 002 invalid virtual account, 003 invalid amount,
 * 004 duplicate UTR. Each maps to its register message.
 */
export const BANK_RESPONSES = {
  OK: { code: '000', message: 'WAL.BANK_OK' },
  INVALID_VA: { code: '002', message: 'WAL.BANK_INVALID_VA' },
  INVALID_AMOUNT: { code: '003', message: 'WAL.BANK_INVALID_AMOUNT' },
  DUPLICATE: { code: '004', message: 'WAL.BANK_DUPLICATE' },
} as const;

/**
 * The Axis Bank Power E-coll format (client 2026-10-12, "Updated Axis Bank APIs for Integration"; the
 * earlier application's answers kept word for word, as the bank already reads them). Bank protocol
 * values, not texts shown to people.
 */
export const AXIS_BANK_SCOPES = {
  transaction_validation: 'va.validate',
  transaction_notification_posting: 'va.notify',
} as const satisfies Record<string, PartnerScope>;
export type AxisBankScope = keyof typeof AXIS_BANK_SCOPES;

export const AXIS_BANK_RESPONSES = {
  SUCCESS: { flag: 'S', code: '000', message: 'Success' },
  INVALID_PARAMS: { flag: 'F', code: '003', message: 'Invalid request parameters' },
  INVALID_VAN: { flag: 'F', code: '002', message: 'Invalid Van' },
  INCORRECT_VAN: { flag: 'F', code: '002', message: 'Incorrect Van' },
  INVALID_DATE: { flag: 'F', code: '006', message: 'Invalid date format' },
  SERVER_ERROR: { flag: 'F', code: '999', message: 'Internal server error' },
  // notification
  MISSING_FIELDS: {
    flag: 'F',
    code: '001',
    message: 'Authentication failed',
    error: 'Missing mandatory fields',
  },
  NOTIFY_INVALID_DATE: {
    flag: 'F',
    code: '006',
    message: 'Invalid date format. Expected YYYY-MM-DD',
  },
  INVALID_REQ_TYPE: {
    flag: 'F',
    code: '003',
    message: 'Invalid request type',
    error: "Request type must be 'notification'",
  },
  NOT_VALIDATED: {
    flag: 'F',
    code: '001',
    message: 'Authentication failed',
    error: 'Validation not completed or failed',
  },
  DUPLICATE_UTR: { flag: 'F', code: '002', message: 'Duplicate UTR' },
  NOTIFY_INVALID_VAN: { flag: 'F', code: '004', message: 'Invalid VAN' },
  NOTIFY_FAILED: {
    flag: 'F',
    code: '001',
    message: 'Authentication failed',
    error: 'Posting failed',
  },
} as const;
export type AxisBankResponse = (typeof AXIS_BANK_RESPONSES)[keyof typeof AXIS_BANK_RESPONSES];

/** The bank's refusals of a call itself (address, token, scope), as the earlier application sent them. */
export const AXIS_BANK_AUTH_ERRORS = {
  IP_NOT_ALLOWED: 'Access denied: IP not whitelisted',
  MISSING_TOKEN: 'Missing bearer token',
  INVALID_TOKEN: 'Invalid token',
  INSUFFICIENT_SCOPE: 'Insufficient scope',
} as const;

/** 27.4 reference shape (pay.reference). */
export const REFERENCE_PATTERN = /^RP[A-Z]{2}[A-Z0-9]{23}\d{8}$/;

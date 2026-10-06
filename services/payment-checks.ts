/**
 * The payment engine's ordered checks (SRS §9.11, RNG-PAY-123…126; docs/03 §8.2; docs/01 §4.3) as
 * pure functions over facts the engine has read. Keeping them free of I/O lets the tests cover every
 * branch (CLAUDE.md: 100 % on the §9.11 checks); the engine supplies the facts and acts on the result.
 *
 * - Caller guards G2, G4, G5 run before anything is written (G3 and G6 need the database and live in
 *   the engine: the request row lock and the PIN / spending cap).
 * - Pre-checks P1–P8: a refusal writes no payment record.
 * - Validations V1–V12, then V13 under the wallet row locks: a refusal keeps the record as a failure.
 * - The first failure stops the pipeline; each refusal names its step and the message key.
 * - An allowance payment (SRS 10.7) takes the same steps from the allowance wallet, with its own
 *   wording (MSG-ALW-76…83): the merchant must accept allowances (V6), and the grant's daily limits
 *   are a spending limit (G6, today's spend — OI-ALW-10).
 */
import {
  STAGE_OF_CHECK,
  type MessageKey,
  type PaymentChannelCode,
  type PaymentCheck,
  type PaymentStage,
} from '../config/registers';
import { formatInr } from '../utils/format';

export interface Refusal {
  readonly check: PaymentCheck;
  readonly stage: PaymentStage;
  readonly code: MessageKey;
  readonly status: number;
  readonly params?: Readonly<Record<string, string | number>>;
}

const refuse = (
  check: PaymentCheck,
  code: MessageKey,
  status: number,
  params?: Readonly<Record<string, string | number>>,
): Refusal => ({
  check,
  stage: STAGE_OF_CHECK[check],
  code,
  status,
  ...(params ? { params } : {}),
});

export type ProfileStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
export type WalletState = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

/** A party to the payment as read from its institution profile. */
export interface PartyFacts {
  readonly profileId: string;
  readonly institutionId: string;
  readonly status: ProfileStatus;
  /** The user type's category (STUDENT, PARENT, STAFF, MERCHANT …). */
  readonly category: string;
  readonly txnPermission: boolean;
  readonly name: string;
  /** Merchant sub-type, for a merchant payee. */
  readonly subType: 'REGULAR' | 'VENDOR' | null;
}

export interface WalletFacts {
  readonly id: string;
  readonly status: WalletState;
  readonly availablePaise: number;
}

/** A named payment request (dynamic QR / NFC), re-read under its row lock. */
export interface RequestFacts {
  readonly status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly expiresAt: Date;
  /** A payment attempt is already linked to the request. */
  readonly hasPayment: boolean;
}

/** An allowance payment (10.7): what the merchant accepts and the grant's limits and today's use. */
export interface AllowanceFacts {
  /** A regular merchant that accepts allowances (RNG-ALW-068 (6), (7)). */
  readonly merchantAccepts: boolean;
  readonly dailyCount: number | null;
  readonly dailyAmountPaise: number | null;
  /** Successful allowance payments of the payer today (IST). */
  readonly countToday: number;
  readonly spentTodayPaise: number;
}

export interface PaymentFacts {
  readonly channel: PaymentChannelCode;
  /** The session's institution (golden rule: never from the request). */
  readonly institutionId: string | null;
  readonly payerProfileId: string | null;
  readonly payeeProfileId: string | null;
  readonly amountPaise: number | null;
  readonly remarks: string | null;
  readonly payer: PartyFacts | null;
  readonly payee: PartyFacts | null;
  readonly payerWallet: WalletFacts | null;
  readonly payeeWallet: WalletFacts | null;
  /** Purpose references (P2–P8); `undefined` when the payment names none. */
  /** A paid event (13.10): Active and within its dates; whether this payer has paid it already. */
  readonly event?: { readonly active: boolean; readonly alreadyPaid?: boolean } | undefined;
  readonly order?: { readonly payable: boolean } | undefined;
  /** A fee record (13.15, the tuition input): open, the payer's own, for its outstanding amount. */
  readonly feeRecord?: { readonly payable: boolean } | undefined;
  readonly asset?: { readonly active: boolean } | undefined;
  readonly invoice?: { readonly invoiceNo: string; readonly alreadyPaid: boolean } | undefined;
  readonly request?: RequestFacts | undefined;
  /** Present when the payment is made from the allowance wallet (`payerWallet` is that wallet). */
  readonly allowance?: AllowanceFacts | undefined;
  readonly now: Date;
  /** Request lifetime in seconds (`pay.request.ttlSeconds`), for the expiry message. */
  readonly requestTtlSeconds: number;
}

export interface GuardLimits {
  readonly staticQrMaxPaise: number;
  readonly dynamicQrMaxPaise: number;
  readonly transferMaxPaise: number;
  readonly pendingGuardMaxPaise: number;
}

/** Channel maximum (27.4 §8–§10); `null` when the channel has none here. */
export function channelMax(channel: PaymentChannelCode, limits: GuardLimits): number | null {
  switch (channel) {
    case 'STATIC_QR':
      return limits.staticQrMaxPaise;
    case 'DYNAMIC_QR':
    case 'POS_QR':
    case 'NFC':
      return limits.dynamicQrMaxPaise;
    case 'TRANSFER':
      return limits.transferMaxPaise;
    default:
      return null;
  }
}

/** Rupees without the symbol or paise, as the K-class texts print them ("1,000"). */
const rupeesPlain = (paise: number) => formatInr(paise).replace('₹', '').replace(/\.00$/, '');
const rupees0 = (paise: number) => formatInr(paise).replace(/\.00$/, '');

/**
 * Caller guards that need no lock: G2 (the channel's maximum; the amount format is the schema's),
 * G4 (a pending payment holds back payments above the guard limit, on every channel) and G5 (wallet
 * status, CR-08: a suspended or inactive wallet is refused before anything is written).
 */
function guardChecks(
  f: Pick<PaymentFacts, 'channel' | 'amountPaise' | 'payee' | 'payerWallet' | 'payeeWallet'>,
  o: { readonly limits: GuardLimits; readonly pendingCount: number },
): Refusal | null {
  const amount = f.amountPaise ?? 0;
  const max = channelMax(f.channel, o.limits);
  if (max !== null && amount > max)
    return refuse('G2', 'PAY.LIMIT_EXCEEDED', 422, { max: rupees0(max) });
  if (o.pendingCount > 0 && amount > o.limits.pendingGuardMaxPaise) {
    return refuse('G4', 'PAY.PENDING_GUARD', 409, {
      limit: rupeesPlain(o.limits.pendingGuardMaxPaise),
    });
  }
  const payerWallet = f.payerWallet?.status;
  if (payerWallet === 'SUSPENDED') return refuse('G5', 'PAY.PAYER_WALLET_SUSPENDED', 409);
  if (payerWallet === 'INACTIVE') return refuse('G5', 'PAY.PAYER_WALLET_INACTIVE', 409);
  if (f.payeeWallet && f.payeeWallet.status !== 'ACTIVE') {
    return refuse('G5', 'PAY.PAYEE_WALLET_INACTIVE', 409, { name: f.payee?.name ?? '' });
  }
  return null;
}

/** P1–P8 (RNG-PAY-123): a refusal rolls back and writes no payment record. */
export function preChecks(f: PaymentFacts): Refusal | null {
  // P1 — the parties, institution, amount and remarks are present (amount 0 counts as missing).
  if (
    !f.payerProfileId ||
    !f.payeeProfileId ||
    !f.institutionId ||
    !f.amountPaise ||
    !f.remarks?.trim()
  ) {
    return refuse('P1', 'VALIDATION.REQUIRED', 422);
  }
  // P2 — a named event is active.
  if (f.event && !f.event.active) return refuse('P2', 'FEE.EVENT_CLOSED', 409);
  // P2 — and paid once per payer (RNG-FEE-094).
  if (f.event?.alreadyPaid) return refuse('P2', 'FEE.EVENT_ALREADY_PAID', 409);
  // P3 — a named canteen order is open with its payment pending.
  if (f.order && !f.order.payable) return refuse('P3', 'MER.ORDER_PAID', 409);
  // P3 — likewise a named fee record (the tuition reference of RNG-PAY-123).
  if (f.feeRecord && !f.feeRecord.payable) return refuse('P3', 'FEE.RECORD_PAID', 409);
  // P4 — a named asset is active in the institution.
  if (f.asset && !f.asset.active) return refuse('P4', 'PAY.VENDOR_ASSET_REQUIRED', 422);
  // P5 — a named invoice is not already on a successful payment (BR-20).
  if (f.invoice?.alreadyPaid) {
    return refuse('P5', 'PAY.INVOICE_ALREADY_PAID', 409, { invoiceNo: f.invoice.invoiceNo });
  }
  // P6 — a named request is pending and unexpired; P7 — and has no payment yet.
  if (f.request) {
    const minutes = Math.max(1, Math.round(f.requestTtlSeconds / 60));
    if (f.request.status === 'SUCCESS') return refuse('P6', 'PAY.REQUEST_PAID', 409);
    if (f.request.status !== 'PENDING' || f.request.expiresAt.getTime() <= f.now.getTime()) {
      return refuse('P6', 'PAY.REQUEST_EXPIRED', 409, { minutes });
    }
    if (f.request.hasPayment) return refuse('P7', 'PAY.REQUEST_PAID', 409);
  }
  // P8 — a vendor is paid only against an asset and an invoice.
  if (f.payee?.subType === 'VENDOR' && (!f.asset || !f.invoice)) {
    return refuse('P8', 'PAY.VENDOR_ASSET_REQUIRED', 422);
  }
  return null;
}

/** V1–V12 (RNG-PAY-124): a refusal keeps the pending record as a failure with the reason. */
function validationChecks(f: PaymentFacts): Refusal | null {
  const { payer, payee } = f;
  // V1, V2 — both parties are found.
  if (!payer) return refuse('V1', 'PAY.PARTY_UNKNOWN', 404);
  if (!payee) return refuse('V2', 'PAY.PARTY_UNKNOWN', 404);
  // V3 — the payee is a merchant (transfers pay people through their own routine, 8.7).
  if (f.channel !== 'TRANSFER' && payee.category !== 'MERCHANT') {
    return refuse('V3', 'PAY.PAYEE_NOT_MERCHANT', 409);
  }
  // V4 — payer, payee and the session are in one institution (BR-12; another tenant is "unknown").
  if (payer.institutionId !== payee.institutionId || payer.institutionId !== f.institutionId) {
    return refuse('V4', 'PAY.PARTY_UNKNOWN', 404);
  }
  // V5 — the payer holds transaction permission (BR-13).
  if (!payer.txnPermission) return refuse('V5', 'PAY.NO_TXN_PERMISSION', 403);
  // V6 — the payee profile is active (CR-08).
  if (payee.status !== 'ACTIVE') {
    return refuse('V6', 'PAY.PAYEE_NOT_ACCEPTING', 409, { merchant: payee.name });
  }
  // V6 — an allowance is spent only at a regular merchant that accepts it (BR-42).
  if (f.allowance && !f.allowance.merchantAccepts) {
    return refuse('V6', 'ALW.MERCHANT_NOT_ACCEPTING', 409, { merchant: payee.name });
  }
  // V7 — the amount is above zero.
  if (!f.amountPaise || f.amountPaise <= 0) return refuse('V7', 'PAY.AMOUNT_INVALID', 422);
  // V8 — not to oneself.
  if (payer.profileId === payee.profileId) return refuse('V8', 'PAY.SELF_PAYMENT', 409);
  // V9 — both wallets exist.
  if (!f.payerWallet || !f.payeeWallet) return refuse('V9', 'PAY.PARTY_UNKNOWN', 404);
  // V10, V11 — both wallets are active (a second line after G5).
  if (f.payerWallet.status === 'SUSPENDED') return refuse('V10', 'PAY.PAYER_WALLET_SUSPENDED', 409);
  if (f.payerWallet.status !== 'ACTIVE') return refuse('V10', 'PAY.PAYER_WALLET_INACTIVE', 409);
  if (f.payeeWallet.status !== 'ACTIVE') {
    return refuse('V11', 'PAY.PAYEE_WALLET_INACTIVE', 409, { name: payee.name });
  }
  // V12 — two different wallets.
  if (f.payerWallet.id === f.payeeWallet.id) return refuse('V12', 'PAY.SELF_PAYMENT', 409);
  return null;
}

/**
 * Transfers (8.7) take the same steps for a person: the recipient's wording (MSG-WAL-75/77/79/84)
 * and the transfer screen's stage order (prototype `E.transferSteps`: amount, recipient found,
 * recipient and wallet active, your permission and wallet, balance, posted).
 */
function asTransfer(r: Refusal, f: Pick<PaymentFacts, 'payeeWallet'>): Refusal {
  const name = r.params?.['merchant'] ?? r.params?.['name'] ?? '';
  switch (r.check) {
    case 'G2':
      return { ...r, code: 'PAY.TRANSFER_LIMIT' };
    case 'V2':
    case 'V4':
      return { ...r, code: 'PAY.RECIPIENT_NOT_FOUND' };
    case 'V9':
      return f.payeeWallet ? r : { ...r, code: 'PAY.RECIPIENT_NOT_FOUND' };
    case 'V6':
    case 'V11':
      return {
        ...r,
        stage: 'walletsActive',
        code: 'PAY.RECIPIENT_CANNOT_RECEIVE',
        params: { name },
      };
    case 'G5':
      return r.code === 'PAY.PAYEE_WALLET_INACTIVE'
        ? { ...r, code: 'PAY.RECIPIENT_CANNOT_RECEIVE', params: { name } }
        : { ...r, stage: 'permission' };
    case 'V10':
      return { ...r, stage: 'permission' };
    case 'V8':
    case 'V12':
      return { ...r, stage: 'identify', code: 'PAY.SELF_TRANSFER' };
    default:
      return r;
  }
}

/** An allowance's wording for the steps it shares with a wallet payment (MSG-ALW-80, 81). */
function asAllowance(r: Refusal): Refusal {
  if (r.code === 'PAY.PAYER_WALLET_INACTIVE') return { ...r, code: 'ALW.WALLET_INACTIVE' };
  return r;
}

const worded = (
  r: Refusal | null,
  f: Pick<PaymentFacts, 'channel' | 'payeeWallet' | 'allowance'>,
) => (!r ? null : f.channel === 'TRANSFER' ? asTransfer(r, f) : f.allowance ? asAllowance(r) : r);

export function guards(
  f: Pick<
    PaymentFacts,
    'channel' | 'amountPaise' | 'payee' | 'payerWallet' | 'payeeWallet' | 'allowance'
  >,
  o: { readonly limits: GuardLimits; readonly pendingCount: number },
): Refusal | null {
  return worded(guardChecks(f, o), f);
}

export function validations(f: PaymentFacts): Refusal | null {
  return worded(validationChecks(f), f);
}

/**
 * G6 for an allowance (10.7, BR-42): the grant's payments a day and amount a day. The amount limit
 * counts today's spend (SRS FR-ALW-06, OQ-09; OI-ALW-10), not the whole period's.
 */
export function allowanceLimits(a: AllowanceFacts, amountPaise: number): Refusal | null {
  if (a.dailyCount !== null && a.countToday >= a.dailyCount) {
    return refuse('G6', 'ALW.DAILY_COUNT', 409);
  }
  if (a.dailyAmountPaise !== null && a.spentTodayPaise + amountPaise > a.dailyAmountPaise) {
    return refuse('G6', 'ALW.DAILY_AMOUNT', 409, { limit: formatInr(a.dailyAmountPaise) });
  }
  return null;
}

/** V13 (RNG-GOV-016): the balance read under the row lock covers the amount. */
export function balanceCheck(
  availablePaise: number,
  amountPaise: number,
  allowance = false,
): Refusal | null {
  if (availablePaise >= amountPaise) return null;
  if (allowance) return refuse('V13', 'ALW.INSUFFICIENT_BALANCE', 409);
  return refuse('V13', 'PAY.INSUFFICIENT_BALANCE', 409, {
    balance: formatInr(availablePaise),
    shortfall: formatInr(amountPaise - availablePaise),
  });
}

/** Refusal from a guard that needs the database (G3 request binding, G6 PIN and cap). */
export function guardRefusal(
  check: 'G3' | 'G6',
  code: MessageKey,
  status: number,
  params?: Readonly<Record<string, string | number>>,
): Refusal {
  return refuse(check, code, status, params);
}

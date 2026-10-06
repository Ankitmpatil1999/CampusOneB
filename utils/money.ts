/**
 * Shared file. The master is RingPe_Backend_API/utils/money.ts; identical copies live in
 * RingPe_Web_Application/src/components/Utils/ and RingPe_Mobile_App/src/utils/. Edit the master,
 * then run `npm run shared:sync` in RingPe_Backend_API (`npm run shared:check` fails on drift).
 *
 * Money as integer paise (ADR-0004).
 *
 * - Storage: BIGINT paise. Code: integer paise in a `number` per row (always a safe integer);
 *   aggregates in `bigint`.
 * - API: a decimal string with exactly two places plus `"currency": "INR"`.
 * - Parsing follows the SRS amount rule (27.4 §5, "Amount": whole number or one or two decimal
 *   places; no sign, no exponent).
 */

/** Integer number of paise. Always a safe, non-negative integer unless a caller allows otherwise. */
export type Paise = number & { readonly __unit: 'paise' };

export const CURRENCY = 'INR' as const;
export type Currency = typeof CURRENCY;

/** Money on the wire: `{"amount": "1240.50", "currency": "INR"}`. */
export interface MoneyDto {
  amount: string;
  currency: Currency;
}

export type MoneyErrorCode =
  'MONEY_FORMAT' | 'MONEY_PRECISION' | 'MONEY_RANGE' | 'MONEY_CURRENCY' | 'MONEY_UNSAFE';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** SRS 27.4 §5 amount pattern, with the decimal point escaped (the register quotes it unescaped). */
export const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

const PAISE_PER_RUPEE = 100;

/** Narrows a number to `Paise` after checking it is a safe integer within the given bounds. */
export function asPaise(value: number, opts: { allowNegative?: boolean } = {}): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError('MONEY_UNSAFE', `Paise must be a safe integer, got ${String(value)}`);
  }
  if (!opts.allowNegative && value < 0) {
    throw new MoneyError('MONEY_RANGE', 'Amount must not be negative');
  }
  return value as Paise;
}

export interface ParseAmountOptions {
  /** Accept "0" / "0.00". Default false: an amount of 0 counts as missing (RNG-PAY-123 (1)). */
  allowZero?: boolean;
  /** Inclusive minimum in paise. */
  minPaise?: number;
  /** Inclusive maximum in paise. */
  maxPaise?: number;
}

/**
 * Parses a rupee amount string such as "1240", "1240.5" or "1240.50" into paise without
 * floating-point arithmetic. Refuses signs, exponents, spaces, more than two decimals and
 * anything that is not a decimal number.
 */
export function parseAmount(input: string, opts: ParseAmountOptions = {}): Paise {
  if (typeof input !== 'string' || input.length === 0) {
    throw new MoneyError('MONEY_FORMAT', 'Amount is required');
  }
  if (!AMOUNT_PATTERN.test(input)) {
    const precision = /^\d+\.\d{3,}$/.test(input);
    throw new MoneyError(
      precision ? 'MONEY_PRECISION' : 'MONEY_FORMAT',
      precision ? 'Amount may have at most two decimal places' : 'Amount must be a number',
    );
  }
  const [rupeesPart, fractionPart = ''] = input.split('.');
  const paiseBig = BigInt(rupeesPart ?? '0') * 100n + BigInt(fractionPart.padEnd(2, '0') || '0');
  if (paiseBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError('MONEY_UNSAFE', 'Amount is too large');
  }
  const paise = Number(paiseBig);
  if (paise === 0 && !opts.allowZero) {
    throw new MoneyError('MONEY_RANGE', 'Amount must be greater than zero');
  }
  if (opts.minPaise !== undefined && paise < opts.minPaise) {
    throw new MoneyError('MONEY_RANGE', 'Amount is below the minimum');
  }
  if (opts.maxPaise !== undefined && paise > opts.maxPaise) {
    throw new MoneyError('MONEY_RANGE', 'Amount is above the maximum');
  }
  return paise as Paise;
}

/** Formats paise as a plain decimal string with exactly two places ("1240.50"). */
export function formatAmount(paise: number | bigint): string {
  const value = typeof paise === 'bigint' ? paise : BigInt(asPaise(paise, { allowNegative: true }));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export function toMoneyDto(paise: number | bigint): MoneyDto {
  return { amount: formatAmount(paise), currency: CURRENCY };
}

export function fromMoneyDto(dto: MoneyDto, opts: ParseAmountOptions = {}): Paise {
  if (dto.currency !== CURRENCY) {
    throw new MoneyError('MONEY_CURRENCY', 'Only INR is supported');
  }
  return parseAmount(dto.amount, opts);
}

/** Exact sum of paise values (numbers, bigints or decimal-integer strings from the driver). */
export function sumPaise(values: Iterable<number | bigint | string>): bigint {
  let total = 0n;
  for (const v of values) {
    if (typeof v === 'bigint') total += v;
    else if (typeof v === 'number') total += BigInt(asPaise(v, { allowNegative: true }));
    else if (/^-?\d+$/.test(v)) total += BigInt(v);
    else throw new MoneyError('MONEY_FORMAT', 'Aggregate values must be integer paise');
  }
  return total;
}

/**
 * Applies a rate in basis points (50 = 0.5 %) with half-up rounding to the paisa, once, at the
 * point of calculation (ADR-0004).
 */
export function applyBasisPoints(paise: number, basisPoints: number): Paise {
  asPaise(paise);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyError('MONEY_RANGE', 'Basis points must be a non-negative integer');
  }
  const product = BigInt(paise) * BigInt(basisPoints);
  const rounded = (product + 5000n) / 10000n;
  return Number(rounded) as Paise;
}

/** Converts whole rupees to paise (for configuration defaults written in rupees). */
export function rupees(value: number): Paise {
  return asPaise(value * PAISE_PER_RUPEE);
}

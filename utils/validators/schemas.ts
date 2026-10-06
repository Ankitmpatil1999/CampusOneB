/**
 * zod schemas for the shared field rules. The error message of each refinement is the message
 * register key (`config/registers`), so the server returns `code` and clients translate it.
 */
import { z } from 'zod';
import { AMOUNT_PATTERN, parseAmount, type Paise } from '../money';
import { LIMITS } from '../../config/registers';
import { PATTERNS, isRealDate, isValidPassword, type PasswordPolicy } from './patterns';

export const mobile = () => z.string().regex(PATTERNS.mobile, 'VALIDATION.MOBILE');

/** E-mail is lower-cased and trimmed before the server rule is applied. */
export const email = () =>
  z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'VALIDATION.EMAIL')
    .regex(PATTERNS.email, 'VALIDATION.EMAIL');

export const pan = () => z.string().trim().toUpperCase().regex(PATTERNS.pan, 'VALIDATION.PAN');

export const ifsc = () => z.string().trim().toUpperCase().regex(PATTERNS.ifsc, 'VALIDATION.FORMAT');

export const postalCode = () => z.string().regex(PATTERNS.postalCode, 'VALIDATION.FORMAT');

export const otp = () => z.string().regex(PATTERNS.otp, 'VALIDATION.OTP');

export const tpin = () => z.string().regex(PATTERNS.tpin, 'VALIDATION.FORMAT');

export const languageCode = () => z.string().regex(PATTERNS.languageCode, 'VALIDATION.FORMAT');

export const isoDate = () =>
  z.string().refine((v) => isRealDate(v), { message: 'VALIDATION.DATE' });

export const defaultPasswordPolicy: PasswordPolicy = {
  minLength: LIMITS.passwordMinLength.value,
  maxLength: LIMITS.passwordMaxLength.value,
};

export const password = (policy: PasswordPolicy = defaultPasswordPolicy) =>
  z.string().refine((v) => isValidPassword(v, policy), { message: 'VALIDATION.PASSWORD' });

export interface AmountRuleOptions {
  minPaise?: number;
  maxPaise?: number;
  allowZero?: boolean;
}

/** Rupee amount string → paise (ADR-0004). Format, precision and bounds give VALIDATION.AMOUNT. */
export const amount = (opts: AmountRuleOptions = {}) =>
  z
    .string()
    .regex(AMOUNT_PATTERN, 'VALIDATION.AMOUNT')
    .transform((value, ctx): Paise => {
      try {
        return parseAmount(value, opts);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'VALIDATION.AMOUNT' });
        return z.NEVER;
      }
    });

/** `{ amount, currency: "INR" }` on the wire (ADR-0004). */
export const money = (opts: AmountRuleOptions = {}) =>
  z.strictObject({ amount: amount(opts), currency: z.literal('INR') });

/** Public identifiers are UUIDv7 strings (ADR-0010). */
export const publicId = () => z.uuid({ version: 'v7', message: 'VALIDATION.FORMAT' });

export interface FieldError {
  /** Dotted path of the field, e.g. `contacts.0.mobile`. */
  readonly field: string;
  /** Message register key. */
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Converts zod issues to the problem+json `errors[]` shape (brief §7.1). */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      return {
        field: [field, issue.keys.join(',')].filter(Boolean).join('.'),
        code: 'VALIDATION.UNKNOWN_FIELD',
      };
    }
    if (issue.code === 'invalid_type' && issue.input === undefined) {
      return { field, code: 'VALIDATION.REQUIRED' };
    }
    const code = /^[A-Z]+\.[A-Z0-9_]+$/.test(issue.message) ? issue.message : 'VALIDATION.FORMAT';
    return { field, code };
  });
}

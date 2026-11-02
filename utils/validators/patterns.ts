/**
 * Shared file. The master is CampusOne_Backend_API/utils/validators/patterns.ts; identical copies live
 * in CampusOne_Web_App/src/components/Utils/ and CampusOne_Mobile_App/src/utils/ so the apps check
 * a field with the same rule the server applies. Edit the master, then run `npm run shared:sync`.
 *
 * Field patterns from SRS v2.1 27.4 §5 (Global Application Standards) and §6.
 *
 * 27.4 quotes several expressions with an unescaped `.` (e.g. the e-mail and amount rules) and
 * records the server PAN rule as unanchored at the start. The intent of each row is applied here:
 * the dot is a literal dot and every pattern is anchored at both ends. Where 27.4 records a
 * server rule and a looser client rule, the server rule is used (the server is the authority).
 */
export const PATTERNS = {
  /** 27.4 §5 Mobile number — ten digits beginning 6–9. */
  mobile: /^[6-9]\d{9}$/,
  /** 27.4 §5 Temporary member mobile for bulk onboarding — '2' + nine digits (system-generated). */
  temporaryMobile: /^2\d{9}$/,
  /**
   * 27.4 §5 E-mail (server) — lower case, TLD of at least two letters. After the @, a name and one
   * or two endings ("mail.com", "mail.co.in"), never more (client 2026-10-15: "mail.com.com.com" was
   * taken); each part starts and ends with a letter or digit.
   */
  email:
    /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?\.[a-z]{2,}$/,
  /** 27.4 §5 Amount — whole number or one or two decimals; no sign, no exponent. */
  amount: /^\d+(\.\d{1,2})?$/,
  /** 27.4 §5 Tax identification number (PAN) — anchored (the server rule is not, a recorded defect). */
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  /** 27.4 §5 Bank branch code (IFSC). */
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  /** 27.4 §5 National identity number — twelve digits after non-digits are stripped. */
  nationalId: /^\d{12}$/,
  /** Aadhaar number — twelve digits, never starting with 0 or 1 (with the checksum, see isAadhaar). */
  aadhaar: /^[2-9]\d{11}$/,
  /** 27.4 §5 Postal code — six digits. */
  postalCode: /^\d{6}$/,
  /** 27.4 §5 Person name (server) — letters only; stored upper case. */
  personNameStrict: /^[a-zA-Z]+$/,
  /** 27.4 §5 Person name (admission forms) — letters incl. accented, . ' -, single spaces. */
  personName: /^[A-Za-zÀ-ÿ.'-]+(?:\s[A-Za-zÀ-ÿ.'-]+)*$/,
  /** 27.4 §5 Security answer — lower-case letters only, no spaces. */
  securityAnswer: /^[a-z]+$/,
  /** 27.4 §5 Alphanumeric identifier. */
  alphanumeric: /^[a-zA-Z0-9]+$/,
  /** 27.4 §5 Alphanumeric with spaces (user-type, department and role names). */
  alphanumericWithSpaces: /^[a-zA-Z0-9\s]+$/,
  /** Institution name and address: the 7.4.4 rule plus & and brackets (client 2026-10-03). */
  institutionName: /^[A-Za-z0-9 '_,.@&()-]+$/,
  /** 7.4.4 Institution name, address and contact names — letters, digits, space and ' _ , . @ - */
  institutionText: /^[A-Za-z0-9 '_,.@-]+$/,
  /** 7.3.4 User-type and department names — letters, digits, space and ' - _ (MSG-ONB-36/38). */
  userTypeName: /^[A-Za-z0-9 '_-]+$/,
  /** 27.4 §5 Alphanumeric with punctuation . _ # + @ / - */
  alphanumericWithPunctuation: /^[a-zA-Z0-9._#+@/-]+$/,
  /** 27.4 §5 Language code — ISO 639-1. */
  languageCode: /^[a-z]{2}$/,
  /** 27.4 §5 Vehicle registration number (server). */
  vehicleRegistration: /^[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}$/,
  /** 27.4 §5 Date exchanged and stored — YYYY-MM-DD plus a real-calendar check (see isRealDate). */
  isoDate: /^\d{4}-\d{2}-\d{2}$/,
  /** 27.4 §5 One-time password — a four-digit whole number 1000–9999. */
  otp: /^[1-9]\d{3}$/,
  /** 27.4 §6 Transaction PIN — integer of four digits 1000–9999. */
  tpin: /^[1-9]\d{3}$/,
  /** 27.4 §5 Numeric identifier (shared sanitiser). */
  numericId: /^\d+$/,
  /** Password special characters accepted by the server rule (27.4 §5). */
  passwordSpecial: /[!@#$%^&*(),.?":{}|<>]/,
} as const;

export type PatternName = keyof typeof PATTERNS;

/** True when `value` is YYYY-MM-DD and a real calendar date (no auto-correction, 27.4 §5). */
export function isRealDate(value: string): boolean {
  if (!PATTERNS.isoDate.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// The Verhoeff check digit (UIDAI): the multiplication and permutation tables of the dihedral group D5.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/** Whether the last of an Aadhaar number's twelve digits is the Verhoeff check digit of the others. */
export function hasAadhaarCheckDigit(digits: string): boolean {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => {
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![Number(ch)]!]!;
  });
  return c === 0;
}

/**
 * An Aadhaar number (client 2026-10-12): twelve digits, not starting with 0 or 1. Spaces and hyphens
 * typed between groups are ignored.
 */
export function isAadhaar(value: string): boolean {
  const v = value.replace(/[\s-]/g, '');
  if (!PATTERNS.aadhaar.test(v)) return false;
  // The Verhoeff check digit is not enforced for now (client 2026-10-12). To enforce it again:
  // if (!hasAadhaarCheckDigit(v)) return false;
  return true;
}

export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
}

/** 27.4 §5 Password: length bounds and one upper, one lower, one digit, one special character. */
export function isValidPassword(value: string, policy: PasswordPolicy): boolean {
  return (
    value.length >= policy.minLength &&
    value.length <= policy.maxLength &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    PATTERNS.passwordSpecial.test(value)
  );
}

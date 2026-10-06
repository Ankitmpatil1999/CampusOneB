/**
 * Redaction by default (brief §7.2, OI-INT-08): secrets, credentials and personal identifiers are
 * removed or masked before anything is logged. Keys are matched case-insensitively and ignoring
 * `_`/`-`; free text is scanned for identifier patterns as a second line of defence.
 */
const REDACTED = '[REDACTED]';

const SECRET_KEYS = new Set(
  [
    'password',
    'newpassword',
    'oldpassword',
    'currentpassword',
    'confirmpassword',
    'pin',
    'tpin',
    'oldtpin',
    'newtpin',
    'otp',
    'otpcode',
    'securityanswer',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'authorization',
    'cookie',
    'setcookie',
    'secret',
    'clientsecret',
    'apikey',
    'privatekey',
    'signature',
    'xringpesignature',
    'pan',
    'pannumber',
    'aadhaar',
    'aadhar',
    'aadhaarnumber',
    'iddocnumber',
    'idnumber',
    'documentnumber',
    'accountnumber',
    'bankaccount',
    'bankaccountnumber',
    'cardnumber',
    'cvv',
    'body',
    'rawbody',
  ].map(normaliseKey),
);

const MASK_TAIL_KEYS = new Set(
  ['mobile', 'phone', 'mobilenumber', 'phonenumber', 'msisdn'].map(normaliseKey),
);
const EMAIL_KEYS = new Set(['email', 'emailaddress', 'mail'].map(normaliseKey));

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return '*'.repeat(value.length);
  return '*'.repeat(value.length - visible) + value.slice(-visible);
}

export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at < 1) return REDACTED;
  return `${value[0]}***${value.slice(at)}`;
}

const TEXT_PATTERNS: readonly [RegExp, (m: string) => string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, () => `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, () => REDACTED], // JWT
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => '[PAN]'],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, () => '[ID-NUMBER]'], // 12-digit national identity number
  [/(?<!\d)[6-9]\d{9}(?!\d)/g, (m) => maskTail(m)], // Indian mobile number
];

/** Scrubs identifier patterns from free text (messages, SQL error text). */
export function redactText(text: string): string {
  return TEXT_PATTERNS.reduce((acc, [re, fn]) => acc.replace(re, fn), text);
}

export interface RedactOptions {
  maxDepth?: number;
  maxArrayItems?: number;
}

/** Deep copy with secrets removed and identifiers masked. Handles cycles, depth and size. */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const maxDepth = opts.maxDepth ?? 6;
  const maxItems = opts.maxArrayItems ?? 20;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return redactText(v);
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return { name: v.name, message: redactText(v.message) };
    if (Buffer.isBuffer(v)) return `[${v.length} bytes]`;
    if (seen.has(v)) return '[Circular]';
    if (depth >= maxDepth) return '[Truncated]';
    seen.add(v);
    if (Array.isArray(v)) {
      const items = v.slice(0, maxItems).map((x) => walk(x, depth + 1));
      if (v.length > maxItems) items.push(`[+${v.length - maxItems} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      const nk = normaliseKey(k);
      if (SECRET_KEYS.has(nk)) out[k] = REDACTED;
      else if (MASK_TAIL_KEYS.has(nk) && typeof inner === 'string') out[k] = maskTail(inner);
      else if (EMAIL_KEYS.has(nk) && typeof inner === 'string') out[k] = maskEmail(inner);
      else out[k] = walk(inner, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}

/**
 * Field-level encryption and blind indexes (ADR-0012, golden rule "personal data").
 *
 * - AES-256-GCM per purpose (`pan`, `id_doc`, `bank_acct`, `mobile`, …) with a data key derived by
 *   HKDF-SHA256 from the active root key. Ciphertext layout:
 *   `0x01 ‖ len(keyId) ‖ keyId ‖ iv(12) ‖ ciphertext ‖ tag(16)`; the AAD binds the value to its
 *   table, column and row, so a ciphertext copied to another row does not decrypt.
 * - Blind index: HMAC-SHA256 with a per-purpose key, over the normalised value (exact lookup and
 *   uniqueness without storing the value).
 * - Root keys come from a key file (local development and tests). In production the same file is
 *   mounted as a secret until the KMS wrapping of Q3 is in place.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyFileSchema = z.object({
  version: z.literal(1),
  activeKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  keys: z.record(z.string(), z.string()),
  indexKey: z.string(),
});
export type FieldKeyFile = z.infer<typeof keyFileSchema>;

const key32 = (b64: string, name: string): Buffer => {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error(`field key ${name} must be 32 bytes`);
  return k;
};

export class DecryptionError extends Error {
  constructor() {
    super('field could not be decrypted');
    this.name = 'DecryptionError';
  }
}

export class FieldCipher {
  private readonly roots: ReadonlyMap<string, Buffer>;
  private readonly indexRoot: Buffer;
  private readonly activeKeyId: string;
  private readonly derived = new Map<string, Buffer>();

  constructor(file: FieldKeyFile) {
    const f = keyFileSchema.parse(file);
    this.roots = new Map(Object.entries(f.keys).map(([id, k]) => [id, key32(k, id)]));
    if (!this.roots.has(f.activeKeyId)) throw new Error('activeKeyId is not in keys');
    this.activeKeyId = f.activeKeyId;
    this.indexRoot = key32(f.indexKey, 'indexKey');
  }

  private derive(root: Buffer, info: string): Buffer {
    const cached = this.derived.get(info);
    if (cached) return cached;
    const k = Buffer.from(hkdfSync('sha256', root, Buffer.from('campusone-field-v1'), info, 32));
    this.derived.set(info, k);
    return k;
  }

  private dataKey(keyId: string, purpose: string): Buffer {
    const root = this.roots.get(keyId);
    if (!root) throw new DecryptionError();
    return this.derive(root, `dek:${keyId}:${purpose}`);
  }

  /** A per-purpose secret for HMACs that are not blind indexes (OTP codes, signed URLs, CSRF). */
  secret(purpose: string): Buffer {
    return this.derive(this.indexRoot, `secret:${purpose}`);
  }

  encrypt(purpose: string, plaintext: string, aad: string): Buffer {
    const keyId = Buffer.from(this.activeKeyId, 'ascii');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey(this.activeKeyId, purpose), iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([
      Buffer.from([VERSION, keyId.length]),
      keyId,
      iv,
      ct,
      cipher.getAuthTag(),
    ]);
  }

  decrypt(purpose: string, blob: Buffer, aad: string): string {
    if (blob.length < 2 || blob[0] !== VERSION) throw new DecryptionError();
    const idLen = blob[1]!;
    const minLen = 2 + idLen + IV_BYTES + TAG_BYTES;
    if (blob.length < minLen) throw new DecryptionError();
    const keyId = blob.subarray(2, 2 + idLen).toString('ascii');
    const iv = blob.subarray(2 + idLen, 2 + idLen + IV_BYTES);
    const ct = blob.subarray(2 + idLen + IV_BYTES, blob.length - TAG_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.dataKey(keyId, purpose), iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new DecryptionError();
    }
  }

  /** Blind index of a normalised value (exact-match lookups and uniqueness). */
  blindIndex(purpose: string, value: string): Buffer {
    return createHmac('sha256', this.derive(this.indexRoot, `bidx:${purpose}`))
      .update(normaliseForIndex(value), 'utf8')
      .digest();
  }

  /** Key id that new ciphertexts use (re-encryption jobs compare against it). */
  get currentKeyId(): string {
    return this.activeKeyId;
  }
}

/** Upper-case, no spaces or separators: "abcde 1234f" and "ABCDE1234F" index the same. */
export const normaliseForIndex = (v: string) =>
  v.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();

/** Last four characters for masked display (`••••1234`). */
export const lastFour = (v: string) => normaliseForIndex(v).slice(-4);

/**
 * Masked display in the prototype's formats (fmt.mask: up to six "•" then the last four):
 * PAN "••••••821M", Aadhaar "XXXX XXXX 4821", bank account "XXXXXXXX7719". Only the last four
 * characters are ever stored in clear, so the dot count follows the document's fixed length.
 */
const MASK_DOTS: Readonly<Record<string, number>> = { PASSPORT: 4 };

export const maskPan = (last4: string | null | undefined) => (last4 ? `••••••${last4}` : null);

export const maskIdNumber = (type: string | null | undefined, last4: string | null | undefined) =>
  !last4
    ? null
    : type === 'AADHAAR'
      ? `XXXX XXXX ${last4}`
      : `${'•'.repeat(MASK_DOTS[type ?? ''] ?? 6)}${last4}`;

export const maskAccountNumber = (last4: string | null | undefined) =>
  last4 ? `XXXXXXXX${last4}` : null;

export async function loadFieldCipher(path: string): Promise<FieldCipher> {
  return new FieldCipher(JSON.parse(await readFile(path, 'utf8')) as FieldKeyFile);
}

/** A new key file (local development, tests and the key-generation script). */
export function generateFieldKeyFile(
  keyId = `k${new Date().toISOString().slice(0, 7).replace('-', '')}`,
): FieldKeyFile {
  return {
    version: 1,
    activeKeyId: keyId,
    keys: { [keyId]: randomBytes(32).toString('base64') },
    indexKey: randomBytes(32).toString('base64'),
  };
}

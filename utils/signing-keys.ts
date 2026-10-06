/**
 * ES256 signing keys for access tokens (ADR-0011): one key set for the member, console, portal and
 * terminal audiences and a separate set for the back office (`ops`). A key file is a JWK set of
 * private keys; the first key signs, the others only verify (rotation every 90 days).
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from 'jose';
import { z } from 'zod';

export interface SigningKeySet {
  /** Key id of the signing key. */
  readonly activeKid: string;
  readonly privateKey: CryptoKey;
  /** Public halves of every key in the set (published as JWKS, used to verify). */
  readonly publicJwks: JSONWebKeySet;
}

const privateJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    kid: z.string().min(1),
    x: z.string().min(1),
    y: z.string().min(1),
    d: z.string().min(1),
  })
  .passthrough();

const keyFileSchema = z.object({ keys: z.array(privateJwkSchema).min(1) });

export type PrivateKeyFile = z.infer<typeof keyFileSchema>;

const publicPart = (k: JWK): JWK => ({
  kty: k.kty,
  crv: k.crv,
  x: k.x,
  y: k.y,
  kid: k.kid,
  alg: 'ES256',
  use: 'sig',
});

export async function keySetFromFile(file: PrivateKeyFile): Promise<SigningKeySet> {
  const parsed = keyFileSchema.parse(file);
  const kids = parsed.keys.map((k) => k.kid);
  if (new Set(kids).size !== kids.length) throw new Error('duplicate kid in signing key file');
  const active = parsed.keys[0]!;
  const privateKey = (await importJWK({ ...active, alg: 'ES256' }, 'ES256')) as CryptoKey;
  return {
    activeKid: active.kid,
    privateKey,
    publicJwks: { keys: parsed.keys.map((k) => publicPart(k as JWK)) },
  };
}

export async function loadSigningKeys(path: string): Promise<SigningKeySet> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return keySetFromFile(raw as PrivateKeyFile);
}

/** A new key file with one key (local development, tests and the key-generation script). */
export async function generateKeyFile(kidPrefix: string): Promise<PrivateKeyFile> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  // Date for humans, random suffix so two keys made the same day never share an id.
  const kid = `${kidPrefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
  return keyFileSchema.parse({ keys: [{ ...jwk, kid }] });
}

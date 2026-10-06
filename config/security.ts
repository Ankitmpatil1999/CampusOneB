/**
 * Start-up of the security building blocks (ADR-0011, ADR-0012): signing keys, token signer and
 * verifier, field cipher and the session revocation list. Development may run with a temporary
 * signing key (sessions end at restart); the field keys are always required, because data
 * encrypted with a lost key cannot be read again.
 */
import type { Redis } from 'ioredis';
import type { JSONWebKeySet } from 'jose';
import type { Config } from './config';
import { LIMITS } from './registers';
import type { Loggers } from '../controllers/logger';
import { FieldCipher, loadFieldCipher } from '../utils/fieldEncryption';
import {
  generateKeyFile,
  keySetFromFile,
  loadSigningKeys,
  type SigningKeySet,
} from '../utils/signing-keys';
import {
  memoryRevocations,
  redisRevocations,
  type SessionRevocations,
} from '../utils/session-revocations';
import { createTokenSigner, type TokenSigner } from '../utils/token-signer';
import { createTokenVerifier, type TokenVerifier } from '../utils/token-verifier';

export interface Security {
  readonly signer: TokenSigner;
  readonly verifier: TokenVerifier;
  /** Published at /.well-known/jwks.json (back-office keys are not published). */
  readonly publicJwks: JSONWebKeySet;
  readonly cipher: FieldCipher;
  readonly revocations: SessionRevocations;
}

async function keysOrTemporary(
  path: string | undefined,
  name: string,
  loggers: Loggers,
): Promise<SigningKeySet> {
  if (path) return loadSigningKeys(path);
  loggers.app.warn(`${name} not set — using a temporary signing key (sessions end at restart)`);
  return keySetFromFile(await generateKeyFile(`tmp-${name.toLowerCase().replace(/_/g, '-')}`));
}

export async function createSecurity(
  config: Config,
  loggers: Loggers,
  redis?: Redis,
): Promise<Security> {
  if (!config.fieldKeysFile) {
    throw new Error('FIELD_KEYS_FILE is not set — run `npm run keys:generate` and add it to .env');
  }
  const keys = await keysOrTemporary(
    config.auth.signingKeysFile,
    'AUTH_SIGNING_KEYS_FILE',
    loggers,
  );
  const opsKeys = await keysOrTemporary(
    config.auth.opsSigningKeysFile,
    'AUTH_OPS_SIGNING_KEYS_FILE',
    loggers,
  );
  return assembleSecurity({
    issuer: config.auth.issuer,
    keys,
    opsKeys,
    cipher: await loadFieldCipher(config.fieldKeysFile),
    revocations: redis ? redisRevocations(redis) : memoryRevocations(),
  });
}

/** Also used by tests with in-memory keys. */
export function assembleSecurity(parts: {
  issuer: string;
  keys: SigningKeySet;
  opsKeys: SigningKeySet;
  cipher: FieldCipher;
  revocations: SessionRevocations;
}): Security {
  return {
    signer: createTokenSigner({
      issuer: parts.issuer,
      keys: parts.keys,
      opsKeys: parts.opsKeys,
      ttlSeconds: LIMITS.accessTokenMinutes.value * 60,
    }),
    verifier: createTokenVerifier({
      issuer: parts.issuer,
      jwks: parts.keys.publicJwks,
      opsJwks: parts.opsKeys.publicJwks,
    }),
    publicJwks: parts.keys.publicJwks,
    cipher: parts.cipher,
    revocations: parts.revocations,
  };
}

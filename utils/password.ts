/**
 * Argon2id for passwords, PINs and security answers (golden rule; ADR-0011). Parameters follow the
 * OWASP minimum (19 MiB, 2 passes, 1 lane); the encoded hash carries them, so they can be raised
 * later and old hashes upgraded at the next successful sign-in (`needsRehash`).
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2';

export const ARGON2_PARAMS = {
  algorithm: 2 as Algorithm, // Algorithm.Argon2id (a const enum, not importable as a value)
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Security answers are compared case- and space-insensitively (prototype behaviour). */
export const normaliseAnswer = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export function hashSecret(plain: string): Promise<string> {
  return hash(plain, ARGON2_PARAMS);
}

export async function verifySecret(encoded: string, plain: string): Promise<boolean> {
  try {
    return await verify(encoded, plain);
  } catch {
    return false;
  }
}

/** True when the stored hash used weaker parameters than the current ones. */
export function needsRehash(encoded: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  if (!m) return true;
  return (
    Number(m[1]) < ARGON2_PARAMS.memoryCost ||
    Number(m[2]) < ARGON2_PARAMS.timeCost ||
    Number(m[3]) !== ARGON2_PARAMS.parallelism
  );
}

let dummy: Promise<string> | undefined;

/**
 * Burns the same time as a real check when the account does not exist, so response times do not
 * reveal which mobile numbers or e-mails are registered.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummy ??= hashSecret('dummy-password-for-timing');
  await verifySecret(await dummy, plain);
  return false;
}

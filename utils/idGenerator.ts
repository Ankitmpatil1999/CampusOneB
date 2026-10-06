import { parse, stringify, v7 as uuidv7, validate, version } from 'uuid';

/** Time-ordered public identifier (ADR-0010). */
export function newPublicId(): string {
  return uuidv7();
}

export function newCorrelationId(): string {
  return uuidv7();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && validate(value);
}

export function isUuidV7(value: unknown): value is string {
  return isUuid(value) && version(value) === 7;
}

/** A UUID string as the 16 bytes stored in `BINARY(16)` columns. */
export function uuidToBin(uuid: string): Buffer {
  return Buffer.from(parse(uuid));
}

/** `BINARY(16)` bytes back to the canonical UUID string. */
export function binToUuid(bytes: Buffer | Uint8Array): string {
  return stringify(bytes);
}

/** A new UUIDv7 as both forms (store the bytes, return the string). */
export function newPublicIdPair(): { readonly id: string; readonly bin: Buffer } {
  const id = uuidv7();
  return { id, bin: uuidToBin(id) };
}

/** The all-zero UUID: stands in for "no principal" where a key column must not be NULL. */
export const NIL_UUID_BIN = Buffer.alloc(16);

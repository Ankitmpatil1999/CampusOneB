/**
 * Optimistic locking (golden rule): every editable record has `row_version`, exposed as a strong
 * ETag. Updates must send `If-Match` with the version they read (428 without it, 412 when someone
 * else changed the record first); the repository then updates `WHERE row_version = ?`.
 */
import type { Request, Response } from 'express';
import { CustomAPIError, PreconditionFailedError } from './CustomAPIError';

export const etagOf = (rowVersion: number) => `"v${rowVersion}"`;

export function setEtag(res: Response, rowVersion: number): void {
  res.setHeader('ETag', etagOf(rowVersion));
}

/** The `row_version` the client read, from `If-Match`; refuses a missing or malformed header. */
export function expectedVersion(req: Request): number {
  const header = req.get('if-match');
  if (!header) throw new CustomAPIError(428, 'GEN.PRECONDITION_REQUIRED');
  const m = /^(?:W\/)?"v(\d{1,9})"$/.exec(header.trim());
  if (!m) throw new PreconditionFailedError();
  return Number(m[1]);
}

/** Throws 412 when the guarded update changed nothing (someone else updated the row first). */
export function assertUpdated(numUpdatedRows: bigint | number): void {
  if (Number(numUpdatedRows) !== 1) throw new PreconditionFailedError();
}

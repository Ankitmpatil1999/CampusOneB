/** Opaque keyset cursors for lists read newest first by row id. */
import { ValidationError } from './CustomAPIError';

export const idCursor = {
  encode(id: string | number): string {
    return Buffer.from(`i:${id}`, 'utf8').toString('base64url');
  },
  /** The row id behind a cursor; a malformed cursor is a validation error. */
  decode(cursor: string | undefined): string | undefined {
    if (!cursor) return undefined;
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^i:(\d{1,20})$/.exec(raw);
    if (!m?.[1]) throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
    return m[1];
  },
};

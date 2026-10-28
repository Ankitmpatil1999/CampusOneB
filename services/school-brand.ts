/**
 * A school's own e-mail identity (client 2026-10-26: "replace RingPe with the institution's name and
 * show its logo"): the school as the sender's name and the heading, replies to its office address,
 * and its logo inside the e-mail. Best effort: a school without a usable logo still sends, by name.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { logoFileOf } from './institution-logo';

type Db = Kysely<Database> | Transaction<Database>;

/** Mail apps show PNG and JPEG inline; a bigger logo would weigh down every e-mail. */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg']);
const LOGO_MAX_BYTES = 300 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads a stored file's bytes (FileService.contents). */
export interface LogoFiles {
  contents(fileId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string } | null>;
}

export interface SchoolBrand {
  readonly fromName: string;
  readonly replyTo: string | null;
  readonly logo: { readonly content: Buffer; readonly contentType: string } | null;
}

export async function schoolBrand(
  db: Db,
  files: LogoFiles | undefined,
  institutionId: string,
): Promise<SchoolBrand | null> {
  const i = await db
    .selectFrom('institutions')
    .select(['name', 'office_email'])
    .where('id', '=', institutionId)
    .executeTakeFirst();
  if (!i) return null;
  let logo: SchoolBrand['logo'] = null;
  try {
    const f = files ? await logoFileOf(db, { rowId: institutionId }) : null;
    const file = f ? await files!.contents(f.fileId, LOGO_MAX_BYTES) : null;
    if (file && LOGO_TYPES.has(file.mimeType)) {
      logo = { content: file.data, contentType: file.mimeType };
    }
  } catch {
    // The e-mail goes without the logo.
  }
  return {
    fromName: i.name,
    replyTo: i.office_email && EMAIL.test(i.office_email) ? i.office_email : null,
    logo,
  };
}

/** The fields an e-mail takes from the brand (none when there is no school). */
export const brandFields = (b: SchoolBrand | null) =>
  b ? { fromName: b.fromName, replyTo: b.replyTo, logo: b.logo } : {};

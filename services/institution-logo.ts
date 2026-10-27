/**
 * An institution's logo at a stable public address (client 2026-10-15: "I have uploaded the logo,
 * but it is not reflecting anywhere"). The console's menu, the admission pages and the apps show it
 * from INS-049. A signed file link expires in minutes and isn't cached; this address changes only
 * when the logo is replaced, so it can be.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { binToUuid, uuidToBin } from '../utils/idGenerator';

type Db = Kysely<Database> | Transaction<Database>;

/** INS-049's path for an institution and its logo file (the file's id makes it a new address). */
export const logoPath = (institutionPublicId: string, filePublicId: string) =>
  `/api/v1/public/institutions/${institutionPublicId}/logo?v=${filePublicId.replace(/-/g, '').slice(0, 12)}`;

/** The institution's logo file, when it has one scanned clean (by its row id or public id). */
export async function logoFileOf(db: Db, institution: { rowId: string } | { publicId: string }) {
  let q = db
    .selectFrom('institutions as i')
    .innerJoin('institution_settings as s', 's.institution_id', 'i.id')
    .innerJoin('files as f', 'f.id', 's.logo_file_id')
    .select(['i.public_id as institution_public_id', 'f.public_id as file_public_id'])
    .where('f.scan_status', '=', 'CLEAN');
  q =
    'rowId' in institution
      ? q.where('i.id', '=', institution.rowId)
      : q.where('i.public_id', '=', uuidToBin(institution.publicId));
  const r = await q.executeTakeFirst();
  return r
    ? {
        institutionId: binToUuid(r.institution_public_id),
        fileId: binToUuid(r.file_public_id),
      }
    : null;
}

/** The institution's logo address, or null when it has none. */
export async function logoUrlOf(db: Db, institutionRowId: string): Promise<string | null> {
  const f = await logoFileOf(db, { rowId: institutionRowId });
  return f ? logoPath(f.institutionId, f.fileId) : null;
}

/** An institution a person may open, as the apps offer it to choose from (client 2026-10-27). */
export interface InstitutionItem {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  readonly logoUrl: string | null;
}

/** The institutions of these rows (each once, in their order), with their logos. */
export async function institutionItems(
  db: Db,
  rows: readonly {
    readonly institution_id: string;
    readonly institution_public_id: Buffer;
    readonly institution_name: string;
    readonly short_name: string;
    readonly city: string;
  }[],
): Promise<InstitutionItem[]> {
  const items: InstitutionItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(String(r.institution_id))) continue;
    seen.add(String(r.institution_id));
    items.push({
      id: binToUuid(r.institution_public_id),
      name: r.institution_name,
      shortName: r.short_name,
      city: r.city,
      logoUrl: await logoUrlOf(db, String(r.institution_id)),
    });
  }
  return items;
}

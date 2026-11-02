/** File metadata (migration 0004 `files`). The bytes live in the storage provider. */
import type { Kysely } from 'kysely';
import type { Database } from '../models/campusone_models';

export const fileRepository = {
  async insert(
    db: Kysely<Database>,
    f: {
      publicId: Buffer;
      institutionId: string | null;
      purpose: string;
      objectKey: string;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR';
      createdBy: Buffer | null;
    },
  ) {
    await db
      .insertInto('files')
      .values({
        public_id: f.publicId,
        institution_id: f.institutionId,
        purpose: f.purpose,
        object_key: f.objectKey,
        original_name: f.originalName,
        mime_type: f.mimeType,
        size_bytes: f.sizeBytes,
        sha256: f.sha256,
        scan_status: f.scanStatus,
        created_by: f.createdBy,
      })
      .execute();
  },

  async findByPublicId(db: Kysely<Database>, publicId: Buffer) {
    return db
      .selectFrom('files')
      .select([
        'id',
        'public_id',
        'institution_id',
        'purpose',
        'object_key',
        'original_name',
        'mime_type',
        'size_bytes',
        'scan_status',
        'created_by',
        'created_at',
      ])
      .where('public_id', '=', publicId)
      .executeTakeFirst();
  },
};

export const institutionLookup = {
  /** Internal id of an institution from its public id (sessions carry the public id). */
  async idByPublicId(db: Kysely<Database>, publicId: Buffer): Promise<string | undefined> {
    const row = await db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', publicId)
      .executeTakeFirst();
    return row ? String(row.id) : undefined;
  },
};

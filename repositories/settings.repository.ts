/** Platform settings over the limits-register defaults (migration 0006). */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export const settingsRepository = {
  async all(db: Db) {
    return db
      .selectFrom('platform_settings')
      .select(['setting_key', 'value_json', 'reason', 'row_version', 'updated_at', 'updated_by'])
      .execute();
  },

  async lock(db: Db, key: string) {
    return db
      .selectFrom('platform_settings')
      .select(['value_json', 'row_version'])
      .where('setting_key', '=', key)
      .forUpdate()
      .executeTakeFirst();
  },

  async insert(db: Db, key: string, value: number, reason: string, by: Buffer | null) {
    await db
      .insertInto('platform_settings')
      .values({ setting_key: key, value_json: JSON.stringify(value), reason, updated_by: by })
      .execute();
  },

  /** Guarded by the version the operator read (optimistic locking). */
  async update(
    db: Db,
    key: string,
    value: number,
    reason: string,
    by: Buffer | null,
    expectedVersion: number,
  ): Promise<boolean> {
    const r = await db
      .updateTable('platform_settings')
      .set((eb) => ({
        value_json: JSON.stringify(value),
        reason,
        updated_by: by,
        updated_at: new Date(),
        row_version: eb('row_version', '+', 1),
      }))
      .where('setting_key', '=', key)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async remove(db: Db, key: string, expectedVersion: number): Promise<boolean> {
    const r = await db
      .deleteFrom('platform_settings')
      .where('setting_key', '=', key)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    return Number(r.numDeletedRows) === 1;
  },

  async recordChange(
    db: Db,
    c: { key: string; from: number | null; to: number | null; reason: string; by: Buffer | null },
  ) {
    await db
      .insertInto('platform_setting_changes')
      .values({
        setting_key: c.key,
        from_json: c.from === null ? null : JSON.stringify(c.from),
        to_json: c.to === null ? null : JSON.stringify(c.to),
        reason: c.reason,
        changed_by: c.by,
      })
      .execute();
  },

  async history(db: Db, key: string, limit: number) {
    return db
      .selectFrom('platform_setting_changes')
      .select(['from_json', 'to_json', 'reason', 'changed_at', 'changed_by'])
      .where('setting_key', '=', key)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  },
};

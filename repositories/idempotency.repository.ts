/** API-level replay protection records (migration 0004, brief §7.4). */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../models/campusone_models';

export interface IdempotencyKeyRef {
  readonly scopeKey: string;
  readonly principalRef: Buffer;
  readonly key: string;
}

const where = (ref: IdempotencyKeyRef) =>
  sql<boolean>`scope_key = ${ref.scopeKey} AND principal_ref = ${ref.principalRef} AND idempotency_key = ${ref.key}`;

export const idempotencyRepository = {
  /**
   * Claims the key: true when this request is the first. An expired record is replaced.
   * Uses INSERT … ON DUPLICATE so two parallel requests cannot both win.
   */
  async claim(
    db: Kysely<Database>,
    ref: IdempotencyKeyRef,
    r: { method: string; route: string; requestHash: string; expiresAt: Date; now: Date },
  ): Promise<boolean> {
    await db
      .deleteFrom('idempotency_records')
      .where(where(ref))
      .where('expires_at', '<=', r.now)
      .execute();
    const result = await sql`
      INSERT IGNORE INTO idempotency_records
        (scope_key, principal_ref, idempotency_key, method, route, request_hash, status, expires_at)
      VALUES (${ref.scopeKey}, ${ref.principalRef}, ${ref.key}, ${r.method}, ${r.route},
              ${r.requestHash}, 'IN_PROGRESS', ${r.expiresAt})`.execute(db);
    return Number(result.numAffectedRows ?? 0n) === 1;
  },

  async find(db: Kysely<Database>, ref: IdempotencyKeyRef) {
    return db
      .selectFrom('idempotency_records')
      .select(['method', 'route', 'request_hash', 'status', 'response_status', 'response_body'])
      .where(where(ref))
      .executeTakeFirst();
  },

  async complete(
    db: Kysely<Database>,
    ref: IdempotencyKeyRef,
    response: { status: number; body: string | null },
  ) {
    await db
      .updateTable('idempotency_records')
      .set({ status: 'COMPLETED', response_status: response.status, response_body: response.body })
      .where(where(ref))
      .where('status', '=', 'IN_PROGRESS')
      .execute();
  },

  /** Server errors are not replayed: the client may try again with the same key. */
  async release(db: Kysely<Database>, ref: IdempotencyKeyRef) {
    await db
      .deleteFrom('idempotency_records')
      .where(where(ref))
      .where('status', '=', 'IN_PROGRESS')
      .execute();
  },
};

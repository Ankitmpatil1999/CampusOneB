/**
 * Sessions and refresh tokens (ADR-0011, docs/04 §3.2). Parameterised SQL only; every state change
 * is a guarded update. Callers pass the transaction so a sign-in or rotation is all-or-nothing.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, SurfaceCode } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export interface NewSession {
  readonly publicId: Buffer;
  readonly accountId: string;
  readonly surface: SurfaceCode;
  /** A console session of the staff app (migration 0084). */
  readonly staffApp: boolean;
  readonly institutionId: string | null;
  readonly profileId: string | null;
  readonly deviceId: string | null;
  readonly ip: Buffer | null;
  readonly uaHash: Buffer | null;
  readonly absoluteExpiresAt: Date;
}

export interface RefreshTokenRow {
  readonly tokenId: string;
  readonly familyId: Buffer;
  readonly status: 'ACTIVE' | 'ROTATED' | 'REVOKED';
  readonly expiresAt: Date;
  readonly rotatedAt: Date | null;
  readonly sessionId: string;
  readonly sessionPublicId: Buffer;
  readonly surface: SurfaceCode;
  readonly staffApp: number;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly absoluteExpiresAt: Date;
  readonly accountId: string;
  readonly accountPublicId: Buffer;
  readonly accountStatus: 'ACTIVE' | 'DEACTIVATED';
  readonly institutionId: string | null;
  readonly institutionPublicId: Buffer | null;
  readonly profileId: string | null;
  readonly profilePublicId: Buffer | null;
}

export const sessionRepository = {
  /**
   * Active sessions of an account on a surface — the staff app's or the others' (migration 0084) —
   * locked for the ending update.
   */
  async lockActive(db: Db, accountId: string, surface: SurfaceCode, staffApp = false) {
    return db
      .selectFrom('sessions')
      .select(['id', 'public_id'])
      .where('account_id', '=', accountId)
      .where('surface', '=', surface)
      .where('staff_app', '=', staffApp ? 1 : 0)
      .where('ended_at', 'is', null)
      .forUpdate()
      .execute();
  },

  async endSessions(db: Db, sessionIds: readonly string[], reason: string, at: Date) {
    if (sessionIds.length === 0) return;
    await db
      .updateTable('sessions')
      .set({ ended_at: at, end_reason: reason })
      .where('id', 'in', [...sessionIds])
      .where('ended_at', 'is', null)
      .execute();
    await db
      .updateTable('refresh_tokens')
      .set({ status: 'REVOKED' })
      .where('session_id', 'in', [...sessionIds])
      .where('status', '=', 'ACTIVE')
      .execute();
  },

  async insertSession(db: Db, s: NewSession): Promise<string> {
    const result = await db
      .insertInto('sessions')
      .values({
        public_id: s.publicId,
        account_id: s.accountId,
        surface: s.surface,
        staff_app: s.staffApp ? 1 : 0,
        institution_id: s.institutionId,
        profile_id: s.profileId,
        device_id: s.deviceId,
        ip: s.ip,
        ua_hash: s.uaHash,
        last_seen_at: sql<Date>`UTC_TIMESTAMP(3)`,
        absolute_expires_at: s.absoluteExpiresAt,
      })
      .executeTakeFirstOrThrow();
    return String(result.insertId);
  },

  async insertRefreshToken(
    db: Db,
    t: { sessionId: string; familyId: Buffer; tokenHash: Buffer; expiresAt: Date },
  ) {
    await db
      .insertInto('refresh_tokens')
      .values({
        session_id: t.sessionId,
        family_id: t.familyId,
        token_hash: t.tokenHash,
        expires_at: t.expiresAt,
      })
      .execute();
  },

  /** The token with its session, account and institution, locked for rotation. */
  async lockByTokenHash(db: Db, tokenHash: Buffer): Promise<RefreshTokenRow | undefined> {
    const row = await db
      .selectFrom('refresh_tokens as rt')
      .innerJoin('sessions as s', 's.id', 'rt.session_id')
      .innerJoin('platform_accounts as a', 'a.id', 's.account_id')
      .leftJoin('institutions as i', 'i.id', 's.institution_id')
      .leftJoin('member_profiles as mp', 'mp.id', 's.profile_id')
      .select([
        'rt.id as tokenId',
        'rt.family_id as familyId',
        'rt.status as status',
        'rt.expires_at as expiresAt',
        'rt.rotated_at as rotatedAt',
        's.id as sessionId',
        's.public_id as sessionPublicId',
        's.surface as surface',
        's.staff_app as staffApp',
        's.ended_at as endedAt',
        's.end_reason as endReason',
        's.absolute_expires_at as absoluteExpiresAt',
        's.account_id as accountId',
        'a.public_id as accountPublicId',
        'a.status as accountStatus',
        's.institution_id as institutionId',
        'i.public_id as institutionPublicId',
        's.profile_id as profileId',
        'mp.public_id as profilePublicId',
      ])
      .where('rt.token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();
    return row as RefreshTokenRow | undefined;
  },

  /** ACTIVE → ROTATED (guarded): false when another request rotated it first. */
  async markRotated(db: Db, tokenId: string, at: Date): Promise<boolean> {
    const r = await db
      .updateTable('refresh_tokens')
      .set({ status: 'ROTATED', rotated_at: at })
      .where('id', '=', tokenId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** The tokens of a family issued after the given one, oldest first, locked. */
  async laterInFamily(db: Db, familyId: Buffer, afterTokenId: string) {
    const rows = await db
      .selectFrom('refresh_tokens')
      .select(['id', 'status', 'expires_at as expiresAt'])
      .where('family_id', '=', familyId)
      .where('id', '>', afterTokenId)
      .orderBy('id')
      .forUpdate()
      .execute();
    return rows.map((r) => ({ ...r, id: String(r.id) }));
  },

  async revokeTokens(db: Db, tokenIds: readonly string[]) {
    if (tokenIds.length === 0) return;
    await db
      .updateTable('refresh_tokens')
      .set({ status: 'REVOKED' })
      .where('id', 'in', [...tokenIds])
      .where('status', '=', 'ACTIVE')
      .execute();
  },

  /** A ROTATED token rotated once more (its earlier answer was lost): the time moves on. */
  async markRotatedAgain(db: Db, tokenId: string, at: Date) {
    await db
      .updateTable('refresh_tokens')
      .set({ rotated_at: at })
      .where('id', '=', tokenId)
      .where('status', '=', 'ROTATED')
      .execute();
  },

  async revokeFamily(db: Db, familyId: Buffer) {
    await db
      .updateTable('refresh_tokens')
      .set({ status: 'REVOKED' })
      .where('family_id', '=', familyId)
      .where('status', '=', 'ACTIVE')
      .execute();
  },

  async touch(db: Db, sessionId: string, at: Date) {
    await db
      .updateTable('sessions')
      .set({ last_seen_at: at })
      .where('id', '=', sessionId)
      .execute();
  },

  async findActiveByPublicId(db: Db, publicId: Buffer) {
    return db
      .selectFrom('sessions')
      .select(['id', 'account_id', 'surface', 'absolute_expires_at'])
      .where('public_id', '=', publicId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
  },

  async activeSessionsOfAccount(
    db: Db,
    accountId: string,
    surfaces?: readonly SurfaceCode[],
    exceptPublicId?: Buffer,
  ) {
    let q = db
      .selectFrom('sessions')
      .select(['id', 'public_id'])
      .where('account_id', '=', accountId)
      .where('ended_at', 'is', null);
    if (exceptPublicId) q = q.where('public_id', '!=', exceptPublicId);
    if (surfaces && surfaces.length > 0) q = q.where('surface', 'in', [...surfaces]);
    return q.forUpdate().execute();
  },

  async activeSessionsOfInstitution(db: Db, institutionId: string) {
    return db
      .selectFrom('sessions')
      .select(['id', 'public_id'])
      .where('institution_id', '=', institutionId)
      .where('ended_at', 'is', null)
      .forUpdate()
      .execute();
  },
};

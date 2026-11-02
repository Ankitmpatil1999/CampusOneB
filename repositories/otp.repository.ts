/** One-time code challenges (docs/04 §3.2). Codes are stored only as an HMAC. */
import type { Kysely, Transaction } from 'kysely';
import type { Database, OtpPurpose } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export const otpRepository = {
  /** The newest challenge for a destination and purpose that is not used up yet. */
  async findLive(db: Db, destinationHash: Buffer, purpose: OtpPurpose, now: Date) {
    return db
      .selectFrom('otp_challenges')
      .selectAll()
      .where('destination_hash', '=', destinationHash)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .where('abandoned_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('id', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
  },

  async insert(
    db: Db,
    c: {
      publicId: Buffer;
      accountId: string | null;
      purpose: OtpPurpose;
      channel: 'SMS' | 'EMAIL';
      destinationHash: Buffer;
      contextHash: Buffer | null;
      codeHash: Buffer;
      maxAttempts: number;
      maxResends: number;
      resendAfterAt: Date;
      expiresAt: Date;
    },
  ) {
    await db
      .insertInto('otp_challenges')
      .values({
        public_id: c.publicId,
        account_id: c.accountId,
        purpose: c.purpose,
        channel: c.channel,
        destination_hash: c.destinationHash,
        context_hash: c.contextHash,
        code_hash: c.codeHash,
        max_attempts: c.maxAttempts,
        max_resends: c.maxResends,
        resend_after_at: c.resendAfterAt,
        expires_at: c.expiresAt,
      })
      .execute();
  },

  async findByPublicId(db: Db, publicId: Buffer) {
    return db
      .selectFrom('otp_challenges')
      .selectAll()
      .where('public_id', '=', publicId)
      .executeTakeFirst();
  },

  async lockByPublicId(db: Db, publicId: Buffer) {
    return db
      .selectFrom('otp_challenges')
      .selectAll()
      .where('public_id', '=', publicId)
      .forUpdate()
      .executeTakeFirst();
  },

  async recordWrongCode(db: Db, id: string, abandon: boolean, now: Date) {
    await db
      .updateTable('otp_challenges')
      .set((eb) => ({
        attempts: eb('attempts', '+', 1),
        ...(abandon ? { abandoned_at: now } : {}),
      }))
      .where('id', '=', id)
      .execute();
  },

  /** Ends a live challenge without using it (its code stops working; not a wrong attempt). */
  async close(db: Db, id: string, now: Date) {
    await db
      .updateTable('otp_challenges')
      .set({ expires_at: now })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .execute();
  },

  async markConsumed(db: Db, id: string, now: Date): Promise<boolean> {
    const r = await db
      .updateTable('otp_challenges')
      .set({ consumed_at: now })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .where('abandoned_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** The account's own mobile or e-mail (resends of account-bound codes). */
  async destinationOfAccount(db: Db, accountId: string, channel: 'SMS' | 'EMAIL') {
    const a = await db
      .selectFrom('platform_accounts')
      .select(['mobile', 'email'])
      .where('id', '=', accountId)
      .executeTakeFirst();
    return channel === 'SMS' ? a?.mobile : (a?.email ?? undefined);
  },

  async replaceCode(
    db: Db,
    id: string,
    c: { codeHash: Buffer; resendAfterAt: Date; expiresAt: Date },
  ) {
    await db
      .updateTable('otp_challenges')
      .set((eb) => ({
        code_hash: c.codeHash,
        resends: eb('resends', '+', 1),
        attempts: 0,
        resend_after_at: c.resendAfterAt,
        expires_at: c.expiresAt,
      }))
      .where('id', '=', id)
      .execute();
  },
};

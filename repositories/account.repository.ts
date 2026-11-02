/**
 * Platform accounts, credentials, consents and devices (docs/04 §3.2; SRS 6.2, 6.3, 6.8, 6.9,
 * 6.15, 6.16). Parameterised SQL only; state changes are guarded updates.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;
export type CredentialKind = 'PASSWORD' | 'TPIN' | 'SECURITY_ANSWER';

export interface NewAccount {
  readonly publicId: Buffer;
  readonly mobile: string;
  readonly email: string;
  readonly firstName: string;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly gender: 'MALE' | 'FEMALE';
  readonly dob: string;
  /** Null when a provider sign-up skipped the personal wallet (CR-03). */
  readonly panEnc: Buffer | null;
  readonly panBidx: Buffer | null;
  readonly panLast4: string | null;
  readonly idDocType: string;
  readonly idDocEnc: Buffer;
  readonly idDocBidx: Buffer;
  readonly idDocLast4: string;
  readonly preferredLang: string;
}

const ACCOUNT_COLUMNS = [
  'id',
  'public_id',
  'mobile',
  'email',
  'email_verified_at',
  'first_name',
  'middle_name',
  'last_name',
  'gender',
  'dob',
  'pan_last4',
  'id_doc_type',
  'id_doc_last4',
  'kyc_level',
  'status',
  'txn_permission',
  'signin_lock',
  'failed_signins',
  'locked_until',
  'preferred_lang',
  'last_signin_at',
  'current_signin_at',
  'row_version',
] as const;

export const accountRepository = {
  async findByMobile(db: Db, mobile: string) {
    return db
      .selectFrom('platform_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('mobile', '=', mobile)
      .executeTakeFirst();
  },

  async lockByMobile(db: Db, mobile: string) {
    return db
      .selectFrom('platform_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('mobile', '=', mobile)
      .forUpdate()
      .executeTakeFirst();
  },

  async findById(db: Db, id: string) {
    return db
      .selectFrom('platform_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  },

  async findByPublicId(db: Db, publicId: Buffer) {
    return db
      .selectFrom('platform_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('public_id', '=', publicId)
      .executeTakeFirst();
  },

  async emailInUse(db: Db, email: string): Promise<boolean> {
    const r = await db
      .selectFrom('platform_accounts')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    return r !== undefined;
  },

  async panInUse(db: Db, panBidx: Buffer): Promise<boolean> {
    const r = await db
      .selectFrom('platform_accounts')
      .select('id')
      .where('pan_bidx', '=', panBidx)
      .executeTakeFirst();
    return r !== undefined;
  },

  /** The account a sign-in provider identity is linked to (CR-03). */
  async findBySocial(db: Db, provider: string, subjectHash: Buffer) {
    return db
      .selectFrom('social_identities as s')
      .innerJoin('platform_accounts as a', 'a.id', 's.account_id')
      .select(ACCOUNT_COLUMNS.map((c) => `a.${c}` as const))
      .where('s.provider', '=', provider)
      .where('s.subject_hash', '=', subjectHash)
      .executeTakeFirst();
  },

  async linkSocial(
    db: Db,
    s: { accountId: string; provider: string; subjectHash: Buffer; email: string | null },
  ): Promise<void> {
    await db
      .insertInto('social_identities')
      .values({
        account_id: s.accountId,
        provider: s.provider,
        subject_hash: s.subjectHash,
        email: s.email,
      })
      .execute();
  },

  /** A confirmed e-mail change (IDN-019). */
  async setVerifiedEmail(db: Db, accountId: string, email: string): Promise<void> {
    await db
      .updateTable('platform_accounts')
      .set({
        email,
        email_verified_at: sql`UTC_TIMESTAMP(3)`,
        row_version: sql`row_version + 1`,
      })
      .where('id', '=', accountId)
      .execute();
  },

  async insert(db: Db, a: NewAccount): Promise<string> {
    const r = await db
      .insertInto('platform_accounts')
      .values({
        public_id: a.publicId,
        mobile: a.mobile,
        email: a.email,
        first_name: a.firstName,
        middle_name: a.middleName,
        last_name: a.lastName,
        gender: a.gender,
        dob: a.dob,
        pan_enc: a.panEnc,
        pan_bidx: a.panBidx,
        pan_last4: a.panLast4,
        id_doc_type: a.idDocType,
        id_doc_enc: a.idDocEnc,
        id_doc_bidx: a.idDocBidx,
        id_doc_last4: a.idDocLast4,
        preferred_lang: a.preferredLang,
        created_by: a.publicId,
        updated_by: a.publicId,
      })
      .executeTakeFirstOrThrow();
    return String(r.insertId);
  },

  async credential(db: Db, accountId: string, kind: CredentialKind) {
    return db
      .selectFrom('account_credentials')
      .select([
        'id',
        'hash',
        'question_code',
        'failed_attempts',
        'locked_until',
        'must_change',
        'row_version',
      ])
      .where('account_id', '=', accountId)
      .where('kind', '=', kind)
      .executeTakeFirst();
  },

  async lockCredential(db: Db, accountId: string, kind: CredentialKind) {
    return db
      .selectFrom('account_credentials')
      .select(['id', 'hash', 'question_code', 'failed_attempts', 'locked_until', 'row_version'])
      .where('account_id', '=', accountId)
      .where('kind', '=', kind)
      .forUpdate()
      .executeTakeFirst();
  },

  async insertCredential(
    db: Db,
    c: { accountId: string; kind: CredentialKind; hash: string; questionCode?: string },
  ) {
    await db
      .insertInto('account_credentials')
      .values({
        account_id: c.accountId,
        kind: c.kind,
        hash: c.hash,
        question_code: c.questionCode ?? null,
      })
      .execute();
  },

  /** Replaces a secret (keeps the previous hash for "not the same" rules); guarded by version. */
  async replaceCredential(
    db: Db,
    c: { id: string; hash: string; previousHash: string; expectedVersion: number },
  ): Promise<boolean> {
    const r = await db
      .updateTable('account_credentials')
      .set((eb) => ({
        hash: c.hash,
        previous_hash: c.previousHash,
        failed_attempts: 0,
        locked_until: null,
        must_change: 0,
        set_at: new Date(),
        row_version: eb('row_version', '+', 1),
      }))
      .where('id', '=', c.id)
      .where('row_version', '=', c.expectedVersion)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async credentialFailure(db: Db, id: string, lockUntil: Date | null) {
    await db
      .updateTable('account_credentials')
      .set((eb) => ({
        failed_attempts: lockUntil ? 0 : eb('failed_attempts', '+', 1),
        locked_until: lockUntil,
      }))
      .where('id', '=', id)
      .execute();
  },

  async insertConsent(
    db: Db,
    c: {
      accountId: string;
      kind: 'CONSENT' | 'TERMS';
      version: string;
      ip: Buffer | null;
      deviceId: string | null;
    },
  ) {
    await db
      .insertInto('consents')
      .values({
        account_id: c.accountId,
        kind: c.kind === 'CONSENT' ? 'DATA_PROCESSING' : 'TERMS',
        version: c.version,
        ip: c.ip,
        device_id: c.deviceId,
      })
      .execute();
  },

  /** A failed sign-in: counts it, or locks the account when the limit is reached (Q13). */
  async signinFailure(db: Db, id: string, lockUntil: Date | null) {
    await db
      .updateTable('platform_accounts')
      .set((eb) => ({
        failed_signins: lockUntil ? 0 : eb('failed_signins', '+', 1),
        locked_until: lockUntil,
      }))
      .where('id', '=', id)
      .execute();
  },

  /** The right password was given: the failure counter starts again. */
  async resetFailures(db: Db, id: string) {
    await db
      .updateTable('platform_accounts')
      .set({ failed_signins: 0, locked_until: null })
      .where('id', '=', id)
      .execute();
  },

  /** A successful sign-in: clears the counter and moves the sign-in timestamps (6.3). */
  async signinSuccess(db: Db, id: string, at: Date) {
    await db
      .updateTable('platform_accounts')
      .set({
        failed_signins: 0,
        locked_until: null,
        last_signin_at: sql<Date>`current_signin_at`,
        current_signin_at: at,
      })
      .where('id', '=', id)
      .execute();
  },

  async setPreferredLang(db: Db, id: string, lang: string) {
    await db
      .updateTable('platform_accounts')
      .set((eb) => ({ preferred_lang: lang, row_version: eb('row_version', '+', 1) }))
      .where('id', '=', id)
      .execute();
  },

  async activeDevice(db: Db, accountId: string) {
    return db
      .selectFrom('devices')
      .select(['id', 'public_id', 'install_id_hash', 'model', 'os', 'app_version', 'bound_at'])
      .where('account_id', '=', accountId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
  },

  /**
   * Binds a device: the previous active device becomes Inactive (27.3, 6.15). `fresh` (a new account)
   * has none, and skipping the update avoids its gap lock.
   */
  async bindDevice(
    db: Db,
    d: {
      accountId: string;
      publicId: Buffer;
      installIdHash: Buffer;
      model: string | null;
      os: string | null;
      appVersion: string | null;
      at: Date;
      fresh?: boolean;
    },
  ): Promise<string> {
    if (!d.fresh) {
      await db
        .updateTable('devices')
        .set({ status: 'INACTIVE', inactivated_at: d.at })
        .where('account_id', '=', d.accountId)
        .where('status', '=', 'ACTIVE')
        .execute();
    }
    const r = await db
      .insertInto('devices')
      .values({
        public_id: d.publicId,
        account_id: d.accountId,
        install_id_hash: d.installIdHash,
        model: d.model,
        os: d.os,
        app_version: d.appVersion,
        bound_at: d.at,
      })
      .executeTakeFirstOrThrow();
    return String(r.insertId);
  },
};

export const referenceRepository = {
  async activeConsent(db: Db, kind: 'CONSENT' | 'TERMS') {
    return db
      .selectFrom('consent_documents')
      .select(['version', 'title_en', 'body_en', 'is_draft'])
      .where('kind', '=', kind)
      .where('active', '=', 1)
      .orderBy('published_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
  },

  async consentExists(db: Db, kind: 'CONSENT' | 'TERMS', version: string): Promise<boolean> {
    const r = await db
      .selectFrom('consent_documents')
      .select('id')
      .where('kind', '=', kind)
      .where('version', '=', version)
      .where('active', '=', 1)
      .executeTakeFirst();
    return r !== undefined;
  },

  async securityQuestions(db: Db) {
    return db
      .selectFrom('ref_security_questions')
      .select(['code', 'label_key', 'text_en'])
      .where('active', '=', 1)
      .orderBy('sort_order')
      .execute();
  },

  async idDocumentTypes(db: Db) {
    return db
      .selectFrom('ref_id_document_types')
      .select(['code', 'label_key', 'number_regex'])
      .where('active', '=', 1)
      .orderBy('sort_order')
      .execute();
  },

  async languageEnabled(db: Db, code: string): Promise<boolean> {
    const r = await db
      .selectFrom('languages')
      .select('code')
      .where('code', '=', code)
      .where('enabled', '=', 1)
      .executeTakeFirst();
    return r !== undefined;
  },
};

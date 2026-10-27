/**
 * Institutions (SRS 7.2–7.5; INS-001…013, INS-035, SAS-027; prototype o.institutions, o.features,
 * c.institution): the tenant record, contacts, settings, plan, onboarding checklist, lifecycle
 * history, feature permissions and channels. Every tenant read is keyed by the internal id the
 * caller resolved from the session (console) or from the operator's request (back office).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ChannelKey } from '../config/registers';
import type { Database, InstitutionStatusCode } from '../models/ringpe_models';

type SubscriptionStatusCode = 'TRIAL' | 'ACTIVE' | 'GRACE' | 'SUSPENDED' | 'CANCELLED';

type Db = Kysely<Database> | Transaction<Database>;

const INSTITUTION_COLUMNS = [
  'i.id',
  'i.public_id',
  'i.identifier',
  'i.name',
  'i.short_name',
  'i.board',
  'i.address_line1',
  'i.city',
  'i.state',
  'i.pin_code',
  'i.office_phone',
  'i.office_email',
  'i.status',
  'i.suspended_at',
  'i.cancelled_at',
  'i.corporate_code',
  'i.pool_account_ref',
  'i.shadow_account_ref',
  'i.fee_merchant_profile_id',
  'i.row_version',
  'i.created_at',
  'i.signup_source',
  'i.start_preference',
] as const;

export const institutionsRepository = {
  async list(db: Db) {
    return db
      .selectFrom('institutions as i')
      .leftJoin('subscriptions as s', 's.institution_id', 'i.id')
      .leftJoin('plans as p', 'p.id', 's.plan_id')
      .leftJoin('plan_versions as pv', 'pv.id', 's.plan_version_id')
      .select([
        ...INSTITUTION_COLUMNS,
        'p.public_id as plan_public_id',
        'p.code as plan_code',
        'p.name as plan_name',
        'pv.cycle as plan_cycle',
        's.status as subscription_status',
        's.trial_ends_on',
        (eb) =>
          eb
            .selectFrom('member_profiles as m')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('m.institution_id', '=', 'i.id')
            .where('m.status', '=', 'ACTIVE')
            .as('members'),
        (eb) =>
          eb
            .selectFrom('onboarding_checklist_steps as c')
            .select(sql<string>`GROUP_CONCAT(c.step_key)`.as('keys'))
            .whereRef('c.institution_id', '=', 'i.id')
            .as('steps_done'),
      ])
      .orderBy('i.id', 'desc')
      .execute();
  },

  async byPublicId(db: Db, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('institutions as i')
      .select(INSTITUTION_COLUMNS)
      .where('i.public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async byId(db: Db, id: string, lock = false) {
    let q = db.selectFrom('institutions as i').select(INSTITUTION_COLUMNS).where('i.id', '=', id);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async byIdentifier(db: Db, identifier: string) {
    return db
      .selectFrom('institutions as i')
      .select(INSTITUTION_COLUMNS)
      .where('i.identifier', '=', identifier)
      .executeTakeFirst();
  },

  async nameAddressTaken(db: Db, key: string, exceptId?: string) {
    let q = db.selectFrom('institutions').select('id').where('name_address_key', '=', key);
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  },

  async corporateCodeTaken(db: Db, code: string, exceptId: string) {
    const r = await db
      .selectFrom('institutions')
      .select('id')
      .where('corporate_code', '=', code)
      .where('id', '!=', exceptId)
      .executeTakeFirst();
    return Boolean(r);
  },

  async insert(
    db: Db,
    v: {
      publicId: Buffer;
      identifier: string;
      name: string;
      shortName: string;
      board: string | null;
      address: string;
      city: string;
      nameAddressKey: string;
      createdBy: Buffer | null;
    },
  ) {
    const r = await db
      .insertInto('institutions')
      .values({
        public_id: v.publicId,
        identifier: v.identifier,
        name: v.name,
        short_name: v.shortName,
        board: v.board,
        address_line1: v.address,
        address_line2: null,
        city: v.city,
        state: null,
        pin_code: null,
        office_phone: null,
        office_email: null,
        suspended_at: null,
        cancelled_at: null,
        corporate_code: null,
        pool_account_ref: null,
        shadow_account_ref: null,
        fee_merchant_profile_id: null,
        name_address_key: v.nameAddressKey,
        created_by: v.createdBy,
        updated_by: v.createdBy,
      })
      .executeTakeFirstOrThrow();
    return String(r.insertId);
  },

  async setIdentifier(db: Db, id: string, identifier: string) {
    await db.updateTable('institutions').set({ identifier }).where('id', '=', id).execute();
  },

  /** Optimistic update of the record (ETag); returns false when the version moved on. */
  async update(
    db: Db,
    id: string,
    expectedVersion: number,
    set: Partial<{
      name: string;
      short_name: string;
      board: string | null;
      address_line1: string;
      city: string;
      pin_code: string | null;
      office_phone: string | null;
      office_email: string | null;
      name_address_key: string;
      corporate_code: string;
      pool_account_ref: string;
      shadow_account_ref: string | null;
      fee_merchant_profile_id: string | null;
    }>,
    by: Buffer | null,
  ) {
    const r = await db
      .updateTable('institutions')
      .set({
        ...set,
        updated_by: by,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Moves the record version on (features, channels, plan: one ETag per institution). */
  async touch(db: Db, id: string, by: Buffer | null) {
    await db
      .updateTable('institutions')
      .set({
        updated_by: by,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .execute();
  },

  /** Guarded status change (01c: `WHERE status = from`, one row). */
  async changeStatus(
    db: Db,
    id: string,
    from: InstitutionStatusCode,
    to: InstitutionStatusCode,
    by: Buffer | null,
    now: Date,
  ) {
    const r = await db
      .updateTable('institutions')
      .set({
        status: to,
        ...(to === 'SUSPENDED' ? { suspended_at: now } : {}),
        ...(from === 'SUSPENDED' && to === 'ACTIVE' ? { suspended_at: null } : {}),
        ...(to === 'CANCELLED' ? { cancelled_at: now } : {}),
        updated_by: by,
        updated_at: now,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('status', '=', from)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async contacts(db: Db, institutionId: string) {
    return db
      .selectFrom('institution_contacts')
      .select(['kind', 'name', 'email', 'mobile_enc', 'mobile_last4'])
      .where('institution_id', '=', institutionId)
      .execute();
  },

  async putContact(
    db: Db,
    v: {
      institutionId: string;
      kind: 'PRIMARY' | 'SECONDARY';
      name: string;
      email: string | null;
      mobileEnc: Buffer | null;
      mobileLast4: string | null;
    },
  ) {
    await db
      .insertInto('institution_contacts')
      .values({
        institution_id: v.institutionId,
        kind: v.kind,
        name: v.name,
        email: v.email,
        mobile_enc: v.mobileEnc,
        mobile_last4: v.mobileLast4,
      })
      .onDuplicateKeyUpdate({
        name: v.name,
        email: v.email,
        mobile_enc: v.mobileEnc,
        mobile_last4: v.mobileLast4,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
      })
      .execute();
  },

  async removeContact(db: Db, institutionId: string, kind: 'PRIMARY' | 'SECONDARY') {
    await db
      .deleteFrom('institution_contacts')
      .where('institution_id', '=', institutionId)
      .where('kind', '=', kind)
      .execute();
  },

  async settings(db: Db, institutionId: string) {
    return db
      .selectFrom('institution_settings as s')
      .leftJoin('files as f', 'f.id', 's.logo_file_id')
      .select([
        's.consent_validity_months',
        's.brand_color',
        's.logo_file_id',
        'f.public_id as logo_public_id',
        'f.original_name as logo_name',
        'f.size_bytes as logo_size',
        'f.scan_status as logo_scan',
      ])
      .where('s.institution_id', '=', institutionId)
      .executeTakeFirst();
  },

  async insertSettings(db: Db, institutionId: string, consentValidityMonths: number) {
    await db
      .insertInto('institution_settings')
      .values({ institution_id: institutionId, consent_validity_months: consentValidityMonths })
      .execute();
  },

  async updateSettings(
    db: Db,
    institutionId: string,
    set: Partial<{ consent_validity_months: number; logo_file_id: string; brand_color: string }>,
  ) {
    await db
      .updateTable('institution_settings')
      .set({ ...set, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
      .where('institution_id', '=', institutionId)
      .execute();
  },

  // --- plans and subscription ---------------------------------------------------------------------
  async subscription(db: Db, institutionId: string, lock = false) {
    let q = db
      .selectFrom('subscriptions')
      .select([
        'plan_id',
        'plan_version_id',
        'scheduled_plan_version_id',
        'status',
        'trial_ends_on',
        'current_period_start_on',
        'current_period_end_on',
        'renews_on',
        'row_version',
      ])
      .where('institution_id', '=', institutionId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  /**
   * Guarded subscription status change (RC-09): only from the listed statuses (`null` = no period
   * started yet). Returns false when the subscription was in another status.
   */
  async setSubscriptionStatus(
    db: Db,
    institutionId: string,
    from: readonly (SubscriptionStatusCode | null)[],
    to: SubscriptionStatusCode,
    set: Partial<{
      plan_version_id: number;
      trial_ends_on: string | null;
      current_period_start_on: string;
      current_period_end_on: string;
      renews_on: string;
    }> = {},
  ) {
    const statuses = from.filter((s): s is SubscriptionStatusCode => s !== null);
    const r = await db
      .updateTable('subscriptions')
      .set({
        status: to,
        ...set,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('institution_id', '=', institutionId)
      .where((eb) =>
        eb.or([
          ...(statuses.length ? [eb('status', 'in', statuses)] : []),
          ...(from.includes(null) ? [eb('status', 'is', null)] : []),
        ]),
      )
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** The plan and the version of its terms the subscription is on. */
  async setPlan(db: Db, institutionId: string, planId: number, versionId: number) {
    await db
      .insertInto('subscriptions')
      .values({
        institution_id: institutionId,
        plan_id: planId,
        plan_version_id: versionId,
        status: null,
      })
      .onDuplicateKeyUpdate({
        plan_id: planId,
        plan_version_id: versionId,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .execute();
  },

  // --- onboarding checklist (RC-10) -----------------------------------------------------------------
  async stepsDone(db: Db, institutionId: string) {
    return db
      .selectFrom('onboarding_checklist_steps')
      .select(['step_key', 'done_at', 'done_by', 'note'])
      .where('institution_id', '=', institutionId)
      .execute();
  },

  /** Pending → Complete; a step already complete stays as it was. Returns true when it changed. */
  async completeStep(
    db: Db,
    institutionId: string,
    stepKey: string,
    by: Buffer | null,
    note: string | null,
  ) {
    const done = await db
      .selectFrom('onboarding_checklist_steps')
      .select('step_key')
      .where('institution_id', '=', institutionId)
      .where('step_key', '=', stepKey)
      .forUpdate()
      .executeTakeFirst();
    if (done) return false;
    await db
      .insertInto('onboarding_checklist_steps')
      .values({ institution_id: institutionId, step_key: stepKey, done_by: by, note })
      .execute();
    return true;
  },

  // --- lifecycle history (RNG-SAS-019, append-only) ---------------------------------------------------
  async addEvent(
    db: Db,
    v: {
      institutionId: string;
      action: string;
      from: string | null;
      to: string | null;
      reason: string;
      actor: Buffer | null;
      at: Date;
    },
  ) {
    await db
      .insertInto('institution_lifecycle_events')
      .values({
        institution_id: v.institutionId,
        action: v.action,
        from_status: v.from,
        to_status: v.to,
        reason: v.reason,
        actor_ref: v.actor,
        occurred_at: v.at,
        notified_at: null,
      })
      .execute();
  },

  async history(db: Db, institutionId: string) {
    return db
      .selectFrom('institution_lifecycle_events as e')
      .leftJoin('platform_accounts as a', 'a.public_id', 'e.actor_ref')
      .select([
        'e.action',
        'e.from_status',
        'e.to_status',
        'e.reason',
        'e.occurred_at',
        'a.first_name',
        'a.last_name',
      ])
      .where('e.institution_id', '=', institutionId)
      .orderBy('e.occurred_at', 'desc')
      .orderBy('e.id', 'desc')
      .execute();
  },

  // --- feature permissions and channels (7.5) --------------------------------------------------------
  async features(db: Db, institutionId: string) {
    return db
      .selectFrom('feature_toggles')
      .select(['feature_key', 'enabled'])
      .where('institution_id', '=', institutionId)
      .execute();
  },

  async setFeature(db: Db, institutionId: string, key: string, enabled: boolean) {
    await db
      .insertInto('feature_toggles')
      .values({ institution_id: institutionId, feature_key: key, enabled })
      .onDuplicateKeyUpdate({ enabled, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
      .execute();
  },

  async channels(db: Db, institutionId: string) {
    return db
      .selectFrom('notification_channel_settings')
      .select(['channel', 'enabled'])
      .where('institution_id', '=', institutionId)
      .execute();
  },

  async setChannel(db: Db, institutionId: string, channel: ChannelKey, enabled: boolean) {
    await db
      .insertInto('notification_channel_settings')
      .values({ institution_id: institutionId, channel, enabled })
      .onDuplicateKeyUpdate({ enabled, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
      .execute();
  },

  async logFeature(
    db: Db,
    v: {
      institutionId: string;
      key: string;
      from: boolean;
      to: boolean;
      reason: string | null;
      actor: Buffer | null;
      at: Date;
    },
  ) {
    await db
      .insertInto('feature_change_log')
      .values({
        institution_id: v.institutionId,
        feature_key: v.key,
        from_value: v.from,
        to_value: v.to,
        reason: v.reason,
        actor_ref: v.actor,
        changed_at: v.at,
      })
      .execute();
  },

  async featureLog(db: Db, institutionId: string | undefined, limit: number) {
    let q = db
      .selectFrom('feature_change_log as l')
      .innerJoin('institutions as i', 'i.id', 'l.institution_id')
      .leftJoin('platform_accounts as a', 'a.public_id', 'l.actor_ref')
      .select([
        'l.id',
        'l.feature_key',
        'l.from_value',
        'l.to_value',
        'l.reason',
        'l.changed_at',
        'i.public_id as institution_public_id',
        'i.short_name',
        'a.first_name',
        'a.last_name',
      ])
      .orderBy('l.changed_at', 'desc')
      .orderBy('l.id', 'desc')
      .limit(limit);
    if (institutionId) q = q.where('l.institution_id', '=', institutionId);
    return q.execute();
  },

  // --- people ---------------------------------------------------------------------------------------
  /**
   * The registered administrator: the account holding the Institution Administrator role, or —
   * until that person creates their RingPe account (client 2026-10-06) — the profile waiting for
   * it, with the e-mail it was registered for (`pending`).
   */
  async administrator(db: Db, institutionId: string) {
    const r = await db
      .selectFrom('profile_roles as pr')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .innerJoin('member_profiles as m', 'm.id', 'pr.profile_id')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select([
        'a.email',
        'a.first_name',
        'a.last_name',
        'm.account_id',
        'm.contact_email',
        'm.first_name as profile_first',
        'm.last_name as profile_last',
      ])
      .where('pr.institution_id', '=', institutionId)
      .where('r.code', '=', 'INSTITUTION_ADMIN')
      .orderBy('pr.created_at')
      .executeTakeFirst();
    if (!r) return undefined;
    const pending = r.account_id === null;
    return {
      email: pending ? r.contact_email : r.email,
      first_name: pending ? r.profile_first : r.first_name,
      last_name: pending ? r.profile_last : r.last_name,
      pending,
    };
  },

  /**
   * The oldest administrator profile waiting for an account with this e-mail (an institution the
   * back office registered before its administrator had a RingPe account).
   */
  async pendingAdministrator(db: Db, email: string) {
    return this.pendingAdministrators(db, email).executeTakeFirst();
  },

  /** Every administrator profile waiting for an account with this e-mail, oldest first. */
  pendingAdministrators(db: Db, email: string) {
    return db
      .selectFrom('member_profiles as m')
      .innerJoin('profile_roles as pr', 'pr.profile_id', 'm.id')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .select(['m.id', 'm.institution_id', 'i.name', 'i.identifier', 'i.public_id'])
      .where('m.account_id', 'is', null)
      .where('m.contact_email', '=', email.trim().toLowerCase())
      .where('r.code', '=', 'INSTITUTION_ADMIN')
      .where('i.status', '!=', 'CANCELLED')
      .orderBy('m.id');
  },

  /**
   * Gives the administrator profiles waiting for this e-mail — every one of them (client
   * 2026-10-27: a person may belong to, and administer, several institutions) — to an account whose
   * e-mail is verified. A back-office account never takes one. Returns the institutions linked
   * (none: nothing to link).
   */
  async claimPendingAdministrator(
    db: Db,
    account: { id: string; email: string; firstName: string; lastName: string | null },
  ) {
    if (await this.isOperator(db, account.id)) return [];
    const claimed = [];
    for (const pending of await this.pendingAdministrators(db, account.email).execute()) {
      const r = await db
        .updateTable('member_profiles')
        .set({
          account_id: account.id,
          first_name: account.firstName,
          last_name: account.lastName,
          updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', pending.id)
        .where('account_id', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 1) claimed.push(pending);
    }
    return claimed;
  },

  async isOperator(db: Db, accountId: string) {
    const r = await db
      .selectFrom('operator_accounts')
      .select('id')
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return Boolean(r);
  },

  async roleId(db: Db, code: string) {
    const r = await db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return String(r.id);
  },

  async memberCount(db: Db, institutionId: string) {
    const r = await db
      .selectFrom('member_profiles')
      .select((e) => e.fn.countAll<number>().as('n'))
      .where('institution_id', '=', institutionId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  },
};

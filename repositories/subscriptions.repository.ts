/**
 * Subscriptions after go-live (FR-SAS-05/07; SAS-026, SAS-034…039; prototype c.subscription,
 * o.institutions "Change plan"): plan switches, changes scheduled for renewal, the renewal
 * roll-over of the billing run, and the institution's plan change requests. Every change is a
 * guarded update.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, PlanChangeRequestStatus } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export const subscriptionsRepository = {
  /** Switches the plan now (a trial, or an upgrade billed prorated); any scheduled change goes. */
  async switchNow(
    db: Db,
    institutionId: string,
    expected: number,
    v: { planId: number; versionId: number },
  ) {
    const r = await db
      .updateTable('subscriptions')
      .set({
        plan_id: v.planId,
        plan_version_id: v.versionId,
        scheduled_plan_version_id: null,
        scheduled_at: null,
        scheduled_by: null,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('institution_id', '=', institutionId)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Schedules (or clears, with `null`) the version the next period takes. */
  async schedule(
    db: Db,
    institutionId: string,
    expected: number,
    v: { versionId: number | null; by: Buffer | null; at: Date | null },
  ) {
    const r = await db
      .updateTable('subscriptions')
      .set({
        scheduled_plan_version_id: v.versionId,
        scheduled_at: v.at,
        scheduled_by: v.by,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('institution_id', '=', institutionId)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Running subscriptions (Active or Grace) with a renewal date — the billing run's input. */
  async running(db: Db) {
    return db
      .selectFrom('subscriptions as s')
      .innerJoin('institutions as i', 'i.id', 's.institution_id')
      .select([
        's.institution_id',
        's.plan_id',
        's.plan_version_id',
        's.scheduled_plan_version_id',
        's.status',
        's.renews_on',
        's.row_version',
        'i.public_id',
        'i.name',
        'i.status as institution_status',
      ])
      .where('s.status', 'in', ['ACTIVE', 'GRACE'])
      .where('s.renews_on', 'is not', null)
      .orderBy('s.institution_id')
      .execute();
  },

  /**
   * The renewal roll-over: the next period starts on the renewal date with the renewal terms.
   * Guarded by the renewal date, so a second run finds nothing to do.
   */
  async rollOver(
    db: Db,
    institutionId: string,
    renewsOn: string,
    v: { planId: number; versionId: number; start: string; end: string; renews: string },
  ) {
    const r = await db
      .updateTable('subscriptions')
      .set({
        plan_id: v.planId,
        plan_version_id: v.versionId,
        scheduled_plan_version_id: null,
        scheduled_at: null,
        scheduled_by: null,
        current_period_start_on: v.start,
        current_period_end_on: v.end,
        renews_on: v.renews,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('institution_id', '=', institutionId)
      .where('renews_on', '=', renewsOn)
      .where('status', 'in', ['ACTIVE', 'GRACE'])
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  // --- plan change requests (RC-09) ----------------------------------------------------------------
  async insertRequest(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      planId: number;
      timing: 'RENEWAL' | 'NOW';
      note: string | null;
      by: Buffer;
      at: Date;
    },
  ) {
    await db
      .insertInto('plan_change_requests')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        plan_id: v.planId,
        timing: v.timing,
        note: v.note,
        status: 'PENDING',
        requested_by: v.by,
        requested_at: v.at,
      })
      .execute();
  },

  async requests(db: Db, institutionId: string, limit = 20) {
    return db
      .selectFrom('plan_change_requests as r')
      .innerJoin('plans as p', 'p.id', 'r.plan_id')
      .leftJoin('platform_accounts as a', 'a.public_id', 'r.requested_by')
      .select([
        'r.id',
        'r.public_id',
        'r.plan_id',
        'p.public_id as plan_public_id',
        'p.name as plan_name',
        'r.timing',
        'r.note',
        'r.status',
        'r.requested_at',
        'r.resolved_at',
        'r.resolution',
        'a.first_name',
        'a.last_name',
        'a.email',
      ])
      .where('r.institution_id', '=', institutionId)
      .orderBy('r.id', 'desc')
      .limit(limit)
      .execute();
  },

  async pendingRequest(db: Db, institutionId: string) {
    return db
      .selectFrom('plan_change_requests')
      .select(['id', 'plan_id'])
      .where('institution_id', '=', institutionId)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
  },

  async requestByPublicId(db: Db, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('plan_change_requests')
      .select(['id', 'institution_id', 'plan_id', 'timing', 'status', 'requested_by'])
      .where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  /** Guarded: only a pending request is resolved. */
  async resolveRequest(
    db: Db,
    id: string,
    to: Exclude<PlanChangeRequestStatus, 'PENDING'>,
    v: { by: Buffer | null; at: Date; resolution: string | null },
  ) {
    const r = await db
      .updateTable('plan_change_requests')
      .set({
        status: to,
        resolved_by: v.by,
        resolved_at: v.at,
        resolution: v.resolution,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Pending requests for a plan the operator has just applied are marked applied. */
  async applyPending(
    db: Db,
    institutionId: string,
    planId: number,
    v: { by: Buffer | null; at: Date; resolution: string },
  ) {
    await db
      .updateTable('plan_change_requests')
      .set({
        status: 'APPLIED',
        resolved_by: v.by,
        resolved_at: v.at,
        resolution: v.resolution,
        row_version: sql<number>`row_version + 1`,
      })
      .where('institution_id', '=', institutionId)
      .where('plan_id', '=', planId)
      .where('status', '=', 'PENDING')
      .execute();
  },

  /** Bytes stored for the institution (usage against the plan's storage allowance). */
  async storageBytes(db: Db, institutionId: string) {
    const r = await db
      .selectFrom('files')
      .select((e) => e.fn.sum<number>('size_bytes').as('n'))
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  },

  /** When the subscription first started (trial or activation), from the lifecycle history. */
  async since(db: Db, institutionId: string) {
    const r = await db
      .selectFrom('institution_lifecycle_events')
      .select((e) => e.fn.min('occurred_at').as('at'))
      .where('institution_id', '=', institutionId)
      .where('action', 'in', ['TRIAL_STARTED', 'ACTIVATED'])
      .executeTakeFirst();
    return r?.at ? new Date(r.at as Date) : null;
  },
};

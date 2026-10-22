/**
 * In-app notifications (COM-009/010 console, COM-014/015 member app; docs/04 §3.9). A row is for one
 * platform account on one surface; console rows also carry the institution. Rows are read in id
 * order (keyset) and marked read; they are never deleted by the app.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';

type Db = Kysely<Database> | Transaction<Database>;

export type NotificationSurface = 'CONSOLE' | 'MEMBER';

export interface NewNotification {
  readonly publicId: Buffer;
  readonly institutionId: string | null;
  readonly accountId: string;
  readonly surface: NotificationSurface;
  readonly category: string;
  readonly titleKey: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly body: string;
  readonly link: string | null;
  readonly at: Date;
}

const scope = (
  db: Db,
  accountId: string,
  surface: NotificationSurface,
  institutionId: string | null,
) => {
  let q = db
    .selectFrom('notifications')
    .where('account_id', '=', accountId)
    .where('surface', '=', surface);
  if (institutionId !== null) q = q.where('institution_id', '=', institutionId);
  return q;
};

export const notificationsRepository = {
  async insertMany(db: Db, rows: readonly NewNotification[]) {
    if (!rows.length) return;
    await db
      .insertInto('notifications')
      .values(
        rows.map((n) => ({
          created_on: n.at.toISOString().slice(0, 10),
          public_id: n.publicId,
          institution_id: n.institutionId,
          account_id: n.accountId,
          surface: n.surface,
          category: n.category,
          title_key: n.titleKey,
          params: JSON.stringify(n.params),
          body: n.body.slice(0, 300),
          link: n.link,
          created_at: n.at,
        })),
      )
      .execute();
  },

  async page(
    db: Db,
    accountId: string,
    surface: NotificationSurface,
    institutionId: string | null,
    f: { unread: boolean; before?: string | undefined; limit: number },
  ) {
    let q = scope(db, accountId, surface, institutionId).select([
      'id',
      'public_id',
      'category',
      'title_key',
      'params',
      'body',
      'link',
      'read_at',
      'created_at',
    ]);
    if (f.unread) q = q.where('read_at', 'is', null);
    if (f.before) q = q.where('id', '<', f.before);
    return q
      .orderBy('id', 'desc')
      .limit(f.limit + 1)
      .execute();
  },

  async unread(
    db: Db,
    accountId: string,
    surface: NotificationSurface,
    institutionId: string | null,
  ) {
    const r = await scope(db, accountId, surface, institutionId)
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  },

  /** Marks the given notifications (or all) read; returns how many changed. */
  async markRead(
    db: Db,
    accountId: string,
    surface: NotificationSurface,
    institutionId: string | null,
    publicIds: readonly Buffer[] | null,
    at: Date,
  ) {
    let q = db
      .updateTable('notifications')
      .set({ read_at: at })
      .where('account_id', '=', accountId)
      .where('surface', '=', surface)
      .where('read_at', 'is', null);
    if (institutionId !== null) q = q.where('institution_id', '=', institutionId);
    if (publicIds !== null) {
      if (!publicIds.length) return 0;
      q = q.where('public_id', 'in', [...publicIds]);
    }
    const r = await q.executeTakeFirst();
    return Number(r.numUpdatedRows);
  },

  /** Accounts that decide this institution's approvals: active Institution Administrators (Q9). */
  async checkers(db: Db, institutionId: string) {
    const rows = await db
      .selectFrom('profile_roles as pr')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .innerJoin('member_profiles as m', 'm.id', 'pr.profile_id')
      .select('m.account_id')
      .distinct()
      .where('pr.institution_id', '=', institutionId)
      .where('r.code', '=', 'INSTITUTION_ADMIN')
      .where('m.status', '=', 'ACTIVE')
      .where('m.account_id', 'is not', null)
      .execute();
    return rows.map((r) => String(r.account_id));
  },

  /**
   * Accounts whose roles at this institution grant the sub-task (client 2026-10-19): the staff a
   * piece of work waits for — Accounts for a fee to confirm, the Co-ordinator for an application to
   * approve. A role grants a sub-task when it has it and its task is assigned (as the session does).
   */
  async holdersOf(db: Db, institutionId: string, subTask: string) {
    const rows = await db
      .selectFrom('profile_roles as pr')
      .innerJoin('member_profiles as m', 'm.id', 'pr.profile_id')
      .innerJoin('role_tasks as rt', 'rt.role_id', 'pr.role_id')
      .innerJoin('sub_tasks as st', 'st.id', 'rt.sub_task_id')
      .innerJoin('role_task_assignments as a', (j) =>
        j.onRef('a.role_id', '=', 'rt.role_id').onRef('a.task_id', '=', 'st.task_id'),
      )
      .select('m.account_id')
      .distinct()
      .where('pr.institution_id', '=', institutionId)
      .where('st.code', '=', subTask)
      .where('m.status', '=', 'ACTIVE')
      .where('m.account_id', 'is not', null)
      .execute();
    return rows.map((r) => String(r.account_id));
  },
};

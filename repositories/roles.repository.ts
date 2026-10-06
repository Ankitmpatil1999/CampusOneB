/**
 * Roles administration (SRS 6.28; IDN-063…069, IDN-081; prototype o.roles): roles with their tasks
 * and grants, operator accounts, the append-only change record.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, RoleScope } from '../models/ringpe_models';

type Db = Kysely<Database> | Transaction<Database>;

export const rolesRepository = {
  async tasks(db: Db, scope?: RoleScope) {
    let q = db
      .selectFrom('tasks as t')
      .leftJoin('sub_tasks as st', 'st.task_id', 't.id')
      .select([
        't.id as task_id',
        't.scope',
        't.code as task_code',
        't.label_key as task_label',
        'st.code as sub_code',
        'st.label_key as sub_label',
      ])
      .orderBy('t.sort_order')
      .orderBy('st.id');
    if (scope) q = q.where('t.scope', '=', scope);
    return q.execute();
  },

  async roles(db: Db, scope?: RoleScope) {
    let q = db
      .selectFrom('roles')
      .select([
        'id',
        'public_id',
        'scope',
        'code',
        'name',
        'description',
        'status',
        'read_only',
        'row_version',
      ])
      .where('institution_id', 'is', null)
      .orderBy('scope', 'desc')
      .orderBy('id');
    if (scope) q = q.where('scope', '=', scope);
    return q.execute();
  },

  async roleByPublicId(db: Db, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('roles')
      .select(['id', 'public_id', 'scope', 'code', 'name', 'status', 'row_version'])
      .where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async assignments(db: Db, roleIds: readonly string[]) {
    if (roleIds.length === 0) return [];
    return db
      .selectFrom('role_task_assignments as a')
      .innerJoin('tasks as t', 't.id', 'a.task_id')
      .select(['a.role_id', 't.code'])
      .where('a.role_id', 'in', roleIds)
      .execute();
  },

  async grants(db: Db, roleIds: readonly string[]) {
    if (roleIds.length === 0) return [];
    return db
      .selectFrom('role_tasks as g')
      .innerJoin('sub_tasks as st', 'st.id', 'g.sub_task_id')
      .select(['g.role_id', 'st.code'])
      .where('g.role_id', 'in', roleIds)
      .execute();
  },

  /** Operator accounts holding each operator role (names for "held by …"). */
  async operatorHolders(db: Db) {
    return db
      .selectFrom('operator_accounts as oa')
      .innerJoin('platform_accounts as a', 'a.id', 'oa.account_id')
      .select(['oa.role_id', 'oa.status', 'a.first_name', 'a.last_name'])
      .execute();
  },

  /** Institution profiles holding each institution role (counts only — no names cross tenants). */
  async institutionHolderCounts(db: Db) {
    return db
      .selectFrom('profile_roles')
      .select(['role_id', sql<number>`COUNT(*)`.as('n')])
      .groupBy('role_id')
      .execute();
  },

  async taskId(db: Db, scope: RoleScope, code: string) {
    return db
      .selectFrom('tasks')
      .select('id')
      .where('scope', '=', scope)
      .where('code', '=', code)
      .executeTakeFirst();
  },

  async subTask(db: Db, scope: RoleScope, code: string) {
    return db
      .selectFrom('sub_tasks as st')
      .innerJoin('tasks as t', 't.id', 'st.task_id')
      .select(['st.id', 'st.task_id', 't.code as task_code'])
      .where('t.scope', '=', scope)
      .where('st.code', '=', code)
      .executeTakeFirst();
  },

  /** Enabled roles other than `exceptRoleId` that hold `roles.edit` inside an assigned task. */
  async otherRoleAdmins(db: Db, exceptRoleId: string): Promise<number> {
    const r = await db
      .selectFrom('roles as r')
      .innerJoin('role_tasks as g', 'g.role_id', 'r.id')
      .innerJoin('sub_tasks as st', 'st.id', 'g.sub_task_id')
      .innerJoin('role_task_assignments as a', (j) =>
        j.onRef('a.role_id', '=', 'r.id').onRef('a.task_id', '=', 'st.task_id'),
      )
      .select(sql<number>`COUNT(DISTINCT r.id)`.as('n'))
      .where('r.scope', '=', 'OPERATOR')
      .where('r.status', '=', 'ACTIVE')
      .where('st.code', '=', 'roles.edit')
      .where('r.id', '<>', exceptRoleId)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  },

  /** Bumps the version when it is still `expected` (optimistic locking). */
  async touchRole(db: Db, id: string, expected: number): Promise<boolean> {
    const r = await db
      .updateTable('roles')
      .set({ row_version: sql<number>`row_version + 1`, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
      .where('id', '=', id)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Platform accounts whose sessions a role change affects. */
  async operatorAccountsOfRole(db: Db, roleId: string) {
    const rows = await db
      .selectFrom('operator_accounts')
      .select('account_id')
      .where('role_id', '=', roleId)
      .execute();
    return rows.map((r) => r.account_id);
  },

  async operatorAccounts(db: Db) {
    return db
      .selectFrom('operator_accounts as oa')
      .innerJoin('platform_accounts as a', 'a.id', 'oa.account_id')
      .innerJoin('roles as r', 'r.id', 'oa.role_id')
      .select([
        'oa.id',
        'oa.public_id',
        'oa.status',
        'oa.status_note',
        'oa.row_version',
        'a.id as account_id',
        'a.public_id as account_public_id',
        'a.first_name',
        'a.last_name',
        'a.email',
        'a.current_signin_at',
        'a.signin_lock',
        'a.locked_until',
        'r.public_id as role_public_id',
        'r.name as role_name',
      ])
      .orderBy('oa.id')
      .execute();
  },

  async operatorAccountByPublicId(db: Db, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('operator_accounts as oa')
      .innerJoin('platform_accounts as a', 'a.id', 'oa.account_id')
      .innerJoin('roles as r', 'r.id', 'oa.role_id')
      .select([
        'oa.id',
        'oa.status',
        'oa.row_version',
        'oa.account_id',
        'oa.role_id',
        'a.first_name',
        'a.last_name',
        'r.name as role_name',
      ])
      .where('oa.public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async operatorAccountOf(db: Db, accountId: string) {
    return db
      .selectFrom('operator_accounts')
      .select(['id', 'public_id', 'role_id', 'status', 'row_version'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  },

  /** The institution an account has a profile in (an institution account holds no operator role). */
  async institutionOfAccount(db: Db, accountId: string) {
    return db
      .selectFrom('member_profiles as p')
      .innerJoin('institutions as i', 'i.id', 'p.institution_id')
      .select('i.name')
      .where('p.account_id', '=', accountId)
      .orderBy('p.id')
      .executeTakeFirst();
  },

  async log(
    db: Db,
    e: {
      publicId: Buffer;
      actorAccountId: string;
      roleId?: string | null;
      operatorAccountId?: string | null;
      text: string;
      reason: string;
    },
  ) {
    await db
      .insertInto('role_change_log')
      .values({
        public_id: e.publicId,
        actor_account_id: e.actorAccountId,
        role_id: e.roleId ?? null,
        operator_account_id: e.operatorAccountId ?? null,
        change_text: e.text.slice(0, 300),
        reason: e.reason.slice(0, 300),
      })
      .execute();
  },

  async changes(db: Db, limit: number) {
    return db
      .selectFrom('role_change_log as l')
      .innerJoin('platform_accounts as a', 'a.id', 'l.actor_account_id')
      .select([
        'l.public_id',
        'l.created_at',
        'l.change_text',
        'l.reason',
        'a.first_name',
        'a.last_name',
      ])
      .orderBy('l.id', 'desc')
      .limit(limit)
      .execute();
  },
};

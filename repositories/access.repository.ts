/**
 * Staff access: who may enter the institution console or the back office, and with which grants
 * (SRS 6.4 RNG-IDN-041…045, 6.28; docs/01 §6). Every query is scoped by the account or profile it
 * is given; the institution always comes from the profile, never from a request.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';

type Db = Kysely<Database> | Transaction<Database>;

/** Granted sub-tasks of an assigned task, plus `task.<code>` for every assigned task. */
async function grantsOfRoles(db: Db, roleIds: readonly string[]): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const [subs, tasks] = await Promise.all([
    db
      .selectFrom('role_tasks as rt')
      .innerJoin('sub_tasks as st', 'st.id', 'rt.sub_task_id')
      .innerJoin('role_task_assignments as a', (j) =>
        j.onRef('a.role_id', '=', 'rt.role_id').onRef('a.task_id', '=', 'st.task_id'),
      )
      .select('st.code')
      .distinct()
      .where('rt.role_id', 'in', roleIds)
      .execute(),
    db
      .selectFrom('role_task_assignments as a')
      .innerJoin('tasks as t', 't.id', 'a.task_id')
      .select('t.code')
      .distinct()
      .where('a.role_id', 'in', roleIds)
      .execute(),
  ]);
  return [...subs.map((r) => r.code), ...tasks.map((t) => `task.${t.code}`)].sort();
}

export const accessRepository = {
  async findAccountByEmail(db: Db, email: string) {
    return db
      .selectFrom('platform_accounts')
      .select([
        'id',
        'public_id',
        'email',
        'email_verified_at',
        'mobile',
        'first_name',
        'last_name',
        'status',
        'signin_lock',
        'failed_signins',
        'locked_until',
        'abandoned_code_attempts',
        'preferred_lang',
      ])
      .where('email', '=', email)
      .executeTakeFirst();
  },

  /**
   * The console context (RNG-IDN-043/044/045): the account's first active, non-student profile in
   * an active institution that holds at least one active role with a grant.
   */
  async consoleContext(db: Db, accountId: string) {
    return db
      .selectFrom('member_profiles as p')
      .innerJoin('institutions as i', 'i.id', 'p.institution_id')
      .innerJoin('user_types as ut', 'ut.id', 'p.user_type_id')
      .select([
        'p.id as profile_id',
        'p.public_id as profile_public_id',
        'p.first_name',
        'p.last_name',
        'i.id as institution_id',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'i.short_name',
        'i.city',
      ])
      .where('p.account_id', '=', accountId)
      .where('p.status', '=', 'ACTIVE')
      .where('i.status', '=', 'ACTIVE')
      .where('ut.category', '<>', 'STUDENT')
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('profile_roles as pr')
            .innerJoin('roles as r', 'r.id', 'pr.role_id')
            .innerJoin('role_task_assignments as rta', 'rta.role_id', 'r.id')
            .select(sql<number>`1`.as('one'))
            .whereRef('pr.profile_id', '=', 'p.id')
            .where('r.status', '=', 'ACTIVE'),
        ),
      )
      .orderBy('p.id')
      .limit(1)
      .executeTakeFirst();
  },

  /**
   * The customer portal (SAS-005/006): an active profile holding the Institution Administrator
   * role. The portal stays open while the institution is pending, on trial or suspended, so it can
   * always go live and pay; only a cancelled institution is closed.
   */
  async portalContext(db: Db, accountId: string) {
    return db
      .selectFrom('member_profiles as p')
      .innerJoin('institutions as i', 'i.id', 'p.institution_id')
      .innerJoin('profile_roles as pr', 'pr.profile_id', 'p.id')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .select([
        'p.id as profile_id',
        'p.public_id as profile_public_id',
        'p.first_name',
        'p.last_name',
        'i.id as institution_id',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'i.short_name',
        'i.city',
        'i.identifier',
        'i.status as institution_status',
      ])
      .where('p.account_id', '=', accountId)
      .where('p.status', '=', 'ACTIVE')
      .where('r.code', '=', 'INSTITUTION_ADMIN')
      .where('i.status', '<>', 'CANCELLED')
      .orderBy('p.id')
      .limit(1)
      .executeTakeFirst();
  },

  /** RNG-IDN-043: an account with an institution profile does not enter the back office. */
  async hasInstitutionProfile(db: Db, accountId: string): Promise<boolean> {
    const r = await db
      .selectFrom('member_profiles')
      .select('id')
      .where('account_id', '=', accountId)
      .where('status', '=', 'ACTIVE')
      .limit(1)
      .executeTakeFirst();
    return r !== undefined;
  },

  async operatorContext(db: Db, accountId: string) {
    return db
      .selectFrom('operator_accounts as oa')
      .innerJoin('roles as r', 'r.id', 'oa.role_id')
      .select(['oa.id as operator_id', 'r.code as role_code', 'r.name as role_name'])
      .where('oa.account_id', '=', accountId)
      .where('oa.status', '=', 'ACTIVE')
      .where('r.status', '=', 'ACTIVE')
      .where('r.scope', '=', 'OPERATOR')
      .executeTakeFirst();
  },

  /**
   * What a profile's active institution roles allow: the granted sub-tasks, and `task.<code>` for
   * each assigned task (menus follow tasks, actions follow sub-tasks — RNG-GOV-001).
   */
  async profileGrants(db: Db, profileId: string): Promise<string[]> {
    const roles = await db
      .selectFrom('profile_roles as pr')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .select('r.id')
      .where('pr.profile_id', '=', profileId)
      .where('r.status', '=', 'ACTIVE')
      .where('r.scope', '=', 'INSTITUTION')
      .execute();
    return grantsOfRoles(
      db,
      roles.map((r) => r.id),
    );
  },

  /** What an operator's role allows (sub-tasks and `task.<code>`). */
  async operatorGrants(db: Db, accountId: string): Promise<string[]> {
    const roles = await db
      .selectFrom('operator_accounts as oa')
      .innerJoin('roles as r', 'r.id', 'oa.role_id')
      .select('r.id')
      .where('oa.account_id', '=', accountId)
      .where('oa.status', '=', 'ACTIVE')
      .where('r.status', '=', 'ACTIVE')
      .where('r.scope', '=', 'OPERATOR')
      .execute();
    return grantsOfRoles(
      db,
      roles.map((r) => r.id),
    );
  },

  async profileRoles(db: Db, profileId: string) {
    return db
      .selectFrom('profile_roles as pr')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .select(['r.code', 'r.name', 'r.read_only'])
      .where('pr.profile_id', '=', profileId)
      .where('r.status', '=', 'ACTIVE')
      .orderBy('r.name')
      .execute();
  },

  async institutionOfProfile(db: Db, profilePublicId: Buffer) {
    return db
      .selectFrom('member_profiles as p')
      .innerJoin('institutions as i', 'i.id', 'p.institution_id')
      .select([
        'p.id as profile_id',
        'p.first_name',
        'p.last_name',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'i.short_name',
        'i.city',
      ])
      .where('p.public_id', '=', profilePublicId)
      .executeTakeFirst();
  },

  /**
   * An abandoned code attempt (RNG-IDN-380): counts it, and locks the account for the
   * administrator to release once the limit is reached. Returns whether it is now locked.
   */
  async abandonedAttempt(db: Db, accountId: string, lockAfter: number): Promise<boolean> {
    await db
      .updateTable('platform_accounts')
      // MySQL applies SET assignments left to right: the lock test reads the count before it moves.
      .set((eb) => ({
        signin_lock: sql<
          'LOCKED' | 'UNLOCKED'
        >`IF(abandoned_code_attempts + 1 >= ${lockAfter}, 'LOCKED', signin_lock)`,
        abandoned_code_attempts: eb('abandoned_code_attempts', '+', 1),
      }))
      .where('id', '=', accountId)
      .execute();
    const r = await db
      .selectFrom('platform_accounts')
      .select('signin_lock')
      .where('id', '=', accountId)
      .executeTakeFirst();
    return r?.signin_lock === 'LOCKED';
  },

  /** A completed staff sign-in starts the abandoned-attempt count again. */
  async resetAbandoned(db: Db, accountId: string) {
    await db
      .updateTable('platform_accounts')
      .set({ abandoned_code_attempts: 0 })
      .where('id', '=', accountId)
      .execute();
  },
};

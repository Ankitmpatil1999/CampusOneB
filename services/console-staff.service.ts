/**
 * Console accounts of an institution (SRS 6.28, CR-05; IDN-038, IDN-060…062): who may sign in to
 * the console, with which institution roles, and the administrator's release of a locked account.
 *
 * - A "staff account" is a staff profile of the institution that has a CampusOne account; students
 *   and parents never hold console roles. A merchant may hold the Merchant or Vendor merchant role
 *   matching its type (client 2026-10-13), and nothing else.
 * - Roles are the platform's institution roles (the operator keeps the catalogue, IDN-063…066).
 *   The Institution Administrator role is given and taken away by CampusOne only (it decides
 *   approvals, Q9); every other active role can be assigned here. New grants apply at the account's
 *   next token refresh; a role taken away ends the account's console sessions.
 */
import type { Kysely } from 'kysely';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { rolesRepository } from '../repositories/roles.repository';
import { recordAudit } from './audit.service';
import type { SessionService } from './session.service';
import { ConflictError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { usesProfile } from './member-roles';

export const ADMIN = 'INSTITUTION_ADMIN';

/**
 * The roles of one person's own work go only to the matching profile (client 2026-10-13): the
 * Principal role to the principal (or management), the Merchant role to a regular merchant and the
 * Vendor merchant role to a vendor merchant — and a merchant holds no other role.
 */
const ROLE_PROFILE: Readonly<
  Record<string, { who: string; fits: (category: string, merchantType: string | null) => boolean }>
> = {
  PRINCIPAL: {
    who: 'the principal or management',
    fits: (c) => c === 'PRINCIPAL' || c === 'MANAGEMENT',
  },
  MERCHANT: { who: 'a regular merchant', fits: (c, t) => c === 'MERCHANT' && t === 'REGULAR' },
  VENDOR_MERCHANT: { who: 'a vendor merchant', fits: (c, t) => c === 'MERCHANT' && t === 'VENDOR' },
};

export function checkProfileForRole(
  role: { code: string | null; name: string },
  m: { category: string; merchant_type: string | null },
) {
  const rule = role.code ? ROLE_PROFILE[role.code] : undefined;
  const ok = rule
    ? rule.fits(m.category, m.merchant_type)
    : // A staff role: not for a merchant.
      m.category !== 'MERCHANT';
  if (!ok) {
    throw new ConflictError('IDN.ROLE_WRONG_PROFILE', {
      params: { role: role.name, who: rule?.who ?? 'staff of the school, not a merchant' },
    });
  }
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

export class ConsoleStaffService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly sessions: SessionService;
      readonly loggers: Loggers;
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async inst(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    return row;
  }

  // --- IDN-062 ------------------------------------------------------------------------------------
  /** Institution roles with their tasks and sub-tasks; which ones may be assigned here. */
  async roles(_p: Principal) {
    const db = this.deps.db;
    const roles = (await rolesRepository.roles(db, 'INSTITUTION')).filter(
      (r) => r.status === 'ACTIVE',
    );
    const ids = roles.map((r) => r.id);
    const [assignments, grants] = await Promise.all([
      rolesRepository.assignments(db, ids),
      rolesRepository.grants(db, ids),
    ]);
    return {
      items: roles.map((r) => ({
        id: binToUuid(r.public_id),
        code: r.code,
        name: r.name,
        description: r.description,
        readOnly: r.read_only === 1,
        assignable: r.code !== ADMIN,
        tasks: assignments.filter((a) => a.role_id === r.id).map((a) => a.code),
        subTasks: grants.filter((g) => g.role_id === r.id).map((g) => g.code),
      })),
    };
  }

  // --- IDN-060 ------------------------------------------------------------------------------------
  /** Staff of the institution with a CampusOne account: roles, last sign-in, lock. */
  async accounts(p: Principal) {
    const inst = await this.inst(p);
    const db = this.deps.db;
    const rows = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
      .leftJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .select([
        'm.id',
        'm.public_id',
        'm.member_seq',
        'm.first_name',
        'm.last_name',
        'm.status',
        'ut.name as user_type',
        'ut.category',
        'mer.sub_type as merchant_type',
        'a.email',
        'a.mobile',
        'a.signin_lock',
        'a.locked_until',
        'a.current_signin_at',
      ])
      .where('m.institution_id', '=', inst.id)
      // Merchants are listed too (client 2026-10-13): the Merchant or Vendor merchant role opens
      // their counter on the web.
      .where('ut.category', 'not in', ['STUDENT', 'PARENT'])
      .orderBy('m.first_name')
      .execute();
    const roles = rows.length
      ? await db
          .selectFrom('profile_roles as pr')
          .innerJoin('roles as r', 'r.id', 'pr.role_id')
          .select(['pr.profile_id', 'r.public_id', 'r.code', 'r.name'])
          .where('pr.institution_id', '=', inst.id)
          .execute()
      : [];
    const now = this.now();
    return {
      items: rows.map((m) => ({
        id: binToUuid(m.public_id),
        memberNo: `${inst.short_name}-${String(m.member_seq).padStart(5, '0')}`,
        name: [m.first_name, m.last_name].filter(Boolean).join(' '),
        userType: m.user_type,
        category: m.category,
        /** A merchant's type, which decides its role: Merchant (REGULAR) or Vendor merchant. */
        merchantType: m.merchant_type ?? null,
        email: m.email,
        mobile: `••••••${m.mobile.slice(-4)}`,
        status: m.status,
        roles: roles
          .filter((r) => String(r.profile_id) === String(m.id))
          .map((r) => ({ id: binToUuid(r.public_id), code: r.code, name: r.name })),
        locked:
          m.signin_lock === 'LOCKED' || (m.locked_until !== null && new Date(m.locked_until) > now),
        lastSignInAt: m.current_signin_at ? new Date(m.current_signin_at).toISOString() : null,
      })),
    };
  }

  private async staff(p: Principal, profileId: string) {
    if (!isUuid(profileId)) throw new NotFoundError();
    const inst = await this.inst(p);
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
      .leftJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'ut.category',
        'mer.sub_type as merchant_type',
        'a.id as account_id',
        'a.public_id as account_public_id',
      ])
      .where('m.institution_id', '=', inst.id)
      .where('m.public_id', '=', uuidToBin(profileId))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    return { inst, m };
  }

  // --- IDN-061 ------------------------------------------------------------------------------------
  /** Sets the staff member's institution roles (the administrator role is CampusOne's to give). */
  async setRoles(p: Principal, profileId: string, input: { roleIds: readonly string[] }) {
    const { inst, m } = await this.staff(p, profileId);
    if (['STUDENT', 'PARENT'].includes(m.category)) {
      throw new ConflictError('IDN.ROLE_NOT_ASSIGNABLE');
    }
    const wanted = [...new Set(input.roleIds.map((r) => r.toLowerCase()))];
    if (wanted.some((r) => !isUuid(r))) {
      throw new ValidationError([{ field: 'roleIds', code: 'VALIDATION.FORMAT' }]);
    }
    const all = await rolesRepository.roles(this.deps.db, 'INSTITUTION');
    const chosen = wanted.map((id) => all.find((r) => binToUuid(r.public_id) === id));
    if (chosen.some((r) => !r)) {
      throw new ValidationError([{ field: 'roleIds', code: 'VALIDATION.FORMAT' }]);
    }
    if (chosen.some((r) => r!.status !== 'ACTIVE')) throw new ConflictError('IDN.ROLE_DISABLED');
    for (const r of chosen) checkProfileForRole(r!, m);
    const at = this.now();
    const removed = await this.deps.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('profile_roles as pr')
        .innerJoin('roles as r', 'r.id', 'pr.role_id')
        .select(['r.id', 'r.code', 'r.name'])
        .where('pr.profile_id', '=', String(m.id))
        .forUpdate()
        .execute();
      const hadAdmin = current.some((r) => r.code === ADMIN);
      const wantsAdmin = chosen.some((r) => r!.code === ADMIN);
      if (hadAdmin !== wantsAdmin) throw new ConflictError('IDN.ROLE_NOT_ASSIGNABLE');
      const keep = new Set(chosen.map((r) => String(r!.id)));
      const drop = current.filter((r) => !keep.has(String(r.id)));
      const add = chosen.filter((r) => !current.some((c) => String(c.id) === String(r!.id)));
      if (drop.length) {
        await trx
          .deleteFrom('profile_roles')
          .where('profile_id', '=', String(m.id))
          .where(
            'role_id',
            'in',
            drop.map((r) => String(r.id)),
          )
          .execute();
      }
      for (const r of add) {
        await trx
          .insertInto('profile_roles')
          .values({ institution_id: inst.id, profile_id: String(m.id), role_id: String(r!.id) })
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CONSOLE_ROLES_CHANGED',
        entityType: 'member',
        entityRef: binToUuid(m.public_id),
        before: { roles: current.map((r) => r.code) },
        after: { roles: chosen.map((r) => r!.code) },
      });
      return drop.length > 0;
    });
    // A role taken away ends the console sessions, so no old grant stays in a token.
    if (removed) {
      await this.deps.sessions.endAllForAccount(String(m.account_id), 'ADMIN_REVOKED', ['console']);
    }
    this.deps.loggers.security.info('console.roles_changed', { at: at.toISOString() });
    return (await this.accounts(p)).items.find((x) => x.id === binToUuid(m.public_id))!;
  }

  // --- IDN-038 ------------------------------------------------------------------------------------
  /** Releases a staff member's sign-in lock (abandoned codes or wrong passwords), recorded. */
  async unlock(p: Principal, profileId: string, input: { reason: string }) {
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 300) {
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.FORMAT' }]);
    }
    const { inst, m } = await this.staff(p, profileId);
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform_accounts')
        .set({
          signin_lock: 'UNLOCKED',
          abandoned_code_attempts: 0,
          failed_signins: 0,
          locked_until: null,
        })
        .where('id', '=', String(m.account_id))
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'SIGNIN_LOCK_RELEASED',
        entityType: 'member',
        entityRef: binToUuid(m.public_id),
        reason,
        after: { name: titleCase([m.first_name, m.last_name].filter(Boolean).join(' ')) },
      });
    });
    this.deps.loggers.security.info('auth.lock_released', { by: 'console' });
  }
}

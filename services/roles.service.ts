/**
 * Roles & tasks (SRS 6.28, RNG-GOV-001/032, OI-GOV-01; IDN-063…069, IDN-039, IDN-081; prototype
 * o.roles). A role is assigned tasks — they open menu pages — and granted sub-tasks inside them —
 * every action checks its sub-task. Every change carries a reason and is kept in the change record.
 *
 * Rules (the prototype's, plus client decisions):
 * - operator roles only are edited here; institution roles are the platform's defaults (OI-GOV-01);
 * - at least one enabled role keeps "Roles, tasks and accounts" (roles.edit);
 * - nobody disables or changes their own role, or disables their own account;
 * - xi.drill only for the Platform Administrator (Q10a); approvals.decide only for the Institution
 *   Administrator (Q9);
 * - an account that belongs to an institution never holds an operator role (RNG-IDN-043);
 * - taking a permission away ends the holders' back-office sessions at once; a new grant applies at
 *   the next token renewal (15 minutes at most) or sign-in.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  OPERATOR_TASKS,
  INSTITUTION_TASKS,
  RESERVED_SUB_TASKS,
  ROLE_TEMPLATES,
  taskOfSubTask,
} from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { Database, RoleScope } from '../models/campusone_models';
import { accessRepository } from '../repositories/access.repository';
import { rolesRepository } from '../repositories/roles.repository';
import { recordAudit } from './audit.service';
import type { SessionService } from './session.service';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

export type RoleAction = 'ASSIGN_TASK' | 'REMOVE_TASK' | 'GRANT' | 'REVOKE' | 'ENABLE' | 'DISABLE';

const nameOf = (a: { first_name: string; last_name: string | null }) =>
  [a.first_name, a.last_name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());

const subName = (scope: RoleScope, code: string) =>
  taskOfSubTask(scope, code)?.subTasks.find((s) => s.code === code)?.en ?? code;
const taskName = (scope: RoleScope, code: string) =>
  (scope === 'OPERATOR' ? OPERATOR_TASKS : INSTITUTION_TASKS).find((t) => t.code === code)?.en ??
  code;
/** Catalogue order of tasks and sub-tasks (the prototype lists them in this order). */
const catalogueOf = (scope: RoleScope) =>
  scope === 'OPERATOR' ? OPERATOR_TASKS : INSTITUTION_TASKS;
const order = (scope: RoleScope, task: string) =>
  catalogueOf(scope).findIndex((t) => t.code === task);
const subOrder = (scope: RoleScope, sub: string) =>
  catalogueOf(scope)
    .flatMap((t) => t.subTasks.map((s) => s.code))
    .indexOf(sub);
const roleCodeName = (code: string) => ROLE_TEMPLATES.find((r) => r.code === code)?.name ?? code;

function requireReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) throw new ValidationError([{ field: 'reason', code: 'VALIDATION.REQUIRED' }]);
  if (r.length < 5 || r.length > 200) {
    throw new ValidationError([{ field: 'reason', code: 'VALIDATION.FORMAT' }]);
  }
  return r;
}

export class RolesService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly sessions: SessionService;
      readonly loggers: Loggers;
    },
  ) {}

  private async actor(p: Principal) {
    const a = await this.deps.db
      .selectFrom('platform_accounts')
      .select(['id', 'first_name', 'last_name'])
      .where('public_id', '=', uuidToBin(p.subject))
      .executeTakeFirst();
    if (!a) throw new AuthenticationError();
    return a;
  }

  /** IDN-063: tasks with their sub-tasks, by scope. */
  async tasks(scope?: RoleScope) {
    const rows = await rolesRepository.tasks(this.deps.db, scope);
    const out = new Map<
      string,
      {
        scope: RoleScope;
        code: string;
        labelKey: string;
        name: string;
        cr: string | null;
        subTasks: { code: string; labelKey: string; name: string }[];
      }
    >();
    for (const r of rows) {
      const key = `${r.scope}:${r.task_code}`;
      let t = out.get(key);
      if (!t) {
        const def = (r.scope === 'OPERATOR' ? OPERATOR_TASKS : INSTITUTION_TASKS).find(
          (x) => x.code === r.task_code,
        );
        t = {
          scope: r.scope,
          code: r.task_code,
          labelKey: r.task_label,
          name: def?.en ?? r.task_code,
          cr: def?.cr ?? null,
          subTasks: [],
        };
        out.set(key, t);
      }
      if (r.sub_code) {
        t.subTasks.push({
          code: r.sub_code,
          labelKey: r.sub_label ?? r.sub_code,
          name: subName(r.scope, r.sub_code),
        });
      }
    }
    return { items: [...out.values()] };
  }

  /** IDN-064: platform roles (operator roles and institution defaults) with tasks and grants. */
  async roles(scope?: RoleScope) {
    const db = this.deps.db;
    const roles = await rolesRepository.roles(db, scope);
    const ids = roles.map((r) => r.id);
    const [assignments, grants, holders, counts] = await Promise.all([
      rolesRepository.assignments(db, ids),
      rolesRepository.grants(db, ids),
      rolesRepository.operatorHolders(db),
      rolesRepository.institutionHolderCounts(db),
    ]);
    return {
      items: roles.map((r) => {
        const held = holders.filter((h) => h.role_id === r.id && h.status === 'ACTIVE');
        return {
          id: binToUuid(r.public_id),
          code: r.code,
          name: r.name,
          description: r.description,
          scope: r.scope,
          status: r.status,
          readOnly: r.read_only === 1,
          tasks: assignments
            .filter((a) => a.role_id === r.id)
            .map((a) => a.code)
            .sort((x, y) => order(r.scope, x) - order(r.scope, y)),
          subTasks: grants
            .filter((g) => g.role_id === r.id)
            .map((g) => g.code)
            .sort((x, y) => subOrder(r.scope, x) - subOrder(r.scope, y)),
          holders: r.scope === 'OPERATOR' ? held.map((h) => ({ name: nameOf(h) })) : [],
          holderCount:
            r.scope === 'OPERATOR'
              ? held.length
              : Number(counts.find((c) => c.role_id === r.id)?.n ?? 0),
          version: r.row_version,
        };
      }),
    };
  }

  /** IDN-065: a new operator role; it starts with the Home task (prototype ob.role.create). */
  async createRole(p: Principal, input: { name: string; description: string }) {
    const name = String(input.name ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    const description = String(input.description ?? '').trim();
    const e = [];
    if (!name) e.push({ field: 'name', code: 'VALIDATION.REQUIRED' as const });
    else if (name.length < 3 || name.length > 40) {
      e.push({ field: 'name', code: 'VALIDATION.FORMAT' as const });
    }
    if (!description) e.push({ field: 'description', code: 'VALIDATION.REQUIRED' as const });
    else if (description.length < 10 || description.length > 160) {
      e.push({ field: 'description', code: 'VALIDATION.FORMAT' as const });
    }
    if (e.length) throw new ValidationError(e);
    const actor = await this.actor(p);
    const taken = await this.deps.db
      .selectFrom('roles')
      .select('id')
      .where('institution_id', 'is', null)
      .where((eb) => eb(eb.fn('lower', ['name']), '=', name.toLowerCase()))
      .executeTakeFirst();
    if (taken) throw new ConflictError('IDN.ROLE_NAME_TAKEN');
    const id = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('roles')
        .values({
          public_id: id.bin,
          scope: 'OPERATOR',
          name,
          description,
          grants_seeded: 1,
        })
        .executeTakeFirstOrThrow();
      const roleId = String(r.insertId);
      const home = await rolesRepository.taskId(trx, 'OPERATOR', 'home');
      const view = await rolesRepository.subTask(trx, 'OPERATOR', 'home.view');
      if (home) {
        await trx
          .insertInto('role_task_assignments')
          .values({ role_id: roleId, task_id: home.id })
          .execute();
      }
      if (view) {
        await trx
          .insertInto('role_tasks')
          .values({ role_id: roleId, sub_task_id: view.id })
          .execute();
      }
      await this.record(trx, actor.id, `Created the ${name} role`, description, { roleId });
    });
    return { roleId: id.id };
  }

  /** IDN-066: one change to an operator role, with its reason. */
  async changeRole(
    p: Principal,
    roleId: string,
    expected: number,
    input: { action: RoleAction; task?: string; subTask?: string; reason: string },
  ) {
    const reason = requireReason(input.reason);
    if (!isUuid(roleId)) throw new NotFoundError();
    const actor = await this.actor(p);
    let endSessionsOf: string[] = [];
    await this.deps.db.transaction().execute(async (trx) => {
      const role = await rolesRepository.roleByPublicId(trx, uuidToBin(roleId), true);
      if (!role) throw new NotFoundError();
      if (role.scope !== 'OPERATOR') throw new ConflictError('IDN.ROLE_NOT_EDITABLE');
      if (role.row_version !== expected) throw new PreconditionFailedError();
      let text: string;
      switch (input.action) {
        case 'ASSIGN_TASK':
        case 'REMOVE_TASK': {
          const code = String(input.task ?? '');
          const task = await rolesRepository.taskId(trx, 'OPERATOR', code);
          if (!task) throw new ValidationError([{ field: 'task', code: 'VALIDATION.FORMAT' }]);
          const subs = OPERATOR_TASKS.find((t) => t.code === code)?.subTasks ?? [];
          if (input.action === 'ASSIGN_TASK') {
            await trx
              .insertInto('role_task_assignments')
              .values({ role_id: role.id, task_id: task.id })
              .onDuplicateKeyUpdate({ task_id: task.id })
              .execute();
            text = `Assigned the ${taskName('OPERATOR', code)} task to ${role.name}`;
          } else {
            if (
              subs.some((s) => s.code === 'roles.edit') &&
              (await rolesRepository.otherRoleAdmins(trx, role.id)) === 0
            ) {
              throw new ConflictError('IDN.LAST_ROLE_ADMIN');
            }
            await trx
              .deleteFrom('role_tasks')
              .where('role_id', '=', role.id)
              .where('sub_task_id', 'in', (eb) =>
                eb.selectFrom('sub_tasks').select('id').where('task_id', '=', task.id),
              )
              .execute();
            await trx
              .deleteFrom('role_task_assignments')
              .where('role_id', '=', role.id)
              .where('task_id', '=', task.id)
              .execute();
            text = `Removed the ${taskName('OPERATOR', code)} task from ${role.name}`;
            endSessionsOf = await rolesRepository.operatorAccountsOfRole(trx, role.id);
          }
          break;
        }
        case 'GRANT':
        case 'REVOKE': {
          const code = String(input.subTask ?? '');
          const s = await rolesRepository.subTask(trx, 'OPERATOR', code);
          if (!s) throw new ValidationError([{ field: 'subTask', code: 'VALIDATION.FORMAT' }]);
          if (input.action === 'GRANT') {
            const assigned = await trx
              .selectFrom('role_task_assignments')
              .select('task_id')
              .where('role_id', '=', role.id)
              .where('task_id', '=', s.task_id)
              .executeTakeFirst();
            if (!assigned) throw new ConflictError('IDN.TASK_NOT_ASSIGNED');
            const reserved = RESERVED_SUB_TASKS[code];
            if (reserved && !reserved.includes(role.code ?? '')) {
              throw new ConflictError('IDN.SUBTASK_RESERVED', {
                params: { role: roleCodeName(reserved[0] ?? '') },
              });
            }
            await trx
              .insertInto('role_tasks')
              .values({ role_id: role.id, sub_task_id: s.id })
              .onDuplicateKeyUpdate({ sub_task_id: s.id })
              .execute();
            text = `Granted “${subName('OPERATOR', code)}” to ${role.name}`;
          } else {
            if (
              code === 'roles.edit' &&
              (await rolesRepository.otherRoleAdmins(trx, role.id)) === 0
            ) {
              throw new ConflictError('IDN.LAST_ROLE_ADMIN');
            }
            await trx
              .deleteFrom('role_tasks')
              .where('role_id', '=', role.id)
              .where('sub_task_id', '=', s.id)
              .execute();
            text = `Removed “${subName('OPERATOR', code)}” from ${role.name}`;
            endSessionsOf = await rolesRepository.operatorAccountsOfRole(trx, role.id);
          }
          break;
        }
        case 'ENABLE':
        case 'DISABLE': {
          if (input.action === 'DISABLE') {
            const mine = await rolesRepository.operatorAccountOf(trx, actor.id);
            if (mine && mine.role_id === role.id) throw new ConflictError('IDN.OWN_ROLE_DISABLE');
            if ((await rolesRepository.otherRoleAdmins(trx, role.id)) === 0) {
              throw new ConflictError('IDN.LAST_ROLE_ADMIN');
            }
            endSessionsOf = await rolesRepository.operatorAccountsOfRole(trx, role.id);
          }
          await trx
            .updateTable('roles')
            .set({ status: input.action === 'DISABLE' ? 'INACTIVE' : 'ACTIVE' })
            .where('id', '=', role.id)
            .execute();
          text = `${input.action === 'DISABLE' ? 'Disabled' : 'Enabled'} the ${role.name} role`;
          break;
        }
        default:
          throw new ValidationError([{ field: 'action', code: 'VALIDATION.FORMAT' }]);
      }
      if (!(await rolesRepository.touchRole(trx, role.id, expected))) {
        throw new PreconditionFailedError();
      }
      await this.record(trx, actor.id, text, reason, { roleId: role.id });
    });
    await this.endSessions(endSessionsOf, p.sessionId);
    return { version: expected + 1 };
  }

  /** IDN-067: operator accounts with role, last sign-in, status and lock. */
  async accounts(now: Date = new Date()) {
    const rows = await rolesRepository.operatorAccounts(this.deps.db);
    return {
      items: rows.map((a) => ({
        id: binToUuid(a.public_id),
        accountId: binToUuid(a.account_public_id),
        name: nameOf(a),
        email: a.email,
        role: { id: binToUuid(a.role_public_id), name: a.role_name },
        lastSignInAt: a.current_signin_at ? new Date(a.current_signin_at).toISOString() : null,
        status: a.status,
        statusNote: a.status_note,
        locked:
          a.signin_lock === 'LOCKED' || (a.locked_until !== null && new Date(a.locked_until) > now),
        version: a.row_version,
      })),
    };
  }

  /** IDN-068: give an existing CampusOne account an operator role ("Assign a role"). */
  async assign(p: Principal, input: { email: string; roleId: string; reason: string }) {
    const reason = requireReason(input.reason);
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) throw new ValidationError([{ field: 'email', code: 'VALIDATION.REQUIRED' }]);
    if (!isUuid(input.roleId))
      throw new ValidationError([{ field: 'roleId', code: 'VALIDATION.REQUIRED' }]);
    const actor = await this.actor(p);
    const account = await accessRepository.findAccountByEmail(this.deps.db, email);
    if (!account) throw new NotFoundError('IDN.ACCOUNT_EMAIL_UNKNOWN');
    const inst = await rolesRepository.institutionOfAccount(this.deps.db, account.id);
    if (inst) {
      throw new ConflictError('IDN.ACCOUNT_IS_INSTITUTION', { params: { institution: inst.name } });
    }
    const existing = await rolesRepository.operatorAccountOf(this.deps.db, account.id);
    if (existing) {
      return this.changeAccount(p, binToUuid(existing.public_id), existing.row_version, {
        roleId: input.roleId,
        reason,
      });
    }
    const role = await this.operatorRole(input.roleId);
    const id = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('operator_accounts')
        .values({ public_id: id.bin, account_id: account.id, role_id: role.id })
        .executeTakeFirstOrThrow();
      await this.record(
        trx,
        actor.id,
        `Assigned the ${role.name} role to ${nameOf(account)}`,
        reason,
        {
          roleId: role.id,
          operatorAccountId: String(r.insertId),
        },
      );
    });
    return { id: id.id, version: 1 };
  }

  private async operatorRole(publicId: string) {
    const role = await rolesRepository.roleByPublicId(this.deps.db, uuidToBin(publicId));
    if (!role || role.scope !== 'OPERATOR') {
      throw new ValidationError([{ field: 'roleId', code: 'VALIDATION.FORMAT' }]);
    }
    if (role.status !== 'ACTIVE') throw new ConflictError('IDN.ROLE_DISABLED');
    return role;
  }

  /** IDN-069: change an operator account's role, or disable / enable it, with a reason. */
  async changeAccount(
    p: Principal,
    id: string,
    expected: number,
    input: { roleId?: string; status?: 'ACTIVE' | 'INACTIVE'; reason: string },
  ) {
    const reason = requireReason(input.reason);
    if (!isUuid(id)) throw new NotFoundError();
    const actor = await this.actor(p);
    const role = input.roleId ? await this.operatorRole(input.roleId) : undefined;
    let ended: string[] = [];
    await this.deps.db.transaction().execute(async (trx) => {
      const a = await rolesRepository.operatorAccountByPublicId(trx, uuidToBin(id), true);
      if (!a) throw new NotFoundError();
      if (a.row_version !== expected) throw new PreconditionFailedError();
      const own = a.account_id === actor.id;
      const name = nameOf(a);
      if (role && role.id !== a.role_id) {
        if (own) throw new ConflictError('IDN.OWN_ROLE_CHANGE');
        await trx
          .updateTable('operator_accounts')
          .set({ role_id: role.id, row_version: expected + 1 })
          .where('id', '=', a.id)
          .execute();
        await this.record(
          trx,
          actor.id,
          `Changed ${name}'s role: ${a.role_name} → ${role.name}`,
          reason,
          {
            roleId: role.id,
            operatorAccountId: a.id,
          },
        );
        ended = [a.account_id];
      } else if (input.status && input.status !== a.status) {
        if (own) throw new ConflictError('IDN.OWN_ACCOUNT_DISABLE');
        const disable = input.status === 'INACTIVE';
        await trx
          .updateTable('operator_accounts')
          .set({
            status: input.status,
            status_note: disable ? reason : null,
            row_version: expected + 1,
          })
          .where('id', '=', a.id)
          .execute();
        await this.record(
          trx,
          actor.id,
          `${disable ? 'Disabled' : 'Enabled'} ${name}'s account`,
          reason,
          { operatorAccountId: a.id },
        );
        if (disable) ended = [a.account_id];
      } else {
        return;
      }
    });
    await this.endSessions(ended, p.sessionId);
    return { id, version: expected + 1 };
  }

  /**
   * IDN-039: the Platform Administrator releases a locked staff account (operator or console):
   * the administrator lock of RNG-IDN-380 and any timed lock end; the counts start again.
   */
  async unlock(p: Principal, accountPublicId: string, input: { reason: string }) {
    const reason = requireReason(input.reason);
    if (!isUuid(accountPublicId)) throw new NotFoundError();
    const actor = await this.actor(p);
    const account = await this.deps.db
      .selectFrom('platform_accounts')
      .select(['id', 'first_name', 'last_name', 'signin_lock', 'locked_until'])
      .where('public_id', '=', uuidToBin(accountPublicId))
      .executeTakeFirst();
    if (!account) throw new NotFoundError();
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform_accounts')
        .set({
          signin_lock: 'UNLOCKED',
          abandoned_code_attempts: 0,
          failed_signins: 0,
          locked_until: null,
        })
        .where('id', '=', account.id)
        .execute();
      const op = await rolesRepository.operatorAccountOf(trx, account.id);
      await this.record(trx, actor.id, `Released ${nameOf(account)}'s sign-in lock`, reason, {
        operatorAccountId: op ? op.id : null,
      });
      await recordAudit(trx, {
        action: 'SIGNIN_LOCK_RELEASED',
        entityType: 'platform_account',
        entityRef: accountPublicId,
        after: { reason },
        actor: { type: 'operator', ref: p.subject },
      });
    });
    this.deps.loggers.security.info('auth.lock_released', { by: 'ops' });
  }

  /** IDN-081: the change record, newest first. */
  async changes(limit = 200) {
    const rows = await rolesRepository.changes(this.deps.db, limit);
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        at: new Date(r.created_at).toISOString(),
        by: nameOf(r),
        change: r.change_text,
        reason: r.reason,
      })),
    };
  }

  private async record(
    trx: Transaction<Database>,
    actorId: string,
    text: string,
    reason: string,
    refs: { roleId?: string | null; operatorAccountId?: string | null },
  ) {
    await rolesRepository.log(trx, {
      publicId: newPublicIdPair().bin,
      actorAccountId: actorId,
      roleId: refs.roleId ?? null,
      operatorAccountId: refs.operatorAccountId ?? null,
      text,
      reason,
    });
  }

  /** Taking a permission away ends the holders' back-office sessions (not the caller's own). */
  private async endSessions(accountIds: readonly string[], exceptSessionId: string) {
    for (const id of accountIds) {
      await this.deps.sessions.endAllForAccount(id, 'ADMIN_REVOKED', ['ops'], exceptSessionId);
    }
  }
}

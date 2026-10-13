/**
 * Members in the console (SRS 6.18–6.27; IDN-044…055, IDN-058, IDN-059; prototype c.members,
 * c.onboard, c.search; CR-06, CR-08, CR-09, CR-12, CR-13; BR-01, BR-02).
 *
 * - The list is per tab (students, parents, staff & teachers, merchants), filtered by search,
 *   grade and section for the current year, user type, department, status and filterable custom
 *   fields; paged by name.
 * - A person belongs to at most one institution (BR-01): a mobile number registered with another
 *   institution is refused. A profile links to the person's RingPe account when there is one;
 *   otherwise it keeps the contact mobile and links when that number signs up. Students may have
 *   no phone (BR-02).
 * - Members are never deleted (CR-08): Active, Inactive or Suspended. Deactivating and lifting are
 *   immediate; a suspension and a de-link go to a checker — except an Institution Administrator's
 *   own request, which applies directly (Q9, ADR-0015, setting `mkr.adminSelfApply`). Sessions end
 *   when a member stops being Active.
 * - Identity fields (name, date of birth, gender, admission number) are changed only through a
 *   correction request (CR-06); the editable fields are department, e-mail, joining date and the
 *   institution's own fields.
 * - Wallets, cards and payment permission arrive with their modules (Phases 3 and 4).
 */
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { LIMITS, MEMBER_PROFILE } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { MessageSender } from '../integrations/sms.provider';
import type { Database } from '../models/ringpe_models';
import { academicsRepository } from '../repositories/academics.repository';
import { accountRepository } from '../repositories/account.repository';
import { raiseApproval } from './approvals.service';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  KIND_CATEGORIES,
  kindOf,
  membersRepository as repo,
  type MemberFilter,
  type MemberKind,
} from '../repositories/members.repository';
import { userTypesRepository } from '../repositories/institution-setup.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import type { FieldError } from '../utils/validators';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { hashSecret } from '../utils/password';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { istBusinessDate } from '../utils/format';
import { recordAudit } from './audit.service';
import { dateOnly } from './billing.service';
import {
  activeFields,
  parseValues,
  readValues,
  saveValues,
  showValue,
  type CfField,
} from './custom-values.service';
import { memberOf } from './member-roles';
import type { SessionService } from './session.service';
import { defaultValues, type SettingValues } from './settings.service';

const STATUS_LABEL = Object.fromEntries(MEMBER_PROFILE.values.map((v) => [v.code, v.label]));
export const GUARDIAN_RELATIONS = ['FATHER', 'MOTHER', 'GUARDIAN'] as const;
const STAFF_CATEGORIES = KIND_CATEGORIES.STAFF;

const personName = (first: string | null, last: string | null) =>
  [first, last].filter(Boolean).join(' ');

const maskMobile = (m: string | null) => (m ? `${'•'.repeat(6)}${m.slice(-4)}` : null);

export interface OnboardInput {
  readonly userTypeId: string;
  readonly departmentId?: string | null | undefined;
  readonly firstName: string;
  readonly lastName?: string | null | undefined;
  readonly gender?: 'MALE' | 'FEMALE' | 'OTHER' | null | undefined;
  readonly dateOfBirth?: string | null | undefined;
  readonly mobile?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly joinedOn?: string | null | undefined;
  readonly admissionNo?: string | null | undefined;
  readonly sectionId?: string | null | undefined;
  /** Students: link to existing parents, or add a new parent. */
  readonly guardians?:
    | readonly {
        readonly memberId?: string | undefined;
        readonly firstName?: string | undefined;
        readonly lastName?: string | null | undefined;
        readonly mobile?: string | undefined;
        readonly email?: string | null | undefined;
        readonly relation: (typeof GUARDIAN_RELATIONS)[number];
      }[]
    | undefined;
  /** Parents: their children (student member ids). */
  readonly wards?: readonly string[] | undefined;
  readonly relation?: (typeof GUARDIAN_RELATIONS)[number] | undefined;
  readonly customFields?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Internal (admission approval, ADM-018): enrol into this academic year (public id) instead of the
   * current one — an admission for next year. Not accepted from a request body.
   */
  readonly enrolYearId?: string | undefined;
}

export interface StaffInput {
  readonly userTypeId: string;
  readonly departmentId: string;
  readonly firstName: string;
  readonly lastName?: string | null | undefined;
  readonly gender: 'MALE' | 'FEMALE' | 'OTHER';
  readonly dateOfBirth: string;
  readonly mobile: string;
  readonly email: string;
  readonly joinedOn: string;
  readonly employeeNo?: string | null | undefined;
  readonly customFields?: Readonly<Record<string, unknown>> | undefined;
}

export class MembersService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly loggers: Loggers;
      readonly sessions: SessionService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly email?: MessageSender;
      readonly webUrl?: string;
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async own(p: Principal, db: Kysely<Database> = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  private async year(db: Kysely<Database>, institutionId: string) {
    return academicsRepository.currentYear(db, institutionId);
  }

  private id(publicId: string | null | undefined, field: string) {
    if (!publicId || !isUuid(publicId)) {
      throw new ValidationError([{ field, code: 'VALIDATION.FORMAT' }]);
    }
    return uuidToBin(publicId);
  }

  // --- IDN-044 ------------------------------------------------------------------------------------
  async list(
    p: Principal,
    q: {
      kind?: MemberKind | 'ALL' | undefined;
      q?: string | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | undefined;
      userTypeId?: string | undefined;
      departmentId?: string | undefined;
      classId?: string | undefined;
      sectionId?: string | undefined;
      cf?: Readonly<Record<string, string>> | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const db = this.deps.db;
    const inst = await this.own(p);
    const year = await this.year(db, inst.id);
    const fields = await activeFields(db, inst.id, 'MEMBER');
    const resolve = async (
      table: 'user_types' | 'departments' | 'classes' | 'sections',
      v?: string,
    ) => {
      if (!v) return undefined;
      if (!isUuid(v)) return '0';
      const r = await db
        .selectFrom(table)
        .select('id')
        .where('institution_id', '=', inst.id)
        .where('public_id', '=', uuidToBin(v))
        .executeTakeFirst();
      return r ? String(r.id) : '0';
    };
    const cf = Object.entries(q.cf ?? {}).flatMap(
      ([fid, v]): { fieldId: string; optionId?: string; bool?: boolean }[] => {
        const f = fields.find((x) => x.id === fid && x.filterable);
        if (!f || !v) return [];
        if (f.type === 'YES_NO') return [{ fieldId: f.dbId, bool: /^(yes|true)$/i.test(v) }];
        const o = f.options.find((x) => x.label === v);
        return [{ fieldId: f.dbId, optionId: o?.id ?? '0' }];
      },
    );
    const filter: MemberFilter = {
      kind: q.kind && q.kind !== 'ALL' ? q.kind : undefined,
      q: q.q,
      status: q.status,
      userTypeId: await resolve('user_types', q.userTypeId),
      departmentId: await resolve('departments', q.departmentId),
      classId: await resolve('classes', q.classId),
      sectionId: await resolve('sections', q.sectionId),
      cf,
    };
    let after: { name: string; id: string } | undefined;
    if (q.cursor) {
      try {
        const [name, id] = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [
          string,
          string,
        ];
        after = { name: String(name), id: String(id) };
      } catch {
        throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
      }
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const yearId = year ? String(year.id) : null;
    const [rows, counts] = await Promise.all([
      repo.page(db, inst.id, yearId, filter, { after, limit }),
      repo.counts(db, inst.id, yearId, filter),
    ]);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const ids = page.map((r) => String(r.id));
    const [relations, values, pending] = await Promise.all([
      repo.relations(db, inst.id, yearId, ids),
      readValues(
        db,
        inst.id,
        fields.filter((f) => f.listColumn),
        page.map((r) => r.public_id),
      ),
      repo.pending(
        db,
        inst.id,
        page.map((r) => binToUuid(r.public_id)),
      ),
    ]);
    const tabs = { STUDENTS: 0, PARENTS: 0, STAFF: 0, MERCHANTS: 0, ALL: 0 };
    const statuses = { ACTIVE: 0, INACTIVE: 0, SUSPENDED: 0 };
    for (const c of counts) {
      const n = Number(c.n);
      const k = kindOf(c.category);
      if (!filter.status || c.status === filter.status) {
        tabs[k] += n;
        tabs.ALL += n;
      }
      if (!filter.kind || k === filter.kind) statuses[c.status] += n;
    }
    const last = page.at(-1);
    return {
      year: year ? { id: binToUuid(year.public_id), label: year.label } : null,
      columns: fields.filter((f) => f.listColumn).map((f) => ({ id: f.id, label: f.label })),
      filters: fields
        .filter((f) => f.filterable)
        .map((f) => ({
          id: f.id,
          label: f.label,
          options: f.type === 'YES_NO' ? ['Yes', 'No'] : f.options.map((o) => o.label),
        })),
      counts: { tabs, statuses },
      items: page.map((r) => {
        const ref = binToUuid(r.public_id);
        const kind = kindOf(r.category);
        const wards = relations.filter((x) => String(x.guardian_profile_id) === String(r.id));
        const rec = values.get(Buffer.from(r.public_id).toString('hex')) ?? {};
        return {
          id: ref,
          memberNo: `${inst.short_name}-${String(r.member_seq).padStart(5, '0')}`,
          name: personName(r.first_name, r.last_name),
          kind,
          userType: {
            id: binToUuid(r.user_type_public_id),
            name: r.user_type_name,
            category: r.category,
          },
          department: r.department_public_id
            ? { id: binToUuid(r.department_public_id), name: r.department_name! }
            : null,
          admissionNo: r.admission_no,
          employeeNo: r.employee_no,
          grade: r.class_name ? { class: r.class_name, section: r.section_name } : null,
          mobile: r.account_mobile ?? r.contact_mobile,
          children:
            kind === 'PARENTS'
              ? wards.map((w) => ({
                  id: binToUuid(w.ward_public_id),
                  name: w.ward_first_name,
                  grade: w.ward_class
                    ? `${w.ward_class}${w.ward_section ? ` ${w.ward_section}` : ''}`
                    : null,
                }))
              : undefined,
          relation: kind === 'PARENTS' ? (wards[0]?.relation ?? null) : undefined,
          linked: r.account_id !== null,
          status: r.status,
          wallet:
            r.wallet_status === null
              ? null
              : {
                  status: r.wallet_status,
                  balance: toMoneyDto(Number(r.wallet_available_paise ?? 0)),
                },
          pending: {
            suspension: pending.some((x) => x.member === ref && x.module === 'MEMBER_SUSPENSION'),
            delink: pending.some((x) => x.member === ref && x.module === 'MEMBER_DELINK'),
          },
          customFields: Object.fromEntries(
            fields.filter((f) => f.listColumn).map((f) => [f.id, showValue(rec[f.id])]),
          ),
        };
      }),
      nextCursor:
        more && last
          ? Buffer.from(JSON.stringify([last.first_name, String(last.id)])).toString('base64url')
          : null,
    };
  }

  // --- IDN-087 ------------------------------------------------------------------------------------
  /**
   * The member's own school record, or a child's (`for`: a profile on the same account) — what the
   * family may see: number, class, dates, status, guardians (mobiles masked) and the school's own
   * fields that have a value. Nothing the console keeps for itself (wallet, approvals, roles).
   */
  async schoolRecord(p: Principal, forProfile?: string) {
    const db = this.deps.db;
    const me = await memberOf(db, p, forProfile);
    const inst = await db
      .selectFrom('institutions')
      .select(['id', 'short_name'])
      .where('id', '=', me.institutionId)
      .executeTakeFirstOrThrow();
    const year = await this.year(db, me.institutionId);
    const yearId = year ? String(year.id) : null;
    const own = await db
      .selectFrom('member_profiles')
      .select('public_id')
      .where('id', '=', me.rowId)
      .executeTakeFirstOrThrow();
    const r = await repo.byPublicId(db, me.institutionId, yearId, own.public_id);
    if (!r) throw new NotFoundError();
    const fields = await activeFields(db, me.institutionId, 'MEMBER');
    const [relations, values] = await Promise.all([
      repo.relations(db, me.institutionId, yearId, [String(r.id)]),
      readValues(db, me.institutionId, fields, [r.public_id]),
    ]);
    const rec = values.get(Buffer.from(r.public_id).toString('hex')) ?? {};
    return {
      id: binToUuid(r.public_id),
      memberNo: `${inst.short_name}-${String(r.member_seq).padStart(5, '0')}`,
      name: personName(r.first_name, r.last_name),
      firstName: r.first_name,
      lastName: r.last_name,
      kind: kindOf(r.category),
      userType: r.user_type_name,
      status: r.status,
      gender: r.gender,
      dateOfBirth: dateOnly(r.date_of_birth),
      admissionNo: r.admission_no,
      employeeNo: r.employee_no,
      joinedOn: dateOnly(r.joined_on),
      grade: r.class_name
        ? { class: r.class_name, section: r.section_name, year: year?.label ?? null }
        : null,
      guardians: relations
        .filter((x) => String(x.ward_profile_id) === String(r.id))
        .map((x) => ({
          name: personName(x.guardian_first_name, x.guardian_last_name),
          relation: x.relation,
          primary: Boolean(Number(x.is_primary_contact)),
          mobile: maskMobile(x.guardian_account_mobile ?? x.guardian_contact_mobile),
        })),
      fields: fields
        .filter((f) => rec[f.id] !== undefined && rec[f.id] !== null && rec[f.id] !== '')
        .map((f) => ({ label: f.label, value: showValue(rec[f.id]) })),
    };
  }

  // --- IDN-045 ------------------------------------------------------------------------------------
  async detail(p: Principal, memberId: string) {
    const db = this.deps.db;
    const inst = await this.own(p);
    if (!isUuid(memberId)) throw new NotFoundError();
    const year = await this.year(db, inst.id);
    const yearId = year ? String(year.id) : null;
    const r = await repo.byPublicId(db, inst.id, yearId, uuidToBin(memberId));
    if (!r) throw new NotFoundError();
    const fields = await activeFields(db, inst.id, 'MEMBER');
    const [relations, values, roles, pending, history] = await Promise.all([
      repo.relations(db, inst.id, yearId, [String(r.id)]),
      readValues(db, inst.id, fields, [r.public_id]),
      repo.roles(db, String(r.id)),
      repo.pending(db, inst.id, [memberId]),
      repo.history(db, inst.id, r.public_id, 1),
    ]);
    const rec = values.get(Buffer.from(r.public_id).toString('hex')) ?? {};
    const kind = kindOf(r.category);
    return {
      id: memberId,
      memberNo: `${inst.short_name}-${String(r.member_seq).padStart(5, '0')}`,
      name: personName(r.first_name, r.last_name),
      firstName: r.first_name,
      lastName: r.last_name,
      kind,
      userType: {
        id: binToUuid(r.user_type_public_id),
        name: r.user_type_name,
        category: r.category,
      },
      department: r.department_public_id
        ? { id: binToUuid(r.department_public_id), name: r.department_name! }
        : null,
      gender: r.gender,
      dateOfBirth: dateOnly(r.date_of_birth),
      admissionNo: r.admission_no,
      employeeNo: r.employee_no,
      joinedOn: dateOnly(r.joined_on),
      grade:
        r.class_name && r.section_public_id
          ? {
              class: r.class_name,
              classId: binToUuid(r.class_public_id!),
              section: r.section_name,
              sectionId: binToUuid(r.section_public_id),
              year: year?.label ?? null,
            }
          : null,
      contact: {
        mobile: r.account_mobile ?? r.contact_mobile,
        email: r.contact_email ?? r.account_email,
      },
      account: {
        linked: r.account_id !== null,
        mobileMasked: maskMobile(r.account_mobile),
      },
      guardians: relations
        .filter((x) => String(x.ward_profile_id) === String(r.id))
        .map((x) => ({
          id: binToUuid(x.guardian_public_id),
          name: personName(x.guardian_first_name, x.guardian_last_name),
          relation: x.relation,
          mobile: x.guardian_account_mobile ?? x.guardian_contact_mobile,
          primary: Boolean(Number(x.is_primary_contact)),
          status: x.guardian_status,
        })),
      wards: relations
        .filter((x) => String(x.guardian_profile_id) === String(r.id))
        .map((x) => ({
          id: binToUuid(x.ward_public_id),
          name: personName(x.ward_first_name, x.ward_last_name),
          relation: x.relation,
          grade: x.ward_class
            ? `${x.ward_class}${x.ward_section ? ` ${x.ward_section}` : ''}`
            : null,
          status: x.ward_status,
        })),
      roles: roles.map((x) => ({ code: x.code, name: x.name })),
      status: r.status,
      statusReason: r.status_reason,
      statusChangedAt: r.status_changed_at ? new Date(r.status_changed_at).toISOString() : null,
      transactionPermission: {
        enabled: Boolean(Number(r.txn_permission)),
        reason: r.txn_permission_reason,
        changedAt: r.txn_permission_changed_at
          ? new Date(r.txn_permission_changed_at).toISOString()
          : null,
      },
      wallet:
        r.wallet_status === null
          ? null
          : {
              status: r.wallet_status,
              balance: toMoneyDto(Number(r.wallet_available_paise ?? 0)),
            },
      pending: {
        suspension: pending.some((x) => x.module === 'MEMBER_SUSPENSION'),
        delink: pending.some((x) => x.module === 'MEMBER_DELINK'),
      },
      customFields: fields.map((f) => ({
        id: f.id,
        label: f.label,
        type: f.type,
        required: f.required,
        unique: f.unique,
        options: f.options.map((o) => o.label),
        value: rec[f.id] ?? null,
      })),
      onboardedAt: new Date(r.created_at).toISOString(),
      lastChangedAt: history[0] ? new Date(history[0].occurred_at).toISOString() : null,
      version: r.row_version,
      kindLabel: kind,
    };
  }

  // --- IDN-046 ------------------------------------------------------------------------------------
  async update(
    p: Principal,
    memberId: string,
    expected: number,
    input: {
      departmentId?: string | null | undefined;
      email?: string | null | undefined;
      joinedOn?: string | null | undefined;
      sectionId?: string | undefined;
      customFields?: Readonly<Record<string, unknown>> | undefined;
    },
  ) {
    if (!isUuid(memberId)) throw new NotFoundError();
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const m = await repo.lock(trx, inst.id, uuidToBin(memberId));
      if (!m) throw new NotFoundError();
      if (m.row_version !== expected) throw new PreconditionFailedError();
      const set: Parameters<typeof repo.update>[3] = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (input.departmentId !== undefined) {
        const dep = input.departmentId
          ? await this.department(trx, inst.id, m.user_type_id, input.departmentId)
          : null;
        if (String(dep ?? '') !== String(m.department_id ?? '')) {
          set.department_id = dep;
          before['department'] = m.department_id;
          after['department'] = dep;
        }
      }
      if (input.email !== undefined && (input.email || null) !== m.contact_email) {
        set.contact_email = input.email ? input.email.toLowerCase() : null;
        before['email'] = m.contact_email;
        after['email'] = set.contact_email;
      }
      if (input.joinedOn !== undefined && (input.joinedOn || null) !== dateOnly(m.joined_on)) {
        set.joined_on = input.joinedOn || null;
        after['joinedOn'] = set.joined_on;
      }
      let changed = Object.keys(set).length > 0;
      if (input.sectionId) {
        const year = await this.year(trx, inst.id);
        if (!year) throw new CustomAPIError(409, 'ACA.NO_CURRENT_YEAR');
        const sec = await academicsRepository.sectionByPublicId(
          trx,
          inst.id,
          this.id(input.sectionId, 'sectionId'),
        );
        if (!sec) throw new ValidationError([{ field: 'sectionId', code: 'VALIDATION.FORMAT' }]);
        await academicsRepository.enrol(trx, {
          institutionId: inst.id,
          studentId: m.id,
          yearId: year.id,
          sectionId: sec.id,
          by,
        });
        after['section'] = `${sec.class_name} ${sec.name}`;
        changed = true;
      }
      if (input.customFields && Object.keys(input.customFields).length) {
        const fields = await activeFields(trx, inst.id, 'MEMBER');
        const { parsed, errors } = parseValues(fields, input.customFields, { partial: true });
        if (errors.length) throw new ValidationError(errors);
        await saveValues(trx, inst.id, m.public_id, parsed);
        after['customFields'] = Object.keys(input.customFields).length;
        changed = true;
      }
      if (!changed) throw new CustomAPIError(422, 'IDN.NOTHING_TO_UPDATE');
      if (Object.keys(set).length) {
        if (!(await repo.update(trx, m.id, expected, set))) throw new PreconditionFailedError();
      } else await repo.touch(trx, m.id);
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MEMBER_EDITED',
        entityType: 'member',
        entityRef: memberId,
        before,
        after,
      });
    });
    return this.detail(p, memberId);
  }

  private async department(
    db: Kysely<Database>,
    institutionId: string,
    userTypeId: string,
    departmentId: string,
  ) {
    const d = await db
      .selectFrom('departments')
      .select(['id', 'user_type_id'])
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', this.id(departmentId, 'departmentId'))
      .executeTakeFirst();
    if (!d || String(d.user_type_id) !== String(userTypeId)) {
      throw new ValidationError([{ field: 'departmentId', code: 'VALIDATION.FORMAT' }]);
    }
    return String(d.id);
  }

  // --- IDN-047 ------------------------------------------------------------------------------------
  /** Step 1 of onboarding: is this mobile free to join here (BR-01)? */
  async eligibility(p: Principal, input: { mobile: string }) {
    const inst = await this.own(p);
    const profiles = await repo.profilesOfMobile(this.deps.db, input.mobile);
    const elsewhere = profiles.some((x) => String(x.institution_id) !== String(inst.id));
    const here = profiles.filter((x) => String(x.institution_id) === String(inst.id));
    const account = await accountRepository.findByMobile(this.deps.db, input.mobile);
    if (elsewhere) {
      return {
        eligible: false,
        code: 'IDN.MOBILE_IN_OTHER_INSTITUTION',
        account: Boolean(account),
        profiles: [],
      };
    }
    return {
      eligible: true,
      code: here.length
        ? 'IDN.PROFILE_EXISTS_HERE'
        : account
          ? 'IDN.ACCOUNT_EXISTS'
          : 'IDN.NEW_PERSON',
      account: Boolean(account),
      profiles: here.map((x) => ({
        id: binToUuid(x.public_id),
        category: x.category,
        name: personName(x.first_name, x.last_name),
        userType: x.user_type_name,
        status: x.status,
      })),
    };
  }

  /** BR-01 inside a transaction: the mobile's account, refused when it belongs elsewhere. */
  private async mobileFor(
    trx: Kysely<Database>,
    institutionId: string,
    mobile: string,
    field: string,
  ) {
    const profiles = await repo.profilesOfMobile(trx, mobile);
    if (profiles.some((x) => String(x.institution_id) !== String(institutionId))) {
      throw new CustomAPIError(409, 'IDN.MOBILE_IN_OTHER_INSTITUTION', {
        errors: [{ field, code: 'IDN.MOBILE_IN_OTHER_INSTITUTION' }],
      });
    }
    const account = await accountRepository.findByMobile(trx, mobile);
    return account ? String(account.id) : null;
  }

  private async userType(trx: Kysely<Database>, institutionId: string, userTypeId: string) {
    const ut = (await userTypesRepository.list(trx, institutionId)).find(
      (x) => isUuid(userTypeId) && binToUuid(x.public_id) === userTypeId.toLowerCase(),
    );
    if (!ut || ut.status !== 'ACTIVE') {
      throw new ValidationError([
        { field: 'userTypeId', code: 'IDN.USER_TYPE_UNKNOWN', params: { t: userTypeId } },
      ]);
    }
    return ut;
  }

  // --- IDN-048 ------------------------------------------------------------------------------------
  async onboard(p: Principal, input: OnboardInput) {
    const by = this.by(p);
    const pub = newPublicIdPair();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      return this.createMember(trx, inst, pub, input, by);
    });
    return { id: pub.id, memberNo: out.memberNo, guardians: out.guardians };
  }

  /** Creates one member inside the caller's transaction (single onboarding and sheets). */
  async createMember(
    trx: Kysely<Database>,
    inst: { id: string; short_name: string },
    pub: { id: string; bin: Buffer },
    input: OnboardInput,
    by: Buffer | null,
  ) {
    const errors: FieldError[] = [];
    const ut = await this.userType(trx, inst.id, input.userTypeId);
    if (ut.category === 'MERCHANT') throw new CustomAPIError(422, 'IDN.MERCHANT_NOT_HERE');
    const student = ut.category === 'STUDENT';
    const parent = ut.category === 'PARENT';
    const mobile = input.mobile?.trim() || null;
    if (!student && !mobile) errors.push({ field: 'mobile', code: 'VALIDATION.REQUIRED' });
    if (student && !input.admissionNo?.trim()) {
      errors.push({ field: 'admissionNo', code: 'IDN.ADMISSION_NO_REQUIRED' });
    }
    if (student && !input.sectionId)
      errors.push({ field: 'sectionId', code: 'VALIDATION.REQUIRED' });
    if (input.dateOfBirth && input.dateOfBirth >= istBusinessDate(this.now())) {
      errors.push({ field: 'dateOfBirth', code: 'IDN.DOB_IN_FUTURE' });
    }
    if (parent && !(input.wards ?? []).length)
      errors.push({ field: 'wards', code: 'IDN.WARD_REQUIRED' });
    const fields = await activeFields(trx, inst.id, 'MEMBER');
    const cf = parseValues(fields, input.customFields ?? {}, { partial: false });
    errors.push(...cf.errors);
    if (errors.length) throw new ValidationError(errors);

    let accountId = mobile ? await this.mobileFor(trx, inst.id, mobile, 'mobile') : null;
    let contactMobile = mobile;
    if (student && !mobile && input.guardians?.[0]) {
      // A child without a phone sits under the primary contact's mobile and account (BR-02, CR-04).
      const g = input.guardians[0];
      if (g.memberId) {
        const gp = await repo.lock(trx, inst.id, this.id(g.memberId, 'guardians.0.memberId'));
        contactMobile = gp?.contact_mobile ?? null;
        accountId = gp?.account_id ? String(gp.account_id) : null;
      } else if (g.mobile) {
        contactMobile = g.mobile;
        accountId = await this.mobileFor(trx, inst.id, g.mobile, 'guardians.0.mobile');
      }
    }
    const admissionNo = input.admissionNo?.trim() || null;
    if (admissionNo && (await repo.admissionTaken(trx, inst.id, admissionNo))) {
      throw new CustomAPIError(409, 'IDN.ADMISSION_NO_TAKEN', {
        params: { n: admissionNo },
        errors: [
          { field: 'admissionNo', code: 'IDN.ADMISSION_NO_TAKEN', params: { n: admissionNo } },
        ],
      });
    }
    const departmentId = input.departmentId
      ? await this.department(trx, inst.id, ut.id, input.departmentId)
      : null;
    let section: Awaited<ReturnType<typeof academicsRepository.sectionByPublicId>> | undefined;
    let year: Awaited<ReturnType<typeof academicsRepository.currentYear>> | undefined;
    if (student) {
      year = input.enrolYearId
        ? await academicsRepository.yearByPublicId(
            trx,
            inst.id,
            this.id(input.enrolYearId, 'enrolYearId'),
          )
        : await this.year(trx, inst.id);
      if (!year) throw new CustomAPIError(409, 'ACA.NO_CURRENT_YEAR');
      section = await academicsRepository.sectionByPublicId(
        trx,
        inst.id,
        this.id(input.sectionId, 'sectionId'),
      );
      if (!section) throw new ValidationError([{ field: 'sectionId', code: 'VALIDATION.FORMAT' }]);
    }
    const id = await repo.insert(trx, {
      publicId: pub.bin,
      institutionId: inst.id,
      accountId,
      userTypeId: ut.id,
      departmentId,
      firstName: input.firstName.trim(),
      lastName: input.lastName?.trim() || null,
      gender: input.gender ?? null,
      dateOfBirth: input.dateOfBirth || null,
      contactMobile,
      contactEmail: input.email?.trim().toLowerCase() || null,
      admissionNo,
      employeeNo: null,
      joinedOn: input.joinedOn || null,
      by,
    });
    if (student && section && year) {
      await academicsRepository.enrol(trx, {
        institutionId: inst.id,
        studentId: id,
        yearId: year.id,
        sectionId: section.id,
        by,
      });
    }
    await saveValues(trx, inst.id, pub.bin, cf.parsed);

    const guardians: string[] = [];
    if (student) {
      const parentType = (await userTypesRepository.list(trx, inst.id)).find(
        (x) => x.category === 'PARENT' && x.status === 'ACTIVE',
      );
      for (const [i, g] of (input.guardians ?? []).entries()) {
        let guardianId: string;
        if (g.memberId) {
          const gp = await repo.lock(trx, inst.id, this.id(g.memberId, `guardians.${i}.memberId`));
          if (!gp)
            throw new ValidationError([
              { field: `guardians.${i}.memberId`, code: 'VALIDATION.FORMAT' },
            ]);
          guardianId = gp.id;
        } else {
          if (!parentType) {
            throw new ValidationError([
              { field: `guardians.${i}`, code: 'IDN.USER_TYPE_UNKNOWN', params: { t: 'Parent' } },
            ]);
          }
          if (!g.firstName?.trim() || !g.mobile) {
            throw new ValidationError([
              { field: `guardians.${i}.mobile`, code: 'VALIDATION.REQUIRED' },
            ]);
          }
          const gAccount = await this.mobileFor(trx, inst.id, g.mobile, `guardians.${i}.mobile`);
          const gPub = newPublicIdPair();
          guardianId = await repo.insert(trx, {
            publicId: gPub.bin,
            institutionId: inst.id,
            accountId: gAccount,
            userTypeId: parentType.id,
            departmentId: null,
            firstName: g.firstName.trim(),
            lastName: g.lastName?.trim() || null,
            gender: g.relation === 'FATHER' ? 'MALE' : g.relation === 'MOTHER' ? 'FEMALE' : null,
            dateOfBirth: null,
            contactMobile: g.mobile,
            contactEmail: g.email?.trim().toLowerCase() || null,
            admissionNo: null,
            employeeNo: null,
            joinedOn: input.joinedOn || null,
            by,
          });
          guardians.push(gPub.id);
          await recordAudit(trx, {
            institutionId: inst.id,
            action: 'MEMBER_ONBOARDED',
            entityType: 'member',
            entityRef: gPub.id,
            after: { userType: parentType.name, ward: pub.id },
          });
        }
        await repo.addGuardian(trx, {
          institutionId: inst.id,
          guardianId,
          wardId: id,
          relation: g.relation,
          primary: i === 0,
        });
      }
    }
    if (parent) {
      const wards = await repo.students(
        trx,
        inst.id,
        (input.wards ?? []).map((w, i) => this.id(w, `wards.${i}`)),
      );
      if (
        wards.length !== (input.wards ?? []).length ||
        wards.some((w) => w.category !== 'STUDENT')
      ) {
        throw new ValidationError([{ field: 'wards', code: 'IDN.WARD_NOT_STUDENT' }]);
      }
      for (const w of wards) {
        await repo.addGuardian(trx, {
          institutionId: inst.id,
          guardianId: id,
          wardId: String(w.id),
          relation: input.relation ?? 'GUARDIAN',
          primary: false,
        });
      }
    }
    await recordAudit(trx, {
      institutionId: inst.id,
      action: 'MEMBER_ONBOARDED',
      entityType: 'member',
      entityRef: pub.id,
      after: {
        userType: ut.name,
        admissionNo,
        section: section ? `${section.class_name} ${section.name}` : null,
        linked: accountId !== null,
      },
    });
    const seq = await trx
      .selectFrom('member_profiles')
      .select('member_seq')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      memberNo: `${inst.short_name}-${String(seq.member_seq).padStart(5, '0')}`,
      guardians,
    };
  }

  // --- IDN-053 ------------------------------------------------------------------------------------
  /**
   * Staff: an account is created when the mobile has none, with a generated password e-mailed to
   * the work address and changed at first sign-in (OI-IDN-20); staff are at least 18 (FR-IDN-15).
   */
  async onboardStaff(p: Principal, input: StaffInput) {
    this.checkStaffAge(input);
    const by = this.by(p);
    const pub = newPublicIdPair();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      return this.createStaff(trx, inst, pub, input, by);
    });
    const shown = await this.passwordsShown();
    await this.welcome([out], shown);
    return {
      id: pub.id,
      memberNo: out.memberNo,
      employeeNo: out.employeeNo,
      newAccount: out.password !== null,
      // Shown once: never stored, left out of an idempotent replay (the controller).
      ...(shown && out.password ? { temporaryPassword: out.password } : {}),
    };
  }

  /** FR-IDN-15: staff are at least 18, and a date of birth is in the past. */
  checkStaffAge(input: { dateOfBirth: string }, prefix = '') {
    const today = istBusinessDate(this.now());
    const field = `${prefix}dateOfBirth`;
    if (input.dateOfBirth >= today) {
      throw new ValidationError([{ field, code: 'IDN.DOB_IN_FUTURE' }]);
    }
    const [y, m, d] = input.dateOfBirth.split('-').map(Number) as [number, number, number];
    const eighteen = `${y + 18}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (eighteen > today) throw new ValidationError([{ field, code: 'IDN.STAFF_UNDER_18' }]);
  }

  /**
   * Whether a new staff member's temporary password is shown once in the console (setting
   * idn.staff.passwordShownOnce; client 2026-10-07: e-mail is not integrated yet). Then the
   * welcome e-mail leaves it out.
   */
  async passwordsShown() {
    return (await this.limit(LIMITS.staffPasswordShown)) === 1;
  }

  /** E-mails onboarded staff after the commit: a temporary password, or the new link. */
  async welcome(
    list: readonly {
      email: string;
      institution: string;
      employeeNo: string;
      password: string | null;
    }[],
    shown = false,
  ) {
    if (!this.deps.email) return;
    const link = `${this.deps.webUrl ?? 'https://localhost:4200'}/console/signin`;
    for (const x of list) {
      const text = x.password
        ? shown
          ? `Welcome to RingPe at ${x.institution}. Sign in at ${link} with ${x.email} and the temporary password your institution gave you — you'll choose your own password at first sign-in. Your employee ID is ${x.employeeNo}.`
          : `Welcome to RingPe at ${x.institution}. Sign in at ${link} with ${x.email} and this temporary password: ${x.password} — you'll choose your own password at first sign-in. Your employee ID is ${x.employeeNo}.`
        : `Your RingPe account is now linked to ${x.institution} as staff (employee ID ${x.employeeNo}). Sign in with your usual password.`;
      await this.deps.email
        .send({ to: x.email, purpose: 'staff.onboarded', text })
        .catch((e: unknown) =>
          this.deps.loggers.app.warn('staff.email_failed', { error: String(e) }),
        );
    }
  }

  /** Creates one staff member inside the caller's transaction (single form and sheets). */
  async createStaff(
    trx: Kysely<Database>,
    inst: { id: string; name: string; short_name: string },
    pub: { id: string; bin: Buffer },
    input: StaffInput,
    by: Buffer | null,
  ) {
    let generated: string | null = null;
    const ut = await this.userType(trx, inst.id, input.userTypeId);
    if (!STAFF_CATEGORIES.includes(ut.category)) {
      throw new ValidationError([
        { field: 'userTypeId', code: 'IDN.USER_TYPE_UNKNOWN', params: { t: ut.name } },
      ]);
    }
    const departmentId = await this.department(trx, inst.id, ut.id, input.departmentId);
    const fields = await activeFields(trx, inst.id, 'MEMBER');
    const cf = parseValues(fields, input.customFields ?? {}, { partial: false });
    if (cf.errors.length) throw new ValidationError(cf.errors);
    const here = (await repo.profilesOfMobile(trx, input.mobile)).filter(
      (x) => String(x.institution_id) === String(inst.id) && STAFF_CATEGORIES.includes(x.category),
    );
    if (here.length) {
      throw new CustomAPIError(409, 'IDN.STAFF_MOBILE_TAKEN', {
        errors: [{ field: 'mobile', code: 'IDN.STAFF_MOBILE_TAKEN' }],
      });
    }
    const email = input.email.trim().toLowerCase();
    let accountId = await this.mobileFor(trx, inst.id, input.mobile, 'mobile');
    if (!accountId) {
      if (await accountRepository.emailInUse(trx, email)) {
        throw new ValidationError([{ field: 'email', code: 'IDN.EMAIL_TAKEN' }]);
      }
      const created = await trx
        .insertInto('platform_accounts')
        .values({
          public_id: newPublicIdPair().bin,
          mobile: input.mobile,
          email,
          first_name: input.firstName.trim().toUpperCase(),
          last_name: input.lastName?.trim().toUpperCase() || null,
          gender: input.gender === 'OTHER' ? null : input.gender,
          dob: input.dateOfBirth,
        })
        .executeTakeFirstOrThrow();
      accountId = String(created.insertId);
      // A random temporary password, changed at first sign-in (OI-IDN-20).
      generated = `${randomBytes(9).toString('base64url').slice(0, 10)}@1`;
      await trx
        .insertInto('account_credentials')
        .values({
          account_id: accountId,
          kind: 'PASSWORD',
          hash: await hashSecret(generated),
          must_change: 1,
        })
        .execute();
    }
    const employeeNo = input.employeeNo?.trim() || (await repo.nextEmployeeNo(trx, inst.id));
    if (await repo.employeeTaken(trx, inst.id, employeeNo)) {
      throw new CustomAPIError(409, 'IDN.EMPLOYEE_NO_TAKEN', {
        params: { n: employeeNo },
        errors: [{ field: 'employeeNo', code: 'IDN.EMPLOYEE_NO_TAKEN', params: { n: employeeNo } }],
      });
    }
    const id = await repo.insert(trx, {
      publicId: pub.bin,
      institutionId: inst.id,
      accountId,
      userTypeId: ut.id,
      departmentId,
      firstName: input.firstName.trim(),
      lastName: input.lastName?.trim() || null,
      gender: input.gender,
      dateOfBirth: input.dateOfBirth,
      contactMobile: input.mobile,
      contactEmail: email,
      admissionNo: null,
      employeeNo,
      joinedOn: input.joinedOn,
      by,
    });
    await saveValues(trx, inst.id, pub.bin, cf.parsed);
    await recordAudit(trx, {
      institutionId: inst.id,
      action: 'STAFF_ONBOARDED',
      entityType: 'member',
      entityRef: pub.id,
      after: { userType: ut.name, employeeNo, newAccount: generated !== null },
    });
    const seq = await trx
      .selectFrom('member_profiles')
      .select('member_seq')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      email,
      name: [input.firstName.trim(), input.lastName?.trim()].filter(Boolean).join(' '),
      institution: inst.name,
      employeeNo,
      password: generated,
      memberNo: `${inst.short_name}-${String(seq.member_seq).padStart(5, '0')}`,
    };
  }

  // --- IDN-054 ------------------------------------------------------------------------------------
  /** Self-apply when the maker is an Institution Administrator and the setting allows (ADR-0015). */
  async adminSelfApplies(trx: Kysely<Database>, p: Principal) {
    if (!(await this.limit(LIMITS.approvalsAdminSelfApply))) return false;
    if (!p.profileId || !isUuid(p.profileId)) return false;
    const prof = await trx
      .selectFrom('member_profiles')
      .select('id')
      .where('public_id', '=', uuidToBin(p.profileId))
      .executeTakeFirst();
    if (!prof) return false;
    return (await repo.roles(trx, String(prof.id))).some((r) => r.code === 'INSTITUTION_ADMIN');
  }

  async changeStatus(
    p: Principal,
    memberId: string,
    input: { to: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'; reason?: string | null | undefined },
  ) {
    if (!isUuid(memberId)) throw new NotFoundError();
    const reason = input.reason?.trim() || null;
    const min = await this.limit(LIMITS.lifecycleReasonMinLength);
    if (input.to !== 'ACTIVE' && (!reason || reason.length < min)) {
      throw new ValidationError([
        { field: 'reason', code: 'IDN.REASON_TOO_SHORT', params: { min } },
      ]);
    }
    const by = this.by(p);
    const at = this.now();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const m = await repo.lock(trx, inst.id, uuidToBin(memberId));
      if (!m) throw new NotFoundError();
      const from = m.status;
      const allowed: Readonly<Record<string, readonly string[]>> = {
        ACTIVE: ['INACTIVE', 'SUSPENDED'],
        INACTIVE: ['ACTIVE'],
        SUSPENDED: ['ACTIVE', 'INACTIVE'],
      };
      if (!allowed[from]?.includes(input.to)) {
        throw new CustomAPIError(409, 'IDN.STATUS_TRANSITION_INVALID', {
          params: { status: (STATUS_LABEL[from] ?? from).toLowerCase() },
        });
      }
      if (input.to === 'SUSPENDED') {
        const pending = await repo.pending(trx, inst.id, [memberId]);
        if (pending.some((x) => x.module === 'MEMBER_SUSPENSION')) {
          throw new CustomAPIError(409, 'IDN.SUSPENSION_PENDING');
        }
        if (!by) throw new NotFoundError();
        const direct = await this.adminSelfApplies(trx, p);
        const raised = await raiseApproval(trx, {
          institutionId: inst.id,
          module: 'MEMBER_SUSPENSION',
          summary: `Suspend ${personName(m.first_name, m.last_name)} — ${reason}`,
          payload: { member: memberId, reason },
          makerType: 'staff',
          makerRef: by,
          subjectType: 'member',
          subjectRef: m.public_id,
          at,
          appliedDirectly: direct,
        });
        if (!direct) {
          await recordAudit(trx, {
            institutionId: inst.id,
            action: 'MEMBER_SUSPENSION_REQUESTED',
            entityType: 'member',
            entityRef: memberId,
            reason: reason ?? undefined,
            after: { approval: raised.id },
          });
          return { applied: false as const, approvalId: raised.id, accountId: null };
        }
      }
      if (!(await repo.setStatus(trx, m.id, [from], input.to, reason, at))) {
        throw new CustomAPIError(409, 'IDN.STATUS_TRANSITION_INVALID', {
          params: { status: (STATUS_LABEL[from] ?? from).toLowerCase() },
        });
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action:
          input.to === 'ACTIVE'
            ? 'MEMBER_ACTIVATED'
            : input.to === 'INACTIVE'
              ? 'MEMBER_DEACTIVATED'
              : 'MEMBER_SUSPENDED',
        entityType: 'member',
        entityRef: memberId,
        before: { status: from },
        after: { status: input.to },
        reason: reason ?? undefined,
      });
      return { applied: true as const, approvalId: null, accountId: m.account_id };
    });
    if (out.applied && input.to !== 'ACTIVE' && out.accountId) {
      await this.deps.sessions.endAllForAccount(String(out.accountId), 'ACCOUNT_DEACTIVATED');
    }
    return out.applied
      ? { status: input.to, approvalId: null }
      : { status: null, approvalId: out.approvalId };
  }

  /**
   * IDN-086: signs the member out of the app on every device (a lost phone, a shared phone),
   * recorded with its reason (security review S-02). The member can sign in again.
   */
  async endSessions(p: Principal, memberId: string, input: { reason: string }) {
    if (!isUuid(memberId)) throw new NotFoundError();
    const reason = input.reason.trim();
    const min = await this.limit(LIMITS.lifecycleReasonMinLength);
    if (reason.length < min) {
      throw new ValidationError([
        { field: 'reason', code: 'IDN.REASON_TOO_SHORT', params: { min } },
      ]);
    }
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx);
      const m = await repo.lock(trx, inst.id, uuidToBin(memberId));
      if (!m) throw new NotFoundError();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MEMBER_SESSIONS_ENDED',
        entityType: 'member',
        entityRef: memberId,
        reason,
      });
      return { accountId: m.account_id === null ? null : String(m.account_id) };
    });
    const ended = out.accountId
      ? await this.deps.sessions.endAllForAccount(out.accountId, 'ADMIN_REVOKED', ['member'])
      : 0;
    this.deps.loggers.security.info('member.sessions_ended', { ended });
    return { ended };
  }

  /** Applies an approved suspension (called by the approvals service). */
  async applySuspension(
    trx: Kysely<Database>,
    institutionId: string,
    memberId: string,
    reason: string,
  ) {
    const m = await repo.lock(trx, institutionId, uuidToBin(memberId));
    if (!m) throw new NotFoundError();
    if (!(await repo.setStatus(trx, m.id, ['ACTIVE'], 'SUSPENDED', reason, this.now()))) {
      throw new CustomAPIError(409, 'IDN.STATUS_TRANSITION_INVALID', {
        params: { status: (STATUS_LABEL[m.status] ?? m.status).toLowerCase() },
      });
    }
    await recordAudit(trx, {
      institutionId,
      action: 'MEMBER_SUSPENDED',
      entityType: 'member',
      entityRef: memberId,
      before: { status: m.status },
      after: { status: 'SUSPENDED' },
      reason,
    });
    return m.account_id ? String(m.account_id) : null;
  }

  // --- IDN-055 ------------------------------------------------------------------------------------
  async delinkRequest(p: Principal, memberId: string, input: { reason: string }) {
    if (!isUuid(memberId)) throw new NotFoundError();
    const reason = input.reason.trim();
    const min = await this.limit(LIMITS.lifecycleReasonMinLength);
    if (reason.length < min) {
      throw new ValidationError([
        { field: 'reason', code: 'IDN.REASON_TOO_SHORT', params: { min } },
      ]);
    }
    const by = this.by(p);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const m = await repo.lock(trx, inst.id, uuidToBin(memberId));
      if (!m) throw new NotFoundError();
      if (!m.account_id && m.status === 'INACTIVE') {
        throw new CustomAPIError(409, 'IDN.STATUS_TRANSITION_INVALID', {
          params: { status: 'de-linked' },
        });
      }
      const pending = await repo.pending(trx, inst.id, [memberId]);
      if (pending.some((x) => x.module === 'MEMBER_DELINK'))
        throw new CustomAPIError(409, 'IDN.DELINK_PENDING');
      if (!by) throw new NotFoundError();
      const direct = await this.adminSelfApplies(trx, p);
      const raised = await raiseApproval(trx, {
        institutionId: inst.id,
        module: 'MEMBER_DELINK',
        summary: `De-link ${personName(m.first_name, m.last_name)} — ${reason}`,
        payload: { member: memberId, reason },
        makerType: 'staff',
        makerRef: by,
        subjectType: 'member',
        subjectRef: m.public_id,
        at: this.now(),
        appliedDirectly: direct,
      });
      if (direct) {
        const accountId = await this.applyDelink(trx, inst.id, memberId, reason);
        return { applied: true as const, approvalId: null, accountId };
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MEMBER_DELINK_REQUESTED',
        entityType: 'member',
        entityRef: memberId,
        reason,
        after: { approval: raised.id },
      });
      return { applied: false as const, approvalId: raised.id, accountId: null };
    });
    if (out.applied && out.accountId) {
      await this.deps.sessions.endAllForAccount(out.accountId, 'PROFILE_DELINKED');
    }
    return { delinked: out.applied, approvalId: out.approvalId };
  }

  /** De-links a member (on approval or self-applied): Inactive, no account; the record stays. */
  async applyDelink(
    trx: Kysely<Database>,
    institutionId: string,
    memberId: string,
    reason: string,
  ) {
    const m = await repo.lock(trx, institutionId, uuidToBin(memberId));
    if (!m) throw new NotFoundError();
    await repo.delink(trx, m.id, reason, this.now());
    await recordAudit(trx, {
      institutionId,
      action: 'MEMBER_DELINKED',
      entityType: 'member',
      entityRef: memberId,
      before: { status: m.status, linked: m.account_id !== null },
      after: { status: 'INACTIVE', linked: false },
      reason,
    });
    return m.account_id ? String(m.account_id) : null;
  }

  // --- IDN-058 ------------------------------------------------------------------------------------
  async history(p: Principal, memberId: string) {
    const inst = await this.own(p);
    if (!isUuid(memberId)) throw new NotFoundError();
    const m = await repo.lock(this.deps.db, inst.id, uuidToBin(memberId));
    if (!m) throw new NotFoundError();
    const rows = await repo.history(this.deps.db, inst.id, m.public_id);
    const parse = (v: unknown) => {
      if (v === null || v === undefined) return null;
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    };
    return {
      items: rows.map((h) => ({
        action: h.action,
        at: new Date(h.occurred_at).toISOString(),
        by:
          personName(h.first_name, h.last_name) ||
          (h.actor_type === 'system' ? 'System' : 'RingPe'),
        before: parse(h.before_state),
        after: parse(h.after_state),
        reason: h.reason,
      })),
    };
  }

  // --- IDN-059 ------------------------------------------------------------------------------------
  async search(p: Principal, q: string) {
    const inst = await this.own(p);
    const text = q.trim();
    if (text.length < 2) return { members: [], references: [] };
    const year = await this.year(this.deps.db, inst.id);
    const rows = await repo.search(this.deps.db, inst.id, year ? String(year.id) : null, text, 8);
    return {
      members: rows.map((r) => ({
        id: binToUuid(r.public_id),
        memberNo: `${inst.short_name}-${String(r.member_seq).padStart(5, '0')}`,
        name: personName(r.first_name, r.last_name),
        kind: kindOf(r.category),
        userType: r.user_type_name,
        detail:
          r.class_name !== null
            ? `${r.class_name} ${r.section_name ?? ''}`.trim()
            : (r.department_name ?? r.user_type_name),
        number: r.admission_no ?? r.employee_no ?? null,
        status: r.status,
      })),
      // Payment and receipt references arrive with the wallet (Phase 3).
      references: [],
    };
  }

  /** Field definitions for the onboarding form. */
  async formFields(p: Principal): Promise<CfField[]> {
    const inst = await this.own(p);
    return activeFields(this.deps.db, inst.id, 'MEMBER');
  }
}

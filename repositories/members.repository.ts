/**
 * Members of an institution (6.18–6.27; IDN-044…059; CR-08, CR-09, CR-12, CR-13): profiles with
 * their user type and department, grade and section for the current year, guardians and wards,
 * and the account they are linked to. Every query is scoped to one institution.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';
import { uuidToBin } from '../utils/idGenerator';

type Db = Kysely<Database> | Transaction<Database>;

export type MemberKind = 'STUDENTS' | 'PARENTS' | 'STAFF' | 'MERCHANTS';

/** User-type categories of each list tab (prototype MTABS). */
export const KIND_CATEGORIES: Readonly<Record<MemberKind, readonly string[]>> = {
  STUDENTS: ['STUDENT'],
  PARENTS: ['PARENT'],
  STAFF: ['TEACHER', 'STAFF', 'PRINCIPAL', 'MANAGEMENT', 'CREW', 'OTHER'],
  MERCHANTS: ['MERCHANT'],
};

export const kindOf = (category: string): MemberKind =>
  (Object.entries(KIND_CATEGORIES).find(([, c]) => c.includes(category))?.[0] as MemberKind) ??
  'STAFF';

export interface MemberFilter {
  readonly kind?: MemberKind | undefined;
  readonly q?: string | undefined;
  readonly status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | undefined;
  readonly userTypeId?: string | undefined;
  readonly departmentId?: string | undefined;
  readonly classId?: string | undefined;
  readonly sectionId?: string | undefined;
  /** Custom-field filters: field id (internal) → option id (Dropdown) or yes/no. */
  readonly cf?: readonly { fieldId: string; optionId?: string; bool?: boolean }[];
}

const COLUMNS = [
  'm.id',
  'm.public_id',
  'm.member_seq',
  'm.first_name',
  'm.last_name',
  'm.gender',
  'm.date_of_birth',
  'm.contact_mobile',
  'm.contact_email',
  'm.admission_no',
  'm.employee_no',
  'm.joined_on',
  'm.status',
  'm.status_reason',
  'm.status_changed_at',
  'm.account_id',
  'm.row_version',
  'm.created_at',
  'ut.public_id as user_type_public_id',
  'ut.name as user_type_name',
  'ut.category',
  'd.public_id as department_public_id',
  'd.name as department_name',
  'a.mobile as account_mobile',
  'a.email as account_email',
  'c.public_id as class_public_id',
  'c.name as class_name',
  'c.sort_order as class_order',
  's.public_id as section_public_id',
  's.name as section_name',
  'm.txn_permission',
  'm.txn_permission_reason',
  'm.txn_permission_changed_at',
  'w.status as wallet_status',
  'wb.available_paise as wallet_available_paise',
] as const;

function base(db: Db, institutionId: string, yearId: string | null) {
  return (
    db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('departments as d', 'd.id', 'm.department_id')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').on('e.year_id', '=', yearId ?? '0'),
      )
      .leftJoin('sections as s', 's.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      // The profile's main wallet (campus, or a merchant's), for the balance column (WAL-008).
      .leftJoin('wallets as w', (j) =>
        j.onRef('w.owner_profile_id', '=', 'm.id').on('w.kind', 'in', ['CAMPUS', 'MERCHANT']),
      )
      .leftJoin('wallet_balances as wb', 'wb.wallet_id', 'w.id')
      .where('m.institution_id', '=', institutionId)
  );
}

type Base = ReturnType<typeof base>;

function filtered(q: Base, f: MemberFilter, opts: { tab: boolean; status: boolean }) {
  let out = q;
  if (opts.tab && f.kind)
    out = out.where('ut.category', 'in', [...KIND_CATEGORIES[f.kind]] as never);
  if (opts.status && f.status) out = out.where('m.status', '=', f.status);
  if (f.userTypeId) out = out.where('m.user_type_id', '=', f.userTypeId);
  if (f.departmentId) out = out.where('m.department_id', '=', f.departmentId);
  if (f.classId) out = out.where('c.id', '=', f.classId);
  if (f.sectionId) out = out.where('s.id', '=', f.sectionId);
  const text = f.q?.trim();
  if (text) {
    const like = `%${text.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    const digits = text.replace(/\D/g, '');
    out = out.where((eb) =>
      eb.or([
        eb(sql<string>`CONCAT(m.first_name, ' ', COALESCE(m.last_name, ''))`, 'like', like),
        eb('m.admission_no', 'like', like),
        eb('m.employee_no', 'like', like),
        ...(digits.length >= 4
          ? [eb('m.contact_mobile', 'like', `%${digits}%`), eb('a.mobile', 'like', `%${digits}%`)]
          : []),
      ]),
    );
  }
  for (const c of f.cf ?? []) {
    out = out.where((eb) =>
      eb.exists(
        eb
          .selectFrom('custom_field_values as v')
          .select('v.id')
          .whereRef('v.entity_ref', '=', 'm.public_id')
          .where('v.field_id', '=', c.fieldId)
          .$if(c.bool !== undefined, (w) => w.where('v.value_bool', '=', c.bool ?? false))
          .$if(Boolean(c.optionId), (w) =>
            w.where((x) =>
              x.exists(
                x
                  .selectFrom('custom_field_value_options as o')
                  .select('o.value_id')
                  .whereRef('o.value_id', '=', 'v.id')
                  .where('o.option_id', '=', c.optionId ?? '0'),
              ),
            ),
          ),
      ),
    );
  }
  return out;
}

export const membersRepository = {
  /** One page by name (keyset on first name and id). */
  async page(
    db: Db,
    institutionId: string,
    yearId: string | null,
    f: MemberFilter,
    page: { after?: { name: string; id: string } | undefined; limit: number },
  ) {
    let q = filtered(base(db, institutionId, yearId), f, { tab: true, status: true }).select(
      COLUMNS,
    );
    if (page.after) {
      const { name, id } = page.after;
      q = q.where((eb) =>
        eb.or([
          eb('m.first_name', '>', name),
          eb.and([eb('m.first_name', '=', name), eb('m.id', '>', id)]),
        ]),
      );
    }
    return q
      .orderBy('m.first_name')
      .orderBy('m.id')
      .limit(page.limit + 1)
      .execute();
  },

  /** Counts by user-type category and status for the same filters (tabs and status pills). */
  async counts(db: Db, institutionId: string, yearId: string | null, f: MemberFilter) {
    return filtered(base(db, institutionId, yearId), f, { tab: false, status: false })
      .select(['ut.category', 'm.status', (eb) => eb.fn.countAll<number>().as('n')])
      .groupBy(['ut.category', 'm.status'])
      .execute();
  },

  async byPublicId(db: Db, institutionId: string, yearId: string | null, publicId: Buffer) {
    return base(db, institutionId, yearId)
      .select(COLUMNS)
      .where('m.public_id', '=', publicId)
      .executeTakeFirst();
  },

  async lock(db: Db, institutionId: string, publicId: Buffer) {
    return db
      .selectFrom('member_profiles')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', publicId)
      .forUpdate()
      .executeTakeFirst();
  },

  /** Guardians of students and wards of parents, for the given profiles. */
  async relations(
    db: Db,
    institutionId: string,
    yearId: string | null,
    profileIds: readonly string[],
  ) {
    if (!profileIds.length) return [];
    return db
      .selectFrom('guardianships as g')
      .innerJoin('member_profiles as gp', 'gp.id', 'g.guardian_profile_id')
      .innerJoin('member_profiles as wp', 'wp.id', 'g.ward_profile_id')
      .leftJoin('platform_accounts as ga', 'ga.id', 'gp.account_id')
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'wp.id').on('e.year_id', '=', yearId ?? '0'),
      )
      .leftJoin('sections as s', 's.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'g.guardian_profile_id',
        'g.ward_profile_id',
        'g.relation',
        'g.is_primary_contact',
        'gp.public_id as guardian_public_id',
        'gp.first_name as guardian_first_name',
        'gp.last_name as guardian_last_name',
        'gp.contact_mobile as guardian_contact_mobile',
        'ga.mobile as guardian_account_mobile',
        'gp.status as guardian_status',
        'wp.public_id as ward_public_id',
        'wp.first_name as ward_first_name',
        'wp.last_name as ward_last_name',
        'wp.status as ward_status',
        'c.name as ward_class',
        's.name as ward_section',
      ])
      .where('g.institution_id', '=', institutionId)
      .where((eb) =>
        eb.or([
          eb('g.guardian_profile_id', 'in', [...profileIds]),
          eb('g.ward_profile_id', 'in', [...profileIds]),
        ]),
      )
      .execute();
  },

  /** Console roles held by a profile. */
  async roles(db: Db, profileId: string) {
    return db
      .selectFrom('profile_roles as pr')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .select(['r.code', 'r.name'])
      .where('pr.profile_id', '=', profileId)
      .execute();
  },

  /** Requests waiting for a checker about these members (suspension, de-link, correction). */
  async pending(db: Db, institutionId: string, refs: readonly string[]) {
    if (!refs.length) return [];
    return db
      .selectFrom('approval_requests')
      .select(['public_id', 'module', sql<string>`BIN_TO_UUID(subject_ref)`.as('member')])
      .where('institution_id', '=', institutionId)
      .where('status', '=', 'PENDING')
      .where('module', 'in', ['MEMBER_SUSPENSION', 'MEMBER_DELINK', 'PII_CORRECTION'])
      .where('subject_type', '=', 'member')
      .where(
        'subject_ref',
        'in',
        refs.map((r) => uuidToBin(r)),
      )
      .execute();
  },

  // --- onboarding -------------------------------------------------------------------------------------
  /** Profiles of an account or of an unlinked contact mobile, in any institution (BR-01). */
  async profilesOfMobile(db: Db, mobile: string) {
    return db
      .selectFrom('member_profiles as m')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'm.id',
        'm.public_id',
        'm.account_id',
        'm.contact_mobile',
        'm.institution_id',
        'm.first_name',
        'm.last_name',
        'm.status',
        'ut.name as user_type_name',
        'ut.category',
      ])
      .where((eb) => eb.or([eb('a.mobile', '=', mobile), eb('m.contact_mobile', '=', mobile)]))
      .execute();
  },

  async admissionTaken(db: Db, institutionId: string, admissionNo: string, exceptId?: string) {
    let q = db
      .selectFrom('member_profiles')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('admission_no', '=', admissionNo);
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  },

  async employeeTaken(db: Db, institutionId: string, employeeNo: string) {
    return Boolean(
      await db
        .selectFrom('member_profiles')
        .select('id')
        .where('institution_id', '=', institutionId)
        .where('employee_no', '=', employeeNo)
        .executeTakeFirst(),
    );
  },

  /** The next EMP number of the institution (27.4 `EMP…`). */
  async nextEmployeeNo(db: Db, institutionId: string) {
    const r = await db
      .selectFrom('member_profiles')
      .select(sql<number>`MAX(CAST(SUBSTRING(employee_no, 4) AS UNSIGNED))`.as('n'))
      .where('institution_id', '=', institutionId)
      .where('employee_no', 'like', 'EMP%')
      .executeTakeFirst();
    return `EMP${String(Number(r?.n ?? 0) + 1).padStart(5, '0')}`;
  },

  async insert(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      accountId: string | null;
      userTypeId: string;
      departmentId: string | null;
      firstName: string;
      lastName: string | null;
      gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
      dateOfBirth: string | null;
      contactMobile: string | null;
      contactEmail: string | null;
      admissionNo: string | null;
      employeeNo: string | null;
      joinedOn: string | null;
      by: Buffer | null;
    },
  ) {
    const r = await db
      .insertInto('member_profiles')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        account_id: v.accountId,
        user_type_id: v.userTypeId,
        department_id: v.departmentId,
        first_name: v.firstName,
        last_name: v.lastName,
        gender: v.gender,
        date_of_birth: v.dateOfBirth,
        contact_mobile: v.contactMobile,
        contact_email: v.contactEmail,
        admission_no: v.admissionNo,
        employee_no: v.employeeNo,
        joined_on: v.joinedOn,
        status: 'ACTIVE',
        created_by: v.by,
      })
      .executeTakeFirstOrThrow();
    return String(r.insertId);
  },

  async addGuardian(
    db: Db,
    v: {
      institutionId: string;
      guardianId: string;
      wardId: string;
      relation: string;
      primary: boolean;
    },
  ) {
    await db
      .insertInto('guardianships')
      .values({
        institution_id: v.institutionId,
        guardian_profile_id: v.guardianId,
        ward_profile_id: v.wardId,
        relation: v.relation,
        is_primary_contact: v.primary,
      })
      .onDuplicateKeyUpdate({ relation: v.relation })
      .execute();
  },

  async students(db: Db, institutionId: string, publicIds: readonly Buffer[]) {
    if (!publicIds.length) return [];
    return db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select(['m.id', 'm.public_id', 'ut.category'])
      .where('m.institution_id', '=', institutionId)
      .where('m.public_id', 'in', [...publicIds])
      .execute();
  },

  // --- changes ----------------------------------------------------------------------------------------
  async update(
    db: Db,
    id: string,
    expected: number,
    set: Partial<{
      department_id: string | null;
      contact_email: string | null;
      joined_on: string | null;
      employee_no: string | null;
    }>,
  ) {
    const r = await db
      .updateTable('member_profiles')
      .set({
        ...set,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async touch(db: Db, id: string) {
    await db
      .updateTable('member_profiles')
      .set({ updated_at: sql<Date>`UTC_TIMESTAMP(3)`, row_version: sql<number>`row_version + 1` })
      .where('id', '=', id)
      .execute();
  },

  /** Guarded status change (RC-01). */
  async setStatus(
    db: Db,
    id: string,
    from: readonly ('ACTIVE' | 'INACTIVE' | 'SUSPENDED')[],
    to: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED',
    reason: string | null,
    at: Date,
  ) {
    const r = await db
      .updateTable('member_profiles')
      .set({
        status: to,
        status_reason: reason,
        status_changed_at: at,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('status', 'in', [...from])
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** De-link: the profile leaves its account and becomes Inactive (6.26; the record stays). */
  async delink(db: Db, id: string, reason: string, at: Date) {
    await db
      .updateTable('member_profiles')
      .set({
        status: 'INACTIVE',
        status_reason: reason,
        status_changed_at: at,
        account_id: null,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .execute();
  },

  /** Links the unlinked profiles of a mobile number to the account that just signed up. */
  async linkByMobile(db: Db, accountId: string, mobile: string) {
    const r = await db
      .updateTable('member_profiles')
      .set({ account_id: accountId, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
      .where('account_id', 'is', null)
      .where('contact_mobile', '=', mobile)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  },

  // --- history and search -------------------------------------------------------------------------
  async history(db: Db, institutionId: string, ref: Buffer, limit = 100) {
    return db
      .selectFrom('audit_log as l')
      .leftJoin('platform_accounts as a', 'a.public_id', 'l.actor_ref')
      .select([
        'l.action',
        'l.occurred_at',
        'l.before_state',
        'l.after_state',
        'l.reason',
        'l.actor_type',
        'a.first_name',
        'a.last_name',
      ])
      .where('l.institution_id', '=', institutionId)
      .where('l.entity_type', '=', 'member')
      .where('l.entity_ref', '=', ref)
      .orderBy('l.occurred_at', 'desc')
      .limit(limit)
      .execute();
  },

  async search(db: Db, institutionId: string, yearId: string | null, q: string, limit: number) {
    return filtered(base(db, institutionId, yearId), { q }, { tab: false, status: false })
      .select(COLUMNS)
      .orderBy('m.first_name')
      .orderBy('m.id')
      .limit(limit)
      .execute();
  },

  // --- uploads ------------------------------------------------------------------------------------------
  async insertUpload(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      kind: 'MEMBERS' | 'STAFF' | 'PROFILE_UPDATE';
      fileName: string;
      total: number;
      accepted: number;
      rejected: number;
      report: unknown;
      by: Buffer | null;
    },
  ) {
    await db
      .insertInto('member_uploads')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        kind: v.kind,
        file_name: v.fileName,
        rows_total: v.total,
        rows_accepted: v.accepted,
        rows_rejected: v.rejected,
        report: JSON.stringify(v.report),
        created_by: v.by,
      })
      .execute();
  },

  async upload(db: Db, institutionId: string, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('member_uploads')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async commitUpload(db: Db, id: string, count: number, at: Date) {
    const r = await db
      .updateTable('member_uploads')
      .set({ status: 'COMMITTED', committed_at: at, committed_count: count })
      .where('id', '=', id)
      .where('status', '=', 'VALIDATED')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },
};

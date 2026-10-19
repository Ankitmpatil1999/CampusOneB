/**
 * Student and staff leave (SRS 20.26–20.30; ACA-042, ACA-043, ACA-055…059, ACA-061, ACA-062,
 * ACA-072…074; FR-ACA-09/10; BR-53; OI-ACA-44…51; CR-13; prototype m.leave, m.leave.new, m.t.leaves,
 * m.t.myleave, m.pr.approvals, c.leave).
 *
 * - Days are counted without Sundays and school holidays (calendar entries of type Holiday for
 *   everyone, or for the student's class or section). A request with no such day is refused.
 * - A student's request (by the student or a guardian on the account) is for dates from today inside
 *   the year, with a reason and an optional document, never overlapping a pending or approved request.
 *   The class teachers are told; a class teacher of the section decides (remarks when rejecting) and
 *   the family is told; it can be withdrawn while pending.
 * - A teacher's request goes to the academic coordinator (recommend, or reject with feedback), then
 *   to the principal, who decides only after a recommendation (OI-ACA-51). Other staff go to the
 *   principal directly (example until the non-teaching module is specified, Q16). Requests can't
 *   overlap, can't exceed the year's balance (settings), and can be cancelled until reviewed. No one
 *   decides their own request.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type { Database, StaffLeaveType } from '../models/ringpe_models';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import { formatDate, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import {
  assertInYear,
  assertOpen,
  institutionOf,
  yearFor,
  yearView,
  type Year,
} from './academic-year';
import { recordAudit } from './audit.service';
import { occurrences } from './calendar.service';
import { memberOf, teacherOf, type Member } from './member-roles';
import { notify } from './notifications.service';
import type { SettingsService } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_LABEL: Record<StaffLeaveType, string> = {
  CASUAL: 'Casual',
  MEDICAL: 'Medical',
  EARNED: 'Earned',
};
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const range = (from: string, to: string) =>
  from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
const ref = (prefix: 'SL' | 'TL', id: string | number) =>
  `${prefix}-${String(id).padStart(6, '0')}`;

/** The staff leave's state as people read it (27.2 coordinator and final statuses together). */
const staffState = (l: {
  needs_coordinator: number;
  coordinator_status: 'APPROVED' | 'REJECTED' | null;
  final_status: 'APPROVED' | 'REJECTED' | 'CANCELLED' | null;
}) =>
  l.final_status ??
  (l.coordinator_status === 'REJECTED'
    ? 'REJECTED_BY_COORDINATOR'
    : l.coordinator_status === 'APPROVED' || !Number(l.needs_coordinator)
      ? 'WITH_PRINCIPAL'
      : 'PENDING');

export class LeaveService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async limit(l: LimitDefinition) {
    if (!this.deps.settings) return Number(l.value);
    const v = await this.deps.settings.values();
    return Number(v[l.key] ?? l.value);
  }

  /** The dates in [from, to] that are school days: no Sundays, no holiday for everyone or the class. */
  private async schoolDays(
    db: Db,
    institutionId: string,
    yearId: string,
    from: string,
    to: string,
    scope?: { classId: string; sectionId: string },
  ) {
    const holidays = await db
      .selectFrom('calendar_entries as e')
      .select(['e.start_date', 'e.end_date', 'e.recurrence', 'e.repeat_until'])
      .where('e.institution_id', '=', institutionId)
      .where('e.year_id', '=', yearId)
      .where('e.type', '=', 'Holiday')
      .where('e.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('e.audience', '=', 'ALL'),
          ...(scope
            ? [
                eb.exists(
                  eb
                    .selectFrom('calendar_entry_targets as t')
                    .select('t.entry_id')
                    .whereRef('t.entry_id', '=', 'e.id')
                    .where((x) =>
                      x.or([
                        x.and([x('t.kind', '=', 'CLASS'), x('t.ref_id', '=', scope.classId)]),
                        x.and([x('t.kind', '=', 'SECTION'), x('t.ref_id', '=', scope.sectionId)]),
                      ]),
                    ),
                ),
              ]
            : []),
        ]),
      )
      .execute();
    const off = new Set<string>();
    for (const h of holidays) {
      for (const o of occurrences(
        {
          start: ymd(h.start_date),
          end: ymd(h.end_date),
          recurrence: h.recurrence,
          until: h.repeat_until ? ymd(h.repeat_until) : null,
        },
        from,
        to,
      )) {
        for (let d = o.start; d <= o.end; d = addDays(d, 1)) off.add(d);
      }
    }
    let n = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0 && !off.has(d)) n++;
    }
    return n;
  }

  private checkDates(from: string, to: string) {
    if (!DAY.test(from)) throw new ValidationError([{ field: 'from', code: 'VALIDATION.DATE' }]);
    if (!DAY.test(to)) throw new ValidationError([{ field: 'to', code: 'VALIDATION.DATE' }]);
    if (from < istBusinessDate(this.now())) {
      throw new ValidationError([{ field: 'from', code: 'ACA.LEAVE_PAST' }]);
    }
    if (to < from) throw new ValidationError([{ field: 'to', code: 'ACA.LEAVE_DATES' }]);
  }

  private async fileOf(db: Db, p: Principal, institutionId: string, id: string) {
    if (!isUuid(id)) throw new ValidationError([{ field: 'fileId', code: 'ACA.HW_FILE' }]);
    const f = await db
      .selectFrom('files')
      .select(['id', 'scan_status', 'purpose', 'institution_id'])
      .where('public_id', '=', uuidToBin(id))
      .where('created_by', '=', this.by(p))
      .executeTakeFirst();
    if (
      !f ||
      f.scan_status === 'INFECTED' ||
      !['document', 'photo', 'evidence'].includes(f.purpose) ||
      (f.institution_id !== null && String(f.institution_id) !== institutionId)
    ) {
      throw new ValidationError([{ field: 'fileId', code: 'ACA.HW_FILE' }]);
    }
    return String(f.id);
  }

  private async accountsOf(db: Db, profileRowIds: readonly string[]) {
    if (!profileRowIds.length) return [];
    const rows = await db
      .selectFrom('member_profiles')
      .select('account_id')
      .where('id', 'in', profileRowIds as string[])
      .execute();
    return [
      ...new Set(
        rows
          .map((r) => r.account_id)
          .filter((a) => a !== null)
          .map(String),
      ),
    ];
  }

  private async familyAccounts(db: Db, studentRowId: string) {
    const rows = await db
      .selectFrom('member_profiles as m')
      .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
      .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select(['m.account_id', 'gm.account_id as guardian_account'])
      .where('m.id', '=', studentRowId)
      .execute();
    return [
      ...new Set(
        rows
          .flatMap((r) => [r.account_id, r.guardian_account])
          .filter((a): a is string => a !== null && a !== undefined)
          .map(String),
      ),
    ];
  }

  /** The active class teachers of a section in the year. */
  private async classTeachers(db: Db, yearId: string, sectionId: string) {
    return db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
      .select(['m.id', 'm.first_name', 'm.last_name'])
      .where('ta.year_id', '=', yearId)
      .where('ta.section_id', '=', sectionId)
      .where('ta.kind', '=', 'CLASS_TEACHER')
      .where('ta.ended_at', 'is', null)
      .execute();
  }

  // --- the student's leave ----------------------------------------------------------------------------------
  private studentRows(db: Db) {
    return db
      .selectFrom('student_leaves as l')
      .innerJoin('member_profiles as m', 'm.id', 'l.student_profile_id')
      .innerJoin('sections as s', 's.id', 'l.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .leftJoin('platform_accounts as a', 'a.public_id', 'l.applied_by')
      .leftJoin('member_profiles as d', 'd.id', 'l.decided_by_profile_id')
      .leftJoin('files as f', 'f.id', 'l.file_id')
      .selectAll('l')
      .select([
        'm.public_id as student_public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.name as class_name',
        'a.first_name as applied_first',
        'a.last_name as applied_last',
        'd.first_name as decided_first',
        'd.last_name as decided_last',
        'f.original_name as file_name',
      ]);
  }

  private studentView(
    l: Awaited<ReturnType<ReturnType<LeaveService['studentRows']>['execute']>>[number],
  ) {
    const from = ymd(l.from_date);
    const to = ymd(l.to_date);
    return {
      id: binToUuid(l.public_id),
      reference: ref('SL', l.id),
      student: {
        id: binToUuid(l.student_public_id),
        name: nameOf(l.first_name, l.last_name),
        admissionNo: l.admission_no,
      },
      section: {
        id: binToUuid(l.section_public_id),
        label: `${l.class_name} ${l.section_name}`,
      },
      from,
      to,
      dates: range(from, to),
      schoolDays: l.school_days,
      reason: l.reason,
      document: l.file_name ? { name: l.file_name } : null,
      appliedBy: nameOf(l.applied_first, l.applied_last) || null,
      appliedAt: iso(l.created_at),
      status: l.status,
      decidedBy: l.decided_at ? nameOf(l.decided_first, l.decided_last) : null,
      decidedAt: iso(l.decided_at),
      remarks: l.remarks,
      withdrawnAt: iso(l.cancelled_at),
      version: l.row_version,
    };
  }

  private async studentOf(p: Principal, forProfile?: string) {
    const me = await memberOf(this.deps.db, p, forProfile);
    if (me.category !== 'STUDENT') throw new CustomAPIError(403, 'ACA.NOT_A_STUDENT_PROFILE');
    return me;
  }

  /** ACA-072: the student's requests for the year, with the class teacher who reviews them. */
  async mine(p: Principal, f: { for?: string | undefined; yearId?: string | undefined }) {
    const me = await this.studentOf(p, f.for);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const rows = await this.studentRows(this.deps.db)
      .where('l.institution_id', '=', me.institutionId)
      .where('l.student_profile_id', '=', me.rowId)
      .where('l.year_id', '=', year.id)
      .orderBy('l.from_date', 'desc')
      .execute();
    const en = await this.enrolment(this.deps.db, me, year);
    const teachers = en
      ? await this.classTeachers(this.deps.db, year.id, String(en.section_id))
      : [];
    const items = rows.map((l) => this.studentView(l));
    return {
      year: yearView(year),
      student: { name: me.name, section: en ? `${en.class_name} ${en.section_name}` : null },
      classTeacher: teachers[0] ? nameOf(teachers[0].first_name, teachers[0].last_name) : null,
      counts: {
        pending: items.filter((l) => l.status === 'PENDING').length,
        approvedDays: items
          .filter((l) => l.status === 'APPROVED')
          .reduce((n, l) => n + l.schoolDays, 0),
      },
      items,
    };
  }

  private async enrolment(db: Db, me: Member, year: Year) {
    return db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['en.section_id', 's.class_id', 's.name as section_name', 'c.name as class_name'])
      .where('en.student_profile_id', '=', me.rowId)
      .where('en.year_id', '=', year.id)
      .executeTakeFirst();
  }

  /** ACA-073: apply for a student's leave; the class teachers are told. */
  async apply(
    p: Principal,
    input: {
      for?: string | undefined;
      from: string;
      to: string;
      reason: string;
      fileId?: string | null | undefined;
    },
  ) {
    const me = await this.studentOf(p, input.for);
    this.checkDates(input.from, input.to);
    const min = await this.limit(LIMITS.studentLeaveReasonMin);
    const reason = input.reason.trim();
    if (reason.length < min || reason.length > 300) {
      throw new ValidationError([
        { field: 'reason', code: 'ACA.LEAVE_REASON', params: { min, max: 300 } },
      ]);
    }
    const at = this.now();
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const year = await yearFor(trx, me.institutionId, undefined);
      assertOpen(year);
      assertInYear(year, input.from, 'from');
      assertInYear(year, input.to, 'to');
      const en = await this.enrolment(trx, me, year);
      if (!en) throw new CustomAPIError(403, 'ACA.NOT_A_STUDENT_PROFILE');
      const days = await this.schoolDays(trx, me.institutionId, year.id, input.from, input.to, {
        classId: String(en.class_id),
        sectionId: String(en.section_id),
      });
      if (!days) throw new ValidationError([{ field: 'from', code: 'ACA.NON_SCHOOL_DAYS' }]);
      // One request at a time per student: the profile row serialises the overlap test (BR-53).
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', me.rowId)
        .forUpdate()
        .execute();
      const clash = await trx
        .selectFrom('student_leaves')
        .select(['id', 'from_date', 'to_date', 'status'])
        .where('student_profile_id', '=', me.rowId)
        .where('status', 'in', ['PENDING', 'APPROVED'])
        .where('from_date', '<=', input.to)
        .where('to_date', '>=', input.from)
        .executeTakeFirst();
      if (clash) {
        throw new CustomAPIError(409, 'ACA.LEAVE_OVERLAP', {
          params: {
            name: me.name.split(' ')[0] ?? me.name,
            dates: range(ymd(clash.from_date), ymd(clash.to_date)),
            ref: ref('SL', clash.id),
            status: clash.status.toLowerCase(),
          },
        });
      }
      const fileRow = input.fileId
        ? await this.fileOf(trx, p, me.institutionId, input.fileId)
        : null;
      await trx
        .insertInto('student_leaves')
        .values({
          public_id: pub.bin,
          institution_id: me.institutionId,
          year_id: year.id,
          student_profile_id: me.rowId,
          section_id: String(en.section_id),
          from_date: input.from,
          to_date: input.to,
          school_days: days,
          reason,
          file_id: fileRow,
          applied_by: this.by(p)!,
          created_at: at,
        })
        .execute();
      const teachers = await this.classTeachers(trx, year.id, String(en.section_id));
      await notify(
        trx,
        {
          institutionId: me.institutionId,
          accountIds: await this.accountsOf(
            trx,
            teachers.map((t) => String(t.id)),
          ),
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.LEAVE_REQUESTED',
          params: { name: me.name },
          body: `${range(input.from, input.to)} · ${reason.slice(0, 80)}`,
          link: '/teacher/student-leaves',
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'STUDENT_LEAVE_REQUESTED',
        entityType: 'student_leave',
        entityRef: pub.id,
        after: { from: input.from, to: input.to, days },
      });
    });
    return this.studentOne(this.deps.db, me.institutionId, pub.id);
  }

  private async studentOne(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
    const l = await this.studentRows(db)
      .where('l.public_id', '=', uuidToBin(id))
      .where('l.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!l) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
    return this.studentView(l);
  }

  /** ACA-074: withdraw a pending request; the class teachers are told. */
  async withdraw(p: Principal, id: string, f: { for?: string | undefined }) {
    const me = await this.studentOf(p, f.for);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const l = await this.studentOne(trx, me.institutionId, id);
      if (
        l.student.id !==
        binToUuid(
          (
            await trx
              .selectFrom('member_profiles')
              .select('public_id')
              .where('id', '=', me.rowId)
              .executeTakeFirstOrThrow()
          ).public_id,
        )
      ) {
        throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
      }
      const r = await trx
        .updateTable('student_leaves')
        .set({
          status: 'CANCELLED',
          cancelled_by: this.by(p),
          cancelled_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('public_id', '=', uuidToBin(id))
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'ACA.LEAVE_NOT_PENDING');
      const row = await trx
        .selectFrom('student_leaves')
        .select(['year_id', 'section_id'])
        .where('public_id', '=', uuidToBin(id))
        .executeTakeFirstOrThrow();
      const teachers = await this.classTeachers(trx, String(row.year_id), String(row.section_id));
      await notify(
        trx,
        {
          institutionId: me.institutionId,
          accountIds: await this.accountsOf(
            trx,
            teachers.map((t) => String(t.id)),
          ),
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.LEAVE_WITHDRAWN',
          params: { name: me.name },
          body: `${l.dates} · ${l.section.label}`,
          link: '/teacher/student-leaves',
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'STUDENT_LEAVE_WITHDRAWN',
        entityType: 'student_leave',
        entityRef: id,
      });
    });
    return this.studentOne(this.deps.db, me.institutionId, id);
  }

  /** ACA-055: the requests for the sections the teacher is class teacher of this year. */
  async classRequests(
    p: Principal,
    f: {
      status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'all' | undefined;
      sectionId?: string | undefined;
      yearId?: string | undefined;
    },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const sections = await this.deps.db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('sections as s', 's.id', 'ta.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.id', 's.public_id', 's.name', 'c.name as class_name'])
      .where('ta.teacher_profile_id', '=', me.rowId)
      .where('ta.year_id', '=', year.id)
      .where('ta.kind', '=', 'CLASS_TEACHER')
      .where('ta.ended_at', 'is', null)
      .execute();
    const wanted =
      f.sectionId && isUuid(f.sectionId)
        ? sections.filter((s) => binToUuid(s.public_id) === f.sectionId!.toLowerCase())
        : sections;
    const all = wanted.length
      ? (
          await this.studentRows(this.deps.db)
            .where('l.institution_id', '=', me.institutionId)
            .where('l.year_id', '=', year.id)
            .where(
              'l.section_id',
              'in',
              wanted.map((s) => String(s.id)),
            )
            .orderBy('l.from_date')
            .execute()
        ).map((l) => this.studentView(l))
      : [];
    const status = f.status ?? 'PENDING';
    const count = (s: string) => all.filter((l) => l.status === s).length;
    return {
      year: yearView(year),
      classTeacher: sections.length > 0,
      sections: sections.map((s) => ({
        id: binToUuid(s.public_id),
        label: `${s.class_name} ${s.name}`,
      })),
      counts: {
        pending: count('PENDING'),
        approved: count('APPROVED'),
        rejected: count('REJECTED'),
        all: all.length,
      },
      items: status === 'all' ? all : all.filter((l) => l.status === status),
    };
  }

  /** For the tenant check before the body is read. */
  async studentLookup(p: Principal, id: string) {
    const me = await memberOf(this.deps.db, p);
    await this.studentOne(this.deps.db, me.institutionId, id);
  }

  /** ACA-056: the class teacher approves or rejects (remarks when rejecting); the family is told. */
  async decideStudent(
    p: Principal,
    id: string,
    input: { decision: 'APPROVED' | 'REJECTED'; remarks?: string | null | undefined },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const remarks = (input.remarks ?? '').trim() || null;
    const min = await this.limit(LIMITS.leaveDecisionRemarksMin);
    if (
      (input.decision === 'REJECTED' && (!remarks || remarks.length < min)) ||
      (remarks && remarks.length > 200)
    ) {
      throw new ValidationError([
        { field: 'remarks', code: 'ACA.DECISION_REMARKS', params: { min, max: 200 } },
      ]);
    }
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
      const l = await trx
        .selectFrom('student_leaves')
        .selectAll()
        .where('public_id', '=', uuidToBin(id))
        .where('institution_id', '=', me.institutionId)
        .forUpdate()
        .executeTakeFirst();
      if (!l) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
      const teachers = await this.classTeachers(trx, String(l.year_id), String(l.section_id));
      if (!teachers.some((t) => String(t.id) === me.rowId)) {
        throw new CustomAPIError(403, 'ACA.CLASS_TEACHER_ONLY');
      }
      const year = await trx
        .selectFrom('academic_years')
        .select('public_id')
        .where('id', '=', String(l.year_id))
        .executeTakeFirstOrThrow();
      assertOpen(await yearFor(trx, me.institutionId, binToUuid(year.public_id)));
      if (l.status !== 'PENDING') throw new CustomAPIError(409, 'ACA.LEAVE_NOT_PENDING');
      await trx
        .updateTable('student_leaves')
        .set({
          status: input.decision,
          decided_by_profile_id: me.rowId,
          decided_at: at,
          remarks,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', l.id)
        .execute();
      const student = await trx
        .selectFrom('member_profiles')
        .select(['first_name', 'last_name'])
        .where('id', '=', String(l.student_profile_id))
        .executeTakeFirstOrThrow();
      await notify(
        trx,
        {
          institutionId: me.institutionId,
          accountIds: await this.familyAccounts(trx, String(l.student_profile_id)),
          about: [String(l.student_profile_id)],
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.LEAVE_DECIDED',
          params: {
            decision: input.decision === 'APPROVED' ? 'approved' : 'rejected',
            name: student.first_name ?? '',
          },
          body: `${range(ymd(l.from_date), ymd(l.to_date))} · by ${me.name}${remarks ? ` · “${remarks}”` : ''}`,
          link: '/leave',
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: `STUDENT_LEAVE_${input.decision}`,
        entityType: 'student_leave',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.studentOne(this.deps.db, me.institutionId, id);
  }

  // --- staff leave ---------------------------------------------------------------------------------------------
  private async staffOf(p: Principal) {
    const me = await memberOf(this.deps.db, p);
    if (!['TEACHER', 'PRINCIPAL', 'STAFF'].includes(me.category)) {
      throw new CustomAPIError(403, 'ACA.STAFF_ONLY');
    }
    return me;
  }

  private async totals() {
    return {
      CASUAL: await this.limit(LIMITS.leaveCasualDays),
      MEDICAL: await this.limit(LIMITS.leaveMedicalDays),
      EARNED: await this.limit(LIMITS.leaveEarnedDays),
    } as Record<StaffLeaveType, number>;
  }

  private staffRows(db: Db) {
    return db
      .selectFrom('staff_leaves as l')
      .innerJoin('member_profiles as m', 'm.id', 'l.profile_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('platform_accounts as ca', 'ca.public_id', 'l.coordinator_by')
      .leftJoin('member_profiles as fp', 'fp.id', 'l.final_by_profile_id')
      .selectAll('l')
      .select([
        'm.public_id as profile_public_id',
        'm.first_name',
        'm.last_name',
        'ut.name as user_type',
        'ca.first_name as coordinator_first',
        'ca.last_name as coordinator_last',
        'fp.first_name as final_first',
        'fp.last_name as final_last',
      ]);
  }

  private staffView(
    l: Awaited<ReturnType<ReturnType<LeaveService['staffRows']>['execute']>>[number],
  ) {
    const from = ymd(l.from_date);
    const to = ymd(l.to_date);
    return {
      id: binToUuid(l.public_id),
      reference: ref('TL', l.id),
      staff: {
        id: binToUuid(l.profile_public_id),
        name: nameOf(l.first_name, l.last_name),
        type: l.user_type,
      },
      type: l.leave_type,
      typeLabel: `${TYPE_LABEL[l.leave_type]} leave`,
      from,
      to,
      dates: range(from, to),
      days: l.days,
      reason: l.reason,
      appliedAt: iso(l.created_at),
      needsCoordinator: !!Number(l.needs_coordinator),
      coordinator: l.coordinator_status
        ? {
            status: l.coordinator_status,
            by: nameOf(l.coordinator_first, l.coordinator_last) || null,
            at: iso(l.coordinator_at),
            remarks: l.coordinator_remarks,
          }
        : null,
      final: l.final_status
        ? {
            status: l.final_status,
            by: nameOf(l.final_first, l.final_last) || null,
            at: iso(l.final_at),
            remarks: l.final_remarks,
          }
        : null,
      state: staffState(l),
      version: l.row_version,
    };
  }

  private async balances(db: Db, institutionId: string, profileRowId: string, yearId: string) {
    const totals = await this.totals();
    const rows = await db
      .selectFrom('staff_leaves')
      .select([
        'leave_type',
        sql<number>`SUM(CASE WHEN final_status = 'APPROVED' THEN days ELSE 0 END)`.as('used'),
        sql<number>`SUM(CASE WHEN final_status IS NULL AND (coordinator_status IS NULL OR coordinator_status = 'APPROVED') THEN days ELSE 0 END)`.as(
          'pending',
        ),
      ])
      .where('institution_id', '=', institutionId)
      .where('profile_id', '=', profileRowId)
      .where('year_id', '=', yearId)
      .groupBy('leave_type')
      .execute();
    return (['CASUAL', 'MEDICAL', 'EARNED'] as const).map((t) => {
      const r = rows.find((x) => x.leave_type === t);
      const used = Number(r?.used ?? 0);
      const pending = Number(r?.pending ?? 0);
      return {
        type: t,
        label: `${TYPE_LABEL[t]} leave`,
        total: totals[t],
        used,
        pending,
        left: Math.max(0, totals[t] - used),
      };
    });
  }

  /** ACA-057: my requests this year and my balances. */
  async staffMine(p: Principal, f: { yearId?: string | undefined }) {
    const me = await this.staffOf(p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const rows = await this.staffRows(this.deps.db)
      .where('l.institution_id', '=', me.institutionId)
      .where('l.profile_id', '=', me.rowId)
      .where('l.year_id', '=', year.id)
      .orderBy('l.created_at', 'desc')
      .execute();
    return {
      year: yearView(year),
      reviewedBy: me.category === 'TEACHER' ? 'COORDINATOR_THEN_PRINCIPAL' : 'PRINCIPAL',
      balances: await this.balances(this.deps.db, me.institutionId, me.rowId, year.id),
      items: rows.map((l) => this.staffView(l)),
    };
  }

  private async principalsOf(db: Db, institutionId: string) {
    const rows = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select('m.account_id')
      .where('m.institution_id', '=', institutionId)
      .where('ut.category', '=', 'PRINCIPAL')
      .where('m.status', '!=', 'INACTIVE')
      .execute();
    return [
      ...new Set(
        rows
          .map((r) => r.account_id)
          .filter((a) => a !== null)
          .map(String),
      ),
    ];
  }

  /** The coordinators of the classes a teacher teaches in the year (their accounts). */
  private async coordinatorsOf(db: Db, teacherRowId: string, yearId: string) {
    const rows = await db
      .selectFrom('teacher_assignments as mine')
      .innerJoin('sections as s', 's.id', 'mine.section_id')
      .innerJoin('teacher_assignments as co', (j) =>
        j.onRef('co.class_id', '=', 's.class_id').onRef('co.year_id', '=', 'mine.year_id'),
      )
      .innerJoin('member_profiles as m', 'm.id', 'co.teacher_profile_id')
      .select('m.account_id')
      .where('mine.teacher_profile_id', '=', teacherRowId)
      .where('mine.year_id', '=', yearId)
      .where('mine.ended_at', 'is', null)
      .where('co.kind', '=', 'COORDINATOR')
      .where('co.ended_at', 'is', null)
      .execute();
    return [
      ...new Set(
        rows
          .map((r) => r.account_id)
          .filter((a) => a !== null)
          .map(String),
      ),
    ];
  }

  /** ACA-058: apply; a teacher's request goes to the coordinator, other staff to the principal. */
  async applyStaff(
    p: Principal,
    input: { type: StaffLeaveType; from: string; to: string; reason: string },
  ) {
    const me = await this.staffOf(p);
    this.checkDates(input.from, input.to);
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 250) {
      throw new ValidationError([
        { field: 'reason', code: 'ACA.LEAVE_REASON', params: { min: 5, max: 250 } },
      ]);
    }
    const at = this.now();
    const pub = newPublicIdPair();
    const needsCoordinator = me.category === 'TEACHER';
    await this.deps.db.transaction().execute(async (trx) => {
      const year = await yearFor(trx, me.institutionId, undefined);
      assertOpen(year);
      assertInYear(year, input.from, 'from');
      assertInYear(year, input.to, 'to');
      const days = await this.schoolDays(trx, me.institutionId, year.id, input.from, input.to);
      if (!days) throw new ValidationError([{ field: 'from', code: 'ACA.NON_SCHOOL_DAYS' }]);
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', me.rowId)
        .forUpdate()
        .execute();
      const clash = await trx
        .selectFrom('staff_leaves')
        .select([
          'id',
          'from_date',
          'to_date',
          'needs_coordinator',
          'coordinator_status',
          'final_status',
        ])
        .where('profile_id', '=', me.rowId)
        .where((eb) => eb.or([eb('final_status', 'is', null), eb('final_status', '=', 'APPROVED')]))
        .where((eb) =>
          eb.or([eb('coordinator_status', 'is', null), eb('coordinator_status', '=', 'APPROVED')]),
        )
        .where('from_date', '<=', input.to)
        .where('to_date', '>=', input.from)
        .executeTakeFirst();
      if (clash) {
        throw new CustomAPIError(409, 'ACA.LEAVE_OVERLAP', {
          params: {
            name: 'You',
            dates: range(ymd(clash.from_date), ymd(clash.to_date)),
            ref: ref('TL', clash.id),
            status: clash.final_status === 'APPROVED' ? 'approved' : 'pending',
          },
        });
      }
      const bal = (await this.balances(trx, me.institutionId, me.rowId, year.id)).find(
        (b) => b.type === input.type,
      )!;
      const left = bal.total - bal.used - bal.pending;
      if (days > left) {
        throw new ValidationError([
          {
            field: 'to',
            code: 'ACA.LEAVE_BALANCE',
            params: { left: Math.max(0, left), type: TYPE_LABEL[input.type].toLowerCase() },
          },
        ]);
      }
      await trx
        .insertInto('staff_leaves')
        .values({
          public_id: pub.bin,
          institution_id: me.institutionId,
          year_id: year.id,
          profile_id: me.rowId,
          needs_coordinator: needsCoordinator ? 1 : 0,
          leave_type: input.type,
          from_date: input.from,
          to_date: input.to,
          days,
          reason,
          created_at: at,
        })
        .execute();
      const to = needsCoordinator
        ? await this.coordinatorsOf(trx, me.rowId, year.id)
        : await this.principalsOf(trx, me.institutionId);
      await notify(
        trx,
        {
          institutionId: me.institutionId,
          accountIds: to,
          surface: needsCoordinator ? 'CONSOLE' : 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.LEAVE_REQUESTED',
          params: { name: me.name },
          body: `${TYPE_LABEL[input.type]} leave · ${range(input.from, input.to)} · ${days} days`,
          link: needsCoordinator ? '/console/leave' : '/principal/approvals',
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'STAFF_LEAVE_REQUESTED',
        entityType: 'staff_leave',
        entityRef: pub.id,
        after: { type: input.type, from: input.from, to: input.to, days },
      });
    });
    return this.staffOne(this.deps.db, me.institutionId, pub.id);
  }

  private async staffOne(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
    const l = await this.staffRows(db)
      .where('l.public_id', '=', uuidToBin(id))
      .where('l.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!l) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
    return this.staffView(l);
  }

  /** ACA-059: cancel my request while no one has reviewed it. */
  async cancelStaff(p: Principal, id: string) {
    const me = await this.staffOf(p);
    const l = await this.staffOne(this.deps.db, me.institutionId, id);
    const own = await this.deps.db
      .selectFrom('member_profiles')
      .select('public_id')
      .where('id', '=', me.rowId)
      .executeTakeFirstOrThrow();
    if (l.staff.id !== binToUuid(own.public_id))
      throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
    const r = await this.deps.db
      .updateTable('staff_leaves')
      .set({
        final_status: 'CANCELLED',
        final_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('public_id', '=', uuidToBin(id))
      .where('final_status', 'is', null)
      .where('coordinator_status', 'is', null)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'ACA.LEAVE_NOT_PENDING');
    await recordAudit(this.deps.db, {
      institutionId: me.institutionId,
      action: 'STAFF_LEAVE_CANCELLED',
      entityType: 'staff_leave',
      entityRef: id,
    });
    return this.staffOne(this.deps.db, me.institutionId, id);
  }

  /** Teachers' leave the console user reviews: all, or those of the classes they coordinate. */
  private async coordinatorScope(db: Db, p: Principal, institutionId: string, yearId: string) {
    if (!p.profileId || !isUuid(p.profileId)) return null;
    const own = await db
      .selectFrom('member_profiles')
      .select('id')
      .where('public_id', '=', uuidToBin(p.profileId))
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!own) return null;
    const classes = await db
      .selectFrom('teacher_assignments')
      .select('class_id')
      .where('teacher_profile_id', '=', String(own.id))
      .where('year_id', '=', yearId)
      .where('kind', '=', 'COORDINATOR')
      .where('ended_at', 'is', null)
      .execute();
    return classes.length ? classes.map((c) => String(c.class_id)) : null;
  }

  /** ACA-042: teacher leave for the coordinator's first review (scoped to their classes, OI-ACA-49). */
  async coordinatorList(
    p: Principal,
    f: {
      status?: 'PENDING' | 'REVIEWED' | 'all' | undefined;
      yearId?: string | undefined;
      q?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const classes = await this.coordinatorScope(this.deps.db, p, inst.id, year.id);
    let q = this.staffRows(this.deps.db)
      .where('l.institution_id', '=', inst.id)
      .where('l.year_id', '=', year.id)
      .where('l.needs_coordinator', '=', 1);
    if (classes) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('teacher_assignments as ta')
            .innerJoin('sections as s', 's.id', 'ta.section_id')
            .select('ta.id')
            .whereRef('ta.teacher_profile_id', '=', 'l.profile_id')
            .whereRef('ta.year_id', '=', 'l.year_id')
            .where('ta.ended_at', 'is', null)
            .where('s.class_id', 'in', classes),
        ),
      );
    }
    const all = (await q.orderBy('l.created_at', 'desc').limit(500).execute()).map((l) =>
      this.staffView(l),
    );
    const text = (f.q ?? '').trim().toLowerCase();
    const searched = text
      ? all.filter((l) =>
          [l.staff.name, l.typeLabel, l.reason, l.reference].some((x) =>
            x.toLowerCase().includes(text),
          ),
        )
      : all;
    const status = f.status ?? 'PENDING';
    const today = istBusinessDate(this.now());
    const week = addDays(today, 6);
    return {
      year: yearView(year),
      scoped: !!classes,
      counts: {
        pending: all.filter((l) => l.state === 'PENDING').length,
        withPrincipal: all.filter((l) => l.state === 'WITH_PRINCIPAL').length,
        awayThisWeek: new Set(
          all
            .filter(
              (l) =>
                (l.state === 'APPROVED' || l.state === 'WITH_PRINCIPAL') &&
                l.from <= week &&
                l.to >= today,
            )
            .map((l) => l.staff.id),
        ).size,
        daysRequested: all.filter((l) => l.state !== 'CANCELLED').reduce((n, l) => n + l.days, 0),
      },
      items:
        status === 'all'
          ? searched
          : status === 'PENDING'
            ? searched.filter((l) => l.state === 'PENDING')
            : searched.filter((l) => l.state !== 'PENDING'),
    };
  }

  /** The leave as the console sees it, with the balance and the periods it affects. */
  async coordinatorDetail(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    const l = await this.staffOne(this.deps.db, inst.id, id);
    const row = await this.deps.db
      .selectFrom('staff_leaves')
      .select(['profile_id', 'year_id'])
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirstOrThrow();
    const db = this.deps.db;
    const slots = await db
      .selectFrom('timetable_slots as ts')
      .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
      .innerJoin('sections as s', 's.id', 'ts.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
      .select([
        'ts.day',
        'pd.name as period',
        'pd.starts_at',
        'c.name as class_name',
        's.name as section_name',
        'sub.name as subject',
      ])
      .where('ts.teacher_profile_id', '=', String(row.profile_id))
      .where('ts.year_id', '=', String(row.year_id))
      .orderBy('pd.starts_at')
      .execute();
    // The school days of the leave (no Sundays or holidays for everyone) and the periods on each.
    const affected = [];
    for (let d = l.from; d <= l.to; d = addDays(d, 1)) {
      if (!(await this.schoolDays(db, inst.id, String(row.year_id), d, d))) continue;
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      const day = slots.filter((x) => x.day === (wd === 0 ? 7 : wd));
      if (day.length) {
        affected.push({
          date: d,
          periods: day.map((x) => ({
            period: x.period,
            section: `${x.class_name} ${x.section_name}`,
            subject: x.subject,
          })),
        });
      }
    }
    const teacher = await db
      .selectFrom('member_profiles')
      .select(['employee_no'])
      .where('id', '=', String(row.profile_id))
      .executeTakeFirstOrThrow();
    return {
      ...l,
      staff: {
        ...l.staff,
        employeeNo: teacher.employee_no,
        subjects: [...new Set(slots.map((x) => x.subject))],
      },
      balance: (await this.balances(db, inst.id, String(row.profile_id), String(row.year_id))).find(
        (b) => b.type === l.type,
      ),
      periodsAffected: affected.reduce((n, x) => n + x.periods.length, 0),
      affected,
    };
  }

  private remarksRule(
    decision: 'APPROVED' | 'REJECTED',
    remarks: string | null,
    min: number,
    max: number,
  ) {
    if (
      (decision === 'REJECTED' && (!remarks || remarks.length < min)) ||
      (remarks && remarks.length > max)
    ) {
      throw new ValidationError([
        { field: 'remarks', code: 'ACA.DECISION_REMARKS', params: { min, max } },
      ]);
    }
  }

  /** ACA-043: the coordinator recommends or rejects (feedback when rejecting); the teacher and the principal are told. */
  async coordinatorDecide(
    p: Principal,
    id: string,
    expected: number,
    input: { decision: 'APPROVED' | 'REJECTED'; remarks?: string | null | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const remarks = (input.remarks ?? '').trim() || null;
    this.remarksRule(
      input.decision,
      remarks,
      await this.limit(LIMITS.leaveDecisionRemarksMin),
      400,
    );
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
      const l = await trx
        .selectFrom('staff_leaves as l')
        .innerJoin('member_profiles as m', 'm.id', 'l.profile_id')
        .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
        .select([
          'l.id',
          'l.year_id',
          'l.profile_id',
          'l.row_version',
          'l.needs_coordinator',
          'l.coordinator_status',
          'l.final_status',
          'l.leave_type',
          'l.from_date',
          'l.to_date',
          'm.first_name',
          'm.last_name',
          'm.account_id',
          'a.public_id as account_public_id',
        ])
        .where('l.public_id', '=', uuidToBin(id))
        .where('l.institution_id', '=', inst.id)
        .forUpdate()
        .executeTakeFirst();
      if (!l || !Number(l.needs_coordinator)) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
      if (binToUuid(l.account_public_id) === p.subject) {
        throw new CustomAPIError(
          403,
          input.decision === 'APPROVED' ? 'MKR.OWN_APPROVE' : 'MKR.OWN_REJECT',
        );
      }
      if (l.row_version !== expected) throw new PreconditionFailedError();
      if (l.coordinator_status !== null || l.final_status !== null) {
        throw new CustomAPIError(409, 'ACA.LEAVE_NOT_PENDING');
      }
      const year = await trx
        .selectFrom('academic_years')
        .select('public_id')
        .where('id', '=', String(l.year_id))
        .executeTakeFirstOrThrow();
      assertOpen(await yearFor(trx, inst.id, binToUuid(year.public_id)));
      await trx
        .updateTable('staff_leaves')
        .set({
          coordinator_status: input.decision,
          coordinator_by: this.by(p),
          coordinator_at: at,
          coordinator_remarks: remarks,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', l.id)
        .execute();
      const name = nameOf(l.first_name, l.last_name);
      const dates = range(ymd(l.from_date), ymd(l.to_date));
      if (l.account_id) {
        await notify(
          trx,
          {
            institutionId: inst.id,
            accountIds: [String(l.account_id)],
            surface: 'MEMBER',
            category: 'ACCOUNT',
            titleKey: 'NTF.LEAVE_REVIEWED',
            body: `${dates} · ${input.decision === 'APPROVED' ? 'recommended · with the principal now' : 'not recommended'}${remarks ? ` · “${remarks}”` : ''}`,
            link: '/teacher/my-leave',
          },
          at,
        );
      }
      if (input.decision === 'APPROVED') {
        await notify(
          trx,
          {
            institutionId: inst.id,
            accountIds: await this.principalsOf(trx, inst.id),
            surface: 'MEMBER',
            category: 'ACCOUNT',
            titleKey: 'NTF.LEAVE_FOR_DECISION',
            params: { name },
            body: `${TYPE_LABEL[l.leave_type]} leave · ${dates} · recommended`,
            link: '/principal/approvals',
          },
          at,
        );
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: `STAFF_LEAVE_COORDINATOR_${input.decision}`,
        entityType: 'staff_leave',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.coordinatorDetail(p, id);
  }

  /** ACA-061: the principal's queue — awaiting them, with the coordinator, or decided. */
  async principalList(
    p: Principal,
    f: { status?: 'AWAITING' | 'COORDINATOR' | 'DECIDED' | undefined; yearId?: string | undefined },
  ) {
    const me = await memberOf(this.deps.db, p);
    if (me.category !== 'PRINCIPAL' && me.category !== 'MANAGEMENT') {
      throw new CustomAPIError(403, 'ACA.PRINCIPAL_ONLY');
    }
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const all = (
      await this.staffRows(this.deps.db)
        .where('l.institution_id', '=', me.institutionId)
        .where('l.year_id', '=', year.id)
        .orderBy('l.created_at', 'desc')
        .limit(500)
        .execute()
    ).map((l) => this.staffView(l));
    const awaiting = all.filter((l) => l.state === 'WITH_PRINCIPAL');
    const coordinator = all.filter((l) => l.state === 'PENDING');
    const decided = all.filter(
      (l) =>
        l.state === 'APPROVED' || l.state === 'REJECTED' || l.state === 'REJECTED_BY_COORDINATOR',
    );
    const status = f.status ?? 'AWAITING';
    const list =
      status === 'AWAITING' ? awaiting : status === 'COORDINATOR' ? coordinator : decided;
    const totals = await this.totals();
    const used = new Map<string, number>();
    for (const l of all) {
      if (l.final?.status === 'APPROVED') {
        const k = `${l.staff.id}|${l.type}`;
        used.set(k, (used.get(k) ?? 0) + l.days);
      }
    }
    return {
      year: yearView(year),
      counts: {
        awaiting: awaiting.length,
        coordinator: coordinator.length,
        decided: decided.length,
      },
      items: list.map((l) => ({
        ...l,
        balance: {
          total: totals[l.type],
          left: Math.max(0, totals[l.type] - (used.get(`${l.staff.id}|${l.type}`) ?? 0)),
        },
        alsoAway: all
          .filter(
            (x) =>
              x.id !== l.id &&
              x.staff.id !== l.staff.id &&
              (x.state === 'APPROVED' || x.state === 'WITH_PRINCIPAL') &&
              x.from <= l.to &&
              x.to >= l.from,
          )
          .map((x) => x.staff.name),
      })),
    };
  }

  /** For the tenant check before the body is read. */
  async staffLookup(p: Principal, id: string) {
    const institutionId =
      p.surface === 'console'
        ? (await institutionOf(this.deps.db, p)).id
        : (await memberOf(this.deps.db, p)).institutionId;
    await this.staffOne(this.deps.db, institutionId, id);
  }

  /** ACA-062: the principal's final decision, only after the coordinator recommended (OI-ACA-51). */
  async principalDecide(
    p: Principal,
    id: string,
    input: { decision: 'APPROVED' | 'REJECTED'; remarks?: string | null | undefined },
  ) {
    const me = await memberOf(this.deps.db, p);
    if (me.category !== 'PRINCIPAL') throw new CustomAPIError(403, 'ACA.PRINCIPAL_ONLY');
    const remarks = (input.remarks ?? '').trim() || null;
    this.remarksRule(
      input.decision,
      remarks,
      await this.limit(LIMITS.leaveDecisionRemarksMin),
      400,
    );
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
      const l = await trx
        .selectFrom('staff_leaves as l')
        .innerJoin('member_profiles as m', 'm.id', 'l.profile_id')
        .select([
          'l.id',
          'l.year_id',
          'l.profile_id',
          'l.needs_coordinator',
          'l.coordinator_status',
          'l.final_status',
          'l.leave_type',
          'l.from_date',
          'l.to_date',
          'm.first_name',
          'm.account_id',
        ])
        .where('l.public_id', '=', uuidToBin(id))
        .where('l.institution_id', '=', me.institutionId)
        .forUpdate()
        .executeTakeFirst();
      if (!l) throw new CustomAPIError(404, 'ACA.LEAVE_NOT_FOUND');
      if (String(l.profile_id) === me.rowId) {
        throw new CustomAPIError(
          403,
          input.decision === 'APPROVED' ? 'MKR.OWN_APPROVE' : 'MKR.OWN_REJECT',
        );
      }
      if (l.final_status !== null || l.coordinator_status === 'REJECTED') {
        throw new CustomAPIError(409, 'ACA.LEAVE_NOT_PENDING');
      }
      if (Number(l.needs_coordinator) && l.coordinator_status !== 'APPROVED') {
        throw new CustomAPIError(409, 'ACA.COORDINATOR_REVIEW_REQUIRED');
      }
      const year = await trx
        .selectFrom('academic_years')
        .select('public_id')
        .where('id', '=', String(l.year_id))
        .executeTakeFirstOrThrow();
      assertOpen(await yearFor(trx, me.institutionId, binToUuid(year.public_id)));
      await trx
        .updateTable('staff_leaves')
        .set({
          final_status: input.decision,
          final_by_profile_id: me.rowId,
          final_at: at,
          final_remarks: remarks,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', l.id)
        .execute();
      if (l.account_id) {
        await notify(
          trx,
          {
            institutionId: me.institutionId,
            accountIds: [String(l.account_id)],
            surface: 'MEMBER',
            category: 'ACCOUNT',
            titleKey: 'NTF.LEAVE_DECIDED',
            params: {
              decision: input.decision === 'APPROVED' ? 'approved' : 'rejected',
              name: l.first_name ?? '',
            },
            body: `${TYPE_LABEL[l.leave_type]} leave · ${range(ymd(l.from_date), ymd(l.to_date))} · by ${me.name}${remarks ? ` · “${remarks}”` : ''}`,
            link: '/teacher/my-leave',
          },
          at,
        );
      }
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: `STAFF_LEAVE_${input.decision}`,
        entityType: 'staff_leave',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.staffOne(this.deps.db, me.institutionId, id);
  }
}

/**
 * The principal's overview and people (SRS 20.20, 20.30, 6.38.7; ACA-060, ACA-064; CR-09; FR-RPT-02;
 * Student Overview and Teacher Overview, SRS 20.32, 20.33, ACA-079…082;
 * prototype m.pr.home, m.pr.people). The principal and management read; decisions stay with the
 * principal's approvals (ACA-062).
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { istBusinessDate } from '../utils/format';
import { NotFoundError } from '../utils/CustomAPIError';
import { maskIdNumber, maskPan } from '../utils/fieldEncryption';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import { activeFields, readValues } from './custom-values.service';
import { outstandingOf } from './payment-engine.service';
import type { Principal } from '../utils/principal';
import { yearFor, yearView } from './academic-year';
import type { ExamsService } from './exams.service';
import type { LeaveService } from './leave.service';
import { principalOf } from './member-roles';
import { studentTransport } from './student-transport';

const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');

export class PrincipalService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly exams: ExamsService;
      /** Staff leave balances for the Teacher Overview (client 2026-10-14). */
      readonly leave?: Pick<LeaveService, 'balancesOf'>;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** ACA-060: the day at a glance — people, approvals waiting, student leave, exams and standings. */
  async overview(p: Principal) {
    const me = await principalOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, me.institutionId, undefined);
    const today = istBusinessDate(this.now());
    const [people, staffLeave, studentLeave, onLeave, academics] = await Promise.all([
      db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .select(['ut.category', sql<number>`COUNT(*)`.as('n')])
        .where('m.institution_id', '=', me.institutionId)
        .where('m.status', '!=', 'INACTIVE')
        .where('ut.category', 'in', ['STUDENT', 'TEACHER', 'STAFF'])
        .groupBy('ut.category')
        .execute(),
      db
        .selectFrom('staff_leaves')
        .select([
          sql<number>`SUM(final_status IS NULL AND (coordinator_status = 'APPROVED' OR needs_coordinator = 0))`.as(
            'awaiting',
          ),
          sql<number>`SUM(final_status IS NULL AND coordinator_status IS NULL AND needs_coordinator = 1)`.as(
            'coordinator',
          ),
        ])
        .where('institution_id', '=', me.institutionId)
        .where('year_id', '=', year.id)
        .executeTakeFirst(),
      db
        .selectFrom('student_leaves')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('institution_id', '=', me.institutionId)
        .where('year_id', '=', year.id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst(),
      db
        .selectFrom('staff_leaves')
        .select(sql<number>`COUNT(DISTINCT profile_id)`.as('n'))
        .where('institution_id', '=', me.institutionId)
        .where('final_status', '=', 'APPROVED')
        .where('from_date', '<=', today)
        .where('to_date', '>=', today)
        .executeTakeFirst(),
      this.deps.exams.principalAcademics(p, {}),
    ]);
    const att = await db
      .selectFrom('attendance_days as d')
      .innerJoin('member_profiles as m', 'm.id', 'd.profile_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'ut.category',
        sql<number>`SUM(d.status IN ('PRESENT','LATE','HALF_DAY'))`.as('attended'),
        sql<number>`SUM(d.status = 'ABSENT')`.as('absent'),
      ])
      .where('d.institution_id', '=', me.institutionId)
      .where('d.att_date', '=', today)
      .groupBy('ut.category')
      .execute();
    const count = (c: string) => Number(people.find((x) => x.category === c)?.n ?? 0);
    const day = (cats: string[], total: number) => {
      const rows = att.filter((a) => cats.includes(a.category));
      const attended = rows.reduce((n, r) => n + Number(r.attended ?? 0), 0);
      const absent = rows.reduce((n, r) => n + Number(r.absent ?? 0), 0);
      return {
        total,
        attended,
        absent,
        notMarked: Math.max(0, total - attended - absent),
        percentage: total ? Math.round((attended * 1000) / total) / 10 : null,
      };
    };
    return {
      year: yearView(year),
      date: today,
      principal: { name: me.name },
      people: { students: count('STUDENT'), teachers: count('TEACHER'), staff: count('STAFF') },
      attendanceToday: {
        students: day(['STUDENT'], count('STUDENT')),
        teachers: day(['TEACHER'], count('TEACHER')),
        staff: day(['STAFF'], count('STAFF')),
      },
      staffOnLeaveToday: Number(onLeave?.n ?? 0),
      approvals: {
        teacherLeaveAwaitingYou: Number(staffLeave?.awaiting ?? 0),
        teacherLeaveWithCoordinator: Number(staffLeave?.coordinator ?? 0),
        studentLeavePending: Number(studentLeave?.n ?? 0),
      },
      academics: {
        sections: academics.sections.length,
        topPerformers: academics.sections.filter((s) => s.standing === 'Top Performer').length,
        needsSupport: academics.sections.filter((s) => s.standing === 'Needs Support').length,
        upcomingExams: academics.upcomingExams.length,
      },
    };
  }

  /** ACA-064: students (CR-09: name, admission number, class, section) or teachers and staff. */
  async people(
    p: Principal,
    f: {
      type?: 'STUDENTS' | 'TEACHERS' | 'STAFF' | undefined;
      sectionId?: string | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const me = await principalOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, me.institutionId, undefined);
    const type = f.type ?? 'STUDENTS';
    const text = (f.q ?? '').trim();
    if (type === 'STUDENTS') {
      let q = db
        .selectFrom('enrolments as en')
        .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
        .innerJoin('sections as s', 's.id', 'en.section_id')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .select([
          'm.id',
          'm.public_id',
          'm.first_name',
          'm.last_name',
          'm.admission_no',
          'm.status',
          'c.name as class_name',
          's.name as section_name',
        ])
        .where('en.institution_id', '=', me.institutionId)
        .where('en.year_id', '=', year.id);
      if (f.sectionId && isUuid(f.sectionId))
        q = q.where('s.public_id', '=', uuidToBin(f.sectionId));
      if (text) {
        q = q.where((eb) =>
          eb.or([
            eb('m.first_name', 'like', `%${text}%`),
            eb('m.last_name', 'like', `%${text}%`),
            eb('m.admission_no', 'like', `%${text}%`),
          ]),
        );
      }
      if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('m.id', '>', f.cursor);
      const rows = await q.orderBy('m.id').limit(101).execute();
      const page = rows.slice(0, 100);
      return {
        year: yearView(year),
        type,
        items: page.map((r) => ({
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          admissionNo: r.admission_no,
          class: r.class_name,
          section: r.section_name,
          status: r.status,
        })),
        nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
      };
    }
    let q = db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.status',
        'ut.name as user_type',
      ])
      .where('m.institution_id', '=', me.institutionId)
      .where('ut.category', '=', type === 'TEACHERS' ? 'TEACHER' : 'STAFF');
    if (text) {
      q = q.where((eb) =>
        eb.or([eb('m.first_name', 'like', `%${text}%`), eb('m.last_name', 'like', `%${text}%`)]),
      );
    }
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('m.id', '>', f.cursor);
    const rows = await q.orderBy('m.id').limit(101).execute();
    const page = rows.slice(0, 100);
    const assignments = page.length
      ? await db
          .selectFrom('teacher_assignments as ta')
          .innerJoin('sections as s', 's.id', 'ta.section_id')
          .innerJoin('classes as c', 'c.id', 's.class_id')
          .leftJoin('subjects as sub', 'sub.id', 'ta.subject_id')
          .select([
            'ta.teacher_profile_id',
            'ta.kind',
            'c.name as class_name',
            's.name as section_name',
            'sub.name as subject_name',
          ])
          .where('ta.year_id', '=', year.id)
          .where('ta.ended_at', 'is', null)
          .where(
            'ta.teacher_profile_id',
            'in',
            page.map((r) => String(r.id)),
          )
          .execute()
      : [];
    return {
      year: yearView(year),
      type,
      items: page.map((r) => {
        const mine = assignments.filter((a) => String(a.teacher_profile_id) === String(r.id));
        return {
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          type: r.user_type,
          status: r.status,
          classTeacherOf: mine
            .filter((a) => a.kind === 'CLASS_TEACHER')
            .map((a) => `${a.class_name} ${a.section_name}`),
          subjects: [...new Set(mine.filter((a) => a.subject_name).map((a) => a.subject_name!))],
        };
      }),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  // --- Student Overview (SRS 20.32) and Teacher Overview (20.33) — client 2026-10-14 --------------

  /**
   * ACA-079 (SRS 20.32): every student of the institution — name, member number, the class and
   * section of the year's enrolment (none when not placed), admission number, department, status and
   * the primary contact (name, relation, mobile, e-mail). The screen searches and filters it
   * (RNG-ACA-383…394); nothing is changed from it.
   */
  async studentOverview(p: Principal) {
    const me = await principalOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, me.institutionId, undefined);
    const inst = await db
      .selectFrom('institutions')
      .select('short_name')
      .where('id', '=', me.institutionId)
      .executeTakeFirstOrThrow();
    const [rows, contacts] = await Promise.all([
      db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .leftJoin('enrolments as en', (j) =>
          j.onRef('en.student_profile_id', '=', 'm.id').on('en.year_id', '=', year.id),
        )
        .leftJoin('sections as s', 's.id', 'en.section_id')
        .leftJoin('classes as c', 'c.id', 's.class_id')
        .leftJoin('departments as d', 'd.id', 'm.department_id')
        .select([
          'm.id',
          'm.public_id',
          'm.member_seq',
          'm.first_name',
          'm.last_name',
          'm.admission_no',
          'm.status',
          'c.name as class_name',
          's.name as section_name',
          'd.name as department',
        ])
        .where('m.institution_id', '=', me.institutionId)
        .where('ut.category', '=', 'STUDENT')
        .orderBy(sql`c.sort_order IS NULL`)
        .orderBy('c.sort_order')
        .orderBy('s.name')
        .orderBy('m.first_name')
        .orderBy('m.last_name')
        .limit(STUDENTS_MAX)
        .execute(),
      // The primary contact first, else the first guardian on record.
      db
        .selectFrom('guardianships as g')
        .innerJoin('member_profiles as gp', 'gp.id', 'g.guardian_profile_id')
        .leftJoin('platform_accounts as ga', 'ga.id', 'gp.account_id')
        .select([
          'g.ward_profile_id',
          'g.relation',
          'g.is_primary_contact',
          'gp.first_name',
          'gp.last_name',
          'gp.contact_mobile',
          'gp.contact_email',
          'ga.mobile as account_mobile',
          'ga.email as account_email',
        ])
        .where('g.institution_id', '=', me.institutionId)
        .orderBy('g.is_primary_contact', 'desc')
        .orderBy('g.id')
        .execute(),
    ]);
    const contactOf = new Map<string, (typeof contacts)[number]>();
    for (const c of contacts) {
      const k = String(c.ward_profile_id);
      if (!contactOf.has(k)) contactOf.set(k, c);
    }
    return {
      year: yearView(year),
      items: rows.map((r) => {
        const c = contactOf.get(String(r.id));
        return {
          id: binToUuid(r.public_id),
          memberNo: `${inst.short_name}-${String(r.member_seq).padStart(5, '0')}`,
          name: nameOf(r.first_name, r.last_name),
          class: r.class_name ?? null,
          section: r.section_name ?? null,
          admissionNo: r.admission_no,
          department: r.department ?? null,
          status: r.status,
          contact: c
            ? {
                name: nameOf(c.first_name, c.last_name),
                relation: c.relation,
                mobile: c.account_mobile ?? c.contact_mobile,
                email: c.contact_email ?? c.account_email,
              }
            : null,
        };
      }),
    };
  }

  /**
   * ACA-082 (SRS 20.32 detail; client 2026-10-14): one student in full for the principal — personal
   * details (the member record, what the admission form gave, masked identity numbers, the school's
   * own fields), family and addresses, the admission, transport and the hostel, the year's fees and
   * their status, the campus wallet, attendance and leave. Read-only.
   */
  async studentDetail(p: Principal, studentId: string) {
    const me = await principalOf(this.deps.db, p);
    const db = this.deps.db;
    if (!isUuid(studentId)) throw new NotFoundError();
    const year = await yearFor(db, me.institutionId, undefined);
    const today = istBusinessDate(this.now());
    const s = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .leftJoin('departments as d', 'd.id', 'm.department_id')
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').on('en.year_id', '=', year.id),
      )
      .leftJoin('sections as sec', 'sec.id', 'en.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.member_seq',
        'm.first_name',
        'm.last_name',
        'm.gender',
        'm.date_of_birth',
        'm.admission_no',
        'm.joined_on',
        'm.status',
        'm.status_reason',
        'm.contact_mobile',
        'm.contact_email',
        'm.account_id',
        'a.mobile as account_mobile',
        'a.email as account_email',
        'i.short_name',
        'd.name as department',
        'en.section_id',
        'en.enrolled_on',
        'c.name as class_name',
        'sec.name as section_name',
      ])
      .where('m.institution_id', '=', me.institutionId)
      .where('m.public_id', '=', uuidToBin(studentId))
      .where('ut.category', '=', 'STUDENT')
      .executeTakeFirst();
    if (!s) throw new NotFoundError();
    const rowId = String(s.id);

    const [
      guardians,
      app,
      classTeacher,
      fields,
      transport,
      records,
      consent,
      financing,
      wallet,
      attendance,
      leave,
    ] = await Promise.all([
      db
        .selectFrom('guardianships as g')
        .innerJoin('member_profiles as gp', 'gp.id', 'g.guardian_profile_id')
        .leftJoin('platform_accounts as ga', 'ga.id', 'gp.account_id')
        .select([
          'g.relation',
          'g.is_primary_contact',
          'gp.first_name',
          'gp.last_name',
          'gp.status',
          'gp.contact_mobile',
          'gp.contact_email',
          'ga.mobile as account_mobile',
          'ga.email as account_email',
        ])
        .where('g.institution_id', '=', me.institutionId)
        .where('g.ward_profile_id', '=', rowId)
        .orderBy('g.is_primary_contact', 'desc')
        .orderBy('g.id')
        .execute(),
      // The approved application that made them a member: what the family gave on the form.
      db
        .selectFrom('admission_applications')
        .select([
          'id',
          'application_no',
          'mid_term',
          'joining_date',
          'decided_at',
          'student_aadhaar_last4',
          'student_pan_last4',
          'data',
        ])
        .where('institution_id', '=', me.institutionId)
        .where('member_profile_id', '=', rowId)
        .where('status', '=', 'APPROVED')
        .orderBy('id', 'desc')
        .executeTakeFirst(),
      s.section_id
        ? db
            .selectFrom('teacher_assignments as ta')
            .innerJoin('member_profiles as t', 't.id', 'ta.teacher_profile_id')
            .select(['t.first_name', 't.last_name'])
            .where('ta.section_id', '=', String(s.section_id))
            .where('ta.year_id', '=', year.id)
            .where('ta.kind', '=', 'CLASS_TEACHER')
            .where('ta.ended_at', 'is', null)
            .executeTakeFirst()
        : Promise.resolve(undefined),
      activeFields(db, me.institutionId, 'MEMBER'),
      studentTransport(db, { profileRowId: rowId, yearId: String(year.id), today }),
      db
        .selectFrom('fee_records as r')
        .leftJoin('fee_structure_versions as v', 'v.id', 'r.version_id')
        .leftJoin('fee_structures as fs', 'fs.id', 'v.structure_id')
        .select([
          'r.id',
          'r.label',
          'r.due_date',
          'r.amount_paise',
          'r.paid_paise',
          'r.late_fine_paise',
          'r.fine_applied',
          'r.status',
          'r.paid_at',
          'r.paid_reference',
          'r.financed',
          'fs.name as structure_name',
        ])
        .where('r.institution_id', '=', me.institutionId)
        .where('r.student_profile_id', '=', rowId)
        .where('r.year_id', '=', year.id)
        .where('r.status', '<>', 'CANCELLED')
        .orderBy('r.due_date')
        .orderBy('r.instalment_seq')
        .execute(),
      db
        .selectFrom('fee_consents')
        .select(['valid_until', 'agreed_at'])
        .where('institution_id', '=', me.institutionId)
        .where('student_profile_id', '=', rowId)
        .orderBy('valid_until', 'desc')
        .executeTakeFirst(),
      db
        .selectFrom('fee_financing_registrations')
        .select(['status', 'partner_name'])
        .where('institution_id', '=', me.institutionId)
        .where('student_profile_id', '=', rowId)
        .orderBy('id', 'desc')
        .executeTakeFirst(),
      db
        .selectFrom('wallets as w')
        .leftJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
        .select(['w.wallet_no', 'w.status', 'b.available_paise'])
        .where('w.owner_profile_id', '=', rowId)
        .where('w.kind', '=', 'CAMPUS')
        .executeTakeFirst(),
      db
        .selectFrom('attendance_days')
        .select([
          sql<number>`COUNT(*)`.as('days'),
          sql<number>`SUM(status = 'PRESENT')`.as('present'),
          sql<number>`SUM(status = 'LATE')`.as('late'),
          sql<number>`SUM(status = 'HALF_DAY')`.as('half_day'),
          sql<number>`SUM(status = 'ABSENT')`.as('absent'),
        ])
        .where('institution_id', '=', me.institutionId)
        .where('profile_id', '=', rowId)
        .where('year_id', '=', year.id)
        .executeTakeFirst(),
      db
        .selectFrom('student_leaves')
        .select([
          sql<number>`SUM(status = 'PENDING')`.as('pending'),
          sql<number>`SUM(status = 'APPROVED')`.as('approved'),
          sql<number>`SUM(CASE WHEN status = 'APPROVED' THEN school_days ELSE 0 END)`.as('days'),
        ])
        .where('institution_id', '=', me.institutionId)
        .where('student_profile_id', '=', rowId)
        .where('year_id', '=', year.id)
        .executeTakeFirst(),
    ]);

    const [custom, appFees, heads, receipts] = await Promise.all([
      readValues(db, me.institutionId, fields, [s.public_id]),
      app
        ? db
            .selectFrom('admission_payments')
            .select(['fee_type', 'amount_paise', 'status', 'receipt_no', 'paid_at', 'confirmed_at'])
            .where('application_id', '=', String(app.id))
            .orderBy('fee_type')
            .execute()
        : Promise.resolve([]),
      records.length
        ? db
            .selectFrom('fee_record_heads')
            .select(['name', sql<string>`SUM(amount_paise)`.as('total')])
            .where(
              'record_id',
              'in',
              records.map((r) => String(r.id)),
            )
            .groupBy('name')
            .orderBy(sql`SUM(amount_paise)`, 'desc')
            .execute()
        : Promise.resolve([]),
      records.length
        ? db
            .selectFrom('fee_collections as fc')
            .innerJoin('payment_attempts as pa', 'pa.id', 'fc.payment_attempt_id')
            .select(['fc.record_id', 'pa.reference'])
            .where(
              'fc.record_id',
              'in',
              records.map((r) => String(r.id)),
            )
            .execute()
        : Promise.resolve([]),
    ]);

    const data = parseJson(app?.data) as AppData;
    const ymd = (d: Date | string | null | undefined) =>
      d ? (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d)) : null;
    const isoOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
    const money = (paise: number) => toMoneyDto(paise);
    const outstanding = (r: (typeof records)[number]) => Math.max(0, outstandingOf(r));
    const receiptOf = new Map(receipts.map((x) => [String(x.record_id), x.reference]));
    const annual = records.reduce((a, r) => a + Number(r.amount_paise), 0);
    const paid = records.reduce((a, r) => a + Number(r.paid_paise), 0);
    const due = records.reduce((a, r) => a + outstanding(r), 0);
    const feeRows = records.map((r) => ({
      label: r.label,
      dueDate: ymd(r.due_date)!,
      amount: money(Number(r.amount_paise)),
      fine: money(Number(r.fine_applied) ? Number(r.late_fine_paise) : 0),
      paid: money(Number(r.paid_paise)),
      amountDue: money(outstanding(r)),
      status: r.status,
      financed: !!Number(r.financed),
      paidAt: isoOf(r.paid_at),
      receipt: receiptOf.get(String(r.id)) ?? r.paid_reference ?? null,
    }));
    const person = (x: AppPerson | null | undefined) =>
      x?.name
        ? {
            name: x.name,
            mobile: x.mobile ?? null,
            email: x.email ?? null,
            occupation: x.occupation ?? null,
            // The father's and the mother's, in rupees (client 2026-10-14).
            annualIncome: x.annualIncome ?? null,
          }
        : null;
    const att = {
      days: Number(attendance?.days ?? 0),
      present: Number(attendance?.present ?? 0),
      late: Number(attendance?.late ?? 0),
      halfDay: Number(attendance?.half_day ?? 0),
      absent: Number(attendance?.absent ?? 0),
    };
    const attended = att.present + att.late + att.halfDay;
    return {
      year: yearView(year),
      student: {
        id: binToUuid(s.public_id),
        memberNo: `${s.short_name}-${String(s.member_seq).padStart(5, '0')}`,
        name: nameOf(s.first_name, s.last_name),
        firstName: s.first_name,
        lastName: s.last_name,
        gender: s.gender,
        dateOfBirth: ymd(s.date_of_birth),
        admissionNo: s.admission_no,
        joinedOn: ymd(s.joined_on),
        department: s.department ?? null,
        status: s.status,
        statusReason: s.status_reason,
        class: s.class_name ?? null,
        section: s.section_name ?? null,
        enrolledOn: ymd(s.enrolled_on),
        classTeacher: classTeacher ? nameOf(classTeacher.first_name, classTeacher.last_name) : null,
        mobile: s.account_mobile ?? s.contact_mobile,
        email: s.contact_email ?? s.account_email,
        ringPeAccount: s.account_id !== null,
        // From the admission form, when there is one.
        bloodGroup: data.student?.bloodGroup ?? null,
        category: data.student?.category ?? null,
        medium: data.student?.medium ?? null,
        allergies: data.student?.allergies ?? null,
        health: data.student?.health ?? null,
        aadhaar: maskIdNumber('AADHAAR', app?.student_aadhaar_last4),
        pan: maskPan(app?.student_pan_last4),
        customFields: fields
          .map((f) => ({
            label: f.label,
            value: custom.get(Buffer.from(s.public_id).toString('hex'))?.[f.id] ?? null,
          }))
          .filter((x) => x.value !== null && x.value !== ''),
      },
      family: {
        guardians: guardians.map((g) => ({
          name: nameOf(g.first_name, g.last_name),
          relation: g.relation,
          mobile: g.account_mobile ?? g.contact_mobile,
          email: g.contact_email ?? g.account_email,
          primary: !!Number(g.is_primary_contact),
          status: g.status,
        })),
        father: person(data.parents?.father),
        mother: person(data.parents?.mother),
        guardian: data.parents?.guardian?.name
          ? { ...person(data.parents.guardian)!, relation: data.parents.guardian.relation ?? null }
          : null,
        children: data.parents?.children ?? null,
      },
      addresses: data.addresses
        ? {
            residential: data.addresses.residential ?? null,
            correspondence: data.addresses.sameAsResidential
              ? null
              : (data.addresses.correspondence ?? null),
            sameAsResidential: !!data.addresses.sameAsResidential,
          }
        : null,
      previousSchool: data.previous?.school
        ? {
            school: data.previous.school,
            lastClass: data.previous.lastClass ?? null,
            result: data.previous.result ?? null,
            board: data.previous.board ?? null,
          }
        : null,
      admission: app
        ? {
            applicationNo: app.application_no,
            admittedOn: ymd(app.decided_at),
            midTerm: !!Number(app.mid_term),
            joiningDate: ymd(app.joining_date),
            fees: appFees.map((x) => ({
              feeType: x.fee_type,
              amount: money(Number(x.amount_paise)),
              status: x.confirmed_at ? 'CONFIRMED' : x.status,
              receiptNo: x.receipt_no,
              paidAt: isoOf(x.paid_at),
            })),
          }
        : null,
      transport: {
        // What the family chose on the admission form, if anything.
        choice:
          typeof data.parents?.transport === 'boolean'
            ? { opted: data.parents.transport, stop: data.parents.transportStop?.name ?? null }
            : null,
        allocation: transport.allocation,
        trips: transport.trips,
      },
      hostel: {
        opted: !!data.parents?.hostel,
        localGuardian:
          data.parents?.hostel && data.parents.localGuardian?.name
            ? {
                name: data.parents.localGuardian.name,
                relation: data.parents.localGuardian.relation ?? null,
                mobile: data.parents.localGuardian.mobile ?? null,
                address: data.parents.localGuardian.address ?? null,
              }
            : null,
      },
      fees: {
        structure: records.find((r) => r.structure_name)?.structure_name ?? null,
        summary: {
          annual: money(annual),
          paid: money(paid),
          outstanding: money(due),
          paidPercent: annual ? Math.min(100, Math.round((100 * paid) / annual)) : 0,
          overdue: records.filter((r) => r.status === 'OVERDUE').length,
        },
        // The first not fully paid.
        next: feeRows.find((r) => ['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(r.status)) ?? null,
        heads: heads.map((h) => ({ name: h.name, amount: money(Number(h.total)) })),
        records: feeRows,
        consent: consent
          ? {
              valid: new Date(consent.valid_until).getTime() > this.now().getTime(),
              validUntil: isoOf(consent.valid_until),
              agreedAt: isoOf(consent.agreed_at),
            }
          : null,
        financing: financing
          ? { status: financing.status, partnerName: financing.partner_name }
          : null,
      },
      wallet: wallet
        ? {
            number: wallet.wallet_no,
            status: wallet.status,
            balance: money(Number(wallet.available_paise ?? 0)),
          }
        : null,
      attendance: {
        ...att,
        percentage: att.days ? Math.round((attended * 1000) / att.days) / 10 : null,
      },
      leave: {
        pending: Number(leave?.pending ?? 0),
        approved: Number(leave?.approved ?? 0),
        days: Number(leave?.days ?? 0),
      },
    };
  }

  /**
   * ACA-080 (SRS 20.33): the teachers of the year's class-teacher and subject-teacher mapping, each
   * once (class teachers first), with the class-section of their first assignment, their roles and
   * how many assignments they hold (RNG-ACA-395…405); and the classes, for the filter.
   */
  async teacherOverview(p: Principal) {
    const me = await principalOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, me.institutionId, undefined);
    const [rows, classes] = await Promise.all([
      this.mapping(me.institutionId, year.id),
      db
        .selectFrom('classes')
        .select(['public_id', 'name'])
        .where('institution_id', '=', me.institutionId)
        .orderBy('sort_order')
        .orderBy('name')
        .execute(),
    ]);
    const teachers = new Map<
      string,
      {
        id: string;
        name: string;
        primaryClass: { class: string; section: string | null } | null;
        roles: Set<'CLASS_TEACHER' | 'SUBJECT_TEACHER'>;
        assignments: number;
        classIds: Set<string>;
      }
    >();
    for (const r of rows) {
      const k = String(r.teacher_profile_id);
      let t = teachers.get(k);
      if (!t) {
        t = {
          id: binToUuid(r.teacher_public_id),
          name: nameOf(r.first_name, r.last_name),
          primaryClass: { class: r.class_name, section: r.section_name },
          roles: new Set(),
          assignments: 0,
          classIds: new Set(),
        };
        teachers.set(k, t);
      }
      t.roles.add(r.kind as 'CLASS_TEACHER' | 'SUBJECT_TEACHER');
      t.assignments++;
      t.classIds.add(binToUuid(r.class_public_id));
    }
    return {
      year: yearView(year),
      classes: classes.map((c) => ({ id: binToUuid(c.public_id), name: c.name })),
      items: [...teachers.values()].map((t) => ({
        id: t.id,
        name: t.name,
        primaryClass: t.primaryClass,
        roles: (['CLASS_TEACHER', 'SUBJECT_TEACHER'] as const).filter((x) => t.roles.has(x)),
        assignments: t.assignments,
        classIds: [...t.classIds],
      })),
    };
  }

  /**
   * ACA-081 (SRS 20.33): one teacher — e-mail, mobile, how many classes, sections and subjects, and
   * their academic assignments of the year (none is not an error: RNG-ACA-403). With the rest the
   * principal may want (client 2026-10-14): personal details, console roles, the classes they lead or
   * coordinate, the week's timetable, today and the year's attendance, leave and its balances,
   * homework, exams and marks entry, transport and the campus wallet. Read-only.
   */
  async teacherDetail(p: Principal, teacherId: string) {
    const me = await principalOf(this.deps.db, p);
    const db = this.deps.db;
    if (!isUuid(teacherId)) throw new NotFoundError();
    const year = await yearFor(db, me.institutionId, undefined);
    const today = istBusinessDate(this.now());
    const t = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .leftJoin('departments as d', 'd.id', 'm.department_id')
      .select([
        'm.id',
        'm.public_id',
        'm.member_seq',
        'm.first_name',
        'm.last_name',
        'm.gender',
        'm.date_of_birth',
        'm.joined_on',
        'm.status',
        'm.status_reason',
        'm.employee_no',
        'm.contact_mobile',
        'm.contact_email',
        'm.account_id',
        'a.mobile as account_mobile',
        'a.email as account_email',
        'ut.name as user_type',
        'i.short_name',
        'd.name as department',
      ])
      .where('m.institution_id', '=', me.institutionId)
      .where('m.public_id', '=', uuidToBin(teacherId))
      .executeTakeFirst();
    if (!t) throw new NotFoundError();
    const rowId = String(t.id);
    const [
      rows,
      fields,
      consoleRoles,
      led,
      coordinated,
      slots,
      todayRow,
      attendance,
      leaves,
      balances,
      homework,
      exams,
      allocation,
      wallet,
    ] = await Promise.all([
      this.mapping(me.institutionId, year.id, rowId),
      activeFields(db, me.institutionId, 'MEMBER'),
      db
        .selectFrom('profile_roles as pr')
        .innerJoin('roles as r', 'r.id', 'pr.role_id')
        .select('r.name')
        .where('pr.profile_id', '=', rowId)
        .execute(),
      // The class-sections they lead, with how many students.
      db
        .selectFrom('teacher_assignments as ta')
        .innerJoin('sections as s', 's.id', 'ta.section_id')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .select([
          'c.name as class_name',
          's.name as section_name',
          (eb) =>
            eb
              .selectFrom('enrolments as en')
              .select(sql<number>`COUNT(*)`.as('n'))
              .whereRef('en.section_id', '=', 'ta.section_id')
              .where('en.year_id', '=', year.id)
              .as('students'),
        ])
        .where('ta.teacher_profile_id', '=', rowId)
        .where('ta.year_id', '=', year.id)
        .where('ta.kind', '=', 'CLASS_TEACHER')
        .where('ta.ended_at', 'is', null)
        .orderBy('c.sort_order')
        .execute(),
      db
        .selectFrom('teacher_assignments as ta')
        .innerJoin('classes as c', 'c.id', 'ta.class_id')
        .select('c.name')
        .where('ta.teacher_profile_id', '=', rowId)
        .where('ta.year_id', '=', year.id)
        .where('ta.kind', '=', 'COORDINATOR')
        .where('ta.ended_at', 'is', null)
        .orderBy('c.sort_order')
        .execute(),
      db
        .selectFrom('timetable_slots as ts')
        .innerJoin('periods as pe', 'pe.id', 'ts.period_id')
        .innerJoin('sections as s', 's.id', 'ts.section_id')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
        .select([
          'ts.day',
          'pe.name as period',
          'pe.starts_at',
          'pe.ends_at',
          'c.name as class_name',
          's.name as section_name',
          'sub.name as subject',
        ])
        .where('ts.teacher_profile_id', '=', rowId)
        .where('ts.year_id', '=', year.id)
        .orderBy('ts.day')
        .orderBy('pe.starts_at')
        .execute(),
      db
        .selectFrom('attendance_days')
        .select(['status', 'check_in_at', 'check_out_at'])
        .where('institution_id', '=', me.institutionId)
        .where('profile_id', '=', rowId)
        .where('att_date', '=', today)
        .executeTakeFirst(),
      db
        .selectFrom('attendance_days')
        .select([
          sql<number>`COUNT(*)`.as('days'),
          sql<number>`SUM(status = 'PRESENT')`.as('present'),
          sql<number>`SUM(status = 'LATE')`.as('late'),
          sql<number>`SUM(status = 'HALF_DAY')`.as('half_day'),
          sql<number>`SUM(status = 'ABSENT')`.as('absent'),
        ])
        .where('institution_id', '=', me.institutionId)
        .where('profile_id', '=', rowId)
        .where('year_id', '=', year.id)
        .executeTakeFirst(),
      db
        .selectFrom('staff_leaves')
        .select([
          'leave_type',
          'from_date',
          'to_date',
          'days',
          'coordinator_status',
          'needs_coordinator',
          'final_status',
          'created_at',
        ])
        .where('institution_id', '=', me.institutionId)
        .where('profile_id', '=', rowId)
        .where('year_id', '=', year.id)
        .orderBy('from_date', 'desc')
        .limit(10)
        .execute(),
      this.deps.leave
        ? this.deps.leave.balancesOf(me.institutionId, rowId, year.id)
        : Promise.resolve([]),
      db
        .selectFrom('homework as h')
        .select([
          sql<number>`COUNT(*)`.as('set'),
          sql<number>`SUM(h.due_at >= ${this.now()})`.as('open'),
          (eb) =>
            eb
              .selectFrom('homework_submissions as hs')
              .innerJoin('homework as h2', 'h2.id', 'hs.homework_id')
              .select(sql<number>`COUNT(*)`.as('n'))
              .where('h2.teacher_profile_id', '=', rowId)
              .where('h2.year_id', '=', year.id)
              .where('hs.status', '=', 'SUBMITTED')
              .as('to_review'),
        ])
        .where('h.institution_id', '=', me.institutionId)
        .where('h.teacher_profile_id', '=', rowId)
        .where('h.year_id', '=', year.id)
        .executeTakeFirst(),
      // The exams of the subjects they teach, with how many marks are in.
      db
        .selectFrom('exams as e')
        .innerJoin('teacher_assignments as ta', (j) =>
          j
            .onRef('ta.section_id', '=', 'e.section_id')
            .onRef('ta.subject_id', '=', 'e.subject_id')
            .onRef('ta.year_id', '=', 'e.year_id'),
        )
        .innerJoin('exam_names as en', 'en.id', 'e.exam_name_id')
        .innerJoin('sections as s', 's.id', 'e.section_id')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .innerJoin('subjects as sub', 'sub.id', 'e.subject_id')
        .select([
          'en.name as exam',
          'c.name as class_name',
          's.name as section_name',
          'sub.name as subject',
          'e.exam_date',
          'e.published_at',
          (eb) =>
            eb
              .selectFrom('marks as mk')
              .select(sql<number>`COUNT(*)`.as('n'))
              .whereRef('mk.exam_id', '=', 'e.id')
              .as('marked'),
        ])
        .where('ta.teacher_profile_id', '=', rowId)
        .where('ta.kind', '=', 'SUBJECT_TEACHER')
        .where('ta.ended_at', 'is', null)
        .where('e.year_id', '=', year.id)
        .where('e.withdrawn_at', 'is', null)
        .orderBy('e.exam_date')
        .execute(),
      db
        .selectFrom('transport_allocations as al')
        .innerJoin('transport_routes as r', 'r.id', 'al.route_id')
        .innerJoin('transport_stops as st', 'st.id', 'al.stop_id')
        .leftJoin('transport_route_stops as rs', (j) =>
          j.onRef('rs.route_id', '=', 'al.route_id').onRef('rs.stop_id', '=', 'al.stop_id'),
        )
        .select(['r.code', 'r.name', 'st.name as stop', 'rs.arrival', 'rs.departure'])
        .where('al.profile_id', '=', rowId)
        .where('al.year_id', '=', year.id)
        .where('al.active', '=', 1)
        .where('al.effective_to', '>=', today)
        .executeTakeFirst(),
      db
        .selectFrom('wallets as w')
        .leftJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
        .select(['w.status', 'b.available_paise'])
        .where('w.owner_profile_id', '=', rowId)
        .where('w.kind', '=', 'CAMPUS')
        .executeTakeFirst(),
    ]);
    const custom = await readValues(db, me.institutionId, fields, [t.public_id]);
    const distinct = (xs: (string | null)[]) => new Set(xs.filter(Boolean)).size;
    const ymd = (d: Date | string | null | undefined) =>
      d ? (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d)) : null;
    const isoOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
    const hhmm = (v: string | null | undefined) => (v ? String(v).slice(0, 5) : null);
    const att = {
      days: Number(attendance?.days ?? 0),
      present: Number(attendance?.present ?? 0),
      late: Number(attendance?.late ?? 0),
      halfDay: Number(attendance?.half_day ?? 0),
      absent: Number(attendance?.absent ?? 0),
    };
    const attended = att.present + att.late + att.halfDay;
    const leaveState = (l: (typeof leaves)[number]) =>
      l.final_status ??
      (l.coordinator_status === 'REJECTED'
        ? 'REJECTED'
        : Number(l.needs_coordinator) && !l.coordinator_status
          ? 'WITH_COORDINATOR'
          : 'WITH_PRINCIPAL');
    const onLeaveToday = leaves.some(
      (l) =>
        l.final_status === 'APPROVED' && ymd(l.from_date)! <= today && ymd(l.to_date)! >= today,
    );
    const pastExams = exams.filter((e) => e.exam_date && ymd(e.exam_date)! < today);
    return {
      year: yearView(year),
      id: binToUuid(t.public_id),
      memberNo: `${t.short_name}-${String(t.member_seq).padStart(5, '0')}`,
      name: nameOf(t.first_name, t.last_name),
      employeeNo: t.employee_no,
      userType: t.user_type,
      department: t.department ?? null,
      gender: t.gender,
      dateOfBirth: ymd(t.date_of_birth),
      joinedOn: ymd(t.joined_on),
      status: t.status,
      statusReason: t.status_reason,
      email: t.contact_email ?? t.account_email,
      mobile: t.account_mobile ?? t.contact_mobile,
      ringPeAccount: t.account_id !== null,
      consoleRoles: consoleRoles.map((r) => r.name),
      customFields: fields
        .map((f) => ({
          label: f.label,
          value: custom.get(Buffer.from(t.public_id).toString('hex'))?.[f.id] ?? null,
        }))
        .filter((x) => x.value !== null && x.value !== ''),
      counts: {
        classes: distinct(rows.map((r) => String(r.class_id))),
        sections: distinct(rows.map((r) => (r.section_id ? String(r.section_id) : null))),
        subjects: distinct(rows.map((r) => (r.subject_id ? String(r.subject_id) : null))),
      },
      assignments: rows.map((r) => ({
        kind: r.kind as 'CLASS_TEACHER' | 'SUBJECT_TEACHER',
        class: r.class_name,
        section: r.section_name,
        subject: r.subject_name,
        periodsAWeek: Number(r.periods ?? 0),
      })),
      classTeacherOf: led.map((x) => ({
        class: x.class_name,
        section: x.section_name,
        students: Number(x.students ?? 0),
      })),
      coordinatorOf: coordinated.map((x) => x.name),
      // The week (Monday = 1): every lesson, and how many a week.
      timetable: {
        periodsAWeek: slots.length,
        lessons: slots.map((x) => ({
          day: x.day,
          period: x.period,
          startsAt: hhmm(x.starts_at),
          endsAt: hhmm(x.ends_at),
          class: x.class_name,
          section: x.section_name,
          subject: x.subject,
        })),
      },
      today: {
        date: today,
        status: todayRow?.status ?? null,
        checkInAt: isoOf(todayRow?.check_in_at),
        checkOutAt: isoOf(todayRow?.check_out_at),
        onLeave: onLeaveToday,
      },
      attendance: {
        ...att,
        percentage: att.days ? Math.round((attended * 1000) / att.days) / 10 : null,
      },
      leave: {
        balances: balances.map((b) => ({
          type: b.type,
          label: b.label,
          total: b.total,
          used: b.used,
          pending: b.pending,
          left: b.left,
        })),
        recent: leaves.map((l) => ({
          type: l.leave_type,
          from: ymd(l.from_date),
          to: ymd(l.to_date),
          days: l.days,
          state: leaveState(l),
          appliedAt: isoOf(l.created_at),
        })),
      },
      homework: {
        set: Number(homework?.set ?? 0),
        open: Number(homework?.open ?? 0),
        toReview: Number(homework?.to_review ?? 0),
      },
      exams: {
        total: exams.length,
        marksEntered: exams.filter((e) => Number(e.marked ?? 0) > 0).length,
        published: exams.filter((e) => e.published_at).length,
        // Held, but no marks in yet.
        marksDue: pastExams.filter((e) => !Number(e.marked ?? 0)).length,
        upcoming: exams
          .filter((e) => e.exam_date && ymd(e.exam_date)! >= today)
          .slice(0, 5)
          .map((e) => ({
            exam: e.exam,
            class: e.class_name,
            section: e.section_name,
            subject: e.subject,
            date: ymd(e.exam_date),
          })),
      },
      transport: allocation
        ? {
            route: { code: allocation.code, name: allocation.name },
            stop: allocation.stop,
            pickUp: hhmm(allocation.arrival),
            drop: hhmm(allocation.departure),
          }
        : null,
      wallet: wallet
        ? { status: wallet.status, balance: toMoneyDto(Number(wallet.available_paise ?? 0)) }
        : null,
    };
  }

  /** The year's class-teacher and subject-teacher assignments, class teachers first. */
  private mapping(institutionId: string, yearId: string, teacherRowId?: string) {
    let q = this.deps.db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
      .innerJoin('classes as c', 'c.id', 'ta.class_id')
      .leftJoin('sections as s', 's.id', 'ta.section_id')
      .leftJoin('subjects as sub', 'sub.id', 'ta.subject_id')
      .select([
        'ta.kind',
        'ta.teacher_profile_id',
        'ta.class_id',
        'ta.section_id',
        'ta.subject_id',
        'm.public_id as teacher_public_id',
        'm.first_name',
        'm.last_name',
        'c.public_id as class_public_id',
        'c.name as class_name',
        's.name as section_name',
        'sub.name as subject_name',
        (eb) =>
          eb
            .selectFrom('timetable_slots as ts')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ts.teacher_profile_id', '=', 'ta.teacher_profile_id')
            .whereRef('ts.section_id', '=', 'ta.section_id')
            .whereRef('ts.subject_id', '=', 'ta.subject_id')
            .where('ts.year_id', '=', yearId)
            .as('periods'),
      ])
      .where('ta.institution_id', '=', institutionId)
      .where('ta.year_id', '=', yearId)
      .where('ta.ended_at', 'is', null)
      .where('ta.kind', 'in', ['CLASS_TEACHER', 'SUBJECT_TEACHER']);
    if (teacherRowId) q = q.where('ta.teacher_profile_id', '=', teacherRowId);
    return q
      .orderBy(sql`ta.kind = 'CLASS_TEACHER'`, 'desc')
      .orderBy('c.sort_order')
      .orderBy('s.name')
      .orderBy('sub.name')
      .orderBy('ta.id')
      .execute();
  }
}

/** The Student Overview reads every student at once (the screen filters them, RNG-ACA-385). */
const STUDENTS_MAX = 10_000;

/** What the admission form keeps (admissions.service StoredData), as far as the detail reads it. */
interface AppPerson {
  name?: string;
  mobile?: string | null;
  email?: string | null;
  occupation?: string | null;
  annualIncome?: number | null;
  relation?: string | null;
}
interface AppAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pin: string;
}
interface AppData {
  student?: {
    category?: string | null;
    medium?: string | null;
    bloodGroup?: string | null;
    allergies?: string | null;
    health?: string | null;
  };
  addresses?: {
    residential?: AppAddress;
    sameAsResidential?: boolean;
    correspondence?: AppAddress | null;
  };
  previous?: {
    school?: string | null;
    lastClass?: string | null;
    result?: string | null;
    board?: string | null;
  };
  parents?: {
    father?: AppPerson | null;
    mother?: AppPerson | null;
    guardian?: AppPerson | null;
    children?: 'SINGLE' | 'MORE' | null;
    transport?: boolean;
    transportStop?: { name: string } | null;
    hostel?: boolean;
    localGuardian?: {
      name?: string;
      relation?: string | null;
      mobile?: string | null;
      address?: string | null;
    } | null;
  };
}
const parseJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v ?? {};
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return {};
  }
};

/**
 * The principal's overview and people (SRS 20.20, 20.30, 6.38.7; ACA-060, ACA-064; CR-09; FR-RPT-02;
 * prototype m.pr.home, m.pr.people). The principal and management read; decisions stay with the
 * principal's approvals (ACA-062).
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { yearFor, yearView } from './academic-year';
import type { ExamsService } from './exams.service';
import { principalOf } from './member-roles';

const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');

export class PrincipalService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly exams: ExamsService;
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
}

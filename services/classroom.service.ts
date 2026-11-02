/**
 * The teacher's portal and the student's week (SRS 20.24, 20.25, 20.31, 6.38.1; ACA-044…047, ACA-065;
 * CR-02, CR-09; OI-ACA-35, OI-ACA-43, OI-ACA-52; prototype m.t.today, m.t.classes, m.t.class,
 * m.t.timetable, m.timetable).
 *
 * - The teacher's menu is built from their assignments in the year (CR-02): sections as class teacher
 *   (the daily register, student leave) and as subject teacher (period work); a teacher with neither
 *   sees the not-assigned state.
 * - Rosters list name, admission number, class and section (CR-09) and open only to a teacher assigned
 *   to the section.
 * - Timetables are the year's slots: the teacher's own week, a section they teach, or the student's
 *   section (for: a child on the account).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { yearFor, yearView, type Year } from './academic-year';
import { memberOf, teacherOf, type Member } from './member-roles';
import { DAYS } from './teaching.service';

type Db = Kysely<Database> | Transaction<Database>;

const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
/** 1 Monday … 7 Sunday for an IST date. */
const weekday = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

export class ClassroomService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** The teacher's live assignments in the year, by section. */
  private async roles(db: Db, me: Member, year: Year) {
    const rows = await db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('sections as s', 's.id', 'ta.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .leftJoin('subjects as sub', 'sub.id', 'ta.subject_id')
      .select([
        'ta.kind',
        's.id as section_id',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.name as class_name',
        'c.sort_order',
        'sub.public_id as subject_public_id',
        'sub.name as subject_name',
        'sub.colour as subject_colour',
        (eb) =>
          eb
            .selectFrom('enrolments as en')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('en.section_id', '=', 's.id')
            .where('en.year_id', '=', year.id)
            .as('students'),
      ])
      .where('ta.teacher_profile_id', '=', me.rowId)
      .where('ta.year_id', '=', year.id)
      .where('ta.ended_at', 'is', null)
      .where('ta.kind', 'in', ['CLASS_TEACHER', 'SUBJECT_TEACHER'])
      .orderBy('c.sort_order')
      .orderBy('s.name')
      .execute();
    const bySection = new Map<
      string,
      {
        rowId: string;
        id: string;
        label: string;
        students: number;
        classTeacher: boolean;
        subjects: { id: string; name: string; colour: string }[];
      }
    >();
    for (const r of rows) {
      const id = binToUuid(r.section_public_id);
      const s = bySection.get(id) ?? {
        rowId: String(r.section_id),
        id,
        label: `${r.class_name} ${r.section_name}`,
        students: Number(r.students ?? 0),
        classTeacher: false,
        subjects: [],
      };
      if (r.kind === 'CLASS_TEACHER') s.classTeacher = true;
      if (r.kind === 'SUBJECT_TEACHER' && r.subject_public_id) {
        s.subjects.push({
          id: binToUuid(r.subject_public_id),
          name: r.subject_name ?? '',
          colour: r.subject_colour ?? '',
        });
      }
      bySection.set(id, s);
    }
    return [...bySection.values()];
  }

  private async periods(db: Db, institutionId: string) {
    const rows = await db
      .selectFrom('periods')
      .select(['public_id', 'name', 'starts_at', 'ends_at', 'is_break'])
      .where('institution_id', '=', institutionId)
      .orderBy('starts_at')
      .execute();
    return rows.map((pd) => ({
      id: binToUuid(pd.public_id),
      name: pd.name,
      startsAt: hm(pd.starts_at),
      endsAt: hm(pd.ends_at),
      isBreak: !!Number(pd.is_break),
    }));
  }

  /** Timetable slots of the year, for a teacher or a section. */
  private async slots(
    db: Db,
    yearId: string,
    by: { teacherRowId?: string; sectionRowId?: string },
    day?: number,
  ) {
    let q = db
      .selectFrom('timetable_slots as ts')
      .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
      .innerJoin('member_profiles as m', 'm.id', 'ts.teacher_profile_id')
      .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
      .innerJoin('sections as s', 's.id', 'ts.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'ts.day',
        'pd.public_id as period_public_id',
        'pd.name as period_name',
        'pd.starts_at',
        'pd.ends_at',
        'sub.public_id as subject_public_id',
        'sub.name as subject_name',
        'sub.colour',
        'm.public_id as teacher_public_id',
        'm.first_name',
        'm.last_name',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.name as class_name',
      ])
      .where('ts.year_id', '=', yearId);
    if (by.teacherRowId) q = q.where('ts.teacher_profile_id', '=', by.teacherRowId);
    if (by.sectionRowId) q = q.where('ts.section_id', '=', by.sectionRowId);
    if (day !== undefined) q = q.where('ts.day', '=', day);
    const rows = await q.orderBy('ts.day').orderBy('pd.starts_at').execute();
    return rows.map((x) => ({
      day: x.day,
      period: {
        id: binToUuid(x.period_public_id),
        name: x.period_name,
        startsAt: hm(x.starts_at),
        endsAt: hm(x.ends_at),
      },
      subject: { id: binToUuid(x.subject_public_id), name: x.subject_name, colour: x.colour },
      teacher: { id: binToUuid(x.teacher_public_id), name: nameOf(x.first_name, x.last_name) },
      section: { id: binToUuid(x.section_public_id), label: `${x.class_name} ${x.section_name}` },
    }));
  }

  /** ACA-044: the teacher's day built from their assignments (CR-02). */
  async today(p: Principal) {
    const me = await teacherOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, me.institutionId, undefined);
    const date = istBusinessDate(this.now());
    const [sections, periods, toReview] = await Promise.all([
      this.roles(db, me, year),
      this.slots(db, year.id, { teacherRowId: me.rowId }, weekday(date)),
      db
        .selectFrom('homework_submissions as x')
        .innerJoin('homework as h', 'h.id', 'x.homework_id')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('h.teacher_profile_id', '=', me.rowId)
        .where('h.year_id', '=', year.id)
        .where('x.status', '=', 'SUBMITTED')
        .executeTakeFirst(),
    ]);
    const marked = await db
      .selectFrom('attendance_days')
      .select(['section_id', sql<number>`COUNT(*)`.as('n')])
      .where('institution_id', '=', me.institutionId)
      .where('att_date', '=', date)
      .where(
        'section_id',
        'in',
        sections
          .filter((s) => s.classTeacher)
          .map((s) => s.rowId)
          .concat(['0']),
      )
      .groupBy('section_id')
      .execute();
    const nowHm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(this.now());
    return {
      year: yearView(year),
      date,
      teacher: { name: me.name },
      assigned: sections.length > 0,
      classTeacherOf: sections
        .filter((s) => s.classTeacher)
        .map((s) => ({
          id: s.id,
          label: s.label,
          students: s.students,
          registerMarked: Number(marked.find((m) => String(m.section_id) === s.rowId)?.n ?? 0),
        })),
      subjectSections: sections
        .filter((s) => s.subjects.length)
        .map((s) => ({ id: s.id, label: s.label, subjects: s.subjects })),
      periods: periods.map((x) => ({
        ...x,
        state: x.period.endsAt! <= nowHm ? 'DONE' : x.period.startsAt! <= nowHm ? 'NOW' : 'LATER',
      })),
      homeworkToReview: Number(toReview?.n ?? 0),
    };
  }

  /** ACA-045: the sections the teacher teaches this year, with their role in each. */
  async classes(p: Principal, f: { yearId?: string | undefined }) {
    const me = await teacherOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const sections = await this.roles(this.deps.db, me, year);
    return {
      year: yearView(year),
      items: sections.map(({ rowId: _rowId, ...s }) => s),
    };
  }

  private async assignedSection(db: Db, me: Member, year: Year, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const s = await db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.id', 's.public_id', 's.name', 'c.name as class_name'])
      .where('s.public_id', '=', uuidToBin(id))
      .where('s.institution_id', '=', me.institutionId)
      .executeTakeFirst();
    if (!s) throw new NotFoundError();
    const mine = (await this.roles(db, me, year)).find((x) => x.rowId === String(s.id));
    if (!mine) throw new CustomAPIError(403, 'ACA.NOT_ASSIGNED');
    return { ...mine, className: s.class_name, sectionName: s.name };
  }

  /** ACA-046: the section's roster with the CR-09 columns. */
  async roster(p: Principal, sectionId: string, f: { yearId?: string | undefined }) {
    const me = await teacherOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const s = await this.assignedSection(this.deps.db, me, year, sectionId);
    const rows = await this.deps.db
      .selectFrom('enrolments as en')
      .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
      .leftJoin('attendance_days as d', (j) =>
        j.onRef('d.profile_id', '=', 'm.id').on('d.att_date', '=', istBusinessDate(this.now())),
      )
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'm.gender',
        'd.status',
      ])
      .where('en.year_id', '=', year.id)
      .where('en.section_id', '=', s.rowId)
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    return {
      year: yearView(year),
      section: { id: s.id, label: s.label, classTeacher: s.classTeacher, subjects: s.subjects },
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        name: nameOf(r.first_name, r.last_name),
        admissionNo: r.admission_no,
        class: s.className,
        section: s.sectionName,
        gender: r.gender,
        attendanceToday: r.status ?? null,
      })),
    };
  }

  /** ACA-047: the teacher's own week and, when asked, a section they teach. */
  async teacherTimetable(
    p: Principal,
    f: { yearId?: string | undefined; sectionId?: string | undefined },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, me.institutionId, f.yearId);
    const section = f.sectionId ? await this.assignedSection(db, me, year, f.sectionId) : null;
    const [periods, mine, sectionSlots] = await Promise.all([
      this.periods(db, me.institutionId),
      this.slots(db, year.id, { teacherRowId: me.rowId }),
      section ? this.slots(db, year.id, { sectionRowId: section.rowId }) : Promise.resolve(null),
    ]);
    return {
      year: yearView(year),
      days: DAYS,
      periods,
      mine,
      section: section ? { id: section.id, label: section.label, slots: sectionSlots } : null,
      today: weekday(istBusinessDate(this.now())),
    };
  }

  /** ACA-065: the student's week (for: a child on the account). */
  async myTimetable(p: Principal, f: { for?: string | undefined; yearId?: string | undefined }) {
    const me = await memberOf(this.deps.db, p, f.for);
    if (me.category !== 'STUDENT') throw new CustomAPIError(403, 'ACA.NOT_A_STUDENT_PROFILE');
    const db = this.deps.db;
    const year = await yearFor(db, me.institutionId, f.yearId);
    const en = await db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['en.section_id', 's.public_id', 's.name', 'c.name as class_name'])
      .where('en.student_profile_id', '=', me.rowId)
      .where('en.year_id', '=', year.id)
      .executeTakeFirst();
    const periods = await this.periods(db, me.institutionId);
    return {
      year: yearView(year),
      student: { name: me.name },
      section: en ? { id: binToUuid(en.public_id), label: `${en.class_name} ${en.name}` } : null,
      days: DAYS,
      periods,
      slots: en ? await this.slots(db, year.id, { sectionRowId: String(en.section_id) }) : [],
      today: weekday(istBusinessDate(this.now())),
    };
  }
}

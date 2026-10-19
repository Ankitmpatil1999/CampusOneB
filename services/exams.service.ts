/**
 * Exams and marks (SRS 20.11, 20.17–20.22; ACA-034…041, ACA-052…054, ACA-063, ACA-070/071; CR-13
 * RNG-ACA-442/449/450; RC-37; prototype c.exams, m.t.marks, m.exams, m.results, m.pr.academics).
 *
 * - Exam names are an institution list. An exam is one subject of one section in a year, with an
 *   optional date (time) and maximum and pass marks; exams for several subjects are created together
 *   or not at all. Once marks exist an exam's marks and withdrawal are fixed.
 * - Marks: the teacher assigned to the section and subject (or its class teacher) saves the whole grid
 *   in one transaction once the exam has been held — each mark 0 to the maximum or absent, each student
 *   enrolled in the exam's section and year. Saved marks are Created; the coordinator validates them
 *   (Valid), or the teacher validates and publishes when every student has a mark. Editing a Valid
 *   mark returns it to Created (RC-37). Publication tells the students and their families.
 * - Reports are server-computed for one year (RNG-ACA-450): per subject the highest, lowest, average,
 *   passes and failures against each exam's own pass marks; the standing of a section (Top Performer,
 *   Average, Needs Support) as the register derives it.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
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
import { principalOf, studentOf, teacherOf, type Member } from './member-roles';
import { notify } from './notifications.service';

type Db = Kysely<Database> | Transaction<Database>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string | null) =>
  d === null ? null : typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d);
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ExamItemInput {
  readonly subjectId: string;
  readonly date?: string | null | undefined;
  readonly startTime?: string | null | undefined;
  readonly endTime?: string | null | undefined;
  readonly maxMarks: number;
  readonly passMarks: number;
}

export class ExamsService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private today() {
    return istBusinessDate(this.now());
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  /** Scheduled (no date), Upcoming, Today or Completed (27.2, derived). */
  private schedule(date: string | null) {
    if (!date) return 'Scheduled';
    const t = this.today();
    return date > t ? 'Upcoming' : date === t ? 'Today' : 'Completed';
  }

  // --- exam names (ACA-037 / ACA-038) ----------------------------------------------------------------------
  async names(p: Principal, f: { yearId?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const rows = await this.deps.db
      .selectFrom('exam_names as n')
      .select([
        'n.public_id',
        'n.name',
        (eb) =>
          eb
            .selectFrom('exams as e')
            .select(sql<number>`COUNT(*)`.as('c'))
            .whereRef('e.exam_name_id', '=', 'n.id')
            .where('e.year_id', '=', year.id)
            .where('e.withdrawn_at', 'is', null)
            .as('this_year'),
        (eb) =>
          eb
            .selectFrom('exams as e')
            .select(sql<number>`COUNT(*)`.as('c'))
            .whereRef('e.exam_name_id', '=', 'n.id')
            .where('e.withdrawn_at', 'is', null)
            .as('all_years'),
      ])
      .where('n.institution_id', '=', inst.id)
      .orderBy('n.name')
      .execute();
    return {
      year: yearView(year),
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        name: r.name,
        examsThisYear: Number(r.this_year ?? 0),
        examsAllYears: Number(r.all_years ?? 0),
      })),
    };
  }

  async createName(p: Principal, input: { name: string }) {
    const inst = await institutionOf(this.deps.db, p);
    const name = input.name.trim();
    if (name.length < 3 || name.length > 40) {
      throw new ValidationError([{ field: 'name', code: 'ACA.EXAM_NAME' }]);
    }
    const pub = newPublicIdPair();
    try {
      await this.deps.db
        .insertInto('exam_names')
        .values({ public_id: pub.bin, institution_id: inst.id, name, created_at: this.now() })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'ACA.EXAM_NAME_TAKEN', { params: { name } });
      }
      throw e;
    }
    return (await this.names(p, {})).items.find((x) => x.id === pub.id)!;
  }

  // --- exams (ACA-034 … ACA-036) ----------------------------------------------------------------------------
  private examRows(db: Db) {
    return db
      .selectFrom('exams as e')
      .innerJoin('exam_names as n', 'n.id', 'e.exam_name_id')
      .innerJoin('sections as s', 's.id', 'e.section_id')
      .innerJoin('classes as c', 'c.id', 'e.class_id')
      .innerJoin('subjects as sub', 'sub.id', 'e.subject_id')
      .innerJoin('academic_years as y', 'y.id', 'e.year_id')
      .selectAll('e')
      .select([
        'n.public_id as name_public_id',
        'n.name as exam_name',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.public_id as class_public_id',
        'c.name as class_name',
        'c.sort_order',
        'sub.public_id as subject_public_id',
        'sub.code as subject_code',
        'sub.name as subject_name',
        'sub.colour as subject_colour',
        'y.public_id as year_public_id',
        'y.label as year_label',
        (eb) =>
          eb
            .selectFrom('enrolments as en')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('en.year_id', '=', 'e.year_id')
            .whereRef('en.section_id', '=', 'e.section_id')
            .as('students'),
        (eb) =>
          eb
            .selectFrom('marks as m')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('m.exam_id', '=', 'e.id')
            .as('marks_count'),
        (eb) =>
          eb
            .selectFrom('marks as m')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('m.exam_id', '=', 'e.id')
            .where('m.status', '=', 'VALID')
            .as('valid_count'),
      ]);
  }

  private examView(
    e: Awaited<ReturnType<ReturnType<ExamsService['examRows']>['execute']>>[number],
  ) {
    const students = Number(e.students ?? 0);
    const marks = Number(e.marks_count ?? 0);
    const valid = Number(e.valid_count ?? 0);
    const date = ymd(e.exam_date);
    return {
      id: binToUuid(e.public_id),
      name: { id: binToUuid(e.name_public_id), name: e.exam_name },
      year: { id: binToUuid(e.year_public_id), label: e.year_label },
      class: { id: binToUuid(e.class_public_id), name: e.class_name },
      section: {
        id: binToUuid(e.section_public_id),
        name: e.section_name,
        label: `${e.class_name} ${e.section_name}`,
      },
      subject: {
        id: binToUuid(e.subject_public_id),
        code: e.subject_code,
        name: e.subject_name,
        colour: e.subject_colour,
      },
      date,
      startTime: hm(e.start_time),
      endTime: hm(e.end_time),
      maxMarks: e.max_marks,
      passMarks: e.pass_marks,
      schedule: this.schedule(date),
      marks: {
        students,
        entered: marks,
        valid,
        status:
          marks === 0
            ? 'NOT_UPLOADED'
            : valid < marks
              ? 'AWAITING_VALIDATION'
              : marks >= students
                ? 'VALIDATED'
                : 'INCOMPLETE',
      },
      published: e.published_at ? { at: iso(e.published_at) } : null,
      withdrawn: !!e.withdrawn_at,
      version: e.row_version,
    };
  }

  async list(
    p: Principal,
    f: {
      yearId?: string | undefined;
      examNameId?: string | undefined;
      sectionId?: string | undefined;
      subjectId?: string | undefined;
      withdrawn?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    let q = this.examRows(this.deps.db)
      .where('e.institution_id', '=', inst.id)
      .where('e.year_id', '=', year.id);
    if (!f.withdrawn) q = q.where('e.withdrawn_at', 'is', null);
    if (f.examNameId && isUuid(f.examNameId))
      q = q.where('n.public_id', '=', uuidToBin(f.examNameId));
    if (f.sectionId && isUuid(f.sectionId)) q = q.where('s.public_id', '=', uuidToBin(f.sectionId));
    if (f.subjectId && isUuid(f.subjectId))
      q = q.where('sub.public_id', '=', uuidToBin(f.subjectId));
    const rows = await q
      .orderBy('e.exam_date')
      .orderBy('c.sort_order')
      .orderBy('s.name')
      .orderBy('sub.name')
      .limit(2000)
      .execute();
    return { year: yearView(year), items: rows.map((e) => this.examView(e)) };
  }

  async exam(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    return this.examView(await this.examRow(this.deps.db, inst.id, id));
  }

  /** ACA-077: the exam with each enrolled student's mark and status (the console's marks table). */
  async examMarks(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    const e = await this.examRow(this.deps.db, inst.id, id);
    return { exam: this.examView(e), grid: await this.grid(this.deps.db, e) };
  }

  private async examRow(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.EXAM_NOT_FOUND');
    const e = await this.examRows(db)
      .where('e.public_id', '=', uuidToBin(id))
      .where('e.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!e) throw new CustomAPIError(404, 'ACA.EXAM_NOT_FOUND');
    return e;
  }

  private checkItem(year: Year, x: ExamItemInput, field: string) {
    if (
      !Number.isInteger(x.maxMarks) ||
      x.maxMarks < 1 ||
      x.maxMarks > 1000 ||
      !Number.isInteger(x.passMarks) ||
      x.passMarks < 0 ||
      x.passMarks > x.maxMarks
    ) {
      throw new ValidationError([{ field, code: 'ACA.EXAM_MARKS_RANGE' }]);
    }
    if (x.date) {
      if (!DAY.test(x.date))
        throw new ValidationError([{ field: `${field}.date`, code: 'VALIDATION.DATE' }]);
      assertInYear(year, x.date, `${field}.date`);
    }
    for (const t of [x.startTime, x.endTime]) {
      if (t && !TIME.test(t))
        throw new ValidationError([{ field: `${field}.startTime`, code: 'ACA.CAL_TIMES' }]);
    }
    if (x.startTime && x.endTime && x.endTime <= x.startTime) {
      throw new ValidationError([{ field: `${field}.endTime`, code: 'ACA.CAL_TIMES' }]);
    }
  }

  /** ACA-035: an exam name for sections × subjects, all created together or none. */
  async create(
    p: Principal,
    input: {
      yearId?: string | undefined;
      examNameId: string;
      sectionIds: readonly string[];
      items: readonly ExamItemInput[];
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    input.items.forEach((x, i) => this.checkItem(year, x, `items.${i}`));
    const by = this.by(p);
    const at = this.now();
    const made: string[] = [];
    await this.deps.db.transaction().execute(async (trx) => {
      if (!isUuid(input.examNameId))
        throw new ValidationError([{ field: 'examNameId', code: 'ACA.EXAM_NAME' }]);
      const name = await trx
        .selectFrom('exam_names')
        .select(['id', 'name'])
        .where('public_id', '=', uuidToBin(input.examNameId))
        .where('institution_id', '=', inst.id)
        .executeTakeFirst();
      if (!name) throw new ValidationError([{ field: 'examNameId', code: 'ACA.EXAM_NAME' }]);
      const ids = [...new Set(input.sectionIds.map((s) => s.toLowerCase()))];
      if (!ids.length || ids.some((i) => !isUuid(i))) throw new NotFoundError();
      const sections = await trx
        .selectFrom('sections as s')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .select(['s.id', 's.name', 's.class_id', 'c.name as class_name'])
        .where('s.institution_id', '=', inst.id)
        .where(
          's.public_id',
          'in',
          ids.map((i) => uuidToBin(i)),
        )
        .execute();
      if (sections.length !== ids.length) throw new NotFoundError();
      for (const [i, x] of input.items.entries()) {
        if (!isUuid(x.subjectId))
          throw new ValidationError([
            { field: `items.${i}.subjectId`, code: 'ACA.SUBJECT_NOT_FOUND' },
          ]);
        const sub = await trx
          .selectFrom('subjects')
          .select(['id', 'name'])
          .where('public_id', '=', uuidToBin(x.subjectId))
          .where('institution_id', '=', inst.id)
          .executeTakeFirst();
        if (!sub)
          throw new ValidationError([
            { field: `items.${i}.subjectId`, code: 'ACA.SUBJECT_NOT_FOUND' },
          ]);
        for (const s of sections) {
          const mapped = await trx
            .selectFrom('class_subjects')
            .select('class_id')
            .where('class_id', '=', s.class_id)
            .where('subject_id', '=', sub.id)
            .executeTakeFirst();
          if (!mapped) {
            throw new CustomAPIError(422, 'ACA.SUBJECT_NOT_MAPPED', {
              params: { subject: sub.name, class: s.class_name },
            });
          }
          const pub = newPublicIdPair();
          try {
            await trx
              .insertInto('exams')
              .values({
                public_id: pub.bin,
                institution_id: inst.id,
                year_id: year.id,
                exam_name_id: name.id,
                class_id: s.class_id,
                section_id: s.id,
                subject_id: sub.id,
                exam_date: x.date ?? null,
                start_time: x.startTime ? `${x.startTime}:00` : null,
                end_time: x.endTime ? `${x.endTime}:00` : null,
                max_marks: x.maxMarks,
                pass_marks: x.passMarks,
                created_by: by,
                created_at: at,
                updated_at: at,
              })
              .execute();
          } catch (e) {
            if ((e as { errno?: number }).errno === 1062) {
              throw new CustomAPIError(409, 'ACA.EXAM_EXISTS', {
                params: {
                  exam: name.name,
                  subject: sub.name,
                  section: `${s.class_name} ${s.name}`,
                  year: year.label,
                },
              });
            }
            throw e;
          }
          made.push(pub.id);
        }
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'EXAMS_CREATED',
        entityType: 'exam',
        after: { name: name.name, year: year.label, exams: made.length },
      });
    });
    const list = await this.list(p, { yearId: year.publicId });
    return { created: made.length, items: list.items.filter((x) => made.includes(x.id)) };
  }

  /** ACA-036: change the date, time or marks, or withdraw — marks and withdrawal fixed once marks exist. */
  async update(
    p: Principal,
    id: string,
    expected: number,
    input: {
      date?: string | null | undefined;
      startTime?: string | null | undefined;
      endTime?: string | null | undefined;
      maxMarks?: number | undefined;
      passMarks?: number | undefined;
      withdraw?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    await this.deps.db.transaction().execute(async (trx) => {
      const e = await this.examRow(trx, inst.id, id);
      const year = await yearFor(trx, inst.id, binToUuid(e.year_public_id));
      assertOpen(year);
      await trx.selectFrom('exams').select('id').where('id', '=', e.id).forUpdate().execute();
      if (e.row_version !== expected) throw new PreconditionFailedError();
      if (e.withdrawn_at) throw new CustomAPIError(404, 'ACA.EXAM_NOT_FOUND');
      const hasMarks = Number(e.marks_count ?? 0) > 0;
      const max = input.maxMarks ?? e.max_marks;
      const pass = input.passMarks ?? e.pass_marks;
      if (hasMarks && (input.withdraw || max !== e.max_marks || pass !== e.pass_marks)) {
        throw new CustomAPIError(409, 'ACA.EXAM_HAS_MARKS');
      }
      const date = input.date === undefined ? ymd(e.exam_date) : input.date;
      const start = input.startTime === undefined ? hm(e.start_time) : input.startTime;
      const end = input.endTime === undefined ? hm(e.end_time) : input.endTime;
      this.checkItem(
        year,
        { subjectId: '', date, startTime: start, endTime: end, maxMarks: max, passMarks: pass },
        'exam',
      );
      await trx
        .updateTable('exams')
        .set({
          exam_date: date ?? null,
          start_time: start ? `${start}:00` : null,
          end_time: end ? `${end}:00` : null,
          max_marks: max,
          pass_marks: pass,
          ...(input.withdraw ? { withdrawn_at: this.now() } : {}),
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', e.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: input.withdraw ? 'EXAM_WITHDRAWN' : 'EXAM_CHANGED',
        entityType: 'exam',
        entityRef: id,
        after: { date, max, pass },
      });
    });
    return this.examView(await this.examRow(this.deps.db, inst.id, id));
  }

  // --- ACA-039 / ACA-040: marks status and validation ------------------------------------------------------
  async marksStatus(
    p: Principal,
    f: { yearId?: string | undefined; scope?: 'due' | 'all' | undefined },
  ) {
    const list = await this.list(p, { yearId: f.yearId });
    const today = this.today();
    const groups = new Map<string, { name: string; section: string; exams: typeof list.items }>();
    for (const e of list.items) {
      const k = `${e.name.id}|${e.section.id}`;
      const g = groups.get(k) ?? {
        name: e.name.name,
        section: e.section.label,
        exams: [] as typeof list.items,
      };
      g.exams.push(e);
      groups.set(k, g);
    }
    const rows = [...groups.entries()].map(([key, g]) => {
      const due = g.exams.filter((e) => e.date !== null && e.date <= today);
      return {
        key,
        examName: g.name,
        section: g.section,
        firstDate:
          g.exams
            .map((e) => e.date)
            .filter(Boolean)
            .sort()[0] ?? null,
        exams: g.exams.length,
        due: due.length,
        uploaded: g.exams.filter((e) => e.marks.entered > 0).length,
        validated: g.exams.filter((e) => e.marks.status === 'VALIDATED').length,
        awaiting: g.exams.filter((e) => e.marks.status === 'AWAITING_VALIDATION').length,
        incomplete: g.exams.filter((e) => e.marks.status === 'INCOMPLETE').length,
        missing: due.filter((e) => e.marks.entered === 0).length,
        examIds: g.exams.map((e) => e.id),
      };
    });
    return {
      year: list.year,
      items: (f.scope ?? 'due') === 'all' ? rows : rows.filter((r) => r.due > 0),
    };
  }

  /** ACA-040: the coordinator validates an exam's saved marks (Created → Valid). */
  async validate(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    await this.deps.db.transaction().execute(async (trx) => {
      const e = await this.examRow(trx, inst.id, id);
      assertOpen(await yearFor(trx, inst.id, binToUuid(e.year_public_id)));
      const r = await trx
        .updateTable('marks')
        .set({ status: 'VALID', validated_by: this.by(p), validated_at: this.now() })
        .where('exam_id', '=', e.id)
        .where('status', '=', 'CREATED')
        .executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new CustomAPIError(409, 'ACA.NOTHING_TO_VALIDATE');
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MARKS_VALIDATED',
        entityType: 'exam',
        entityRef: id,
        after: { marks: Number(r.numUpdatedRows) },
      });
    });
    return this.examView(await this.examRow(this.deps.db, inst.id, id));
  }

  // --- ACA-041 / ACA-063: analytics (server-computed, one year) --------------------------------------------
  private async analyse(
    institutionId: string,
    year: Year,
    f: {
      examNameId?: string | undefined;
      sectionId?: string | undefined;
      includePending?: boolean | undefined;
    },
  ) {
    let q = this.deps.db
      .selectFrom('marks as m')
      .innerJoin('exams as e', 'e.id', 'm.exam_id')
      .innerJoin('exam_names as n', 'n.id', 'e.exam_name_id')
      .innerJoin('sections as s', 's.id', 'e.section_id')
      .innerJoin('classes as c', 'c.id', 'e.class_id')
      .innerJoin('subjects as sub', 'sub.id', 'e.subject_id')
      .innerJoin('member_profiles as st', 'st.id', 'm.student_profile_id')
      .select([
        'e.id as exam_id',
        'e.max_marks',
        'e.pass_marks',
        'n.public_id as name_public_id',
        'n.name as exam_name',
        's.public_id as section_public_id',
        'c.name as class_name',
        's.name as section_name',
        'sub.public_id as subject_public_id',
        'sub.name as subject_name',
        'sub.colour',
        'm.student_profile_id',
        'm.marks',
        'm.is_absent',
        'm.status',
        'st.public_id as student_public_id',
        'st.first_name',
        'st.last_name',
        'st.admission_no',
      ])
      .where('m.institution_id', '=', institutionId)
      .where('m.year_id', '=', year.id)
      .where('e.withdrawn_at', 'is', null);
    if (f.examNameId && isUuid(f.examNameId))
      q = q.where('n.public_id', '=', uuidToBin(f.examNameId));
    if (f.sectionId && isUuid(f.sectionId)) q = q.where('s.public_id', '=', uuidToBin(f.sectionId));
    if (!f.includePending) q = q.where('m.status', '=', 'VALID');
    return q.execute();
  }

  async report(
    p: Principal,
    f: {
      yearId?: string | undefined;
      examNameId?: string | undefined;
      sectionId?: string | undefined;
      includePending?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const rows = await this.analyse(inst.id, year, f);
    const pending = f.includePending
      ? 0
      : Number(
          (
            await this.deps.db
              .selectFrom('marks')
              .select(sql<number>`COUNT(*)`.as('n'))
              .where('institution_id', '=', inst.id)
              .where('year_id', '=', year.id)
              .where('status', '=', 'CREATED')
              .executeTakeFirst()
          )?.n ?? 0,
        );
    const bySubject = new Map<string, typeof rows>();
    for (const r of rows)
      bySubject.set(binToUuid(r.subject_public_id), [
        ...(bySubject.get(binToUuid(r.subject_public_id)) ?? []),
        r,
      ]);
    const subjects = [...bySubject.values()].map((g) => {
      const present = g.filter((r) => !Number(r.is_absent));
      const pct = present.map((r) => (Number(r.marks) * 100) / r.max_marks);
      const passed = present.filter((r) => Number(r.marks) >= r.pass_marks).length;
      const top = [...present].sort(
        (a, b) => Number(b.marks) / b.max_marks - Number(a.marks) / a.max_marks,
      )[0];
      return {
        subject: {
          id: binToUuid(g[0]!.subject_public_id),
          name: g[0]!.subject_name,
          colour: g[0]!.colour,
        },
        students: g.length,
        absent: g.length - present.length,
        highest: present.length ? round1(Math.max(...pct)) : null,
        lowest: present.length ? round1(Math.min(...pct)) : null,
        average: present.length ? round1(pct.reduce((a, b) => a + b, 0) / present.length) : null,
        passed,
        failed: present.length - passed,
        passRate: present.length ? round1((passed * 100) / present.length) : null,
        top: top
          ? { id: binToUuid(top.student_public_id), name: nameOf(top.first_name, top.last_name) }
          : null,
      };
    });
    const totals = new Map<
      string,
      {
        id: string;
        name: string;
        admissionNo: string | null;
        got: number;
        max: number;
        fails: number;
      }
    >();
    for (const r of rows) {
      if (Number(r.is_absent)) continue;
      const id = binToUuid(r.student_public_id);
      const t = totals.get(id) ?? {
        id,
        name: nameOf(r.first_name, r.last_name),
        admissionNo: r.admission_no,
        got: 0,
        max: 0,
        fails: 0,
      };
      t.got += Number(r.marks);
      t.max += r.max_marks;
      if (Number(r.marks) < r.pass_marks) t.fails++;
      totals.set(id, t);
    }
    const students = [...totals.values()].sort((a, b) => b.got / b.max - a.got / a.max);
    return {
      year: yearView(year),
      includesPending: !!f.includePending,
      pendingMarks: pending,
      classAverage: students.length
        ? round1(students.reduce((a, s) => a + (s.got * 100) / s.max, 0) / students.length)
        : null,
      passedEverySubject: students.filter((s) => !s.fails).length,
      students: students.map((s) => ({
        id: s.id,
        name: s.name,
        admissionNo: s.admissionNo,
        marks: s.got,
        maxMarks: s.max,
        percentage: round1((s.got * 100) / s.max),
        failedSubjects: s.fails,
      })),
      subjects,
    };
  }

  /** ACA-063: the principal's view — sections' performance and standing, upcoming exams, timetable cover. */
  async principalAcademics(p: Principal, f: { yearId?: string | undefined }) {
    const me = await principalOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const rows = await this.analyse(me.institutionId, year, {});
    const bySection = new Map<string, typeof rows>();
    for (const r of rows)
      bySection.set(binToUuid(r.section_public_id), [
        ...(bySection.get(binToUuid(r.section_public_id)) ?? []),
        r,
      ]);
    const sections = [...bySection.values()].map((g) => {
      const present = g.filter((r) => !Number(r.is_absent));
      const avg = present.length
        ? present.reduce((a, r) => a + (Number(r.marks) * 100) / r.max_marks, 0) / present.length
        : 0;
      const passRate = present.length
        ? (present.filter((r) => Number(r.marks) >= r.pass_marks).length * 100) / present.length
        : 0;
      return {
        section: {
          id: binToUuid(g[0]!.section_public_id),
          label: `${g[0]!.class_name} ${g[0]!.section_name}`,
        },
        average: round1(avg),
        passRate: round1(passRate),
        // 27.2 derived: Top Performer (≥ 80 and ≥ 80 %), Needs Support (< 50 or < 70 %), otherwise Average.
        standing:
          avg >= 80 && passRate >= 80
            ? 'Top Performer'
            : avg < 50 || passRate < 70
              ? 'Needs Support'
              : 'Average',
      };
    });
    const today = this.today();
    const in14 = istBusinessDate(new Date(this.now().getTime() + 14 * 86_400_000));
    const upcoming = await this.examRows(this.deps.db)
      .where('e.institution_id', '=', me.institutionId)
      .where('e.year_id', '=', year.id)
      .where('e.withdrawn_at', 'is', null)
      .where('e.exam_date', '>=', today)
      .where('e.exam_date', '<=', in14)
      .orderBy('e.exam_date')
      .limit(50)
      .execute();
    const cover = await this.deps.db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select([
        's.public_id',
        'c.name as class_name',
        's.name',
        (eb) =>
          eb
            .selectFrom('timetable_slots as ts')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ts.section_id', '=', 's.id')
            .where('ts.year_id', '=', year.id)
            .as('lessons'),
      ])
      .where('s.institution_id', '=', me.institutionId)
      .orderBy('c.sort_order')
      .orderBy('s.name')
      .execute();
    return {
      year: yearView(year),
      sections: sections.sort((a, b) => b.average - a.average),
      upcomingExams: upcoming.map((e) => this.examView(e)),
      timetables: cover.map((c) => ({
        section: { id: binToUuid(c.public_id), label: `${c.class_name} ${c.name}` },
        lessonsAWeek: Number(c.lessons ?? 0),
      })),
    };
  }

  // --- the teacher (ACA-052 … ACA-054) ----------------------------------------------------------------------
  /** May this teacher enter marks for the exam (its subject teacher, or the section's class teacher)? */
  private async assigned(
    db: Db,
    me: Member,
    e: { year_id: string; section_id: string; subject_id: string },
  ) {
    const a = await db
      .selectFrom('teacher_assignments')
      .select('id')
      .where('teacher_profile_id', '=', me.rowId)
      .where('year_id', '=', e.year_id)
      .where('section_id', '=', e.section_id)
      .where('ended_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('kind', '=', 'CLASS_TEACHER'),
          eb.and([eb('kind', '=', 'SUBJECT_TEACHER'), eb('subject_id', '=', e.subject_id)]),
        ]),
      )
      .executeTakeFirst();
    return !!a;
  }

  async teacherExams(
    p: Principal,
    f: { yearId?: string | undefined; examId?: string | undefined },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const rows = await this.examRows(this.deps.db)
      .where('e.institution_id', '=', me.institutionId)
      .where('e.year_id', '=', year.id)
      .where('e.withdrawn_at', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('teacher_assignments as ta')
            .select('ta.id')
            .where('ta.teacher_profile_id', '=', me.rowId)
            .whereRef('ta.year_id', '=', 'e.year_id')
            .whereRef('ta.section_id', '=', 'e.section_id')
            .where('ta.ended_at', 'is', null)
            .where((x) =>
              x.or([
                x('ta.kind', '=', 'CLASS_TEACHER'),
                x.and([
                  x('ta.kind', '=', 'SUBJECT_TEACHER'),
                  x(x.ref('ta.subject_id'), '=', x.ref('e.subject_id')),
                ]),
              ]),
            ),
        ),
      )
      .orderBy('e.exam_date')
      .execute();
    const visible = rows;
    const items = visible.map((e) => this.examView(e));
    let grid = null;
    if (f.examId) {
      const e = visible.find(
        (x) => isUuid(f.examId!) && binToUuid(x.public_id) === f.examId!.toLowerCase(),
      );
      if (!e) throw new CustomAPIError(404, 'ACA.EXAM_NOT_FOUND');
      grid = await this.grid(this.deps.db, e);
    }
    return { year: yearView(year), items, grid };
  }

  /** The roster of the exam's section and year with each student's mark. */
  private async grid(
    db: Db,
    e: {
      id: string;
      year_id: string;
      section_id: string;
      max_marks: number;
      pass_marks: number;
      row_version: number;
      exam_date: Date | string | null;
    },
  ) {
    const students = await db
      .selectFrom('enrolments as en')
      .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
      .leftJoin('marks as mk', (j) =>
        j.onRef('mk.student_profile_id', '=', 'en.student_profile_id').on('mk.exam_id', '=', e.id),
      )
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'mk.marks',
        'mk.is_absent',
        'mk.status',
      ])
      .where('en.year_id', '=', e.year_id)
      .where('en.section_id', '=', e.section_id)
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    const present = students.filter((s) => s.marks !== null);
    const avg = present.length
      ? present.reduce((a, s) => a + Number(s.marks), 0) / present.length
      : null;
    return {
      examId: binToUuid(
        (
          await db
            .selectFrom('exams')
            .select('public_id')
            .where('id', '=', e.id)
            .executeTakeFirstOrThrow()
        ).public_id,
      ),
      held: !e.exam_date || ymd(e.exam_date)! <= this.today(),
      maxMarks: e.max_marks,
      passMarks: e.pass_marks,
      rows: students.map((s) => ({
        student: {
          id: binToUuid(s.public_id),
          name: nameOf(s.first_name, s.last_name),
          admissionNo: s.admission_no,
        },
        marks: s.marks === null ? null : Number(s.marks),
        absent: !!Number(s.is_absent ?? 0),
        status: s.status ?? null,
      })),
      summary: {
        entered: students.filter((s) => s.status !== null).length,
        average: avg === null ? null : round1(avg),
        passed: present.filter((s) => Number(s.marks) >= e.pass_marks).length,
        failed: present.filter((s) => Number(s.marks) < e.pass_marks).length,
      },
      version: e.row_version,
    };
  }

  /** The exam of the teacher's school, or 404 (looked up before the body is read). */
  async teacherLookup(p: Principal, id: string) {
    const me = await teacherOf(this.deps.db, p);
    await this.examRow(this.deps.db, me.institutionId, id);
  }

  private async teacherExam(trx: Transaction<Database>, me: Member, id: string) {
    const e = await this.examRow(trx, me.institutionId, id);
    if (e.withdrawn_at) throw new CustomAPIError(404, 'ACA.EXAM_NOT_FOUND');
    if (
      !(await this.assigned(trx, me, {
        year_id: String(e.year_id),
        section_id: String(e.section_id),
        subject_id: String(e.subject_id),
      }))
    ) {
      throw new CustomAPIError(403, 'ACA.NOT_YOUR_CLASS');
    }
    await trx.selectFrom('exams').select('id').where('id', '=', e.id).forUpdate().execute();
    return e;
  }

  /** ACA-053: the whole grid in one transaction; a changed Valid mark returns to Created (RC-37). */
  async saveMarks(
    p: Principal,
    id: string,
    expected: number,
    rows: readonly {
      studentId: string;
      marks?: number | null | undefined;
      absent?: boolean | undefined;
    }[],
  ) {
    const me = await teacherOf(this.deps.db, p);
    const at = this.now();
    let examPublic = '';
    await this.deps.db.transaction().execute(async (trx) => {
      const e = await this.teacherExam(trx, me, id);
      examPublic = binToUuid(e.public_id);
      const year = await yearFor(trx, me.institutionId, binToUuid(e.year_public_id));
      assertOpen(year);
      if (e.row_version !== expected) throw new PreconditionFailedError();
      const date = ymd(e.exam_date);
      if (date && date > this.today()) {
        throw new CustomAPIError(409, 'ACA.EXAM_NOT_HELD', { params: { date: formatDate(date) } });
      }
      const roster = await trx
        .selectFrom('enrolments as en')
        .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
        .select(['m.id', 'm.public_id'])
        .where('en.year_id', '=', e.year_id)
        .where('en.section_id', '=', e.section_id)
        .execute();
      const byPublic = new Map(roster.map((r) => [binToUuid(r.public_id), String(r.id)]));
      const existing = new Map(
        (
          await trx
            .selectFrom('marks')
            .select(['student_profile_id', 'marks', 'is_absent', 'status'])
            .where('exam_id', '=', e.id)
            .execute()
        ).map((m) => [String(m.student_profile_id), m]),
      );
      const by = this.by(p);
      for (const [i, r] of rows.entries()) {
        const studentId = isUuid(r.studentId) ? byPublic.get(r.studentId.toLowerCase()) : undefined;
        if (!studentId) {
          throw new ValidationError([
            {
              field: `marks.${i}.studentId`,
              code: 'ACA.MARK_NOT_ENROLLED',
              params: { n: i + 1, section: `${e.class_name} ${e.section_name}`, year: year.label },
            },
          ]);
        }
        const absent = !!r.absent;
        const value = absent ? null : r.marks;
        if (
          !absent &&
          (value === null ||
            value === undefined ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > e.max_marks ||
            !Number.isInteger(value * 2))
        ) {
          throw new ValidationError([
            {
              field: `marks.${i}.marks`,
              code: 'ACA.MARK_RANGE',
              params: { n: i + 1, max: e.max_marks },
            },
          ]);
        }
        const old = existing.get(studentId);
        const same =
          old &&
          Number(old.is_absent) === (absent ? 1 : 0) &&
          (absent || Number(old.marks) === value);
        if (same) continue;
        if (old) {
          await trx
            .updateTable('marks')
            .set({
              marks: value ?? null,
              is_absent: absent ? 1 : 0,
              status: 'CREATED',
              entered_by: by,
              entered_at: at,
              validated_by: null,
              validated_at: null,
            })
            .where('exam_id', '=', e.id)
            .where('student_profile_id', '=', studentId)
            .execute();
        } else {
          await trx
            .insertInto('marks')
            .values({
              institution_id: me.institutionId,
              year_id: String(e.year_id),
              exam_id: e.id,
              student_profile_id: studentId,
              marks: value ?? null,
              is_absent: absent ? 1 : 0,
              entered_by: by,
              entered_at: at,
            })
            .execute();
        }
      }
      await trx
        .updateTable('exams')
        .set({ updated_at: at, row_version: sql<number>`row_version + 1` })
        .where('id', '=', e.id)
        .execute();
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'MARKS_SAVED',
        entityType: 'exam',
        entityRef: examPublic,
        after: { rows: rows.length },
      });
    });
    return this.teacherExams(p, { examId: examPublic, yearId: undefined }).then(async (out) => {
      if (out.grid) return out.grid;
      return null;
    });
  }

  /** ACA-054: validate and publish — every student has a mark or absent; students and families told. */
  async publish(p: Principal, id: string) {
    const me = await teacherOf(this.deps.db, p);
    const at = this.now();
    let examPublic = '';
    await this.deps.db.transaction().execute(async (trx) => {
      const e = await this.teacherExam(trx, me, id);
      examPublic = binToUuid(e.public_id);
      assertOpen(await yearFor(trx, me.institutionId, binToUuid(e.year_public_id)));
      const g = await this.grid(trx, e);
      const missing = g.rows.filter((r) => r.status === null).length;
      if (missing || !g.rows.length) {
        throw new CustomAPIError(409, 'ACA.MARKS_INCOMPLETE', { params: { n: missing } });
      }
      await trx
        .updateTable('marks')
        .set({ status: 'VALID', validated_by: this.by(p), validated_at: at })
        .where('exam_id', '=', e.id)
        .where('status', '=', 'CREATED')
        .execute();
      await trx
        .updateTable('exams')
        .set({
          published_at: at,
          published_by: this.by(p),
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', e.id)
        .execute();
      // The students and their guardians are told.
      const accounts = await trx
        .selectFrom('enrolments as en')
        .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
        .leftJoin('guardianships as g', 'g.ward_profile_id', 'en.student_profile_id')
        .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
        .select(['en.student_profile_id', 'm.account_id', 'gm.account_id as guardian_account'])
        .where('en.year_id', '=', e.year_id)
        .where('en.section_id', '=', e.section_id)
        .execute();
      const students = [...new Set(accounts.map((a) => String(a.student_profile_id)))];
      const ids = [
        ...new Set(
          accounts
            .flatMap((a) => [a.account_id, a.guardian_account])
            .filter((a): a is string => !!a)
            .map(String),
        ),
      ];
      // Parents without the app are e-mailed too (client 2026-10-16).
      if (ids.length || students.length) {
        await notify(
          trx,
          {
            institutionId: me.institutionId,
            accountIds: ids,
            about: students,
            surface: 'MEMBER',
            category: 'ACCOUNT',
            titleKey: 'NTF.RESULTS_PUBLISHED',
            params: { exam: e.exam_name, subject: e.subject_name },
            body: `${e.class_name} ${e.section_name}`,
            link: '/results',
          },
          at,
        );
      }
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'MARKS_PUBLISHED',
        entityType: 'exam',
        entityRef: examPublic,
        after: { students: g.rows.length },
      });
    });
    const out = await this.teacherExams(p, { examId: examPublic });
    return { exam: out.items.find((x) => x.id === examPublic) ?? null, grid: out.grid };
  }

  // --- the student and family (ACA-070 / ACA-071) ------------------------------------------------------------
  private async enrolmentOf(db: Db, me: Member, year: Year) {
    return db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['en.section_id', 's.name as section_name', 'c.name as class_name'])
      .where('en.institution_id', '=', me.institutionId)
      .where('en.student_profile_id', '=', me.rowId)
      .where('en.year_id', '=', year.id)
      .executeTakeFirst();
  }

  async myExams(p: Principal, f: { yearId?: string | undefined; for?: string | undefined }) {
    const me = await studentOf(this.deps.db, p, f.for);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const en = await this.enrolmentOf(this.deps.db, me, year);
    if (!en) return { year: yearView(year), section: null, items: [] };
    const rows = await this.examRows(this.deps.db)
      .where('e.institution_id', '=', me.institutionId)
      .where('e.year_id', '=', year.id)
      .where('e.section_id', '=', String(en.section_id))
      .where('e.withdrawn_at', 'is', null)
      .orderBy('e.exam_date')
      .execute();
    return {
      year: yearView(year),
      section: `${en.class_name} ${en.section_name}`,
      items: rows.map((e) => {
        const v = this.examView(e);
        return {
          id: v.id,
          name: v.name,
          subject: v.subject,
          date: v.date,
          startTime: v.startTime,
          endTime: v.endTime,
          maxMarks: v.maxMarks,
          passMarks: v.passMarks,
          schedule: v.schedule,
          published: !!v.published,
        };
      }),
    };
  }

  /** ACA-071: published marks by exam, labelled with the year (RNG-ACA-449). */
  async myResults(p: Principal, f: { yearId?: string | undefined; for?: string | undefined }) {
    const me = await studentOf(this.deps.db, p, f.for);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const rows = await this.deps.db
      .selectFrom('marks as m')
      .innerJoin('exams as e', 'e.id', 'm.exam_id')
      .innerJoin('exam_names as n', 'n.id', 'e.exam_name_id')
      .innerJoin('subjects as sub', 'sub.id', 'e.subject_id')
      .select([
        'n.public_id as name_public_id',
        'n.name',
        'sub.name as subject_name',
        'sub.colour',
        'e.max_marks',
        'e.pass_marks',
        'e.exam_date',
        'm.marks',
        'm.is_absent',
      ])
      .where('m.institution_id', '=', me.institutionId)
      .where('m.student_profile_id', '=', me.rowId)
      .where('m.year_id', '=', year.id)
      .where('m.status', '=', 'VALID')
      .where('e.published_at', 'is not', null)
      .where('e.withdrawn_at', 'is', null)
      .orderBy('e.exam_date')
      .execute();
    const exams = new Map<string, { name: string; subjects: typeof rows }>();
    for (const r of rows) {
      const k = binToUuid(r.name_public_id);
      exams.set(k, { name: r.name, subjects: [...(exams.get(k)?.subjects ?? []), r] });
    }
    return {
      year: yearView(year),
      exams: [...exams.entries()].map(([id, x]) => {
        const present = x.subjects.filter((s) => !Number(s.is_absent));
        const got = present.reduce((a, s) => a + Number(s.marks), 0);
        const max = present.reduce((a, s) => a + s.max_marks, 0);
        return {
          id,
          name: x.name,
          percentage: max ? round1((got * 100) / max) : null,
          subjects: x.subjects.map((s) => ({
            subject: { name: s.subject_name, colour: s.colour },
            marks: s.marks === null ? null : Number(s.marks),
            absent: !!Number(s.is_absent),
            maxMarks: s.max_marks,
            passMarks: s.pass_marks,
            // 27.2 derived standing against the exam's own pass marks (OI-ACA-39).
            standing: Number(s.is_absent)
              ? 'Absent'
              : Number(s.marks) >= s.pass_marks
                ? 'Passed'
                : 'Failed',
          })),
        };
      }),
    };
  }
}

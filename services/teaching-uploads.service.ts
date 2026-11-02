/**
 * Teacher-assignment and timetable sheets (client 2026-10-21; SRS 20.7–20.8; ACA-083…086): class
 * teachers, subject teachers and a year's timetables uploaded as CSV, kept to the manual screens'
 * rules (teaching-rules.ts). commit=false checks every row and saves nothing; commit=true checks again
 * inside one transaction and saves the accepted rows. A sheet adds or replaces, never removes: taking
 * an assignment away stays on the screen. A teacher is named by employee ID or mobile number — or by
 * the profile id the templates write for a teacher who has neither.
 *
 * - Class teachers: a section already led keeps its teacher unless `replace` (the old one kept as
 *   history); a teacher leads one class-section once the whole sheet is applied, so a sheet can move
 *   teachers between sections.
 * - Subject teachers: a subject and a teacher for one or more sections of a class; assignments
 *   already there are left as they are.
 * - Timetables: each section in the sheet gets exactly the sheet's week (a row with no subject and no
 *   teacher is a free period); a section with any refused row is skipped whole, never half-written.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database, TeacherAssignmentKind } from '../models/campusone_models';
import { CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import { detectDelimiter, parseCsv, toCsv } from '../utils/csv';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { assertOpen, institutionOf, yearFor, yearView, type Year } from './academic-year';
import { recordAudit } from './audit.service';
import { liveClassTeachers } from './teaching.service';
import {
  DAYS,
  classTeacherProblem,
  isTeaching,
  lessonProblem,
  oneClassProblem,
  subjectNotMapped,
  type LessonContext,
  type Problem,
} from './teaching-rules';

type Db = Kysely<Database> | Transaction<Database>;
export type SheetKind = Extract<TeacherAssignmentKind, 'CLASS_TEACHER' | 'SUBJECT_TEACHER'>;

/** Rows a sheet may hold (the 2 MB file limit applies as well). */
const MAX_ASSIGNMENT_ROWS = 1000;
const MAX_TIMETABLE_ROWS = 5000;

const COLUMNS = {
  CLASS_TEACHER: ['class', 'section', 'teacher', 'teacher_name'],
  SUBJECT_TEACHER: ['class', 'sections', 'subject', 'teacher', 'teacher_name'],
  TIMETABLE: ['class', 'section', 'day', 'period', 'subject', 'teacher', 'teacher_name'],
} as const;
/** For the reader's eyes only: the row report shows the teacher the ID matched. */
const OPTIONAL = new Set(['teacher_name']);

const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const lower = (s: string) => s.trim().toLowerCase();
/** A cell as typed: trimmed, without the apostrophe a safe export puts before = + - @ (utils/csv). */
const clean = (v: string | undefined) => {
  const t = (v ?? '').trim();
  return /^'[=+\-@]/.test(t) ? t.slice(1) : t;
};
const slug = (label: string) => label.replace(/[^A-Za-z0-9-]+/g, '-');

/** A mobile number as people write it (spaces, dashes, +91 or a leading 0), or null. */
function mobileOf(cell: string) {
  let d = cell.replace(/[\s-]/g, '');
  if (/^\+?91\d{10}$/.test(d)) d = d.slice(-10);
  else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** The day a cell names: Monday, Mon or 1 … Saturday, Sat or 6. */
function dayOf(cell: string) {
  const k = lower(cell);
  return (
    DAYS.find(
      (d) => lower(d.label) === k || lower(d.label).slice(0, 3) === k || String(d.day) === k,
    )?.day ?? null
  );
}

type Cells = (column: string) => string;

/** The sheet's rows, after the header names every required column (in any order). */
function readSheet(content: string, columns: readonly string[], max: number): Cells[] {
  const table = parseCsv(content, detectDelimiter(content));
  const header = (table[0] ?? []).map(lower);
  const at = new Map(columns.map((c) => [c, header.indexOf(c)]));
  if (columns.some((c) => !OPTIONAL.has(c) && (at.get(c) ?? -1) < 0)) {
    throw new ValidationError([{ field: 'file', code: 'UPL.HEADER_MISMATCH' }]);
  }
  const body = table.slice(1);
  if (!body.length) throw new ValidationError([{ field: 'file', code: 'UPL.NO_ROWS' }]);
  if (body.length > max) {
    throw new ValidationError([{ field: 'file', code: 'UPL.TOO_MANY_ROWS', params: { max } }]);
  }
  return body.map((r) => (c: string) => {
    const i = at.get(c) ?? -1;
    return i < 0 ? '' : clean(r[i]);
  });
}

interface Section {
  readonly id: string;
  readonly classId: string;
  readonly className: string;
  readonly name: string;
  readonly label: string;
}
interface Subject {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The institution's classes, sections, subjects and class × subject mapping. */
async function schoolOf(db: Db, institutionId: string) {
  const classRows = await db
    .selectFrom('classes')
    .select(['id', 'name'])
    .where('institution_id', '=', institutionId)
    .orderBy('sort_order')
    .orderBy('name')
    .execute();
  const sectionRows = await db
    .selectFrom('sections')
    .select(['id', 'class_id', 'name'])
    .where('institution_id', '=', institutionId)
    .orderBy('name')
    .execute();
  const subjectRows = await db
    .selectFrom('subjects')
    .select(['id', 'code', 'name'])
    .where('institution_id', '=', institutionId)
    .orderBy('name')
    .execute();
  const mappedRows = await db
    .selectFrom('class_subjects as cs')
    .innerJoin('classes as c', 'c.id', 'cs.class_id')
    .select(['cs.class_id', 'cs.subject_id'])
    .where('c.institution_id', '=', institutionId)
    .execute();
  const classes = classRows.map((c) => ({
    id: String(c.id),
    name: c.name,
    sections: sectionRows
      .filter((s) => String(s.class_id) === String(c.id))
      .map((s): Section => ({
        id: String(s.id),
        classId: String(c.id),
        className: c.name,
        name: s.name,
        label: `${c.name} ${s.name}`,
      })),
  }));
  const subjects = subjectRows.map((s): Subject => ({
    id: String(s.id),
    code: s.code,
    name: s.name,
  }));
  const mapped = new Set(mappedRows.map((m) => `${m.class_id}:${m.subject_id}`));
  return {
    classes,
    sections: new Map(classes.flatMap((c) => c.sections.map((s) => [s.id, s] as const))),
    mapped,
    /** The class a cell names. */
    classNamed: (cell: string) => classes.find((c) => lower(c.name) === lower(cell)),
    /** A subject by its code, else by its name. */
    subjectNamed: (cell: string) =>
      subjects.find((s) => lower(s.code) === lower(cell)) ??
      subjects.find((s) => lower(s.name) === lower(cell)),
    /** The subjects mapped to a class, by name. */
    subjectsOf: (classId: string) => subjects.filter((s) => mapped.has(`${classId}:${s.id}`)),
  };
}
type School = Awaited<ReturnType<typeof schoolOf>>;

/** The class-section a row names, or why not. */
function sectionNamed(
  school: School,
  className: string,
  sectionName: string,
): { section: Section } | { problem: Problem } {
  const cls = school.classNamed(className);
  if (!cls) return { problem: { code: 'UPL.CLASS_UNKNOWN', params: { class: className } } };
  if (!sectionName) return { problem: { code: 'UPL.SECTION_REQUIRED' } };
  const section = cls.sections.find((s) => lower(s.name) === lower(sectionName));
  return section
    ? { section }
    : {
        problem: { code: 'UPL.SECTION_UNKNOWN', params: { class: cls.name, section: sectionName } },
      };
}

/**
 * Finds the teachers a sheet names, in one read: by employee ID, else by the mobile number of their
 * account, else by profile id. Only an active teacher or principal qualifies (as on the screens).
 */
async function teachersNamed(db: Db, institutionId: string, cells: readonly string[]) {
  const named = [...new Set(cells.filter(Boolean))];
  const mobiles = [...new Set(named.map(mobileOf).filter((m): m is string => !!m))];
  const ids = named.filter(isUuid).map((i) => uuidToBin(i));
  const rows = named.length
    ? await db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
        .select([
          'm.id',
          'm.public_id',
          'm.first_name',
          'm.last_name',
          'm.employee_no',
          'm.status',
          'ut.category',
          'a.mobile',
        ])
        .where('m.institution_id', '=', institutionId)
        .where((eb) =>
          eb.or([
            eb('m.employee_no', 'in', named),
            ...(mobiles.length ? [eb('a.mobile', 'in', mobiles)] : []),
            ...(ids.length ? [eb('m.public_id', 'in', ids)] : []),
          ]),
        )
        .execute()
    : [];
  return (cell: string): { teacher: { id: string; name: string } } | { problem: Problem } => {
    const k = lower(cell);
    const mobile = mobileOf(cell);
    let hits = rows.filter((r) => r.employee_no && lower(r.employee_no) === k);
    if (!hits.length && mobile) hits = rows.filter((r) => r.mobile === mobile);
    if (!hits.length && isUuid(cell)) hits = rows.filter((r) => binToUuid(r.public_id) === k);
    if (!hits.length) return { problem: { code: 'UPL.TEACHER_UNKNOWN', params: { t: cell } } };
    const teaching = hits.filter(isTeaching);
    if (teaching.length > 1)
      return { problem: { code: 'UPL.TEACHER_AMBIGUOUS', params: { t: cell } } };
    if (!teaching.length) return { problem: { code: 'ACA.NOT_A_TEACHER' } };
    const t = teaching[0]!;
    return { teacher: { id: String(t.id), name: nameOf(t.first_name, t.last_name) } };
  };
}

/** How a template names a teacher: employee ID, else mobile number, else profile id. */
const teacherCell = (t: {
  readonly employee_no: string | null;
  readonly mobile: string | null;
  readonly public_id: Buffer;
}) => t.employee_no || t.mobile || binToUuid(t.public_id);

interface AssignmentRow {
  readonly row: number;
  readonly className: string;
  readonly sections: string;
  readonly subject: string | null;
  readonly teacher: string;
  teacherName: string | null;
  outcome: 'NEW' | 'REPLACE' | 'UNCHANGED' | null;
  problem: Problem | null;
}
interface AssignmentPlan {
  readonly rows: readonly AssignmentRow[];
  /** Live class-teacher assignments a sheet replaces (ended, kept as history). */
  readonly end: readonly string[];
  readonly add: readonly {
    classId: string;
    sectionId: string;
    subjectId: string | null;
    teacherId: string;
  }[];
}

interface TimetableRow {
  readonly row: number;
  readonly className: string;
  readonly section: string;
  readonly day: string;
  readonly period: string;
  readonly subject: string;
  readonly teacher: string;
  teacherName: string | null;
  sec: Section | null;
  cell: { day: number; periodId: string } | null;
  lesson: { subjectId: string; subjectName: string; teacherId: string } | null;
  problem: Problem | null;
}
interface TimetablePlan {
  readonly rows: readonly TimetableRow[];
  /** The sections the sheet names. */
  readonly sections: ReadonlySet<string>;
  /** Those whose week the sheet replaces (the rest are skipped). */
  readonly replaced: ReadonlySet<string>;
}

export class TeachingUploadsService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- ACA-083: the assignment sheets -------------------------------------------------------------------
  /** The year's class teachers or subject teachers as a sheet to edit and upload again. */
  async assignmentsTemplate(p: Principal, f: { kind: SheetKind; yearId?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, inst.id, f.yearId);
    const school = await schoolOf(db, inst.id);
    const live = await db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select([
        'ta.section_id',
        'ta.subject_id',
        'm.public_id',
        'm.employee_no',
        'm.first_name',
        'm.last_name',
        'a.mobile',
      ])
      .where('ta.year_id', '=', year.id)
      .where('ta.kind', '=', f.kind)
      .where('ta.ended_at', 'is', null)
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    const rows: string[][] = [[...COLUMNS[f.kind]]];
    for (const c of school.classes) {
      if (f.kind === 'CLASS_TEACHER') {
        for (const s of c.sections) {
          const a = live.find((x) => String(x.section_id) === s.id);
          rows.push([
            c.name,
            s.name,
            a ? teacherCell(a) : '',
            a ? nameOf(a.first_name, a.last_name) : '',
          ]);
        }
        continue;
      }
      // One row per teacher of each mapped subject (their sections together), and one with no
      // teacher for the sections nobody teaches it in yet.
      for (const sub of school.subjectsOf(c.id)) {
        const taught = live.filter(
          (x) =>
            String(x.subject_id) === sub.id &&
            c.sections.some((s) => s.id === String(x.section_id)),
        );
        const teachers = [...new Map(taught.map((x) => [binToUuid(x.public_id), x])).values()];
        for (const t of teachers) {
          const theirs = c.sections.filter((s) =>
            taught.some(
              (x) =>
                String(x.section_id) === s.id && binToUuid(x.public_id) === binToUuid(t.public_id),
            ),
          );
          rows.push([
            c.name,
            theirs.map((s) => s.name).join(', '),
            sub.name,
            teacherCell(t),
            nameOf(t.first_name, t.last_name),
          ]);
        }
        const open = c.sections.filter((s) => !taught.some((x) => String(x.section_id) === s.id));
        if (open.length) rows.push([c.name, open.map((s) => s.name).join(', '), sub.name, '', '']);
      }
    }
    const what = f.kind === 'CLASS_TEACHER' ? 'class-teachers' : 'subject-teachers';
    return { fileName: `${what}-${slug(year.label)}.csv`, csv: toCsv(rows) };
  }

  // --- ACA-084: upload an assignment sheet --------------------------------------------------------------
  async uploadAssignments(
    p: Principal,
    input: {
      kind: SheetKind;
      yearId?: string | undefined;
      replace: boolean;
      content: string;
      commit: boolean;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    const cells = readSheet(input.content, COLUMNS[input.kind], MAX_ASSIGNMENT_ROWS);
    const check = (db: Db, lock: boolean) =>
      input.kind === 'CLASS_TEACHER'
        ? this.checkClassTeachers(db, inst.id, year, cells, input.replace, lock)
        : this.checkSubjectTeachers(db, inst.id, year, cells);
    if (!input.commit)
      return this.assignmentReport(input.kind, year, await check(this.deps.db, false), false);
    const by = this.by(p);
    const at = this.now();
    const plan = await this.deps.db.transaction().execute(async (trx) => {
      // The manual assignments lock the year too: the sheet is checked again against what is there now.
      await trx
        .selectFrom('academic_years')
        .select('id')
        .where('id', '=', year.id)
        .forUpdate()
        .execute();
      const out = await check(trx, true);
      if (out.end.length) {
        await trx
          .updateTable('teacher_assignments')
          .set({ ended_at: at, ended_by: by })
          .where('id', 'in', [...out.end])
          .execute();
      }
      if (out.add.length) {
        await trx
          .insertInto('teacher_assignments')
          .values(
            out.add.map((a) => ({
              public_id: newPublicIdPair().bin,
              institution_id: inst.id,
              year_id: year.id,
              kind: input.kind,
              teacher_profile_id: a.teacherId,
              class_id: a.classId,
              section_id: a.sectionId,
              subject_id: a.subjectId,
              created_by: by,
              created_at: at,
            })),
          )
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TEACHERS_UPLOADED',
        entityType: 'institution',
        entityRef: p.institutionId,
        after: {
          kind: input.kind,
          year: year.label,
          created: out.add.length,
          replaced: out.end.length,
          rejected: out.rows.filter((r) => r.problem).length,
        },
      });
      return out;
    });
    return this.assignmentReport(input.kind, year, plan, true);
  }

  private assignmentReport(kind: SheetKind, year: Year, plan: AssignmentPlan, committed: boolean) {
    const rejected = plan.rows.filter((r) => r.problem).length;
    return {
      committed,
      kind,
      year: yearView(year),
      accepted: plan.rows.length - rejected,
      rejected,
      created: plan.add.length,
      replaced: plan.end.length,
      unchanged: plan.rows.filter((r) => !r.problem && r.outcome === 'UNCHANGED').length,
      rows: plan.rows.map((r) => ({
        row: r.row,
        className: r.className,
        sections: r.sections,
        subject: r.subject,
        teacher: r.teacher,
        teacherName: r.teacherName,
        accepted: !r.problem,
        outcome: r.problem ? null : r.outcome,
        code: r.problem?.code ?? null,
        params: r.problem?.params ?? {},
      })),
    };
  }

  /**
   * Class teachers: the screen's rules (classTeacherProblem) row by row against the live year, then
   * "one class-section per teacher" against the year as the whole sheet leaves it. A refused row
   * leaves its section as it was, so that check repeats until nothing more is refused.
   */
  private async checkClassTeachers(
    db: Db,
    institutionId: string,
    year: Year,
    cells: readonly Cells[],
    replace: boolean,
    lock: boolean,
  ): Promise<AssignmentPlan> {
    const school = await schoolOf(db, institutionId);
    const resolve = await teachersNamed(
      db,
      institutionId,
      cells.map((c) => c('teacher')),
    );
    const live = await liveClassTeachers(db, year.id, lock);
    const liveBySection = new Map(live.map((a) => [a.sectionId, a]));
    const changes: { r: AssignmentRow; section: Section; teacher: { id: string; name: string } }[] =
      [];
    const seen = new Set<string>();
    const rows = cells.map((c, i) => {
      const r: AssignmentRow = {
        row: i + 1,
        className: c('class'),
        sections: c('section'),
        subject: null,
        teacher: c('teacher'),
        teacherName: null,
        outcome: null,
        problem: null,
      };
      const named = sectionNamed(school, r.className, r.sections);
      if ('problem' in named) {
        r.problem = named.problem;
        return r;
      }
      // A row without a teacher changes nothing (the template lists every section).
      if (!r.teacher) {
        r.outcome = 'UNCHANGED';
        return r;
      }
      const found = resolve(r.teacher);
      if ('problem' in found) {
        r.problem = found.problem;
        return r;
      }
      r.teacherName = found.teacher.name;
      if (seen.has(named.section.id)) {
        r.problem = { code: 'ACA.ROW_REPEATED' };
        return r;
      }
      seen.add(named.section.id);
      const cur = liveBySection.get(named.section.id);
      if (cur?.teacherId === found.teacher.id) {
        r.outcome = 'UNCHANGED';
        return r;
      }
      const taken = classTeacherProblem(
        cur ? [cur] : [],
        named.section,
        found.teacher,
        year.label,
        replace,
      );
      if (taken) {
        r.problem = taken;
        return r;
      }
      r.outcome = cur ? 'REPLACE' : 'NEW';
      changes.push({ r, section: named.section, teacher: found.teacher });
      return r;
    });
    let accepted = changes;
    for (;;) {
      const moved = new Set(accepted.map((x) => x.section.id));
      const keeps = new Map<string, string>();
      for (const a of live) if (!moved.has(a.sectionId)) keeps.set(a.teacherId, a.sectionLabel);
      const first = new Map<string, string>();
      const refused = new Set<(typeof changes)[number]>();
      for (const x of accepted) {
        const other = keeps.get(x.teacher.id) ?? first.get(x.teacher.id);
        if (other !== undefined) {
          x.r.problem = oneClassProblem(x.teacher.name, other, year.label);
          x.r.outcome = null;
          refused.add(x);
        } else first.set(x.teacher.id, x.section.label);
      }
      if (!refused.size) break;
      accepted = accepted.filter((x) => !refused.has(x));
    }
    return {
      rows,
      end: accepted
        .filter((x) => x.r.outcome === 'REPLACE')
        .map((x) => liveBySection.get(x.section.id)!.assignmentId),
      add: accepted.map((x) => ({
        classId: x.section.classId,
        sectionId: x.section.id,
        subjectId: null,
        teacherId: x.teacher.id,
      })),
    };
  }

  /** Subject teachers: a mapped subject, a teacher, the class's sections; what is there already stays. */
  private async checkSubjectTeachers(
    db: Db,
    institutionId: string,
    year: Year,
    cells: readonly Cells[],
  ): Promise<AssignmentPlan> {
    const school = await schoolOf(db, institutionId);
    const resolve = await teachersNamed(
      db,
      institutionId,
      cells.map((c) => c('teacher')),
    );
    const live = new Set(
      (
        await db
          .selectFrom('teacher_assignments')
          .select(['section_id', 'subject_id', 'teacher_profile_id'])
          .where('year_id', '=', year.id)
          .where('kind', '=', 'SUBJECT_TEACHER')
          .where('ended_at', 'is', null)
          .execute()
      ).map((a) => `${a.section_id}:${a.subject_id}:${a.teacher_profile_id}`),
    );
    const planned = new Set<string>();
    const add: AssignmentPlan['add'][number][] = [];
    const rows = cells.map((c, i) => {
      const r: AssignmentRow = {
        row: i + 1,
        className: c('class'),
        sections: c('sections'),
        subject: c('subject'),
        teacher: c('teacher'),
        teacherName: null,
        outcome: null,
        problem: null,
      };
      const fail = (problem: Problem) => {
        r.problem = problem;
        return r;
      };
      const cls = school.classNamed(r.className);
      if (!cls) return fail({ code: 'UPL.CLASS_UNKNOWN', params: { class: r.className } });
      const names = [
        ...new Map(
          r.sections
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => [lower(s), s] as const),
        ).values(),
      ];
      if (!names.length) return fail({ code: 'UPL.SECTION_REQUIRED' });
      const sections: Section[] = [];
      for (const n of names) {
        const s = cls.sections.find((x) => lower(x.name) === lower(n));
        if (!s)
          return fail({ code: 'UPL.SECTION_UNKNOWN', params: { class: cls.name, section: n } });
        sections.push(s);
      }
      const sub = school.subjectNamed(r.subject ?? '');
      if (!sub) return fail({ code: 'UPL.SUBJECT_UNKNOWN', params: { subject: r.subject ?? '' } });
      if (!school.mapped.has(`${cls.id}:${sub.id}`))
        return fail(subjectNotMapped(sub.name, cls.name));
      if (!r.teacher) {
        r.outcome = 'UNCHANGED';
        return r;
      }
      const found = resolve(r.teacher);
      if ('problem' in found) return fail(found.problem);
      r.teacherName = found.teacher.name;
      const keys = sections.map((s) => ({ s, k: `${s.id}:${sub.id}:${found.teacher.id}` }));
      const fresh = keys.filter((x) => !live.has(x.k) && !planned.has(x.k));
      if (!fresh.length) {
        if (keys.some((x) => planned.has(x.k))) return fail({ code: 'ACA.ROW_REPEATED' });
        r.outcome = 'UNCHANGED';
        return r;
      }
      for (const x of fresh) {
        planned.add(x.k);
        add.push({
          classId: cls.id,
          sectionId: x.s.id,
          subjectId: sub.id,
          teacherId: found.teacher.id,
        });
      }
      r.outcome = 'NEW';
      return r;
    });
    return { rows, end: [], add };
  }

  // --- ACA-085: the timetable sheet ---------------------------------------------------------------------
  /** Every section's week for the year, one row per day and teaching period (blank = free period). */
  async timetableTemplate(p: Principal, f: { yearId?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const db = this.deps.db;
    const year = await yearFor(db, inst.id, f.yearId);
    const school = await schoolOf(db, inst.id);
    const periods = await db
      .selectFrom('periods')
      .select(['id', 'name'])
      .where('institution_id', '=', inst.id)
      .where('is_break', '=', 0 as never)
      .orderBy('starts_at')
      .execute();
    const slots = await db
      .selectFrom('timetable_slots as ts')
      .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
      .innerJoin('member_profiles as m', 'm.id', 'ts.teacher_profile_id')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select([
        'ts.section_id',
        'ts.day',
        'ts.period_id',
        'sub.name as subject_name',
        'm.public_id',
        'm.employee_no',
        'm.first_name',
        'm.last_name',
        'a.mobile',
      ])
      .where('ts.year_id', '=', year.id)
      .execute();
    const at = new Map(slots.map((x) => [`${x.section_id}:${x.day}:${x.period_id}`, x]));
    const rows: string[][] = [[...COLUMNS.TIMETABLE]];
    for (const c of school.classes) {
      for (const s of c.sections) {
        for (const d of DAYS) {
          for (const pd of periods) {
            const x = at.get(`${s.id}:${d.day}:${pd.id}`);
            rows.push([
              c.name,
              s.name,
              d.label,
              pd.name,
              x?.subject_name ?? '',
              x ? teacherCell(x) : '',
              x ? nameOf(x.first_name, x.last_name) : '',
            ]);
          }
        }
      }
    }
    return { fileName: `timetables-${slug(year.label)}.csv`, csv: toCsv(rows) };
  }

  // --- ACA-086: upload the timetable sheet ---------------------------------------------------------------
  async uploadTimetable(
    p: Principal,
    input: { yearId?: string | undefined; content: string; commit: boolean },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    const cells = readSheet(input.content, COLUMNS.TIMETABLE, MAX_TIMETABLE_ROWS);
    if (!input.commit) {
      return this.timetableReport(
        year,
        await this.checkTimetable(this.deps.db, inst.id, year, cells, false),
        false,
      );
    }
    const by = this.by(p);
    try {
      const plan = await this.deps.db.transaction().execute(async (trx) => {
        const out = await this.checkTimetable(trx, inst.id, year, cells, true);
        const replaced = [...out.replaced];
        if (replaced.length) {
          await trx
            .deleteFrom('timetable_slots')
            .where('year_id', '=', year.id)
            .where('section_id', 'in', replaced)
            .execute();
        }
        const at = this.now();
        const lessons = out.rows.filter((r) => r.sec && out.replaced.has(r.sec.id) && r.lesson);
        for (let i = 0; i < lessons.length; i += 500) {
          await trx
            .insertInto('timetable_slots')
            .values(
              lessons.slice(i, i + 500).map((r) => ({
                institution_id: inst.id,
                year_id: year.id,
                section_id: r.sec!.id,
                day: r.cell!.day,
                period_id: r.cell!.periodId,
                subject_id: r.lesson!.subjectId,
                teacher_profile_id: r.lesson!.teacherId,
                updated_by: by,
                updated_at: at,
              })),
            )
            .execute();
        }
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'TIMETABLE_UPLOADED',
          entityType: 'institution',
          entityRef: p.institutionId,
          after: {
            year: year.label,
            sections: replaced.length,
            lessons: lessons.length,
            skipped: out.sections.size - replaced.length,
          },
        });
        return out;
      });
      return this.timetableReport(year, plan, true);
    } catch (e) {
      // A lesson saved on another section's screen meanwhile now takes the teacher (the year's unique
      // key, RNG-ACA-443): nothing was saved; checking the sheet again names the clash.
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'GEN.CONFLICT_VERSION');
      throw e;
    }
  }

  private timetableReport(year: Year, plan: TimetablePlan, committed: boolean) {
    const rejected = plan.rows.filter((r) => r.problem).length;
    return {
      committed,
      year: yearView(year),
      accepted: plan.rows.length - rejected,
      rejected,
      sections: plan.replaced.size,
      skippedSections: plan.sections.size - plan.replaced.size,
      lessons: plan.rows.filter((r) => !r.problem && r.lesson).length,
      rows: plan.rows.map((r) => ({
        row: r.row,
        className: r.className,
        section: r.section,
        day: r.day,
        period: r.period,
        subject: r.subject,
        teacher: r.teacher,
        teacherName: r.teacherName,
        accepted: !r.problem,
        outcome: r.problem ? null : r.lesson ? ('LESSON' as const) : ('FREE' as const),
        code: r.problem?.code ?? null,
        params: r.problem?.params ?? {},
      })),
    };
  }

  /**
   * Timetables: each row as the screen checks a lesson (lessonProblem); a section with a refused row
   * is skipped whole; then no teacher in two places in one period of the year, against the other
   * sections as the sheet leaves them. Skipping a section keeps its old week, so that check repeats
   * until nothing more is refused.
   */
  private async checkTimetable(
    db: Db,
    institutionId: string,
    year: Year,
    cells: readonly Cells[],
    lock: boolean,
  ): Promise<TimetablePlan> {
    const school = await schoolOf(db, institutionId);
    const resolve = await teachersNamed(
      db,
      institutionId,
      cells.map((c) => c('teacher')),
    );
    const periods = await db
      .selectFrom('periods')
      .select(['id', 'name', 'is_break'])
      .where('institution_id', '=', institutionId)
      .execute();
    const rows = cells.map((c, i): TimetableRow => {
      const r: TimetableRow = {
        row: i + 1,
        className: c('class'),
        section: c('section'),
        day: c('day'),
        period: c('period'),
        subject: c('subject'),
        teacher: c('teacher'),
        teacherName: null,
        sec: null,
        cell: null,
        lesson: null,
        problem: null,
      };
      const named = sectionNamed(school, r.className, r.section);
      if ('problem' in named) {
        r.problem = named.problem;
        return r;
      }
      r.sec = named.section;
      const day = dayOf(r.day);
      if (!day) {
        r.problem = { code: 'UPL.DAY_UNKNOWN', params: { day: r.day } };
        return r;
      }
      const pd = periods.find((x) => lower(x.name) === lower(r.period));
      if (!pd) {
        r.problem = { code: 'UPL.PERIOD_UNKNOWN', params: { period: r.period } };
        return r;
      }
      r.cell = { day, periodId: String(pd.id) };
      if (!r.subject && !r.teacher) return r;
      if (!r.subject || !r.teacher) {
        r.problem = { code: 'UPL.LESSON_INCOMPLETE' };
        return r;
      }
      const sub = school.subjectNamed(r.subject);
      if (!sub) {
        r.problem = { code: 'UPL.SUBJECT_UNKNOWN', params: { subject: r.subject } };
        return r;
      }
      const found = resolve(r.teacher);
      if ('problem' in found) {
        r.problem = found.problem;
        return r;
      }
      r.teacherName = found.teacher.name;
      r.lesson = { subjectId: sub.id, subjectName: sub.name, teacherId: found.teacher.id };
      return r;
    });
    // The sections the sheet names, in the order it names them; locked like the screen's save.
    const sections = new Set(rows.flatMap((r) => (r.sec ? [r.sec.id] : [])));
    if (lock && sections.size) {
      await db
        .selectFrom('sections')
        .select('id')
        .where('id', 'in', [...sections])
        .orderBy('id')
        .forUpdate()
        .execute();
    }
    const assigned = await db
      .selectFrom('teacher_assignments')
      .select(['section_id', 'subject_id', 'teacher_profile_id'])
      .where('year_id', '=', year.id)
      .where('kind', '=', 'SUBJECT_TEACHER')
      .where('ended_at', 'is', null)
      .execute();
    const slots = await db
      .selectFrom('timetable_slots')
      .select(['section_id', 'day', 'period_id', 'teacher_profile_id'])
      .where('year_id', '=', year.id)
      .execute();
    const bell = new Map(periods.map((x) => [String(x.id), { isBreak: !!Number(x.is_break) }]));
    for (const id of sections) {
      const sec = school.sections.get(id)!;
      const ctx: LessonContext = {
        section: sec,
        periods: bell,
        subjects: new Map(school.subjectsOf(sec.classId).map((s) => [s.id, { name: s.name }])),
        assigned: new Set(
          assigned
            .filter((a) => String(a.section_id) === id)
            .map((a) => `${a.subject_id}:${a.teacher_profile_id}`),
        ),
      };
      const seen = new Set<string>();
      for (const r of rows) {
        if (r.problem || r.sec?.id !== id || !r.cell) continue;
        if (!r.lesson) {
          // A free period still takes its cell: one row per day and period.
          const k = `${r.cell.day}:${r.cell.periodId}`;
          if (seen.has(k)) r.problem = { code: 'ACA.ROW_REPEATED' };
          seen.add(k);
          continue;
        }
        r.problem = lessonProblem(
          ctx,
          {
            ...r.cell,
            subjectId: r.lesson.subjectId,
            teacherId: r.lesson.teacherId,
            subjectName: r.lesson.subjectName,
          },
          seen,
        );
      }
    }
    const replaced = new Set(
      [...sections].filter((id) => !rows.some((r) => r.problem && r.sec?.id === id)),
    );
    for (;;) {
      // Who teaches when once the sheet is applied: the other sections' weeks as they are, then the
      // sheet's sections in its order.
      const taken = new Map<string, string>();
      for (const x of slots) {
        if (!replaced.has(String(x.section_id))) {
          taken.set(
            `${x.teacher_profile_id}:${x.day}:${x.period_id}`,
            school.sections.get(String(x.section_id))?.label ?? '',
          );
        }
      }
      const clashed = new Set<string>();
      for (const r of rows) {
        if (!r.sec || !replaced.has(r.sec.id) || !r.lesson || !r.cell) continue;
        const k = `${r.lesson.teacherId}:${r.cell.day}:${r.cell.periodId}`;
        const other = taken.get(k);
        if (other !== undefined && other !== r.sec.label) {
          r.problem = {
            code: 'ACA.TEACHER_CLASH',
            params: { name: r.teacherName ?? '', section: other },
          };
          clashed.add(r.sec.id);
        } else taken.set(k, r.sec.label);
      }
      if (!clashed.size) break;
      for (const id of clashed) replaced.delete(id);
    }
    for (const r of rows) {
      if (!r.problem && r.sec && !replaced.has(r.sec.id)) {
        r.problem = { code: 'UPL.SECTION_SKIPPED', params: { section: r.sec.label } };
      }
    }
    return { rows, sections, replaced };
  }
}

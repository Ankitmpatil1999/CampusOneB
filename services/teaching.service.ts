/**
 * Teacher assignments and timetables (SRS 20.7–20.9; ACA-021…026; BR-52; CR-02; CR-13; prototype
 * c.teachers, c.timetable).
 *
 * - Per academic year: one class teacher per class-section (replacing one keeps the old as history),
 *   subject teachers per section and subject, coordinators per class. A subject is taught only in a
 *   class it is mapped to. Assignments can be copied from an earlier year; a closed year can't change.
 * - A teacher with both a class-teacher and a subject-teacher assignment gets one combined portal
 *   (CR-02), shown as a flag.
 * - A timetable is a section's week: one lesson per day and period, a subject of the class taught by a
 *   teacher assigned to it there, never on a break, and never a teacher in two places in one period of
 *   the year (a unique key; RNG-ACA-443).
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, TeacherAssignmentKind } from '../models/campusone_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { assertOpen, institutionOf, yearFor, yearView, type Year } from './academic-year';
import { recordAudit } from './audit.service';
import { tellMembers } from './member-notices';
import {
  DAYS,
  TEACHING_CATEGORIES,
  classTeacherProblem,
  isTeaching,
  lessonProblem,
  subjectNotMapped,
  type LessonContext,
} from './teaching-rules';

export { DAYS };

type Db = Kysely<Database> | Transaction<Database>;

const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const hm = (t: string) => t.slice(0, 5);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The year's live class teachers, one per section; `lock` inside a write (the year is locked first). */
export async function liveClassTeachers(db: Db, yearId: string, lock = false) {
  const q = db
    .selectFrom('teacher_assignments as ta')
    .innerJoin('sections as s', 's.id', 'ta.section_id')
    .innerJoin('classes as c', 'c.id', 's.class_id')
    .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
    .select([
      'ta.id',
      'ta.section_id',
      'ta.teacher_profile_id',
      'c.name as class_name',
      's.name as section_name',
      'm.first_name',
      'm.last_name',
    ])
    .where('ta.year_id', '=', yearId)
    .where('ta.kind', '=', 'CLASS_TEACHER')
    .where('ta.ended_at', 'is', null);
  const rows = await (lock ? q.forUpdate('ta') : q).execute();
  return rows.map((r) => ({
    assignmentId: String(r.id),
    sectionId: String(r.section_id),
    sectionLabel: `${r.class_name} ${r.section_name}`,
    teacherId: String(r.teacher_profile_id),
    teacherName: nameOf(r.first_name, r.last_name),
  }));
}

export class TeachingService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async teacher(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new ValidationError([{ field: 'teacherId', code: 'ACA.NOT_A_TEACHER' }]);
    const t = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select(['m.id', 'm.first_name', 'm.last_name', 'm.status', 'ut.category'])
      .where('m.public_id', '=', uuidToBin(id))
      .where('m.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!t || !isTeaching(t)) {
      throw new ValidationError([{ field: 'teacherId', code: 'ACA.NOT_A_TEACHER' }]);
    }
    return { id: String(t.id), name: nameOf(t.first_name, t.last_name) };
  }

  private async sectionsOf(db: Db, institutionId: string, ids: readonly string[]) {
    if (!ids.length || ids.some((i) => !isUuid(i))) throw new NotFoundError();
    const rows = await db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.id', 's.public_id', 's.name', 's.class_id', 'c.name as class_name'])
      .where('s.institution_id', '=', institutionId)
      .where(
        's.public_id',
        'in',
        ids.map((i) => uuidToBin(i)),
      )
      .execute();
    if (rows.length !== new Set(ids.map((i) => i.toLowerCase())).size) throw new NotFoundError();
    return rows.map((r) => ({
      id: String(r.id),
      publicId: binToUuid(r.public_id),
      classId: String(r.class_id),
      label: `${r.class_name} ${r.name}`,
      className: r.class_name,
    }));
  }

  private async subject(db: Db, institutionId: string, id: string | undefined) {
    if (!id || !isUuid(id))
      throw new ValidationError([{ field: 'subjectId', code: 'ACA.SUBJECT_NOT_FOUND' }]);
    const s = await db
      .selectFrom('subjects')
      .select(['id', 'name'])
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!s) throw new ValidationError([{ field: 'subjectId', code: 'ACA.SUBJECT_NOT_FOUND' }]);
    return { id: String(s.id), name: s.name };
  }

  // --- ACA-078 --------------------------------------------------------------------------------------------
  /**
   * The active teachers and principals, the people a class, a subject or a coordination can be
   * given to. With the academics grant, not the members one: the Academic Coordinator assigns
   * teachers without seeing the member directory (client 2026-10-13: their teacher lists were empty).
   */
  async teachers(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rows = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.employee_no',
        'ut.name as user_type',
      ])
      .where('m.institution_id', '=', inst.id)
      .where('m.status', '=', 'ACTIVE')
      .where('ut.category', 'in', [...TEACHING_CATEGORIES])
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        name: nameOf(r.first_name, r.last_name),
        employeeNo: r.employee_no,
        userType: r.user_type,
      })),
    };
  }

  // --- ACA-021 --------------------------------------------------------------------------------------------
  async assignments(
    p: Principal,
    f: { yearId?: string | undefined; kind?: TeacherAssignmentKind | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const db = this.deps.db;
    let q = db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
      .innerJoin('classes as c', 'c.id', 'ta.class_id')
      .leftJoin('sections as s', 's.id', 'ta.section_id')
      .leftJoin('subjects as sub', 'sub.id', 'ta.subject_id')
      .select([
        'ta.id',
        'ta.public_id',
        'ta.kind',
        'ta.teacher_profile_id',
        'ta.section_id',
        'ta.subject_id',
        'ta.created_at',
        'm.public_id as teacher_public_id',
        'm.first_name',
        'm.last_name',
        'c.public_id as class_public_id',
        'c.name as class_name',
        'c.sort_order',
        's.public_id as section_public_id',
        's.name as section_name',
        'sub.public_id as subject_public_id',
        'sub.code as subject_code',
        'sub.name as subject_name',
        (eb) =>
          eb
            .selectFrom('timetable_slots as ts')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ts.teacher_profile_id', '=', 'ta.teacher_profile_id')
            .whereRef('ts.section_id', '=', 'ta.section_id')
            .whereRef('ts.subject_id', '=', 'ta.subject_id')
            .where('ts.year_id', '=', year.id)
            .as('periods'),
      ])
      .where('ta.institution_id', '=', inst.id)
      .where('ta.year_id', '=', year.id)
      .where('ta.ended_at', 'is', null);
    if (f.kind) q = q.where('ta.kind', '=', f.kind);
    const rows = await q.orderBy('c.sort_order').orderBy('s.name').orderBy('sub.name').execute();
    const classTeachers = new Set(
      rows.filter((r) => r.kind === 'CLASS_TEACHER').map((r) => String(r.teacher_profile_id)),
    );
    const subjectTeachers = new Set(
      rows.filter((r) => r.kind === 'SUBJECT_TEACHER').map((r) => String(r.teacher_profile_id)),
    );
    const sections = await db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select([
        's.id',
        's.public_id',
        's.name',
        'c.public_id as class_public_id',
        'c.name as class_name',
      ])
      .where('s.institution_id', '=', inst.id)
      .orderBy('c.sort_order')
      .orderBy('s.name')
      .execute();
    const view = (r: (typeof rows)[number]) => ({
      id: binToUuid(r.public_id),
      kind: r.kind,
      teacher: {
        id: binToUuid(r.teacher_public_id),
        name: nameOf(r.first_name, r.last_name),
        combined:
          classTeachers.has(String(r.teacher_profile_id)) &&
          subjectTeachers.has(String(r.teacher_profile_id)),
      },
      class: { id: binToUuid(r.class_public_id), name: r.class_name },
      section: r.section_public_id
        ? { id: binToUuid(r.section_public_id), name: r.section_name }
        : null,
      subject: r.subject_public_id
        ? { id: binToUuid(r.subject_public_id), code: r.subject_code, name: r.subject_name }
        : null,
      periodsAWeek: Number(r.periods ?? 0),
      since: iso(r.created_at),
    });
    const ct = rows.filter((r) => r.kind === 'CLASS_TEACHER');
    return {
      year: yearView(year),
      classTeachers: sections.map((s) => {
        const a = ct.find((r) => String(r.section_id) === String(s.id));
        return {
          section: { id: binToUuid(s.public_id), name: s.name },
          class: { id: binToUuid(s.class_public_id), name: s.class_name },
          assignment: a ? view(a) : null,
        };
      }),
      subjectTeachers: rows.filter((r) => r.kind === 'SUBJECT_TEACHER').map(view),
      coordinators: rows.filter((r) => r.kind === 'COORDINATOR').map(view),
      combinedTeachers: [...classTeachers].filter((t) => subjectTeachers.has(t)).length,
    };
  }

  // --- ACA-022 --------------------------------------------------------------------------------------------
  async assign(
    p: Principal,
    input: {
      yearId?: string | undefined;
      kind: TeacherAssignmentKind;
      teacherId?: string | undefined;
      sectionIds?: readonly string[] | undefined;
      classIds?: readonly string[] | undefined;
      subjectId?: string | undefined;
      replace?: boolean | undefined;
      copyFromYearId?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    const by = this.by(p);
    const at = this.now();
    let made = 0;
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('academic_years')
        .select('id')
        .where('id', '=', year.id)
        .forUpdate()
        .execute();
      if (input.copyFromYearId) {
        made = await this.copy(trx, inst.id, input.copyFromYearId, year, input.kind, by, at);
        return;
      }
      const t = await this.teacher(trx, inst.id, input.teacherId ?? '');
      // What the teacher is told (client 2026-10-22), and the class teacher replaced, if any.
      const given: string[] = [];
      let replaced: { profileRowId: string; what: string } | null = null;
      const insert = (v: { classId: string; sectionId: string | null; subjectId: string | null }) =>
        trx
          .insertInto('teacher_assignments')
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: inst.id,
            year_id: year.id,
            kind: input.kind,
            teacher_profile_id: t.id,
            class_id: v.classId,
            section_id: v.sectionId,
            subject_id: v.subjectId,
            created_by: by,
            created_at: at,
          })
          .execute();
      if (input.kind === 'CLASS_TEACHER') {
        const [s] = await this.sectionsOf(trx, inst.id, (input.sectionIds ?? []).slice(0, 1));
        const live = await liveClassTeachers(trx, year.id, true);
        const problem = classTeacherProblem(live, s!, t, year.label, !!input.replace);
        if (problem) throw new CustomAPIError(409, problem.code, { params: problem.params });
        const cur = live.find((a) => a.sectionId === s!.id);
        if (cur) {
          await trx
            .updateTable('teacher_assignments')
            .set({ ended_at: at, ended_by: by })
            .where('id', '=', cur.assignmentId)
            .execute();
          const prev = await trx
            .selectFrom('teacher_assignments')
            .select('teacher_profile_id')
            .where('id', '=', cur.assignmentId)
            .executeTakeFirst();
          if (prev && String(prev.teacher_profile_id) !== t.id) {
            replaced = {
              profileRowId: String(prev.teacher_profile_id),
              what: `class teacher of ${s!.label}`,
            };
          }
        }
        await insert({ classId: s!.classId, sectionId: s!.id, subjectId: null });
        given.push(`class teacher of ${s!.label}`);
        made = 1;
      } else if (input.kind === 'SUBJECT_TEACHER') {
        const sub = await this.subject(trx, inst.id, input.subjectId);
        const secs = await this.sectionsOf(trx, inst.id, input.sectionIds ?? []);
        for (const s of secs) {
          const mapped = await trx
            .selectFrom('class_subjects')
            .select('class_id')
            .where('class_id', '=', s.classId)
            .where('subject_id', '=', sub.id)
            .executeTakeFirst();
          if (!mapped) {
            const problem = subjectNotMapped(sub.name, s.className);
            throw new CustomAPIError(422, problem.code, { params: problem.params });
          }
          const exists = await trx
            .selectFrom('teacher_assignments')
            .select('id')
            .where('year_id', '=', year.id)
            .where('kind', '=', 'SUBJECT_TEACHER')
            .where('section_id', '=', s.id)
            .where('subject_id', '=', sub.id)
            .where('teacher_profile_id', '=', t.id)
            .where('ended_at', 'is', null)
            .executeTakeFirst();
          if (exists) {
            throw new CustomAPIError(409, 'ACA.ASSIGNMENT_EXISTS', {
              params: { name: t.name, subject: sub.name, section: s.label },
            });
          }
          await insert({ classId: s.classId, sectionId: s.id, subjectId: sub.id });
          given.push(`${sub.name} in ${s.label}`);
          made++;
        }
      } else {
        const ids = input.classIds ?? [];
        if (!ids.length || ids.some((i) => !isUuid(i))) throw new NotFoundError();
        const classes = await trx
          .selectFrom('classes')
          .select(['id', 'name'])
          .where('institution_id', '=', inst.id)
          .where(
            'public_id',
            'in',
            ids.map((i) => uuidToBin(i)),
          )
          .execute();
        if (classes.length !== new Set(ids.map((i) => i.toLowerCase())).size)
          throw new NotFoundError();
        for (const c of classes) {
          const exists = await trx
            .selectFrom('teacher_assignments')
            .select('id')
            .where('year_id', '=', year.id)
            .where('kind', '=', 'COORDINATOR')
            .where('class_id', '=', c.id)
            .where('teacher_profile_id', '=', t.id)
            .where('ended_at', 'is', null)
            .executeTakeFirst();
          if (exists) continue;
          await insert({ classId: String(c.id), sectionId: null, subjectId: null });
          given.push(`co-ordinator of ${c.name}`);
          made++;
        }
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TEACHER_ASSIGNED',
        entityType: 'member',
        entityRef: input.teacherId,
        after: { kind: input.kind, year: year.label, made, replace: !!input.replace },
      });
      if (given.length) {
        await tellMembers(
          trx,
          {
            institutionId: inst.id,
            profileRowIds: [t.id],
            titleKey: 'NTF.TEACHING_ASSIGNED',
            params: { what: given.join(', ') },
            body: `${year.label}. Your classes and timetable show it in the app.`,
            link: '/teacher/timetable',
          },
          at,
        );
      }
      if (replaced) {
        await tellMembers(
          trx,
          {
            institutionId: inst.id,
            profileRowIds: [replaced.profileRowId],
            titleKey: 'NTF.TEACHING_ENDED',
            params: { what: replaced.what },
            body: `${year.label}. Another teacher takes it from today.`,
            link: '/teacher/timetable',
          },
          at,
        );
      }
    });
    return { created: made, ...(await this.assignments(p, { yearId: year.publicId })) };
  }

  /** Copies an earlier year's live assignments of one kind into this year, skipping any already there. */
  private async copy(
    trx: Transaction<Database>,
    institutionId: string,
    fromYearId: string,
    year: Year,
    kind: TeacherAssignmentKind,
    by: Buffer | null,
    at: Date,
  ) {
    const from = await yearFor(trx, institutionId, fromYearId);
    let rows = await trx
      .selectFrom('teacher_assignments')
      .select(['teacher_profile_id', 'class_id', 'section_id', 'subject_id'])
      .where('institution_id', '=', institutionId)
      .where('year_id', '=', from.id)
      .where('kind', '=', kind)
      .where('ended_at', 'is', null)
      .orderBy('id')
      .execute();
    if (kind === 'CLASS_TEACHER') {
      // One class per class teacher (client 2026-10-14): a teacher who already leads a class this
      // year, or a second class of the same teacher in the earlier year, is not copied.
      const now = await trx
        .selectFrom('teacher_assignments')
        .select(['teacher_profile_id', 'section_id'])
        .where('institution_id', '=', institutionId)
        .where('year_id', '=', year.id)
        .where('kind', '=', 'CLASS_TEACHER')
        .where('ended_at', 'is', null)
        .forUpdate()
        .execute();
      const teachers = new Set(now.map((r) => String(r.teacher_profile_id)));
      const sections = new Set(now.map((r) => String(r.section_id)));
      rows = rows.filter((r) => {
        const t = String(r.teacher_profile_id);
        if (teachers.has(t) || sections.has(String(r.section_id))) return false;
        teachers.add(t);
        sections.add(String(r.section_id));
        return true;
      });
    }
    if (!rows.length) return 0;
    const res = await trx
      .insertInto('teacher_assignments')
      .ignore()
      .values(
        rows.map((r) => ({
          public_id: newPublicIdPair().bin,
          institution_id: institutionId,
          year_id: year.id,
          kind,
          teacher_profile_id: r.teacher_profile_id,
          class_id: r.class_id,
          section_id: r.section_id,
          subject_id: r.subject_id,
          created_by: by,
          created_at: at,
        })),
      )
      .executeTakeFirst();
    await recordAudit(trx, {
      institutionId,
      action: 'TEACHER_ASSIGNMENTS_COPIED',
      entityType: 'academic_year',
      entityRef: year.publicId,
      after: { kind, from: from.label, to: year.label },
    });
    return Number(res.numInsertedOrUpdatedRows ?? 0);
  }

  // --- ACA-023 --------------------------------------------------------------------------------------------
  async withdraw(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.ASSIGNMENT_NOT_FOUND');
    let yearPublic = '';
    await this.deps.db.transaction().execute(async (trx) => {
      const a = await trx
        .selectFrom('teacher_assignments as ta')
        .innerJoin('academic_years as y', 'y.id', 'ta.year_id')
        .leftJoin('sections as s', 's.id', 'ta.section_id')
        .leftJoin('classes as c', 'c.id', 'ta.class_id')
        .leftJoin('subjects as sub', 'sub.id', 'ta.subject_id')
        .select([
          'ta.id',
          'ta.kind',
          'ta.teacher_profile_id',
          'ta.section_id',
          'ta.subject_id',
          'ta.year_id',
          'ta.ended_at',
          'y.public_id as year_public_id',
          's.name as section_name',
          'c.name as class_name',
          'sub.name as subject_name',
        ])
        .where('ta.public_id', '=', uuidToBin(id))
        .where('ta.institution_id', '=', inst.id)
        .forUpdate()
        .executeTakeFirst();
      if (!a || a.ended_at) throw new CustomAPIError(404, 'ACA.ASSIGNMENT_NOT_FOUND');
      yearPublic = binToUuid(a.year_public_id);
      assertOpen(await yearFor(trx, inst.id, yearPublic));
      if (a.kind === 'SUBJECT_TEACHER') {
        const used = await trx
          .selectFrom('timetable_slots')
          .select('id')
          .where('year_id', '=', a.year_id)
          .where('teacher_profile_id', '=', a.teacher_profile_id)
          .where('section_id', '=', a.section_id!)
          .where('subject_id', '=', a.subject_id!)
          .limit(1)
          .executeTakeFirst();
        if (used) {
          throw new CustomAPIError(409, 'ACA.ASSIGNMENT_TIMETABLED', {
            params: { subject: a.subject_name ?? '', section: `${a.class_name} ${a.section_name}` },
          });
        }
      }
      await trx
        .updateTable('teacher_assignments')
        .set({ ended_at: this.now(), ended_by: this.by(p) })
        .where('id', '=', a.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TEACHER_ASSIGNMENT_WITHDRAWN',
        entityType: 'teacher_assignment',
        entityRef: id,
        after: { kind: a.kind },
      });
      // The teacher is told (client 2026-10-22).
      const section = a.class_name ? `${a.class_name} ${a.section_name ?? ''}`.trim() : '';
      const what =
        a.kind === 'CLASS_TEACHER'
          ? `class teacher of ${section}`
          : a.kind === 'SUBJECT_TEACHER'
            ? `${a.subject_name ?? 'a subject'} in ${section}`
            : `co-ordinator of ${a.class_name ?? 'a class'}`;
      await tellMembers(
        trx,
        {
          institutionId: inst.id,
          profileRowIds: [String(a.teacher_profile_id)],
          titleKey: 'NTF.TEACHING_ENDED',
          params: { what },
          body: 'The school has withdrawn this assignment.',
          link: '/teacher/timetable',
        },
        this.now(),
      );
    });
    return this.assignments(p, { yearId: yearPublic });
  }

  // --- ACA-024 / ACA-025: a section's timetable ------------------------------------------------------------
  /** A section of the institution, or 404 (looked up before a body is read). */
  async sectionOf(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    return this.section(this.deps.db, inst.id, id);
  }

  private async section(db: Db, institutionId: string, id: string) {
    const [s] = await this.sectionsOf(db, institutionId, [id]);
    return s!;
  }

  private versionOf(
    rows: readonly {
      day: number;
      period_id: string;
      subject_id: string;
      teacher_profile_id: string;
    }[],
  ) {
    const h = createHash('sha256')
      .update(
        JSON.stringify(
          [...rows]
            .map((r) => [
              r.day,
              String(r.period_id),
              String(r.subject_id),
              String(r.teacher_profile_id),
            ])
            .sort((a, b) => String(a).localeCompare(String(b))),
        ),
      )
      .digest();
    return h.readUInt32BE(0) % 1_000_000_000;
  }

  async timetable(p: Principal, sectionId: string, f: { yearId?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const db = this.deps.db;
    const s = await this.section(db, inst.id, sectionId);
    const year = await yearFor(db, inst.id, f.yearId);
    const [periods, slots, subjects, teachers] = await Promise.all([
      db
        .selectFrom('periods')
        .select(['id', 'public_id', 'name', 'starts_at', 'ends_at', 'is_break'])
        .where('institution_id', '=', inst.id)
        .orderBy('starts_at')
        .execute(),
      db
        .selectFrom('timetable_slots as ts')
        .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
        .innerJoin('member_profiles as m', 'm.id', 'ts.teacher_profile_id')
        .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
        .select([
          'ts.day',
          'ts.period_id',
          'ts.subject_id',
          'ts.teacher_profile_id',
          'pd.public_id as period_public_id',
          'sub.public_id as subject_public_id',
          'sub.name as subject_name',
          'sub.colour',
          'm.public_id as teacher_public_id',
          'm.first_name',
          'm.last_name',
        ])
        .where('ts.year_id', '=', year.id)
        .where('ts.section_id', '=', s.id)
        .execute(),
      db
        .selectFrom('class_subjects as cs')
        .innerJoin('subjects as sub', 'sub.id', 'cs.subject_id')
        .select(['sub.id', 'sub.public_id', 'sub.code', 'sub.name', 'sub.colour'])
        .where('cs.class_id', '=', s.classId)
        .orderBy('sub.name')
        .execute(),
      db
        .selectFrom('teacher_assignments as ta')
        .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
        .select(['ta.subject_id', 'm.public_id', 'm.first_name', 'm.last_name'])
        .where('ta.year_id', '=', year.id)
        .where('ta.section_id', '=', s.id)
        .where('ta.kind', '=', 'SUBJECT_TEACHER')
        .where('ta.ended_at', 'is', null)
        .execute(),
    ]);
    return {
      year: yearView(year),
      section: { id: s.publicId, label: s.label },
      days: DAYS,
      periods: periods.map((pd) => ({
        id: binToUuid(pd.public_id),
        name: pd.name,
        startsAt: hm(pd.starts_at),
        endsAt: hm(pd.ends_at),
        isBreak: !!Number(pd.is_break),
      })),
      slots: slots.map((x) => ({
        day: x.day,
        periodId: binToUuid(x.period_public_id),
        subject: { id: binToUuid(x.subject_public_id), name: x.subject_name, colour: x.colour },
        teacher: { id: binToUuid(x.teacher_public_id), name: nameOf(x.first_name, x.last_name) },
      })),
      subjects: subjects.map((sub) => ({
        id: binToUuid(sub.public_id),
        code: sub.code,
        name: sub.name,
        colour: sub.colour,
        teachers: teachers
          .filter((t) => String(t.subject_id) === String(sub.id))
          .map((t) => ({ id: binToUuid(t.public_id), name: nameOf(t.first_name, t.last_name) })),
      })),
      version: this.versionOf(slots),
    };
  }

  /** ACA-025: the section's whole week, checked and saved in one transaction. */
  async saveTimetable(
    p: Principal,
    sectionId: string,
    expected: number,
    input: {
      yearId?: string | undefined;
      slots: readonly { day: number; periodId: string; subjectId: string; teacherId: string }[];
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const s = await this.section(this.deps.db, inst.id, sectionId);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      await trx.selectFrom('sections').select('id').where('id', '=', s.id).forUpdate().execute();
      const current = await trx
        .selectFrom('timetable_slots')
        .select(['day', 'period_id', 'subject_id', 'teacher_profile_id'])
        .where('year_id', '=', year.id)
        .where('section_id', '=', s.id)
        .execute();
      if (this.versionOf(current) !== expected) throw new PreconditionFailedError();
      const periods = await trx
        .selectFrom('periods')
        .select(['id', 'public_id', 'is_break'])
        .where('institution_id', '=', inst.id)
        .execute();
      const subjects = await trx
        .selectFrom('class_subjects as cs')
        .innerJoin('subjects as sub', 'sub.id', 'cs.subject_id')
        .select(['sub.id', 'sub.public_id', 'sub.name'])
        .where('cs.class_id', '=', s.classId)
        .execute();
      const assigned = await trx
        .selectFrom('teacher_assignments as ta')
        .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
        .select(['ta.subject_id', 'ta.teacher_profile_id', 'm.public_id'])
        .where('ta.year_id', '=', year.id)
        .where('ta.section_id', '=', s.id)
        .where('ta.kind', '=', 'SUBJECT_TEACHER')
        .where('ta.ended_at', 'is', null)
        .execute();
      const ctx: LessonContext = {
        section: s,
        periods: new Map(periods.map((r) => [String(r.id), { isBreak: !!Number(r.is_break) }])),
        subjects: new Map(subjects.map((r) => [String(r.id), { name: r.name }])),
        assigned: new Set(assigned.map((a) => `${a.subject_id}:${a.teacher_profile_id}`)),
      };
      const byPublicId = <T extends { public_id: Buffer }>(list: readonly T[], id: string) =>
        isUuid(id) ? list.find((r) => binToUuid(r.public_id) === id.toLowerCase()) : undefined;
      const seen = new Set<string>();
      const rows = input.slots.map((x, i) => {
        const pd = byPublicId(periods, x.periodId);
        const sub = byPublicId(subjects, x.subjectId);
        const t = byPublicId(assigned, x.teacherId);
        const problem = lessonProblem(
          ctx,
          {
            day: x.day,
            periodId: pd ? String(pd.id) : null,
            subjectId: sub ? String(sub.id) : null,
            teacherId: t ? String(t.teacher_profile_id) : null,
          },
          seen,
        );
        if (problem) {
          throw new ValidationError([
            {
              field: `slots.${i}`,
              code: problem.code,
              ...(problem.params ? { params: problem.params } : {}),
            },
          ]);
        }
        return {
          day: x.day,
          periodId: String(pd!.id),
          subjectId: String(sub!.id),
          teacherId: String(t!.teacher_profile_id),
        };
      });
      // A teacher in two places in one period of the year (RNG-ACA-443).
      for (const r of rows) {
        const clash = await trx
          .selectFrom('timetable_slots as ts')
          .innerJoin('sections as sec', 'sec.id', 'ts.section_id')
          .innerJoin('classes as c', 'c.id', 'sec.class_id')
          .innerJoin('member_profiles as m', 'm.id', 'ts.teacher_profile_id')
          .select([
            'c.name as class_name',
            'sec.name as section_name',
            'm.first_name',
            'm.last_name',
          ])
          .where('ts.year_id', '=', year.id)
          .where('ts.teacher_profile_id', '=', r.teacherId)
          .where('ts.day', '=', r.day)
          .where('ts.period_id', '=', r.periodId)
          .where('ts.section_id', '<>', s.id)
          .executeTakeFirst();
        if (clash) {
          throw new CustomAPIError(409, 'ACA.TEACHER_CLASH', {
            params: {
              name: nameOf(clash.first_name, clash.last_name),
              section: `${clash.class_name} ${clash.section_name}`,
            },
          });
        }
      }
      await trx
        .deleteFrom('timetable_slots')
        .where('year_id', '=', year.id)
        .where('section_id', '=', s.id)
        .execute();
      if (rows.length) {
        const at = this.now();
        await trx
          .insertInto('timetable_slots')
          .values(
            rows.map((r) => ({
              institution_id: inst.id,
              year_id: year.id,
              section_id: s.id,
              day: r.day,
              period_id: r.periodId,
              subject_id: r.subjectId,
              teacher_profile_id: r.teacherId,
              updated_by: by,
              updated_at: at,
            })),
          )
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TIMETABLE_SAVED',
        entityType: 'section',
        entityRef: sectionId,
        after: { year: year.label, lessons: rows.length },
      });
    });
    return this.timetable(p, sectionId, { yearId: year.publicId });
  }

  // --- ACA-026: clashes and each teacher's week -----------------------------------------------------------
  async clashes(p: Principal, f: { yearId?: string | undefined; teacherId?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const db = this.deps.db;
    const rows = await db
      .selectFrom('timetable_slots as ts')
      .innerJoin('sections as sec', 'sec.id', 'ts.section_id')
      .innerJoin('classes as c', 'c.id', 'sec.class_id')
      .innerJoin('member_profiles as m', 'm.id', 'ts.teacher_profile_id')
      .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
      .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
      .select([
        'ts.day',
        'ts.teacher_profile_id',
        'pd.public_id as period_public_id',
        'pd.name as period_name',
        'm.public_id as teacher_public_id',
        'm.first_name',
        'm.last_name',
        'sec.public_id as section_public_id',
        'c.name as class_name',
        'sec.name as section_name',
        'sub.name as subject_name',
        'sub.colour',
      ])
      .where('ts.institution_id', '=', inst.id)
      .where('ts.year_id', '=', year.id)
      .execute();
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.teacher_profile_id}|${r.day}|${binToUuid(r.period_public_id)}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const clashes = [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({
        teacher: {
          id: binToUuid(g[0]!.teacher_public_id),
          name: nameOf(g[0]!.first_name, g[0]!.last_name),
        },
        day: g[0]!.day,
        period: { id: binToUuid(g[0]!.period_public_id), name: g[0]!.period_name },
        sections: g.map((x) => ({
          id: binToUuid(x.section_public_id),
          label: `${x.class_name} ${x.section_name}`,
          subject: x.subject_name,
        })),
      }));
    const teacherWeek = f.teacherId
      ? rows
          .filter(
            (r) =>
              isUuid(f.teacherId!) && binToUuid(r.teacher_public_id) === f.teacherId!.toLowerCase(),
          )
          .map((r) => ({
            day: r.day,
            periodId: binToUuid(r.period_public_id),
            section: {
              id: binToUuid(r.section_public_id),
              label: `${r.class_name} ${r.section_name}`,
            },
            subject: { name: r.subject_name, colour: r.colour },
          }))
      : null;
    return { year: yearView(year), clashes, teacherWeek };
  }
}

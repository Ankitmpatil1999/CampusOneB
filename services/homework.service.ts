/**
 * Homework and classwork (SRS 20.13, 20.15; ACA-048…051, ACA-067…069, ACA-075; FR-ACA-06; OI-ACA-30…35;
 * CR-07; CR-13 RNG-ACA-442; prototype m.t.hw, m.t.hw.new, m.homework, m.hw).
 *
 * - A teacher sets homework for a section they teach: as its class teacher (any subject the class
 *   studies) or as the subject teacher of the subject (OI-ACA-31). It goes to the whole class or chosen
 *   students enrolled in the section that year (OI-ACA-32), with a file (≤ 2 MB, uploaded) or a link
 *   (OI-ACA-30). Homework is due after today, classwork today or later, at 11:59 PM on the date, inside
 *   the year. Each student's record is New; the students and their families are told.
 * - The student submits once, a file or a link (OI-ACA-34); after the due time it is marked late. The
 *   record becomes Done and the teacher is told. The teacher reviews with a grade and feedback (again
 *   if needed) and the student and family are told. Those who haven't submitted can be reminded until
 *   the due time.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, HomeworkKind } from '../models/ringpe_models';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { assertInYear, assertOpen, yearFor, yearView } from './academic-year';
import { recordAudit } from './audit.service';
import type { FileService } from './file.service';
import { memberOf, teacherOf, type Member } from './member-roles';
import { notify } from './notifications.service';

type Db = Kysely<Database> | Transaction<Database>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LINK = /^https?:\/\/[^\s.]+\.[^\s]{2,}$/i;
/** The prototype's review grades (m.t.hw); any short grade is accepted. */
export const HOMEWORK_GRADES = ['A+', 'A', 'B+', 'B', 'C', 'Redo'] as const;
const KIND_LABEL: Record<HomeworkKind, string> = { HOMEWORK: 'Homework', CLASSWORK: 'Classwork' };
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
/** 11:59 PM IST on the date. */
const dueAt = (date: string) => new Date(`${date}T23:59:00.000+05:30`);

export interface HomeworkInput {
  readonly sectionId: string;
  readonly subjectId: string;
  readonly kind: HomeworkKind;
  readonly title: string;
  readonly instructions: string;
  readonly dueDate: string;
  readonly studentIds?: readonly string[] | undefined;
  readonly fileId?: string | null | undefined;
  readonly link?: string | null | undefined;
}

export class HomeworkService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly files?: FileService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private link(filePublicId: Buffer | null, scan: string | null) {
    if (!filePublicId || scan !== 'CLEAN' || !this.deps.files) return null;
    return this.deps.files.linkFor(binToUuid(filePublicId)).url;
  }

  /** The teacher's assignment to the section, for the subject as subject teacher or as class teacher. */
  private async assigned(
    db: Db,
    me: Member,
    yearId: string,
    sectionId: string,
    subjectId?: string,
  ) {
    const rows = await db
      .selectFrom('teacher_assignments')
      .select(['kind', 'subject_id'])
      .where('teacher_profile_id', '=', me.rowId)
      .where('year_id', '=', yearId)
      .where('section_id', '=', sectionId)
      .where('ended_at', 'is', null)
      .execute();
    return rows.some(
      (r) =>
        r.kind === 'CLASS_TEACHER' ||
        (r.kind === 'SUBJECT_TEACHER' &&
          (subjectId === undefined || String(r.subject_id) === subjectId)),
    );
  }

  private async fileOf(db: Db, p: Principal, institutionId: string, id: string, field: string) {
    if (!isUuid(id)) throw new ValidationError([{ field, code: 'ACA.HW_FILE' }]);
    const f = await db
      .selectFrom('files')
      .select(['id', 'scan_status', 'purpose', 'institution_id'])
      .where('public_id', '=', uuidToBin(id))
      .where('created_by', '=', this.by(p))
      .executeTakeFirst();
    if (
      !f ||
      f.scan_status === 'INFECTED' ||
      !['document', 'photo'].includes(f.purpose) ||
      (f.institution_id !== null && String(f.institution_id) !== institutionId)
    ) {
      throw new ValidationError([{ field, code: 'ACA.HW_FILE' }]);
    }
    return String(f.id);
  }

  private checkLink(link: string | null | undefined, field: string) {
    const l = (link ?? '').trim();
    if (!l) return null;
    if (l.length > 300 || !LINK.test(l))
      throw new ValidationError([{ field, code: 'ACA.HW_LINK' }]);
    return l;
  }

  // --- the teacher ---------------------------------------------------------------------------------------------
  private rows(db: Db) {
    return db
      .selectFrom('homework as h')
      .innerJoin('sections as s', 's.id', 'h.section_id')
      .innerJoin('classes as c', 'c.id', 'h.class_id')
      .innerJoin('subjects as sub', 'sub.id', 'h.subject_id')
      .innerJoin('member_profiles as t', 't.id', 'h.teacher_profile_id')
      .innerJoin('academic_years as y', 'y.id', 'h.year_id')
      .leftJoin('files as f', 'f.id', 'h.file_id')
      .selectAll('h')
      .select([
        's.public_id as section_public_id',
        's.name as section_name',
        'c.name as class_name',
        'sub.public_id as subject_public_id',
        'sub.name as subject_name',
        'sub.colour as subject_colour',
        't.public_id as teacher_public_id',
        't.first_name as teacher_first',
        't.last_name as teacher_last',
        'y.public_id as year_public_id',
        'y.label as year_label',
        'f.public_id as file_public_id',
        'f.original_name as file_name',
        'f.size_bytes as file_size',
        'f.scan_status as file_scan',
        (eb) =>
          eb
            .selectFrom('homework_students as hs')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('hs.homework_id', '=', 'h.id')
            .as('students'),
        (eb) =>
          eb
            .selectFrom('homework_submissions as x')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('x.homework_id', '=', 'h.id')
            .where('x.status', '=', 'SUBMITTED')
            .as('to_review'),
        (eb) =>
          eb
            .selectFrom('homework_submissions as x')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('x.homework_id', '=', 'h.id')
            .where('x.status', '=', 'REVIEWED')
            .as('reviewed'),
      ]);
  }

  private view(h: Awaited<ReturnType<ReturnType<HomeworkService['rows']>['execute']>>[number]) {
    const students = Number(h.students ?? 0);
    const toReview = Number(h.to_review ?? 0);
    const reviewed = Number(h.reviewed ?? 0);
    return {
      id: binToUuid(h.public_id),
      kind: h.kind,
      kindLabel: KIND_LABEL[h.kind],
      title: h.title,
      instructions: h.instructions,
      year: { id: binToUuid(h.year_public_id), label: h.year_label },
      section: {
        id: binToUuid(h.section_public_id),
        label: `${h.class_name} ${h.section_name}`,
      },
      subject: {
        id: binToUuid(h.subject_public_id),
        name: h.subject_name,
        colour: h.subject_colour,
      },
      teacher: {
        id: binToUuid(h.teacher_public_id),
        name: nameOf(h.teacher_first, h.teacher_last),
      },
      dueAt: iso(h.due_at),
      dueDate: istBusinessDate(h.due_at),
      closed: new Date(h.due_at).getTime() < this.now().getTime(),
      wholeClass: !!Number(h.whole_class),
      file: h.file_public_id
        ? {
            name: h.file_name,
            sizeBytes: Number(h.file_size ?? 0),
            url: this.link(h.file_public_id, h.file_scan),
          }
        : null,
      link: h.link,
      counts: {
        students,
        reviewed,
        toReview,
        notSubmitted: Math.max(0, students - reviewed - toReview),
      },
      createdAt: iso(h.created_at),
      version: h.row_version,
    };
  }

  private async row(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.HW_NOT_FOUND');
    const h = await this.rows(db)
      .where('h.public_id', '=', uuidToBin(id))
      .where('h.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!h) throw new CustomAPIError(404, 'ACA.HW_NOT_FOUND');
    return h;
  }

  /** ACA-048: homework the teacher set, newest first, with submission counts. */
  async teacherList(
    p: Principal,
    f: {
      yearId?: string | undefined;
      sectionId?: string | undefined;
      filter?: 'all' | 'review' | 'HOMEWORK' | 'CLASSWORK' | undefined;
    },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    let q = this.rows(this.deps.db)
      .where('h.institution_id', '=', me.institutionId)
      .where('h.teacher_profile_id', '=', me.rowId)
      .where('h.year_id', '=', year.id);
    if (f.sectionId && isUuid(f.sectionId)) q = q.where('s.public_id', '=', uuidToBin(f.sectionId));
    const all = (await q.orderBy('h.created_at', 'desc').limit(500).execute()).map((h) =>
      this.view(h),
    );
    const filter = f.filter ?? 'all';
    const items = all.filter(
      (h) => filter === 'all' || (filter === 'review' ? h.counts.toReview > 0 : h.kind === filter),
    );
    return {
      year: yearView(year),
      counts: {
        all: all.length,
        review: all.filter((h) => h.counts.toReview > 0).length,
        homework: all.filter((h) => h.kind === 'HOMEWORK').length,
        classwork: all.filter((h) => h.kind === 'CLASSWORK').length,
      },
      grades: HOMEWORK_GRADES,
      items,
    };
  }

  /** The sections and subjects the teacher may set homework for (the form's choices). */
  async choices(p: Principal, f: { yearId?: string | undefined }) {
    const me = await teacherOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const rows = await this.deps.db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('sections as s', 's.id', 'ta.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .innerJoin('class_subjects as cs', 'cs.class_id', 's.class_id')
      .innerJoin('subjects as sub', 'sub.id', 'cs.subject_id')
      .select([
        'ta.kind',
        'ta.subject_id',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.name as class_name',
        'c.sort_order',
        'sub.id as sub_id',
        'sub.public_id as subject_public_id',
        'sub.name as subject_name',
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
      .orderBy('sub.name')
      .execute();
    const seen = new Set<string>();
    const items = [];
    for (const r of rows) {
      if (r.kind === 'SUBJECT_TEACHER' && String(r.subject_id) !== String(r.sub_id)) continue;
      const key = `${binToUuid(r.section_public_id)}|${binToUuid(r.subject_public_id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        section: {
          id: binToUuid(r.section_public_id),
          label: `${r.class_name} ${r.section_name}`,
        },
        subject: { id: binToUuid(r.subject_public_id), name: r.subject_name },
        classTeacher: r.kind === 'CLASS_TEACHER',
        students: Number(r.students ?? 0),
      });
    }
    return { year: yearView(year), items };
  }

  /** ACA-049: set homework or classwork; the students' records are New and the families told. */
  async create(p: Principal, input: HomeworkInput) {
    const me = await teacherOf(this.deps.db, p);
    const at = this.now();
    const title = input.title.trim();
    const instructions = input.instructions.trim();
    if (title.length < 3 || title.length > 80) {
      throw new ValidationError([{ field: 'title', code: 'ACA.HW_TITLE' }]);
    }
    if (instructions.length < 10 || instructions.length > 600) {
      throw new ValidationError([{ field: 'instructions', code: 'ACA.HW_INSTRUCTIONS' }]);
    }
    if (!DAY.test(input.dueDate)) {
      throw new ValidationError([{ field: 'dueDate', code: 'VALIDATION.DATE' }]);
    }
    const today = istBusinessDate(at);
    if (input.kind === 'HOMEWORK' && input.dueDate <= today) {
      throw new ValidationError([{ field: 'dueDate', code: 'ACA.DUE_IN_PAST' }]);
    }
    if (input.kind === 'CLASSWORK' && input.dueDate < today) {
      throw new ValidationError([{ field: 'dueDate', code: 'ACA.CLASSWORK_DUE' }]);
    }
    if (input.fileId && input.link) {
      throw new ValidationError([{ field: 'link', code: 'ACA.HW_MATERIAL' }]);
    }
    const link = this.checkLink(input.link, 'link');
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const year = await yearFor(trx, me.institutionId, undefined);
      assertOpen(year);
      assertInYear(year, input.dueDate, 'dueDate');
      if (!isUuid(input.sectionId)) throw new CustomAPIError(403, 'ACA.NOT_ASSIGNED');
      const s = await trx
        .selectFrom('sections as s')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .select(['s.id', 's.class_id', 's.name', 'c.name as class_name'])
        .where('s.public_id', '=', uuidToBin(input.sectionId))
        .where('s.institution_id', '=', me.institutionId)
        .executeTakeFirst();
      if (!s) throw new CustomAPIError(403, 'ACA.NOT_ASSIGNED');
      const label = `${s.class_name} ${s.name}`;
      const sub = isUuid(input.subjectId)
        ? await trx
            .selectFrom('subjects as sub')
            .innerJoin('class_subjects as cs', 'cs.subject_id', 'sub.id')
            .select(['sub.id', 'sub.name'])
            .where('sub.public_id', '=', uuidToBin(input.subjectId))
            .where('sub.institution_id', '=', me.institutionId)
            .where('cs.class_id', '=', String(s.class_id))
            .executeTakeFirst()
        : undefined;
      if (!sub) throw new ValidationError([{ field: 'subjectId', code: 'ACA.SUBJECT_NOT_FOUND' }]);
      if (!(await this.assigned(trx, me, year.id, String(s.id), String(sub.id)))) {
        throw new CustomAPIError(403, 'ACA.NOT_YOUR_CLASS');
      }
      const roster = await trx
        .selectFrom('enrolments as en')
        .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
        .select(['m.id', 'm.public_id', 'm.account_id'])
        .where('en.year_id', '=', year.id)
        .where('en.section_id', '=', String(s.id))
        .execute();
      let targets = roster;
      const chosen = [...new Set((input.studentIds ?? []).map((x) => x.toLowerCase()))];
      if (chosen.length) {
        const byId = new Map(roster.map((r) => [binToUuid(r.public_id), r]));
        if (chosen.some((c) => !byId.has(c))) {
          throw new ValidationError([
            { field: 'studentIds', code: 'ACA.HW_STUDENTS', params: { section: label } },
          ]);
        }
        targets = chosen.map((c) => byId.get(c)!);
      }
      if (!targets.length) {
        throw new ValidationError([
          { field: 'studentIds', code: 'ACA.HW_STUDENTS', params: { section: label } },
        ]);
      }
      const fileRow = input.fileId
        ? await this.fileOf(trx, p, me.institutionId, input.fileId, 'fileId')
        : null;
      const ins = await trx
        .insertInto('homework')
        .values({
          public_id: pub.bin,
          institution_id: me.institutionId,
          year_id: year.id,
          class_id: String(s.class_id),
          section_id: String(s.id),
          subject_id: String(sub.id),
          teacher_profile_id: me.rowId,
          kind: input.kind,
          title,
          instructions,
          due_at: dueAt(input.dueDate),
          file_id: fileRow,
          link,
          whole_class: chosen.length ? 0 : 1,
          created_at: at,
          updated_at: at,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('homework_students')
        .values(
          targets.map((t) => ({
            homework_id: String(ins.insertId),
            student_profile_id: String(t.id),
            institution_id: me.institutionId,
            year_id: year.id,
            updated_at: at,
          })),
        )
        .execute();
      // The students (OI-ACA-32: chosen ones too) and their guardians are told.
      const accounts = await this.familyAccounts(
        trx,
        targets.map((t) => String(t.id)),
      );
      await notify(
        trx,
        {
          institutionId: me.institutionId,
          accountIds: accounts,
          about: targets.map((t) => String(t.id)),
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.HOMEWORK_SET',
          params: { type: KIND_LABEL[input.kind].toLowerCase(), title },
          body: `${sub.name} · ${label}`,
          link: `/homework/${pub.id}`,
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'HOMEWORK_SET',
        entityType: 'homework',
        entityRef: pub.id,
        after: { section: label, subject: sub.name, students: targets.length, kind: input.kind },
      });
    });
    return this.view(await this.row(this.deps.db, me.institutionId, pub.id));
  }

  /** The students' accounts and their guardians' accounts. */
  private async familyAccounts(db: Db, studentRowIds: readonly string[]) {
    if (!studentRowIds.length) return [];
    const rows = await db
      .selectFrom('member_profiles as m')
      .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
      .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select(['m.account_id', 'gm.account_id as guardian_account'])
      .where('m.id', 'in', studentRowIds as string[])
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

  private async teacherHomework(db: Db, p: Principal, id: string) {
    const me = await teacherOf(this.deps.db, p);
    const h = await this.row(db, me.institutionId, id);
    if (
      String(h.teacher_profile_id) !== me.rowId &&
      !(await this.assigned(db, me, String(h.year_id), String(h.section_id), String(h.subject_id)))
    ) {
      throw new CustomAPIError(404, 'ACA.HW_NOT_FOUND');
    }
    return { me, h };
  }

  /** ACA-050: the homework with each student it went to and their submission. */
  async submissions(p: Principal, id: string) {
    const { h } = await this.teacherHomework(this.deps.db, p, id);
    const rows = await this.deps.db
      .selectFrom('homework_students as hs')
      .innerJoin('member_profiles as m', 'm.id', 'hs.student_profile_id')
      .leftJoin('homework_submissions as x', (j) =>
        j
          .onRef('x.homework_id', '=', 'hs.homework_id')
          .onRef('x.student_profile_id', '=', 'hs.student_profile_id'),
      )
      .leftJoin('files as f', 'f.id', 'x.file_id')
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'hs.status as record_status',
        'x.public_id as submission_public_id',
        'x.status',
        'x.link',
        'x.note',
        'x.is_late',
        'x.submitted_at',
        'x.grade',
        'x.feedback',
        'x.reviewed_at',
        'x.row_version',
        'f.public_id as file_public_id',
        'f.original_name as file_name',
        'f.size_bytes as file_size',
        'f.scan_status as file_scan',
      ])
      .where('hs.homework_id', '=', h.id)
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    return {
      homework: this.view(h),
      grades: HOMEWORK_GRADES,
      rows: rows.map((r) => ({
        student: {
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          admissionNo: r.admission_no,
        },
        record: r.record_status,
        submission: r.submission_public_id
          ? {
              id: binToUuid(r.submission_public_id),
              status: r.status,
              late: !!Number(r.is_late),
              submittedAt: iso(r.submitted_at),
              file: r.file_public_id
                ? {
                    name: r.file_name,
                    sizeBytes: Number(r.file_size ?? 0),
                    url: this.link(r.file_public_id, r.file_scan),
                  }
                : null,
              link: r.link,
              note: r.note,
              grade: r.grade,
              feedback: r.feedback,
              reviewedAt: iso(r.reviewed_at),
              version: r.row_version,
            }
          : null,
      })),
    };
  }

  /** The submission of a homework the teacher may review, or 404 (looked up before the body). */
  async submissionLookup(p: Principal, id: string) {
    const me = await teacherOf(this.deps.db, p);
    return this.submissionRow(this.deps.db, me, id);
  }

  private async submissionRow(db: Db, me: Member, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.SUBMISSION_NOT_FOUND');
    const x = await db
      .selectFrom('homework_submissions as x')
      .innerJoin('homework as h', 'h.id', 'x.homework_id')
      .innerJoin('member_profiles as m', 'm.id', 'x.student_profile_id')
      .select([
        'x.id',
        'x.public_id',
        'x.status',
        'x.row_version',
        'x.student_profile_id',
        'h.id as homework_id',
        'h.public_id as homework_public_id',
        'h.title',
        'h.year_id',
        'h.section_id',
        'h.subject_id',
        'h.teacher_profile_id',
        'm.first_name',
      ])
      .where('x.public_id', '=', uuidToBin(id))
      .where('x.institution_id', '=', me.institutionId)
      .executeTakeFirst();
    if (
      !x ||
      (String(x.teacher_profile_id) !== me.rowId &&
        !(await this.assigned(
          db,
          me,
          String(x.year_id),
          String(x.section_id),
          String(x.subject_id),
        )))
    ) {
      throw new CustomAPIError(404, 'ACA.SUBMISSION_NOT_FOUND');
    }
    return x;
  }

  /** ACA-051: review with a grade and feedback (again if needed); the student and family are told. */
  async review(
    p: Principal,
    id: string,
    expected: number,
    input: { grade: string; feedback?: string | null | undefined },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const grade = input.grade.trim();
    const feedback = (input.feedback ?? '').trim() || null;
    if (!grade || grade.length > 10)
      throw new ValidationError([{ field: 'grade', code: 'ACA.GRADE' }]);
    if (feedback && feedback.length > 300) {
      throw new ValidationError([{ field: 'feedback', code: 'ACA.FEEDBACK' }]);
    }
    const at = this.now();
    let homeworkId = '';
    await this.deps.db.transaction().execute(async (trx) => {
      const x = await this.submissionRow(trx, me, id);
      homeworkId = binToUuid(x.homework_public_id);
      assertOpen(
        await yearFor(
          trx,
          me.institutionId,
          binToUuid(
            (
              await trx
                .selectFrom('academic_years')
                .select('public_id')
                .where('id', '=', String(x.year_id))
                .executeTakeFirstOrThrow()
            ).public_id,
          ),
        ),
      );
      const r = await trx
        .updateTable('homework_submissions')
        .set({
          status: 'REVIEWED',
          grade,
          feedback,
          reviewed_by: this.by(p),
          reviewed_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', x.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      await notify(
        trx,
        {
          institutionId: me.institutionId,
          accountIds: await this.familyAccounts(trx, [String(x.student_profile_id)]),
          about: [String(x.student_profile_id)],
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.HOMEWORK_REVIEWED',
          params: { title: x.title },
          body: `Grade ${grade}${feedback ? ` · “${feedback.slice(0, 60)}${feedback.length > 60 ? '…' : ''}”` : ''} · ${me.name}`,
          link: `/homework/${homeworkId}`,
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'HOMEWORK_REVIEWED',
        entityType: 'homework_submission',
        entityRef: id,
        after: { grade },
      });
    });
    const out = await this.submissions(p, homeworkId);
    return out.rows.find((r) => r.submission?.id === id.toLowerCase())!;
  }

  /** ACA-075: remind the students who haven't submitted (and their families) until the due time. */
  async remind(p: Principal, id: string) {
    const { me, h } = await this.teacherHomework(this.deps.db, p, id);
    const at = this.now();
    const missing = await this.deps.db
      .selectFrom('homework_students')
      .select('student_profile_id')
      .where('homework_id', '=', h.id)
      .where('status', '!=', 'DONE')
      .execute();
    if (!missing.length || new Date(h.due_at).getTime() < at.getTime()) {
      throw new CustomAPIError(409, 'ACA.NOTHING_TO_REMIND');
    }
    const accounts = await this.familyAccounts(
      this.deps.db,
      missing.map((m) => String(m.student_profile_id)),
    );
    await this.deps.db.transaction().execute(async (trx) => {
      await notify(
        trx,
        {
          institutionId: me.institutionId,
          accountIds: accounts,
          about: missing.map((m) => String(m.student_profile_id)),
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.HOMEWORK_REMINDER',
          params: { title: h.title },
          body: `${h.subject_name} · due ${istBusinessDate(h.due_at)}`,
          link: `/homework/${binToUuid(h.public_id)}`,
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'HOMEWORK_REMINDED',
        entityType: 'homework',
        entityRef: binToUuid(h.public_id),
        after: { students: missing.length },
      });
    });
    return { students: missing.length, notifications: accounts.length };
  }

  /** For the tenant-isolation check before a body is read. */
  async lookup(p: Principal, id: string) {
    await this.teacherHomework(this.deps.db, p, id);
  }

  // --- the student and family ----------------------------------------------------------------------------------
  private async mineRows(db: Db, me: Member, yearId: string) {
    return this.rows(db)
      .innerJoin('homework_students as hs', 'hs.homework_id', 'h.id')
      .leftJoin('homework_submissions as x', (j) =>
        j
          .onRef('x.homework_id', '=', 'h.id')
          .onRef('x.student_profile_id', '=', 'hs.student_profile_id'),
      )
      .leftJoin('files as sf', 'sf.id', 'x.file_id')
      .select([
        'hs.status as record_status',
        'x.public_id as submission_public_id',
        'x.status as submission_status',
        'x.is_late',
        'x.submitted_at',
        'x.link as submission_link',
        'x.note as submission_note',
        'x.grade',
        'x.feedback',
        'x.reviewed_at',
        'sf.public_id as sub_file_public_id',
        'sf.original_name as sub_file_name',
        'sf.size_bytes as sub_file_size',
        'sf.scan_status as sub_file_scan',
      ])
      .where('hs.student_profile_id', '=', me.rowId)
      .where('h.institution_id', '=', me.institutionId)
      .where('h.year_id', '=', yearId);
  }

  private mineView(
    r: Awaited<ReturnType<Awaited<ReturnType<HomeworkService['mineRows']>>['execute']>>[number],
  ) {
    const base = this.view(r);
    const state =
      r.submission_status === 'REVIEWED'
        ? 'REVIEWED'
        : r.submission_status === 'SUBMITTED'
          ? 'SUBMITTED'
          : base.closed
            ? 'OVERDUE'
            : 'PENDING';
    return {
      id: base.id,
      kind: base.kind,
      kindLabel: base.kindLabel,
      title: base.title,
      instructions: base.instructions,
      subject: base.subject,
      teacher: base.teacher,
      section: base.section,
      dueAt: base.dueAt,
      dueDate: base.dueDate,
      file: base.file,
      link: base.link,
      createdAt: base.createdAt,
      state,
      record: r.record_status,
      submission: r.submission_public_id
        ? {
            id: binToUuid(r.submission_public_id),
            status: r.submission_status,
            late: !!Number(r.is_late),
            submittedAt: iso(r.submitted_at),
            file: r.sub_file_public_id
              ? {
                  name: r.sub_file_name,
                  sizeBytes: Number(r.sub_file_size ?? 0),
                  url: this.link(r.sub_file_public_id, r.sub_file_scan),
                }
              : null,
            link: r.submission_link,
            note: r.submission_note,
            grade: r.grade,
            feedback: r.feedback,
            reviewedAt: iso(r.reviewed_at),
          }
        : null,
    };
  }

  /** ACA-067: the student's homework (for: a child on the account) by state. */
  async mine(
    p: Principal,
    f: {
      for?: string | undefined;
      yearId?: string | undefined;
      status?: 'PENDING' | 'SUBMITTED' | 'REVIEWED' | undefined;
    },
  ) {
    const me = await this.studentOf(p, f.for);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const all = (
      await (
        await this.mineRows(this.deps.db, me, year.id)
      )
        .orderBy('h.due_at')
        .limit(500)
        .execute()
    ).map((r) => this.mineView(r));
    const pending = all.filter((h) => h.state === 'PENDING' || h.state === 'OVERDUE');
    const today = istBusinessDate(this.now());
    const by = {
      PENDING: pending,
      SUBMITTED: all.filter((h) => h.state === 'SUBMITTED').reverse(),
      REVIEWED: all.filter((h) => h.state === 'REVIEWED').reverse(),
    };
    return {
      year: yearView(year),
      student: { id: binToUuid(uuidToBin(f.for ?? p.profileId!)), name: me.name },
      counts: {
        pending: by.PENDING.length,
        submitted: by.SUBMITTED.length,
        reviewed: by.REVIEWED.length,
        overdue: pending.filter((h) => h.state === 'OVERDUE').length,
        dueToday: pending.filter((h) => h.state === 'PENDING' && h.dueDate === today).length,
      },
      items: by[f.status ?? 'PENDING'],
    };
  }

  private async studentOf(p: Principal, forProfile?: string) {
    const me = await memberOf(this.deps.db, p, forProfile);
    if (me.category !== 'STUDENT') throw new CustomAPIError(403, 'ACA.NOT_A_STUDENT_PROFILE');
    return me;
  }

  private async mineOne(db: Db, me: Member, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.HW_NOT_FOUND');
    const r = await this.rows(db)
      .innerJoin('homework_students as hs', 'hs.homework_id', 'h.id')
      .select(['hs.status as record_status'])
      .where('h.public_id', '=', uuidToBin(id))
      .where('h.institution_id', '=', me.institutionId)
      .where('hs.student_profile_id', '=', me.rowId)
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'ACA.HW_NOT_FOUND');
    return r;
  }

  /** ACA-068: one homework of the student, with the teacher's file link and the submission. */
  async mineDetail(p: Principal, id: string, f: { for?: string | undefined }) {
    const me = await this.studentOf(p, f.for);
    const h = await this.mineOne(this.deps.db, me, id);
    const r = await (
      await this.mineRows(this.deps.db, me, String(h.year_id))
    )
      .where('h.id', '=', h.id)
      .executeTakeFirstOrThrow();
    return {
      ...this.mineView(r),
      self: !f.for || f.for.toLowerCase() === p.profileId?.toLowerCase(),
    };
  }

  /** ACA-069: the student submits once — a file or a link; late after the due time. */
  async submit(
    p: Principal,
    id: string,
    input: {
      fileId?: string | null | undefined;
      link?: string | null | undefined;
      note?: string | null | undefined;
    },
  ) {
    const me = await this.studentOf(p);
    const at = this.now();
    const note = (input.note ?? '').trim() || null;
    if (note && note.length > 300)
      throw new ValidationError([{ field: 'note', code: 'ACA.FEEDBACK' }]);
    if (!input.fileId && !(input.link ?? '').trim()) {
      throw new ValidationError([{ field: 'fileId', code: 'ACA.SUBMISSION_EMPTY' }]);
    }
    if (input.fileId && input.link) {
      throw new ValidationError([{ field: 'link', code: 'ACA.HW_MATERIAL' }]);
    }
    const link = this.checkLink(input.link, 'link');
    await this.deps.db.transaction().execute(async (trx) => {
      const h = await this.mineOne(trx, me, id);
      const year = await yearFor(trx, me.institutionId, binToUuid(h.year_public_id));
      assertOpen(year);
      const claimed = await trx
        .updateTable('homework_students')
        .set({ status: 'DONE', updated_at: at })
        .where('homework_id', '=', h.id)
        .where('student_profile_id', '=', me.rowId)
        .where('status', '=', 'NEW')
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) !== 1)
        throw new CustomAPIError(409, 'ACA.ALREADY_SUBMITTED');
      const fileRow = input.fileId
        ? await this.fileOf(trx, p, me.institutionId, input.fileId, 'fileId')
        : null;
      const late = new Date(h.due_at).getTime() < at.getTime();
      await trx
        .insertInto('homework_submissions')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: me.institutionId,
          year_id: String(h.year_id),
          homework_id: h.id,
          student_profile_id: me.rowId,
          file_id: fileRow,
          link,
          note,
          is_late: late ? 1 : 0,
          submitted_at: at,
        })
        .execute();
      const teacher = await trx
        .selectFrom('member_profiles')
        .select('account_id')
        .where('id', '=', String(h.teacher_profile_id))
        .executeTakeFirst();
      if (teacher?.account_id) {
        await notify(
          trx,
          {
            institutionId: me.institutionId,
            accountIds: [String(teacher.account_id)],
            surface: 'MEMBER',
            category: 'ACCOUNT',
            titleKey: 'NTF.HOMEWORK_SUBMITTED',
            params: { name: me.name, title: h.title },
            body: `${h.class_name} ${h.section_name} · ${h.subject_name}${late ? ' · late' : ''}`,
            link: `/teacher/homework/${id.toLowerCase()}`,
          },
          at,
        );
      }
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'HOMEWORK_SUBMITTED',
        entityType: 'homework',
        entityRef: id,
        after: { late },
      });
    });
    return this.mineDetail(p, id, {});
  }
}

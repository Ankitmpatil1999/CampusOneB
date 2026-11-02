/**
 * Academic structure (20.2, 20.4; ACA-001…003, ACA-009…013; RC-22): academic years with one
 * current year per institution, classes in order and their sections. Students are placed in a
 * section for a year (enrolments, CR-09/CR-13).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export const academicsRepository = {
  async years(db: Db, institutionId: string) {
    return db
      .selectFrom('academic_years')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .orderBy('starts_on', 'desc')
      .execute();
  },

  async currentYear(db: Db, institutionId: string) {
    return db
      .selectFrom('academic_years')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('is_current', '=', true)
      .executeTakeFirst();
  },

  async yearByPublicId(db: Db, institutionId: string, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('academic_years')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  /** Years whose dates overlap the given range (RNG-ACA-444: years never overlap). */
  async overlapping(db: Db, institutionId: string, from: string, to: string) {
    return db
      .selectFrom('academic_years')
      .select(['id', 'label'])
      .where('institution_id', '=', institutionId)
      .where('starts_on', '<=', to)
      .where('ends_on', '>=', from)
      .execute();
  },

  async insertYear(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      label: string;
      startsOn: string;
      endsOn: string;
      current: boolean;
    },
  ) {
    await db
      .insertInto('academic_years')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        label: v.label,
        starts_on: v.startsOn,
        ends_on: v.endsOn,
        status: 'OPEN',
        is_current: v.current,
      })
      .execute();
  },

  /** Moves the current designation to one Open year (guarded). */
  async makeCurrent(db: Db, institutionId: string, yearId: string) {
    await db
      .updateTable('academic_years')
      .set({ is_current: false, row_version: sql<number>`row_version + 1` })
      .where('institution_id', '=', institutionId)
      .where('is_current', '=', true)
      .execute();
    const r = await db
      .updateTable('academic_years')
      .set({
        is_current: true,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', yearId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Open → Closed (guarded); a closed year is not current. */
  async closeYear(db: Db, yearId: string) {
    const r = await db
      .updateTable('academic_years')
      .set({
        status: 'CLOSED',
        is_current: false,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', yearId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  // --- classes and sections --------------------------------------------------------------------------
  async classes(db: Db, institutionId: string) {
    return db
      .selectFrom('classes')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
  },

  async sections(db: Db, institutionId: string) {
    return db
      .selectFrom('sections')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .orderBy('class_id')
      .orderBy('name')
      .execute();
  },

  /** Active students per section in a year. */
  async sectionCounts(db: Db, institutionId: string, yearId: string) {
    return db
      .selectFrom('enrolments as e')
      .innerJoin('member_profiles as m', 'm.id', 'e.student_profile_id')
      .select(['e.section_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('e.institution_id', '=', institutionId)
      .where('e.year_id', '=', yearId)
      .where('m.status', '=', 'ACTIVE')
      .groupBy('e.section_id')
      .execute();
  },

  async classByPublicId(db: Db, institutionId: string, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('classes')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async sectionByPublicId(db: Db, institutionId: string, publicId: Buffer) {
    return db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.id', 's.public_id', 's.class_id', 's.name', 's.capacity', 'c.name as class_name'])
      .where('s.institution_id', '=', institutionId)
      .where('s.public_id', '=', publicId)
      .executeTakeFirst();
  },

  async classNameTaken(db: Db, institutionId: string, name: string, exceptId?: string) {
    let q = db
      .selectFrom('classes')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where(sql<string>`LOWER(name)`, '=', name.toLowerCase());
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  },

  async nextOrder(db: Db, institutionId: string) {
    const r = await db
      .selectFrom('classes')
      .select((e) => e.fn.max('sort_order').as('o'))
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    return r?.o === null || r?.o === undefined ? 0 : Number(r.o) + 1;
  },

  async insertClass(
    db: Db,
    v: { publicId: Buffer; institutionId: string; name: string; order: number },
  ) {
    const r = await db
      .insertInto('classes')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        name: v.name,
        sort_order: v.order,
      })
      .executeTakeFirstOrThrow();
    return String(r.insertId);
  },

  async updateClass(db: Db, id: string, expected: number, v: { name: string; order: number }) {
    const r = await db
      .updateTable('classes')
      .set({
        name: v.name,
        sort_order: v.order,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async touchClass(db: Db, id: string) {
    await db
      .updateTable('classes')
      .set({ updated_at: sql<Date>`UTC_TIMESTAMP(3)`, row_version: sql<number>`row_version + 1` })
      .where('id', '=', id)
      .execute();
  },

  async insertSection(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      classId: string;
      name: string;
      capacity: number | null;
    },
  ) {
    await db
      .insertInto('sections')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        class_id: v.classId,
        name: v.name,
        capacity: v.capacity,
      })
      .execute();
  },

  async renameSection(db: Db, id: string, name: string, capacity: number | null) {
    await db.updateTable('sections').set({ name, capacity }).where('id', '=', id).execute();
  },

  /** Students ever placed in the section (a used section is kept). */
  async sectionUsed(db: Db, sectionId: string) {
    return Boolean(
      await db
        .selectFrom('enrolments')
        .select('id')
        .where('section_id', '=', sectionId)
        .executeTakeFirst(),
    );
  },

  async deleteSection(db: Db, id: string) {
    await db.deleteFrom('sections').where('id', '=', id).execute();
  },

  // --- enrolments ------------------------------------------------------------------------------------
  async enrol(
    db: Db,
    v: {
      institutionId: string;
      studentId: string;
      yearId: string;
      sectionId: string;
      by: Buffer | null;
    },
  ) {
    await db
      .insertInto('enrolments')
      .values({
        institution_id: v.institutionId,
        student_profile_id: v.studentId,
        year_id: v.yearId,
        section_id: v.sectionId,
        created_by: v.by,
      })
      .onDuplicateKeyUpdate({ section_id: v.sectionId })
      .execute();
  },
};

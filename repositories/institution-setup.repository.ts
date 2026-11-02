/**
 * Institution set-up (SRS 7.3, 7.12.1; INS-014…019; prototype c.roles, c.fields): user types with
 * their departments, and institution-defined fields. Every query is keyed by the institution the
 * console session belongs to.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { CfEntityCode, CfTypeCode, Database, UserTypeCategory } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export const userTypesRepository = {
  async list(db: Db, institutionId: string) {
    return db
      .selectFrom('user_types as u')
      .select([
        'u.id',
        'u.public_id',
        'u.name',
        'u.category',
        'u.status',
        'u.row_version',
        (eb) =>
          eb
            .selectFrom('member_profiles as m')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('m.user_type_id', '=', 'u.id')
            .as('members'),
      ])
      .where('u.institution_id', '=', institutionId)
      .orderBy('u.id')
      .execute();
  },

  async departments(db: Db, institutionId: string) {
    return db
      .selectFrom('departments as d')
      .select([
        'd.id',
        'd.public_id',
        'd.user_type_id',
        'd.name',
        (eb) =>
          eb
            .selectFrom('member_profiles as m')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('m.department_id', '=', 'd.id')
            .as('members'),
      ])
      .where('d.institution_id', '=', institutionId)
      .orderBy('d.id')
      .execute();
  },

  async byPublicId(db: Db, institutionId: string, publicId: Buffer) {
    return db
      .selectFrom('user_types')
      .select(['id', 'public_id', 'name', 'category', 'row_version'])
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', publicId)
      .forUpdate()
      .executeTakeFirst();
  },

  async nameTaken(db: Db, institutionId: string, name: string, exceptId?: string) {
    let q = db
      .selectFrom('user_types')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where(sql<string>`LOWER(name)`, '=', name.toLowerCase());
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  },

  async insert(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      name: string;
      category: UserTypeCategory;
      by: Buffer | null;
    },
  ) {
    const r = await db
      .insertInto('user_types')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        name: v.name,
        category: v.category,
        created_by: v.by,
      })
      .executeTakeFirstOrThrow();
    return String(r.insertId);
  },

  async rename(db: Db, id: string, expected: number, name: string | undefined) {
    const r = await db
      .updateTable('user_types')
      .set({
        ...(name !== undefined ? { name } : {}),
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async addDepartment(
    db: Db,
    v: { publicId: Buffer; institutionId: string; userTypeId: string; name: string },
  ) {
    await db
      .insertInto('departments')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        user_type_id: v.userTypeId,
        name: v.name,
      })
      .execute();
  },

  async removeDepartment(db: Db, institutionId: string, id: string) {
    await db
      .deleteFrom('departments')
      .where('institution_id', '=', institutionId)
      .where('id', '=', id)
      .execute();
  },
};

export const customFieldsRepository = {
  async list(db: Db, institutionId: string, entity?: CfEntityCode) {
    let q = db
      .selectFrom('custom_field_definitions as f')
      .leftJoin('platform_accounts as a', 'a.public_id', 'f.created_by')
      .select([
        'f.id',
        'f.public_id',
        'f.entity',
        'f.label',
        'f.data_type',
        'f.is_required',
        'f.is_unique',
        'f.list_column',
        'f.filterable',
        'f.position',
        'f.status',
        'f.created_at',
        'f.row_version',
        'a.first_name',
        'a.last_name',
        (eb) =>
          eb
            .selectFrom('custom_field_values as v')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('v.field_id', '=', 'f.id')
            .as('values'),
      ])
      .where('f.institution_id', '=', institutionId)
      .orderBy('f.entity')
      .orderBy('f.position');
    if (entity) q = q.where('f.entity', '=', entity);
    return q.execute();
  },

  async options(db: Db, institutionId: string) {
    return db
      .selectFrom('custom_field_options')
      .select(['id', 'field_id', 'label', 'position', 'active'])
      .where('institution_id', '=', institutionId)
      .orderBy('position')
      .execute();
  },

  async byPublicId(db: Db, institutionId: string, publicId: Buffer) {
    return db
      .selectFrom('custom_field_definitions')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', publicId)
      .forUpdate()
      .executeTakeFirst();
  },

  async activeCount(db: Db, institutionId: string, entity: CfEntityCode, exceptId?: string) {
    let q = db
      .selectFrom('custom_field_definitions')
      .select((e) => e.fn.countAll<number>().as('n'))
      .where('institution_id', '=', institutionId)
      .where('entity', '=', entity)
      .where('status', '=', 'ACTIVE');
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Number((await q.executeTakeFirst())?.n ?? 0);
  },

  async labelTaken(
    db: Db,
    institutionId: string,
    entity: CfEntityCode,
    label: string,
    exceptId?: string,
  ) {
    let q = db
      .selectFrom('custom_field_definitions')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('entity', '=', entity)
      .where(sql<string>`LOWER(label)`, '=', label.toLowerCase());
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  },

  async nextPosition(db: Db, institutionId: string, entity: CfEntityCode) {
    const r = await db
      .selectFrom('custom_field_definitions')
      .select((e) => e.fn.max('position').as('p'))
      .where('institution_id', '=', institutionId)
      .where('entity', '=', entity)
      .executeTakeFirst();
    return Number(r?.p ?? 0) + 1;
  },

  async valueCount(db: Db, fieldId: string) {
    const r = await db
      .selectFrom('custom_field_values')
      .select((e) => e.fn.countAll<number>().as('n'))
      .where('field_id', '=', fieldId)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  },

  /** True when two captured values of the field are the same (case-insensitive). */
  async hasDuplicateValues(db: Db, fieldId: string) {
    const r = await db
      .selectFrom('custom_field_values')
      .select(
        sql<string>`LOWER(COALESCE(value_text, CAST(value_number AS CHAR), CAST(value_date AS CHAR)))`.as(
          'k',
        ),
      )
      .where('field_id', '=', fieldId)
      .groupBy('k')
      .having((e) => e.fn.countAll(), '>', 1)
      .executeTakeFirst();
    return Boolean(r);
  },

  async insert(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      entity: CfEntityCode;
      label: string;
      type: CfTypeCode;
      required: boolean;
      unique: boolean;
      listColumn: boolean;
      filter: boolean;
      position: number;
      active: boolean;
      by: Buffer | null;
      now: Date;
    },
  ) {
    const r = await db
      .insertInto('custom_field_definitions')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        entity: v.entity,
        label: v.label,
        data_type: v.type,
        is_required: v.required,
        is_unique: v.unique,
        list_column: v.listColumn,
        filterable: v.filter,
        position: v.position,
        status: v.active ? 'ACTIVE' : 'INACTIVE',
        no_id_doc_ack_at: v.now,
        deactivated_at: v.active ? null : v.now,
        created_by: v.by,
      })
      .executeTakeFirstOrThrow();
    return String(r.insertId);
  },

  async update(
    db: Db,
    id: string,
    expected: number,
    set: Partial<{
      entity: CfEntityCode;
      label: string;
      data_type: CfTypeCode;
      is_required: boolean;
      is_unique: boolean;
      list_column: boolean;
      filterable: boolean;
      status: 'ACTIVE' | 'INACTIVE';
      deactivated_at: Date | null;
      no_id_doc_ack_at: Date;
      position: number;
    }>,
  ) {
    const r = await db
      .updateTable('custom_field_definitions')
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

  /** Replaces the option list: kept options keep their id, removed ones stay as inactive. */
  async setOptions(db: Db, institutionId: string, fieldId: string, labels: readonly string[]) {
    const current = await db
      .selectFrom('custom_field_options')
      .select(['id', 'label'])
      .where('field_id', '=', fieldId)
      .execute();
    for (const [i, label] of labels.entries()) {
      const hit = current.find((c) => c.label.toLowerCase() === label.toLowerCase());
      if (hit) {
        await db
          .updateTable('custom_field_options')
          .set({ label, position: i + 1, active: true })
          .where('id', '=', hit.id)
          .execute();
      } else {
        await db
          .insertInto('custom_field_options')
          .values({ institution_id: institutionId, field_id: fieldId, label, position: i + 1 })
          .execute();
      }
    }
    const keep = new Set(labels.map((l) => l.toLowerCase()));
    const removed = current.filter((c) => !keep.has(c.label.toLowerCase())).map((c) => c.id);
    if (removed.length) {
      await db
        .updateTable('custom_field_options')
        .set({ active: false })
        .where('id', 'in', removed)
        .execute();
    }
  },
};

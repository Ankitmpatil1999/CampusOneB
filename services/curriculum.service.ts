/**
 * Subjects, the subjects each class studies, the bell schedule and the class upload (SRS 20.4–20.6;
 * ACA-014…020; FR-ACA-03; prototype c.structure).
 *
 * - A subject has a code (2–5 capitals or digits, fixed once created), a name and a colour; both are
 *   unique in the institution.
 * - A class studies the subjects mapped to it; timetables and exams offer only those. A subject still
 *   on a class's timetable can't be unmapped.
 * - Periods are named, never overlap and end after they start; a break holds no lesson; a period on a
 *   timetable can't be removed.
 * - A class sheet adds classes and sections in bulk: checked first, then imported.
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../models/campusone_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { parseCsv } from '../utils/csv';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { institutionOf, yearFor } from './academic-year';
import { recordAudit } from './audit.service';

const CODE = /^[A-Z0-9]{2,5}$/;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SECTION = /^[A-Za-z0-9]{1,12}$/;
const hm = (t: string) => t.slice(0, 5);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const t12 = (t: string) => {
  const m = minutes(t);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export class CurriculumService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  // --- ACA-015 … ACA-017: subjects ------------------------------------------------------------------------
  async subjects(p: Principal, f: { yearId?: string | undefined } = {}) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId).catch(() => null);
    const db = this.deps.db;
    const rows = await db
      .selectFrom('subjects as s')
      .select([
        's.id',
        's.public_id',
        's.code',
        's.name',
        's.colour',
        's.row_version',
        (eb) =>
          eb
            .selectFrom('class_subjects as cs')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('cs.subject_id', '=', 's.id')
            .as('classes'),
        (eb) =>
          eb
            .selectFrom('teacher_assignments as ta')
            .select(sql<number>`COUNT(DISTINCT ta.teacher_profile_id)`.as('n'))
            .whereRef('ta.subject_id', '=', 's.id')
            .where('ta.ended_at', 'is', null)
            .where('ta.year_id', '=', year?.id ?? '0')
            .as('teachers'),
        (eb) =>
          eb
            .selectFrom('timetable_slots as ts')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ts.subject_id', '=', 's.id')
            .where('ts.year_id', '=', year?.id ?? '0')
            .as('periods'),
      ])
      .where('s.institution_id', '=', inst.id)
      .orderBy('s.name')
      .execute();
    return {
      year: year ? { id: year.publicId, label: year.label } : null,
      items: rows.map((s) => ({
        id: binToUuid(s.public_id),
        code: s.code,
        name: s.name,
        colour: s.colour,
        classes: Number(s.classes ?? 0),
        teachers: Number(s.teachers ?? 0),
        periodsAWeek: Number(s.periods ?? 0),
        version: s.row_version,
      })),
    };
  }

  private subjectInput(input: { name: string; colour?: string | undefined }) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 40) {
      throw new ValidationError([{ field: 'name', code: 'ACA.SUBJECT_NAME' }]);
    }
    const colour = input.colour ?? '#2D5DA8';
    if (!COLOUR.test(colour))
      throw new ValidationError([{ field: 'colour', code: 'VALIDATION.FORMAT' }]);
    return { name, colour };
  }

  private taken(e: unknown, code: string, name: string): never {
    const msg = String((e as { message?: string }).message ?? '');
    if ((e as { errno?: number }).errno === 1062) {
      if (msg.includes('ux_subjects__code')) {
        throw new CustomAPIError(409, 'ACA.SUBJECT_CODE_TAKEN', { params: { code } });
      }
      throw new CustomAPIError(409, 'ACA.SUBJECT_NAME_TAKEN', { params: { name } });
    }
    throw e;
  }

  async createSubject(
    p: Principal,
    input: { code: string; name: string; colour?: string | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const code = input.code.trim().toUpperCase();
    if (!CODE.test(code)) throw new ValidationError([{ field: 'code', code: 'ACA.SUBJECT_CODE' }]);
    const v = this.subjectInput(input);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('subjects')
          .values({
            public_id: pub.bin,
            institution_id: inst.id,
            code,
            name: v.name,
            colour: v.colour,
            created_at: at,
            updated_at: at,
          })
          .execute();
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'SUBJECT_CREATED',
          entityType: 'subject',
          entityRef: pub.id,
          after: { code, name: v.name },
        });
      });
    } catch (e) {
      this.taken(e, code, v.name);
    }
    return (await this.subjects(p)).items.find((s) => s.id === pub.id)!;
  }

  /** A subject of the institution, or 404. */
  async subject(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.SUBJECT_NOT_FOUND');
    const s = await this.deps.db
      .selectFrom('subjects')
      .select('id')
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', inst.id)
      .executeTakeFirst();
    if (!s) throw new CustomAPIError(404, 'ACA.SUBJECT_NOT_FOUND');
  }

  async updateSubject(
    p: Principal,
    id: string,
    expected: number,
    input: { name: string; colour?: string | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.SUBJECT_NOT_FOUND');
    const v = this.subjectInput(input);
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const s = await trx
          .selectFrom('subjects')
          .selectAll()
          .where('public_id', '=', uuidToBin(id))
          .where('institution_id', '=', inst.id)
          .forUpdate()
          .executeTakeFirst();
        if (!s) throw new CustomAPIError(404, 'ACA.SUBJECT_NOT_FOUND');
        if (s.row_version !== expected) throw new PreconditionFailedError();
        await trx
          .updateTable('subjects')
          .set({
            name: v.name,
            colour: v.colour,
            updated_at: this.now(),
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', s.id)
          .execute();
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'SUBJECT_CHANGED',
          entityType: 'subject',
          entityRef: id,
          before: { name: s.name },
          after: { name: v.name },
        });
      });
    } catch (e) {
      this.taken(e, '', v.name);
    }
    return (await this.subjects(p)).items.find((s) => s.id === id)!;
  }

  // --- ACA-018: the subjects a class studies ---------------------------------------------------------------
  async classSubjects(p: Principal, classId: string) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(classId)) throw new NotFoundError();
    const c = await this.deps.db
      .selectFrom('classes')
      .select(['id', 'public_id', 'name', 'row_version'])
      .where('public_id', '=', uuidToBin(classId))
      .where('institution_id', '=', inst.id)
      .executeTakeFirst();
    if (!c) throw new NotFoundError();
    const subs = await this.deps.db
      .selectFrom('class_subjects as cs')
      .innerJoin('subjects as s', 's.id', 'cs.subject_id')
      .select(['s.public_id', 's.code', 's.name'])
      .where('cs.class_id', '=', c.id)
      .orderBy('s.name')
      .execute();
    return {
      class: { id: binToUuid(c.public_id), name: c.name },
      subjects: subs.map((s) => ({ id: binToUuid(s.public_id), code: s.code, name: s.name })),
      version: c.row_version,
    };
  }

  async setClassSubjects(
    p: Principal,
    classId: string,
    expected: number,
    subjectIds: readonly string[],
  ) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(classId)) throw new NotFoundError();
    const ids = [...new Set(subjectIds)];
    if (ids.some((i) => !isUuid(i)))
      throw new ValidationError([{ field: 'subjectIds', code: 'VALIDATION.FORMAT' }]);
    await this.deps.db.transaction().execute(async (trx) => {
      const c = await trx
        .selectFrom('classes')
        .select(['id', 'name', 'row_version'])
        .where('public_id', '=', uuidToBin(classId))
        .where('institution_id', '=', inst.id)
        .forUpdate()
        .executeTakeFirst();
      if (!c) throw new NotFoundError();
      if (c.row_version !== expected) throw new PreconditionFailedError();
      const subs = ids.length
        ? await trx
            .selectFrom('subjects')
            .select(['id', 'name'])
            .where('institution_id', '=', inst.id)
            .where(
              'public_id',
              'in',
              ids.map((i) => uuidToBin(i)),
            )
            .execute()
        : [];
      if (subs.length !== ids.length) {
        throw new ValidationError([{ field: 'subjectIds', code: 'ACA.SUBJECT_NOT_FOUND' }]);
      }
      const keep = new Set(subs.map((s) => String(s.id)));
      const current = await trx
        .selectFrom('class_subjects as cs')
        .innerJoin('subjects as s', 's.id', 'cs.subject_id')
        .select(['cs.subject_id', 's.name'])
        .where('cs.class_id', '=', c.id)
        .execute();
      for (const cur of current) {
        if (keep.has(String(cur.subject_id))) continue;
        const used = await trx
          .selectFrom('timetable_slots as ts')
          .innerJoin('sections as sec', 'sec.id', 'ts.section_id')
          .select('ts.id')
          .where('sec.class_id', '=', c.id)
          .where('ts.subject_id', '=', cur.subject_id)
          .limit(1)
          .executeTakeFirst();
        if (used) {
          throw new CustomAPIError(409, 'ACA.SUBJECT_TIMETABLED', {
            params: { class: c.name, subject: cur.name },
          });
        }
      }
      await trx.deleteFrom('class_subjects').where('class_id', '=', c.id).execute();
      if (subs.length) {
        await trx
          .insertInto('class_subjects')
          .values(subs.map((s) => ({ institution_id: inst.id, class_id: c.id, subject_id: s.id })))
          .execute();
      }
      await trx
        .updateTable('classes')
        .set({ updated_at: this.now(), row_version: sql<number>`row_version + 1` })
        .where('id', '=', c.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CLASS_SUBJECTS_SET',
        entityType: 'class',
        entityRef: classId,
        before: { subjects: current.map((x) => x.name) },
        after: { subjects: subs.map((s) => s.name) },
      });
    });
    return this.classSubjects(p, classId);
  }

  // --- ACA-019 / ACA-020: the bell schedule ----------------------------------------------------------------
  private versionOf(
    rows: { id: string; name: string; starts_at: string; ends_at: string; is_break: number }[],
  ) {
    const h = createHash('sha256')
      .update(
        JSON.stringify(
          rows.map((r) => [String(r.id), r.name, r.starts_at, r.ends_at, Number(r.is_break)]),
        ),
      )
      .digest();
    return h.readUInt32BE(0) % 1_000_000_000;
  }

  async periods(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rows = await this.deps.db
      .selectFrom('periods as pd')
      .select([
        'pd.id',
        'pd.public_id',
        'pd.name',
        'pd.starts_at',
        'pd.ends_at',
        'pd.is_break',
        (eb) =>
          eb
            .selectFrom('timetable_slots as ts')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ts.period_id', '=', 'pd.id')
            .as('slots'),
      ])
      .where('pd.institution_id', '=', inst.id)
      .orderBy('pd.starts_at')
      .execute();
    const teaching = rows.filter((r) => !Number(r.is_break));
    const breaks = rows.filter((r) => Number(r.is_break));
    const length = (r: { starts_at: string; ends_at: string }) =>
      minutes(r.ends_at) - minutes(r.starts_at);
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        name: r.name,
        startsAt: hm(r.starts_at),
        endsAt: hm(r.ends_at),
        isBreak: !!Number(r.is_break),
        minutes: length(r),
        timetableSlots: Number(r.slots ?? 0),
      })),
      summary: {
        teachingPeriods: teaching.length,
        teachingMinutes: teaching.reduce((n, r) => n + length(r), 0),
        breakMinutes: breaks.reduce((n, r) => n + length(r), 0),
      },
      version: this.versionOf(
        rows.map((r) => ({ ...r, id: String(r.id), is_break: Number(r.is_break) })),
      ),
    };
  }

  /** ACA-020: replace the bell schedule (periods kept by id, added, or removed when unused). */
  async setPeriods(
    p: Principal,
    expected: number,
    input: readonly {
      id?: string | undefined;
      name: string;
      startsAt: string;
      endsAt: string;
      isBreak: boolean;
    }[],
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const names = new Set<string>();
    input.forEach((x, i) => {
      const name = x.name.trim();
      if (!name || name.length > 30 || names.has(name.toLowerCase())) {
        throw new ValidationError([{ field: `periods.${i}.name`, code: 'ACA.PERIOD_NAME' }]);
      }
      names.add(name.toLowerCase());
      if (!TIME.test(x.startsAt) || !TIME.test(x.endsAt) || x.endsAt <= x.startsAt) {
        throw new ValidationError([{ field: `periods.${i}.endsAt`, code: 'ACA.PERIOD_TIMES' }]);
      }
    });
    const sorted = [...input].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (b.startsAt < a.endsAt) {
        throw new ValidationError([
          {
            field: `periods.${input.indexOf(b)}.startsAt`,
            code: 'ACA.PERIOD_OVERLAP',
            params: { name: a.name.trim(), from: t12(a.startsAt), to: t12(a.endsAt) },
          },
        ]);
      }
    }
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('institutions')
        .select('id')
        .where('id', '=', inst.id)
        .forUpdate()
        .execute();
      const current = await trx
        .selectFrom('periods')
        .selectAll()
        .where('institution_id', '=', inst.id)
        .orderBy('starts_at')
        .execute();
      if (
        this.versionOf(
          current.map((r) => ({ ...r, id: String(r.id), is_break: Number(r.is_break) })),
        ) !== expected
      ) {
        throw new PreconditionFailedError();
      }
      const byPublic = new Map(current.map((r) => [binToUuid(r.public_id), r]));
      const keep = new Set(input.map((x) => x.id).filter(Boolean) as string[]);
      for (const x of input) {
        if (x.id && !byPublic.has(x.id.toLowerCase())) throw new NotFoundError();
      }
      for (const r of current) {
        if (keep.has(binToUuid(r.public_id))) continue;
        const used = await trx
          .selectFrom('timetable_slots')
          .select('id')
          .where('period_id', '=', r.id)
          .limit(1)
          .executeTakeFirst();
        if (used) throw new CustomAPIError(409, 'ACA.PERIOD_IN_USE', { params: { name: r.name } });
        await trx.deleteFrom('periods').where('id', '=', r.id).execute();
      }
      // Rename to temporary names first, so a swap of names never meets the unique key.
      for (const x of input) {
        if (!x.id) continue;
        await trx
          .updateTable('periods')
          .set({ name: `~${byPublic.get(x.id.toLowerCase())!.id}` })
          .where('id', '=', byPublic.get(x.id.toLowerCase())!.id)
          .execute();
      }
      for (const x of input) {
        const values = {
          name: x.name.trim(),
          starts_at: `${x.startsAt}:00`,
          ends_at: `${x.endsAt}:00`,
          is_break: x.isBreak ? 1 : 0,
        };
        if (x.id) {
          const r = byPublic.get(x.id.toLowerCase())!;
          if (x.isBreak && !Number(r.is_break)) {
            const used = await trx
              .selectFrom('timetable_slots')
              .select('id')
              .where('period_id', '=', r.id)
              .limit(1)
              .executeTakeFirst();
            if (used)
              throw new CustomAPIError(409, 'ACA.PERIOD_IN_USE', { params: { name: r.name } });
          }
          await trx.updateTable('periods').set(values).where('id', '=', r.id).execute();
        } else {
          await trx
            .insertInto('periods')
            .values({ public_id: newPublicIdPair().bin, institution_id: inst.id, ...values })
            .execute();
        }
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'PERIODS_SET',
        entityType: 'institution',
        entityRef: p.institutionId,
        after: {
          periods: input.map(
            (x) => `${x.name.trim()} ${x.startsAt}-${x.endsAt}${x.isBreak ? ' break' : ''}`,
          ),
        },
      });
    });
    return this.periods(p);
  }

  // --- ACA-014: the class sheet ----------------------------------------------------------------------------
  async uploadClasses(p: Principal, input: { content: string; commit: boolean }) {
    const inst = await institutionOf(this.deps.db, p);
    const table = parseCsv(input.content);
    const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    const iName = header.indexOf('class_name');
    const iSecs = header.indexOf('sections');
    const iOrder = header.indexOf('order');
    if (iName < 0 || iSecs < 0)
      throw new ValidationError([{ field: 'file', code: 'UPL.HEADER_MISMATCH' }]);
    const body = table.slice(1);
    if (!body.length) throw new ValidationError([{ field: 'file', code: 'UPL.NO_ROWS' }]);
    if (body.length > 200) {
      throw new ValidationError([
        { field: 'file', code: 'UPL.TOO_MANY_ROWS', params: { max: 200 } },
      ]);
    }
    const db = this.deps.db;
    const classes = await db
      .selectFrom('classes')
      .select(['id', 'name', 'sort_order'])
      .where('institution_id', '=', inst.id)
      .execute();
    const sections = await db
      .selectFrom('sections')
      .select(['class_id', 'name'])
      .where('institution_id', '=', inst.id)
      .execute();
    const seen = new Set<string>();
    const rows = body.map((r, k) => {
      const name = (r[iName] ?? '').trim();
      const secs = (r[iSecs] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const order =
        iOrder >= 0 && (r[iOrder] ?? '').trim() ? Number((r[iOrder] ?? '').trim()) : null;
      const existing = classes.find((c) => c.name.toLowerCase() === name.toLowerCase());
      const have = existing
        ? sections
            .filter((s) => String(s.class_id) === String(existing.id))
            .map((s) => s.name.toLowerCase())
        : [];
      const add = secs.filter((s) => !have.includes(s.toLowerCase()));
      let code: string | null = null;
      if (name.length < 2 || name.length > 40) code = 'VALIDATION.FORMAT';
      else if (
        !secs.length ||
        secs.some((s) => !SECTION.test(s)) ||
        new Set(secs.map((s) => s.toLowerCase())).size !== secs.length
      ) {
        code = 'ACA.SECTION_NAMES';
      } else if (order !== null && (!Number.isInteger(order) || order < 1 || order > 99))
        code = 'VALIDATION.FORMAT';
      else if (seen.has(name.toLowerCase())) code = 'ACA.ROW_REPEATED';
      else if (!add.length) code = 'ACA.CLASS_NAME_TAKEN';
      seen.add(name.toLowerCase());
      return {
        row: k + 1,
        name,
        sections: secs,
        add,
        order,
        existing: existing?.id ?? null,
        accepted: !code,
        code,
      };
    });
    const ok = rows.filter((r) => r.accepted);
    let created = 0;
    let extended = 0;
    if (input.commit && ok.length) {
      await db.transaction().execute(async (trx) => {
        let next =
          Number(
            (
              await trx
                .selectFrom('classes')
                .select(sql<number>`COALESCE(MAX(sort_order), -1)`.as('m'))
                .where('institution_id', '=', inst.id)
                .executeTakeFirst()
            )?.m ?? -1,
          ) + 1;
        for (const r of ok) {
          let classId = r.existing ? String(r.existing) : null;
          if (!classId) {
            const ins = await trx
              .insertInto('classes')
              .values({
                public_id: newPublicIdPair().bin,
                institution_id: inst.id,
                name: r.name,
                sort_order: r.order !== null ? r.order - 1 : next++,
              })
              .executeTakeFirstOrThrow();
            classId = String(ins.insertId);
            created++;
          } else extended++;
          for (const s of r.add) {
            await trx
              .insertInto('sections')
              .values({
                public_id: newPublicIdPair().bin,
                institution_id: inst.id,
                class_id: classId,
                name: s,
              })
              .execute();
          }
        }
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'CLASSES_UPLOADED',
          entityType: 'institution',
          entityRef: p.institutionId,
          after: { created, extended, rejected: rows.length - ok.length },
        });
      });
    }
    return {
      committed: input.commit,
      accepted: ok.length,
      rejected: rows.length - ok.length,
      created,
      extended,
      rows: rows.map((r) => ({
        row: r.row,
        className: r.name,
        sections: r.sections,
        newSections: r.add,
        accepted: r.accepted,
        code: r.code,
      })),
    };
  }
}

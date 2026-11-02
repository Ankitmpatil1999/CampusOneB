/**
 * The academic calendar (SRS 20.2, 20.3; ACA-004…008; FR-ACA-02; CR-13; prototype c.calendar).
 *
 * - An entry belongs to one academic year and falls inside it: a type (holiday, exam, event,
 *   parent–teacher meeting, sports, meeting), a title, all day or timed, an audience (the whole
 *   institution, classes, sections or one member), an optional repeat (daily, weekly, monthly) until
 *   a date in the year, a colour and reminders.
 * - A closed year's calendar can't change. The same type, title and start date can't be entered twice.
 * - Deleting keeps the entry as deleted; it can be restored. Reading expands repeats into dated
 *   occurrences inside the asked range.
 * - A spreadsheet adds entries in bulk: checked first, then imported (accepted rows only).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { CalendarAudience, Database, Recurrence } from '../models/campusone_models';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import { parseCsv } from '../utils/csv';
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
import { memberOf } from './member-roles';

type Db = Kysely<Database> | Transaction<Database>;

export const CALENDAR_TYPES = ['Holiday', 'Exam', 'Event', 'PTM', 'Sports', 'Meeting'] as const;
export const HOLIDAY_TYPES = ['Public holiday', 'Institution holiday', 'Vacation'] as const;
export const REMINDERS = {
  DAY_BEFORE: '1 day before',
  HOUR_BEFORE: '1 hour before',
  MORNING_OF: 'On the day at 7:00 AM',
} as const;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OCCURRENCES = 1000;

export interface EntryInput {
  readonly yearId?: string | null | undefined;
  readonly type: string;
  readonly holidayType?: string | null | undefined;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly allDay: boolean;
  readonly startDate: string;
  readonly endDate: string;
  readonly startTime?: string | null | undefined;
  readonly endTime?: string | null | undefined;
  readonly location?: string | null | undefined;
  readonly audience: {
    readonly kind: CalendarAudience;
    readonly ids?: readonly string[] | undefined;
  };
  readonly recurrence?: Recurrence | undefined;
  readonly repeatUntil?: string | null | undefined;
  readonly colour?: string | undefined;
  readonly reminders?: readonly string[] | undefined;
}

const ymd = (d: Date | string) =>
  typeof d === 'string'
    ? d.slice(0, 10)
    : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(dd, last));
  return t.toISOString().slice(0, 10);
};
const span = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The dated occurrences of an entry inside [from, to]. */
export function occurrences(
  e: { start: string; end: string; recurrence: Recurrence; until: string | null },
  from: string,
  to: string,
) {
  const length = span(e.start, e.end);
  const out: { start: string; end: string }[] = [];
  let s = e.start;
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const end = addDays(s, length);
    if (s > to) break;
    if (end >= from) out.push({ start: s, end });
    if (e.recurrence === 'NONE') break;
    s =
      e.recurrence === 'DAILY'
        ? addDays(e.start, i + 1)
        : e.recurrence === 'WEEKLY'
          ? addDays(e.start, 7 * (i + 1))
          : addMonths(e.start, i + 1);
    if (!e.until || s > e.until) break;
  }
  return out;
}

export class CalendarService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  /** Checks an entry and resolves its audience to row ids of the institution. */
  private async check(db: Db, institutionId: string, year: Year, input: EntryInput) {
    if (!(CALENDAR_TYPES as readonly string[]).includes(input.type)) {
      throw new ValidationError([{ field: 'type', code: 'ACA.CAL_TYPE' }]);
    }
    const title = input.title.trim();
    if (title.length < 3 || title.length > 80) {
      throw new ValidationError([{ field: 'title', code: 'ACA.CAL_TITLE' }]);
    }
    for (const [f, v] of [
      ['startDate', input.startDate],
      ['endDate', input.endDate],
    ] as const) {
      if (!DAY.test(v)) throw new ValidationError([{ field: f, code: 'VALIDATION.DATE' }]);
      assertInYear(year, v, f);
    }
    if (input.endDate < input.startDate) {
      throw new ValidationError([{ field: 'endDate', code: 'ACA.CAL_DATES' }]);
    }
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (!input.allDay) {
      if (!input.startTime || !TIME.test(input.startTime)) {
        throw new ValidationError([{ field: 'startTime', code: 'ACA.CAL_TIMES' }]);
      }
      if (
        !input.endTime ||
        !TIME.test(input.endTime) ||
        (input.startDate === input.endDate && input.endTime <= input.startTime)
      ) {
        throw new ValidationError([{ field: 'endTime', code: 'ACA.CAL_TIMES' }]);
      }
      startTime = `${input.startTime}:00`;
      endTime = `${input.endTime}:00`;
    }
    const recurrence = input.recurrence ?? 'NONE';
    let until: string | null = null;
    if (recurrence !== 'NONE') {
      until = input.repeatUntil ?? null;
      if (!until || !DAY.test(until) || until < input.startDate || until > year.endsOn) {
        throw new ValidationError([{ field: 'repeatUntil', code: 'ACA.CAL_REPEAT' }]);
      }
    }
    const colour = input.colour ?? '#0C6F7D';
    if (!COLOUR.test(colour))
      throw new ValidationError([{ field: 'colour', code: 'VALIDATION.FORMAT' }]);
    const reminders = [...new Set(input.reminders ?? [])];
    if (reminders.some((r) => !(r in REMINDERS))) {
      throw new ValidationError([{ field: 'reminders', code: 'VALIDATION.FORMAT' }]);
    }
    const kind = input.audience.kind;
    const ids = [...new Set(input.audience.ids ?? [])];
    let refs: string[] = [];
    if (kind !== 'ALL') {
      if (!ids.length || ids.some((i) => !isUuid(i))) {
        throw new ValidationError([{ field: 'audience', code: 'ACA.CAL_AUDIENCE' }]);
      }
      const table =
        kind === 'CLASS' ? 'classes' : kind === 'SECTION' ? 'sections' : 'member_profiles';
      const found = await db
        .selectFrom(table)
        .select('id')
        .where('institution_id', '=', institutionId)
        .where(
          'public_id',
          'in',
          ids.map((i) => uuidToBin(i)),
        )
        .execute();
      if (found.length !== ids.length) {
        throw new ValidationError([{ field: 'audience', code: 'ACA.CAL_AUDIENCE' }]);
      }
      refs = found.map((r) => String(r.id));
    }
    return {
      title,
      startTime,
      endTime,
      recurrence,
      until,
      colour,
      reminders,
      kind,
      refs,
      holidayType:
        input.type === 'Holiday' &&
        input.holidayType &&
        (HOLIDAY_TYPES as readonly string[]).includes(input.holidayType)
          ? input.holidayType
          : input.type === 'Holiday'
            ? 'Public holiday'
            : null,
    };
  }

  private async writeTargets(
    trx: Transaction<Database>,
    entryId: string,
    kind: CalendarAudience,
    refs: string[],
  ) {
    await trx.deleteFrom('calendar_entry_targets').where('entry_id', '=', entryId).execute();
    if (kind === 'ALL' || !refs.length) return;
    await trx
      .insertInto('calendar_entry_targets')
      .values(
        refs.map((r) => ({
          entry_id: entryId,
          kind: kind as 'CLASS' | 'SECTION' | 'MEMBER',
          ref_id: r,
        })),
      )
      .execute();
  }

  private duplicate(e: unknown, title: string, date: string): never {
    if ((e as { errno?: number }).errno === 1062) {
      throw new CustomAPIError(409, 'ACA.CAL_DUPLICATE', { params: { title, date } });
    }
    throw e;
  }

  // --- ACA-005 --------------------------------------------------------------------------------------------
  async create(p: Principal, input: EntryInput) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    const c = await this.check(this.deps.db, inst.id, year, input);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const ins = await trx
          .insertInto('calendar_entries')
          .values({
            public_id: pub.bin,
            institution_id: inst.id,
            year_id: year.id,
            type: input.type,
            holiday_type: c.holidayType,
            title: c.title,
            description: input.description?.trim().slice(0, 500) || null,
            all_day: input.allDay ? 1 : 0,
            start_date: input.startDate,
            end_date: input.endDate,
            start_time: c.startTime,
            end_time: c.endTime,
            location: input.location?.trim().slice(0, 100) || null,
            audience: c.kind,
            recurrence: c.recurrence,
            repeat_until: c.until,
            colour: c.colour,
            reminders: JSON.stringify(c.reminders),
            created_by: this.by(p),
            created_at: at,
            updated_at: at,
          })
          .executeTakeFirstOrThrow();
        await this.writeTargets(trx, String(ins.insertId), c.kind, c.refs);
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'CALENDAR_ENTRY_CREATED',
          entityType: 'calendar_entry',
          entityRef: pub.id,
          after: { type: input.type, title: c.title, start: input.startDate, year: year.label },
        });
      });
    } catch (e) {
      this.duplicate(e, c.title, input.startDate);
    }
    return this.entry(p, pub.id);
  }

  private async locked(trx: Transaction<Database>, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.ENTRY_NOT_FOUND');
    const e = await trx
      .selectFrom('calendar_entries')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', institutionId)
      .forUpdate()
      .executeTakeFirst();
    if (!e) throw new CustomAPIError(404, 'ACA.ENTRY_NOT_FOUND');
    const year = await yearFor(trx, institutionId, await this.yearPublic(trx, String(e.year_id)));
    assertOpen(year);
    return { e, year };
  }

  private async yearPublic(db: Db, yearRowId: string) {
    const y = await db
      .selectFrom('academic_years')
      .select('public_id')
      .where('id', '=', yearRowId)
      .executeTakeFirstOrThrow();
    return binToUuid(y.public_id);
  }

  // --- ACA-006: edit, or restore a deleted entry ----------------------------------------------------------
  async update(p: Principal, id: string, expected: number, input: EntryInput | { restore: true }) {
    const inst = await institutionOf(this.deps.db, p);
    const at = this.now();
    let title = '';
    let date = '';
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const { e, year } = await this.locked(trx, inst.id, id);
        if (e.row_version !== expected) throw new PreconditionFailedError();
        if ('restore' in input) {
          title = e.title;
          date = ymd(e.start_date);
          await trx
            .updateTable('calendar_entries')
            .set({
              deleted_at: null,
              deleted_by: null,
              updated_by: this.by(p),
              updated_at: at,
              row_version: sql<number>`row_version + 1`,
            })
            .where('id', '=', e.id)
            .execute();
          await recordAudit(trx, {
            institutionId: inst.id,
            action: 'CALENDAR_ENTRY_RESTORED',
            entityType: 'calendar_entry',
            entityRef: id,
          });
          return;
        }
        if (e.deleted_at) throw new CustomAPIError(404, 'ACA.ENTRY_NOT_FOUND');
        const c = await this.check(trx, inst.id, year, { ...input, yearId: year.publicId });
        title = c.title;
        date = input.startDate;
        await trx
          .updateTable('calendar_entries')
          .set({
            type: input.type,
            holiday_type: c.holidayType,
            title: c.title,
            description: input.description?.trim().slice(0, 500) || null,
            all_day: input.allDay ? 1 : 0,
            start_date: input.startDate,
            end_date: input.endDate,
            start_time: c.startTime,
            end_time: c.endTime,
            location: input.location?.trim().slice(0, 100) || null,
            audience: c.kind,
            recurrence: c.recurrence,
            repeat_until: c.until,
            colour: c.colour,
            reminders: JSON.stringify(c.reminders),
            updated_by: this.by(p),
            updated_at: at,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', e.id)
          .execute();
        await this.writeTargets(trx, String(e.id), c.kind, c.refs);
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'CALENDAR_ENTRY_CHANGED',
          entityType: 'calendar_entry',
          entityRef: id,
          before: { title: e.title, start: ymd(e.start_date) },
          after: { title: c.title, start: input.startDate },
        });
      });
    } catch (e) {
      this.duplicate(e, title, date);
    }
    return this.entry(p, id);
  }

  // --- ACA-007: soft delete --------------------------------------------------------------------------------
  async remove(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    await this.deps.db.transaction().execute(async (trx) => {
      const { e } = await this.locked(trx, inst.id, id);
      if (e.deleted_at) return;
      await trx
        .updateTable('calendar_entries')
        .set({
          deleted_at: this.now(),
          deleted_by: this.by(p),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', e.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CALENDAR_ENTRY_DELETED',
        entityType: 'calendar_entry',
        entityRef: id,
      });
    });
    return this.entry(p, id);
  }

  // --- reading (ACA-004) -----------------------------------------------------------------------------------
  private rows(db: Db, institutionId: string) {
    return db
      .selectFrom('calendar_entries as e')
      .leftJoin('platform_accounts as a', 'a.public_id', 'e.created_by')
      .selectAll('e')
      .select(['a.first_name', 'a.last_name'])
      .where('e.institution_id', '=', institutionId);
  }

  private async targets(db: Db, entryIds: string[]) {
    if (!entryIds.length) return new Map<string, { kind: string; id: string; name: string }[]>();
    const rows = await db
      .selectFrom('calendar_entry_targets as t')
      .leftJoin('classes as c', (j) => j.onRef('c.id', '=', 't.ref_id').on('t.kind', '=', 'CLASS'))
      .leftJoin('sections as s', (j) =>
        j.onRef('s.id', '=', 't.ref_id').on('t.kind', '=', 'SECTION'),
      )
      .leftJoin('classes as sc', 'sc.id', 's.class_id')
      .leftJoin('member_profiles as m', (j) =>
        j.onRef('m.id', '=', 't.ref_id').on('t.kind', '=', 'MEMBER'),
      )
      .select([
        't.entry_id',
        't.kind',
        'c.public_id as class_public_id',
        'c.name as class_name',
        's.public_id as section_public_id',
        's.name as section_name',
        'sc.name as section_class_name',
        'm.public_id as member_public_id',
        'm.first_name',
        'm.last_name',
      ])
      .where('t.entry_id', 'in', entryIds)
      .execute();
    const out = new Map<string, { kind: string; id: string; name: string }[]>();
    for (const r of rows) {
      const list = out.get(String(r.entry_id)) ?? [];
      if (r.kind === 'CLASS' && r.class_public_id) {
        list.push({ kind: 'CLASS', id: binToUuid(r.class_public_id), name: r.class_name ?? '' });
      } else if (r.kind === 'SECTION' && r.section_public_id) {
        list.push({
          kind: 'SECTION',
          id: binToUuid(r.section_public_id),
          name: `${r.section_class_name ?? ''} ${r.section_name ?? ''}`.trim(),
        });
      } else if (r.kind === 'MEMBER' && r.member_public_id) {
        list.push({
          kind: 'MEMBER',
          id: binToUuid(r.member_public_id),
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        });
      }
      out.set(String(r.entry_id), list);
    }
    return out;
  }

  private view(
    e: Awaited<ReturnType<ReturnType<CalendarService['rows']>['execute']>>[number],
    targets: { kind: string; id: string; name: string }[],
  ) {
    return {
      id: binToUuid(e.public_id),
      type: e.type,
      holidayType: e.holiday_type,
      title: e.title,
      description: e.description,
      allDay: !!Number(e.all_day),
      startDate: ymd(e.start_date),
      endDate: ymd(e.end_date),
      startTime: hm(e.start_time),
      endTime: hm(e.end_time),
      location: e.location,
      audience: { kind: e.audience, targets },
      recurrence: e.recurrence,
      repeatUntil: e.repeat_until ? ymd(e.repeat_until) : null,
      colour: e.colour,
      reminders: (typeof e.reminders === 'string'
        ? JSON.parse(e.reminders)
        : e.reminders) as string[],
      source: e.source,
      createdBy: [e.first_name, e.last_name].filter(Boolean).join(' ') || null,
      createdAt: iso(e.created_at),
      deleted: e.deleted_at ? { at: iso(e.deleted_at) } : null,
      version: e.row_version,
    };
  }

  async entry(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.ENTRY_NOT_FOUND');
    const e = await this.rows(this.deps.db, inst.id)
      .where('e.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!e) throw new CustomAPIError(404, 'ACA.ENTRY_NOT_FOUND');
    return this.view(e, (await this.targets(this.deps.db, [String(e.id)])).get(String(e.id)) ?? []);
  }

  /** ACA-004: the year's entries (or a range of it) with their occurrences; deleted ones on request. */
  async list(
    p: Principal,
    f: {
      yearId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      type?: string | undefined;
      deleted?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const from = f.from && DAY.test(f.from) ? f.from : year.startsOn;
    const to = f.to && DAY.test(f.to) ? f.to : year.endsOn;
    let q = this.rows(this.deps.db, inst.id).where('e.year_id', '=', year.id);
    if (!f.deleted) q = q.where('e.deleted_at', 'is', null);
    if (f.type) q = q.where('e.type', '=', f.type);
    const rows = await q.orderBy('e.start_date').orderBy('e.start_time').orderBy('e.id').execute();
    const targets = await this.targets(
      this.deps.db,
      rows.map((r) => String(r.id)),
    );
    const items = rows
      .map((e) => ({
        ...this.view(e, targets.get(String(e.id)) ?? []),
        occurrences: occurrences(
          {
            start: ymd(e.start_date),
            end: ymd(e.end_date),
            recurrence: e.recurrence,
            until: e.repeat_until ? ymd(e.repeat_until) : null,
          },
          from,
          to,
        ),
      }))
      .filter((e) => e.occurrences.length || e.deleted);
    const live = items.filter((e) => !e.deleted);
    const holidays = live.filter((e) => e.type === 'Holiday');
    return {
      year: yearView(year),
      from,
      to,
      types: CALENDAR_TYPES,
      holidayTypes: HOLIDAY_TYPES,
      reminders: REMINDERS,
      counts: {
        entries: live.length,
        holidays: holidays.length,
        holidayDays: holidays.reduce(
          (n, e) => n + e.occurrences.reduce((m, o) => m + span(o.start, o.end) + 1, 0),
          0,
        ),
        exams: live.filter((e) => e.type === 'Exam').length,
      },
      items,
    };
  }

  /**
   * ACA-066: the member's calendar (for: a child on the account) — entries for everyone, for the
   * student's class or section that year, or for the member — with their occurrences in the range.
   */
  async mine(
    p: Principal,
    f: {
      for?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      yearId?: string | undefined;
    },
  ) {
    const me = await memberOf(this.deps.db, p, f.for);
    const year = await yearFor(this.deps.db, me.institutionId, f.yearId);
    const from = f.from && DAY.test(f.from) ? f.from : year.startsOn;
    const to = f.to && DAY.test(f.to) ? f.to : year.endsOn;
    const en = await this.deps.db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .select(['en.section_id', 's.class_id'])
      .where('en.student_profile_id', '=', me.rowId)
      .where('en.year_id', '=', year.id)
      .executeTakeFirst();
    const rows = await this.rows(this.deps.db, me.institutionId)
      .where('e.year_id', '=', year.id)
      .where('e.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('e.audience', '=', 'ALL'),
          eb.exists(
            eb
              .selectFrom('calendar_entry_targets as t')
              .select('t.entry_id')
              .whereRef('t.entry_id', '=', 'e.id')
              .where((x) =>
                x.or([
                  x.and([x('t.kind', '=', 'MEMBER'), x('t.ref_id', '=', me.rowId)]),
                  ...(en
                    ? [
                        x.and([
                          x('t.kind', '=', 'SECTION'),
                          x('t.ref_id', '=', String(en.section_id)),
                        ]),
                        x.and([x('t.kind', '=', 'CLASS'), x('t.ref_id', '=', String(en.class_id))]),
                      ]
                    : []),
                ]),
              ),
          ),
        ]),
      )
      .orderBy('e.start_date')
      .orderBy('e.start_time')
      .execute();
    const items = rows
      .map((e) => {
        const v = this.view(e, []);
        return {
          id: v.id,
          type: v.type,
          holidayType: v.holidayType,
          title: v.title,
          description: v.description,
          allDay: v.allDay,
          startTime: v.startTime,
          endTime: v.endTime,
          location: v.location,
          colour: v.colour,
          occurrences: occurrences(
            {
              start: ymd(e.start_date),
              end: ymd(e.end_date),
              recurrence: e.recurrence,
              until: e.repeat_until ? ymd(e.repeat_until) : null,
            },
            from,
            to,
          ),
        };
      })
      .filter((e) => e.occurrences.length);
    return { year: yearView(year), from, to, items };
  }

  // --- ACA-008: bulk upload ---------------------------------------------------------------------------------
  async upload(
    p: Principal,
    input: { yearId?: string | undefined; content: string; commit: boolean },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    const table = parseCsv(input.content);
    const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    const cols = ['type', 'title', 'start_date', 'end_date', 'all_day', 'colour'];
    const idx = Object.fromEntries(cols.map((c) => [c, header.indexOf(c)]));
    if (['type', 'title', 'start_date'].some((c) => idx[c]! < 0)) {
      throw new ValidationError([{ field: 'file', code: 'UPL.HEADER_MISMATCH' }]);
    }
    const body = table.slice(1);
    if (!body.length) throw new ValidationError([{ field: 'file', code: 'UPL.NO_ROWS' }]);
    if (body.length > 500) {
      throw new ValidationError([
        { field: 'file', code: 'UPL.TOO_MANY_ROWS', params: { max: 500 } },
      ]);
    }
    const cell = (r: string[], c: string) => (idx[c]! >= 0 ? (r[idx[c]!] ?? '').trim() : '');
    const seen = new Set<string>();
    const rows: { n: number; input: EntryInput; ok: boolean; code: string | null }[] = [];
    for (const [k, r] of body.entries()) {
      const type =
        CALENDAR_TYPES.find((t) => t.toLowerCase() === cell(r, 'type').toLowerCase()) ??
        cell(r, 'type');
      const start = cell(r, 'start_date');
      const entry: EntryInput = {
        yearId: year.publicId,
        type,
        title: cell(r, 'title'),
        allDay: !/^(no|n|false|0)$/i.test(cell(r, 'all_day') || 'yes'),
        startDate: start,
        endDate: cell(r, 'end_date') || start,
        audience: { kind: 'ALL' },
        ...(cell(r, 'colour') ? { colour: cell(r, 'colour') } : {}),
      };
      let code: string | null = null;
      try {
        if (!entry.allDay) throw new ValidationError([{ field: 'all_day', code: 'ACA.CAL_TIMES' }]);
        await this.check(this.deps.db, inst.id, year, entry);
        const key = `${type}|${start}|${entry.title.trim().toLowerCase()}`;
        const dup =
          seen.has(key) ||
          !!(await this.deps.db
            .selectFrom('calendar_entries')
            .select('id')
            .where('institution_id', '=', inst.id)
            .where('year_id', '=', year.id)
            .where('type', '=', type)
            .where('start_date', '=', start)
            .where('title', '=', entry.title.trim())
            .where('deleted_at', 'is', null)
            .executeTakeFirst());
        if (dup) code = 'ACA.CAL_DUPLICATE';
        seen.add(key);
      } catch (e) {
        if (!(e instanceof CustomAPIError)) throw e;
        code = e.errors[0]?.code ?? e.code;
      }
      rows.push({ n: k + 1, input: entry, ok: !code, code });
    }
    const accepted = rows.filter((r) => r.ok);
    let imported = 0;
    if (input.commit && accepted.length) {
      const at = this.now();
      await this.deps.db.transaction().execute(async (trx) => {
        for (const r of accepted) {
          await trx
            .insertInto('calendar_entries')
            .values({
              public_id: newPublicIdPair().bin,
              institution_id: inst.id,
              year_id: year.id,
              type: r.input.type,
              holiday_type: r.input.type === 'Holiday' ? 'Public holiday' : null,
              title: r.input.title.trim(),
              all_day: 1,
              start_date: r.input.startDate,
              end_date: r.input.endDate,
              audience: 'ALL',
              recurrence: 'NONE',
              colour: r.input.colour ?? '#0C6F7D',
              reminders: '[]',
              source: 'UPLOAD',
              created_by: this.by(p),
              created_at: at,
              updated_at: at,
            })
            .execute();
          imported++;
        }
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'CALENDAR_UPLOADED',
          entityType: 'calendar_entry',
          after: { year: year.label, imported, rejected: rows.length - accepted.length },
        });
      });
    }
    return {
      year: yearView(year),
      committed: input.commit,
      accepted: accepted.length,
      rejected: rows.length - accepted.length,
      imported,
      rows: rows.map((r) => ({
        row: r.n,
        type: r.input.type,
        title: r.input.title,
        startDate: r.input.startDate,
        endDate: r.input.endDate,
        accepted: r.ok,
        code: r.code,
      })),
    };
  }
}

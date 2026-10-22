/**
 * Fee collection details (client 2026-10-16, 2026-10-19; FEE-044, FEE-045): for an academic year —
 * the current one unless another is chosen — its students with what each fee head has collected, the
 * application and admission fees, and the total collected; narrowed by class, section and, when one
 * is chosen, an approved fee structure (then only its heads and its assigned students). Summary
 * figures cover every student the filters keep; the rows come a page at a time. One student's
 * instalments of every head on request.
 *
 * Every figure is read from the fee records and the collections against them: fee_collections keeps
 * the fee part of each payment apart from the late fine, and only the fee part counts here. A
 * record's collection is shared between its heads in proportion to their amounts — all of each head
 * once the record is paid in full. Cancelled records are left out. The application and admission
 * fees are the payments on the student's approved application of that year; a student already at
 * the school (an import) owes neither.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database, FeeRecordStatus } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';

const nameOf = (first: string | null, last: string | null) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** A record without head lines is shown under this column. */
const OTHER = { key: 'other', id: 'other', name: 'Other fees', order: Number.MAX_SAFE_INTEGER };
const PAGE_SIZE = 15;
const PAGE_SIZE_MAX = 100;
/** An instalment Collect fee can still take (as fee-payments.service.ts). */
const OPEN_STATUSES: readonly FeeRecordStatus[] = ['DUE', 'OVERDUE', 'PARTIALLY_PAID'];

/** A record's fee collection shared between its heads by amount; the remainder on the last head. */
export function headShares(
  collectedPaise: number,
  heads: readonly { readonly key: string; readonly amountPaise: number }[],
): Map<string, number> {
  const total = heads.reduce((a, h) => a + h.amountPaise, 0);
  const out = new Map<string, number>();
  if (collectedPaise >= total) {
    for (const h of heads) out.set(h.key, h.amountPaise);
    return out;
  }
  let given = 0;
  heads.forEach((h, i) => {
    const share =
      i === heads.length - 1
        ? collectedPaise - given
        : total
          ? Math.floor((collectedPaise * h.amountPaise) / total)
          : 0;
    out.set(h.key, share);
    given += share;
  });
  return out;
}

/** A head's line of an instalment: paid, part paid, or the record's own state. */
const lineStatus = (
  amount: number,
  collected: number,
  r: { status: FeeRecordStatus; financed: unknown },
) =>
  collected >= amount && amount > 0
    ? 'PAID'
    : collected > 0
      ? 'PARTIALLY_PAID'
      : Number(r.financed)
        ? 'FINANCED'
        : r.status === 'PAID'
          ? 'PAID'
          : r.status;

const sums = (amount: number, collected: number) => ({
  amount: toMoneyDto(amount),
  collected: toMoneyDto(collected),
  pending: toMoneyDto(Math.max(0, amount - collected)),
});

export interface CollectionFilter {
  readonly yearId?: string | undefined;
  readonly structureId?: string | undefined;
  readonly classId?: string | undefined;
  readonly sectionId?: string | undefined;
  readonly q?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

interface Column {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly order: number;
}

/** A record's line of one head, with the part of the record's collection that is its. */
interface Line extends Column {
  readonly amountPaise: number;
  readonly collectedPaise: number;
}

/** An application or admission fee: the payment made, or the fee still owed. */
interface Entry {
  readonly amountPaise: number;
  readonly collectedPaise: number;
  readonly status: 'PENDING' | 'PAID' | 'FAILED';
  readonly mode: 'ONLINE' | 'CASH' | null;
  readonly receiptNo: string | null;
}

export class FeeCollectionService {
  constructor(private readonly deps: { readonly db: Kysely<Database> }) {}

  private async inst(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!i) throw new NotFoundError();
    return i;
  }

  /** The chosen year, or the current one. */
  private async yearOf(institutionId: string, yearId?: string) {
    let q = this.deps.db
      .selectFrom('academic_years')
      .select(['id', 'public_id', 'label'])
      .where('institution_id', '=', institutionId);
    if (yearId) {
      if (!isUuid(yearId)) throw new NotFoundError();
      q = q.where('public_id', '=', uuidToBin(yearId));
    } else q = q.where('is_current', '=', 1);
    const y = await q.executeTakeFirst();
    if (!y) {
      if (yearId) throw new NotFoundError();
      throw new CustomAPIError(409, 'ACA.NO_CURRENT_YEAR');
    }
    return y;
  }

  /** A structure of the year, its approved version and that version's heads in order. */
  private async structureOf(institutionId: string, yearRowId: string, structureId: string) {
    if (!isUuid(structureId)) throw new NotFoundError();
    const db = this.deps.db;
    const s = await db
      .selectFrom('fee_structures')
      .select(['id', 'public_id', 'name'])
      .where('institution_id', '=', institutionId)
      .where('year_id', '=', yearRowId)
      .where('public_id', '=', uuidToBin(structureId))
      .executeTakeFirst();
    if (!s) throw new NotFoundError();
    const v = await db
      .selectFrom('fee_structure_versions')
      .select(['id', 'version_no'])
      .where('structure_id', '=', s.id)
      .where('state', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!v) throw new CustomAPIError(409, 'FEE.STRUCTURE_NOT_APPROVED');
    const heads = await db
      .selectFrom('fee_structure_heads as sh')
      .innerJoin('fee_heads as h', 'h.id', 'sh.head_id')
      .select(['sh.head_id', 'h.public_id', 'h.name'])
      .where('sh.version_id', '=', v.id)
      .orderBy('sh.sort_order')
      .execute();
    return { s, v, heads };
  }

  /**
   * The year's records — of the structure's live assignments when one is chosen — with their head
   * lines and what was collected on each, by student (row id).
   */
  private async recordsOf(
    institutionId: string,
    yearRowId: string,
    structureRowId: string | null,
    studentRowId?: string,
  ) {
    const db = this.deps.db;
    const ids = () => {
      let q = db
        .selectFrom('fee_records as r')
        .select('r.id')
        .where('r.institution_id', '=', institutionId)
        .where('r.year_id', '=', yearRowId)
        .where('r.status', '<>', 'CANCELLED');
      if (structureRowId) {
        q = q.where((eb) =>
          eb.exists(
            eb
              .selectFrom('fee_assignments as fa')
              .select('fa.id')
              .whereRef('fa.id', '=', 'r.assignment_id')
              .where('fa.structure_id', '=', structureRowId)
              .where('fa.status', '=', 'ACTIVE'),
          ),
        );
      }
      if (studentRowId) q = q.where('r.student_profile_id', '=', studentRowId);
      return q;
    };
    const [rs, hs, ps] = await Promise.all([
      db
        .selectFrom('fee_records as r')
        .select([
          'r.id',
          'r.student_profile_id',
          'r.instalment_seq',
          'r.label',
          'r.due_date',
          'r.amount_paise',
          'r.status',
          'r.financed',
        ])
        .where('r.id', 'in', ids())
        .orderBy('r.due_date')
        .orderBy('r.instalment_seq')
        .execute(),
      db
        .selectFrom('fee_record_heads as rh')
        .innerJoin('fee_heads as h', 'h.id', 'rh.head_id')
        .select([
          'rh.record_id',
          'rh.head_id',
          'h.public_id',
          'h.sort_order',
          'rh.name',
          'rh.amount_paise',
        ])
        .where('rh.record_id', 'in', ids())
        .execute(),
      db
        .selectFrom('fee_collections as fc')
        .select(['fc.record_id', sql<string>`SUM(fc.amount_paise)`.as('fee')])
        .where('fc.record_id', 'in', ids())
        .groupBy('fc.record_id')
        .execute(),
    ]);
    const headsOf = new Map<string, typeof hs>();
    for (const h of hs) {
      const k = String(h.record_id);
      headsOf.set(k, [...(headsOf.get(k) ?? []), h]);
    }
    const collected = new Map(ps.map((x) => [String(x.record_id), Number(x.fee ?? 0)]));
    const byStudent = new Map<string, { record: (typeof rs)[number]; lines: Line[] }[]>();
    for (const r of rs) {
      const own = headsOf.get(String(r.id)) ?? [];
      const lines = own.length
        ? own.map((h) => ({
            key: String(h.head_id),
            id: binToUuid(h.public_id),
            name: h.name,
            order: Number(h.sort_order),
            amountPaise: Number(h.amount_paise),
          }))
        : [{ ...OTHER, amountPaise: Number(r.amount_paise) }];
      const share = headShares(collected.get(String(r.id)) ?? 0, lines);
      const k = String(r.student_profile_id);
      byStudent.set(k, [
        ...(byStudent.get(k) ?? []),
        { record: r, lines: lines.map((l) => ({ ...l, collectedPaise: share.get(l.key) ?? 0 })) },
      ]);
    }
    return byStudent;
  }

  /**
   * The head columns: the chosen structure's approved heads in its order, else every head of the
   * year's structures in the head master's order; then any head only the records carry.
   */
  private async columns(
    institutionId: string,
    yearRowId: string,
    structure: Awaited<ReturnType<FeeCollectionService['structureOf']>> | null,
    records: ReadonlyMap<string, readonly { readonly lines: readonly Line[] }[]>,
  ) {
    const cols: Column[] = [];
    if (structure) {
      for (const h of structure.heads) {
        cols.push({ key: String(h.head_id), id: binToUuid(h.public_id), name: h.name, order: 0 });
      }
    } else {
      const heads = await this.deps.db
        .selectFrom('fee_structure_heads as sh')
        .innerJoin('fee_structure_versions as v', 'v.id', 'sh.version_id')
        .innerJoin('fee_structures as s', 's.id', 'v.structure_id')
        .innerJoin('fee_heads as h', 'h.id', 'sh.head_id')
        .select(['h.id', 'h.public_id', 'h.name', 'h.sort_order'])
        .distinct()
        .where('s.institution_id', '=', institutionId)
        .where('s.year_id', '=', yearRowId)
        .execute();
      for (const h of heads) {
        cols.push({
          key: String(h.id),
          id: binToUuid(h.public_id),
          name: h.name,
          order: Number(h.sort_order),
        });
      }
    }
    const extra: Column[] = [];
    for (const list of records.values()) {
      for (const r of list) {
        for (const l of r.lines) {
          if (!cols.some((c) => c.key === l.key) && !extra.some((c) => c.key === l.key)) {
            extra.push({ key: l.key, id: l.id, name: l.name, order: l.order });
          }
        }
      }
    }
    const byOrder = (a: Column, b: Column) => a.order - b.order || a.name.localeCompare(b.name);
    if (!structure) cols.sort(byOrder);
    return [...cols, ...extra.sort(byOrder)];
  }

  /** The students: the structure's assigned ones, else those enrolled or billed in the year. */
  private async studentsOf(
    institutionId: string,
    yearRowId: string,
    structureRowId: string | null,
    f: CollectionFilter,
    studentPublicId?: string,
  ) {
    let q = this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').on('e.year_id', '=', yearRowId),
      )
      .leftJoin('sections as sec', 'sec.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'c.name as class_name',
        'sec.name as section_name',
      ])
      .where('m.institution_id', '=', institutionId)
      .where('ut.category', '=', 'STUDENT');
    if (structureRowId) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('fee_assignments as fa')
            .select('fa.id')
            .whereRef('fa.student_profile_id', '=', 'm.id')
            .where('fa.structure_id', '=', structureRowId)
            .where('fa.status', '=', 'ACTIVE'),
        ),
      );
    } else {
      q = q.where((eb) =>
        eb.or([
          eb('e.id', 'is not', null),
          eb.exists(
            eb
              .selectFrom('fee_records as r')
              .select('r.id')
              .whereRef('r.student_profile_id', '=', 'm.id')
              .where('r.year_id', '=', yearRowId)
              .where('r.status', '<>', 'CANCELLED'),
          ),
        ]),
      );
    }
    if (f.classId) {
      if (!isUuid(f.classId)) return [];
      q = q.where('c.public_id', '=', uuidToBin(f.classId));
    }
    if (f.sectionId) {
      if (!isUuid(f.sectionId)) return [];
      q = q.where('sec.public_id', '=', uuidToBin(f.sectionId));
    }
    const text = f.q?.trim();
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql<string>`CONCAT_WS(' ', m.first_name, m.last_name)`, 'like', like),
          eb('m.admission_no', 'like', like),
        ]),
      );
    }
    if (studentPublicId) {
      if (!isUuid(studentPublicId)) return [];
      q = q.where('m.public_id', '=', uuidToBin(studentPublicId));
    }
    return q
      .orderBy(sql`c.sort_order IS NULL`)
      .orderBy('c.sort_order')
      .orderBy('sec.name')
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
  }

  /**
   * The application and admission fees of each student's approved application of the year (by the
   * student's row id): the payment made, or the admission fee still owed; nothing for a student
   * already at the school (an import).
   */
  private async entryFeesOf(institutionId: string, yearRowId: string) {
    const db = this.deps.db;
    const out = new Map<string, { application: Entry | null; admission: Entry | null }>();
    const apps = await db
      .selectFrom('admission_applications')
      .select(['id', 'member_profile_id', 'source'])
      .where('institution_id', '=', institutionId)
      .where('year_id', '=', yearRowId)
      .where('status', '=', 'APPROVED')
      .where('member_profile_id', 'is not', null)
      .execute();
    if (!apps.length) return out;
    const [pays, cfg] = await Promise.all([
      db
        .selectFrom('admission_payments')
        .select(['application_id', 'fee_type', 'status', 'amount_paise', 'mode', 'receipt_no'])
        .where(
          'application_id',
          'in',
          apps.map((a) => a.id),
        )
        .execute(),
      db
        .selectFrom('entry_fees')
        .select('admission_fee_paise')
        .where('institution_id', '=', institutionId)
        .where('year_id', '=', yearRowId)
        .executeTakeFirst(),
    ]);
    const entry = (a: (typeof apps)[number], type: 'APPLICATION' | 'ADMISSION'): Entry | null => {
      const rows = pays.filter(
        (x) => String(x.application_id) === String(a.id) && x.fee_type === type,
      );
      const row = rows.find((x) => x.status === 'PAID') ?? rows[0];
      if (!row) {
        // The admission fee is owed from submission on; the application fee only as paid.
        const owed = Number(cfg?.admission_fee_paise ?? 0);
        if (type === 'APPLICATION' || a.source === 'IMPORT' || owed <= 0) return null;
        return {
          amountPaise: owed,
          collectedPaise: 0,
          status: 'PENDING',
          mode: null,
          receiptNo: null,
        };
      }
      const amount = Number(row.amount_paise);
      return {
        amountPaise: amount,
        collectedPaise: row.status === 'PAID' ? amount : 0,
        status: row.status,
        mode: row.mode,
        receiptNo: row.receipt_no,
      };
    };
    for (const a of apps) {
      out.set(String(a.member_profile_id), {
        application: entry(a, 'APPLICATION'),
        admission: entry(a, 'ADMISSION'),
      });
    }
    return out;
  }

  // --- FEE-044 --------------------------------------------------------------------------------------
  async view(p: Principal, f: CollectionFilter) {
    const i = await this.inst(p);
    const inst = String(i.id);
    const y = await this.yearOf(inst, f.yearId);
    const year = String(y.id);
    const structure = f.structureId ? await this.structureOf(inst, year, f.structureId) : null;
    const structureRow = structure ? String(structure.s.id) : null;
    const [students, records, entries] = await Promise.all([
      this.studentsOf(inst, year, structureRow, f),
      this.recordsOf(inst, year, structureRow),
      this.entryFeesOf(inst, year),
    ]);
    const cols = await this.columns(inst, year, structure, records);

    const headCollected = new Map<string, number>();
    const entryTotals = {
      application: { amount: 0, collected: 0 },
      admission: { amount: 0, collected: 0 },
    };
    let billed = 0;
    let got = 0;
    const rows = students.map((st) => {
      const mine = records.get(String(st.id)) ?? [];
      const cells = cols.map((c) => {
        const lines = mine.flatMap((r) => r.lines.filter((l) => l.key === c.key));
        if (!lines.length) return null;
        const amount = lines.reduce((a, l) => a + l.amountPaise, 0);
        const collected = lines.reduce((a, l) => a + l.collectedPaise, 0);
        headCollected.set(c.key, (headCollected.get(c.key) ?? 0) + collected);
        return { headId: c.id, ...sums(amount, collected) };
      });
      const fees = entries.get(String(st.id));
      const entryCell = (e: Entry | null | undefined, k: 'application' | 'admission') => {
        if (!e) return null;
        entryTotals[k].amount += e.amountPaise;
        entryTotals[k].collected += e.collectedPaise;
        return {
          ...sums(e.amountPaise, e.collectedPaise),
          status: e.status,
          mode: e.mode,
          receiptNo: e.receiptNo,
        };
      };
      const lines = mine.flatMap((r) => r.lines);
      const open = mine.filter(
        (r) => OPEN_STATUSES.includes(r.record.status) && !Number(r.record.financed),
      );
      const entryList = [fees?.application, fees?.admission].filter((e): e is Entry => !!e);
      const amount =
        lines.reduce((a, l) => a + l.amountPaise, 0) +
        entryList.reduce((a, e) => a + e.amountPaise, 0);
      const collected =
        lines.reduce((a, l) => a + l.collectedPaise, 0) +
        entryList.reduce((a, e) => a + e.collectedPaise, 0);
      billed += amount;
      got += collected;
      return {
        id: binToUuid(st.public_id),
        name: nameOf(st.first_name, st.last_name),
        admissionNo: st.admission_no,
        classSection: st.class_name ? `${st.class_name} ${st.section_name ?? ''}`.trim() : null,
        heads: cells,
        applicationFee: entryCell(fees?.application, 'application'),
        admissionFee: entryCell(fees?.admission, 'admission'),
        total: sums(amount, collected),
        // What Collect fee can take (client 2026-10-22: no button when nothing is due): the open,
        // unfinanced instalments' outstanding amounts.
        due: toMoneyDto(
          open.reduce(
            (a, r) =>
              a +
              Math.max(
                0,
                Number(r.record.amount_paise) - r.lines.reduce((b, l) => b + l.collectedPaise, 0),
              ),
            0,
          ),
        ),
        collectable: open.length > 0,
      };
    });
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(f.pageSize ?? PAGE_SIZE)));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.floor(f.page ?? 1)));
    return {
      year: { id: binToUuid(y.public_id), label: y.label },
      structure: structure
        ? {
            id: binToUuid(structure.s.public_id),
            name: structure.s.name,
            version: structure.v.version_no,
          }
        : null,
      heads: cols.map((c) => ({ id: c.id, name: c.name })),
      // Every student the filters keep, not only this page's.
      cards: {
        heads: cols.map((c) => ({
          headId: c.id,
          collected: toMoneyDto(headCollected.get(c.key) ?? 0),
        })),
        applicationFee: sums(entryTotals.application.amount, entryTotals.application.collected),
        admissionFee: sums(entryTotals.admission.amount, entryTotals.admission.collected),
        total: sums(billed, got),
      },
      students: rows.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: rows.length,
    };
  }

  // --- FEE-045 --------------------------------------------------------------------------------------
  /** One student's instalments of every head in the year (of the structure, when one is chosen). */
  async student(
    p: Principal,
    studentId: string,
    f: Pick<CollectionFilter, 'yearId' | 'structureId'>,
  ) {
    const i = await this.inst(p);
    const inst = String(i.id);
    const y = await this.yearOf(inst, f.yearId);
    const year = String(y.id);
    const structure = f.structureId ? await this.structureOf(inst, year, f.structureId) : null;
    const structureRow = structure ? String(structure.s.id) : null;
    const [st] = await this.studentsOf(inst, year, structureRow, {}, studentId);
    if (!st) throw new NotFoundError();
    const records = await this.recordsOf(inst, year, structureRow, String(st.id));
    const cols = await this.columns(inst, year, structure, records);
    const mine = records.get(String(st.id)) ?? [];
    return {
      student: {
        id: binToUuid(st.public_id),
        name: nameOf(st.first_name, st.last_name),
        admissionNo: st.admission_no,
        classSection: st.class_name ? `${st.class_name} ${st.section_name ?? ''}`.trim() : null,
      },
      heads: cols.flatMap((c) => {
        const lines = mine.flatMap((r) =>
          r.lines.filter((l) => l.key === c.key).map((l) => ({ r: r.record, l })),
        );
        if (!lines.length) return [];
        const amount = lines.reduce((a, x) => a + x.l.amountPaise, 0);
        const collected = lines.reduce((a, x) => a + x.l.collectedPaise, 0);
        return [
          {
            id: c.id,
            name: c.name,
            ...sums(amount, collected),
            instalments: lines.map(({ r, l }) => ({
              seq: r.instalment_seq,
              label: r.label,
              dueDate: istBusinessDate(new Date(r.due_date)),
              ...sums(l.amountPaise, l.collectedPaise),
              status: lineStatus(l.amountPaise, l.collectedPaise, r),
            })),
          },
        ];
      }),
    };
  }
}

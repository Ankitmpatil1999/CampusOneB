/**
 * Fee sheet uploads (SRS 13.3, FR-FEE-03, OI-FEE-05…07; FEE-014/015, FEE-039…041; prototype
 * c.feerecords "Upload fee sheet"). The institution downloads the template (CSV — Excel opens and
 * saves it), fills one row per student and uploads it.
 *
 * - Every row is checked first — the student by admission number, an admission number repeated in
 *   the file, the same row already uploaded today, the total, the instalment count, the late fine,
 *   the due date inside the year, paid history — and the report shows each rejected row's reasons.
 * - The total is split into equal whole-rupee instalments with the remainder on the last (the one
 *   formula of the fee structures); a missing due date becomes the year's last day.
 * - Nothing is created until the upload is committed: all rows (only when none was rejected) or the
 *   accepted rows only, in one transaction. A row marked paid is recorded as history (PAID with its
 *   date and reference): no collection, no ledger posting at upload (OI-FEE-06).
 */
import { sql, type Kysely } from 'kysely';
import { LIMITS, renderMessage, type MessageKey } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { parseCsv, toCsv } from '../utils/csv';
import { formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { MoneyError, parseAmount, toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { defaultValues, type SettingValues } from './settings.service';

const COLUMNS = [
  'Student name',
  'Admission number',
  'Grade',
  'Section',
  'Total',
  'Instalments',
  'Late fine',
  'Due date',
  'Paid',
  'Paid date',
  'Reference',
  'Remarks',
] as const;

const day = (d: Date | string) => istBusinessDate(new Date(d));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** "2026-11-15", "15/11/2026" or "15-11-2026" as YYYY-MM-DD. */
function toDate(v: string): string | null {
  const t = v.trim();
  let out = t;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (dmy) out = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out) || Number.isNaN(Date.parse(out))) return null;
  return out;
}

/** "12,500", "₹12,500.00" → paise; null when it isn't an amount. */
function toPaise(v: string): number | null {
  const t = v.replace(/[₹,\s]/g, '');
  if (!t) return null;
  try {
    return parseAmount(t, { allowZero: true });
  } catch (e) {
    if (e instanceof MoneyError) return null;
    throw e;
  }
}

/** Equal whole-rupee parts with the remainder on the last (the fee structures' formula). */
export function splitTotal(totalPaise: number, count: number): number[] {
  const each = Math.floor(totalPaise / count / 100) * 100;
  return Array.from({ length: count }, (_, k) =>
    k < count - 1 ? each : totalPaise - each * (count - 1),
  );
}

interface RowInput {
  readonly studentRowId: string;
  readonly parts: readonly number[];
  readonly dueDate: string;
  readonly finePaise: number;
  readonly paid: { readonly date: string; readonly reference: string | null } | null;
  readonly remarks: string | null;
}
interface RowReport {
  readonly row: number;
  readonly name: string;
  readonly admissionNo: string;
  readonly classSection: string;
  readonly totalPaise: number;
  readonly instalments: number;
  readonly dueDate: string | null;
  readonly dueDefaulted: boolean;
  readonly paid: boolean;
  readonly accepted: boolean;
  readonly errors: readonly { readonly column: string; readonly message: string }[];
  readonly input?: RowInput;
}

export class FeeUploadsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  private async own(p: Principal, db: Kysely<Database> = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  private async currentYear(db: Kysely<Database>, institutionId: string) {
    const y = await db
      .selectFrom('academic_years')
      .select(['id', 'public_id', 'label', 'starts_on', 'ends_on', 'status'])
      .where('institution_id', '=', institutionId)
      .where('is_current', '=', 1)
      .executeTakeFirst();
    if (!y) throw new NotFoundError();
    if (y.status === 'CLOSED') {
      throw new CustomAPIError(409, 'FEE.YEAR_CLOSED', { params: { year: y.label } });
    }
    return y;
  }

  // --- FEE-039 ------------------------------------------------------------------------------------
  /** The template: the columns and one example row. */
  async template(p: Principal) {
    const inst = await this.own(p);
    const y = await this.currentYear(this.deps.db, inst.id);
    return {
      fileName: 'ringpe-fee-sheet-template.csv',
      csv: toCsv([
        [...COLUMNS],
        [
          'Aarav Shetty',
          'TV-2026-0101',
          'Grade 6',
          'A',
          '36000.00',
          '3',
          '100.00',
          day(y.ends_on),
          'No',
          '',
          '',
          '',
        ],
      ]),
    };
  }

  // --- FEE-014 ------------------------------------------------------------------------------------
  async upload(p: Principal, input: { fileName: string; content: string }) {
    const db = this.deps.db;
    const inst = await this.own(p);
    const y = await this.currentYear(db, inst.id);
    const rows = parseCsv(input.content.trimStart());
    const got = (rows[0] ?? []).map((c) => c.trim().toLowerCase());
    if (!rows.length || COLUMNS.some((h, i) => got[i] !== h.toLowerCase())) {
      throw new CustomAPIError(422, 'UPL.HEADER_MISMATCH');
    }
    const data = rows.slice(1).filter((r) => r.some((c) => c.trim()));
    if (!data.length) throw new CustomAPIError(422, 'UPL.NO_ROWS');
    const maxRows = await this.limit(LIMITS.uploadMaxRows);
    if (data.length > maxRows) {
      throw new CustomAPIError(422, 'UPL.TOO_MANY_ROWS', { params: { max: maxRows } });
    }
    const maxInstalments = await this.limit(LIMITS.feeInstalmentsMax);
    const yearFrom = day(y.starts_on);
    const yearTo = day(y.ends_on);
    const today = istBusinessDate(this.now());

    // Students by admission number (one query), repeats in the file, and today's committed rows.
    const admissionNos = [
      ...new Set(data.map((r) => (r[1] ?? '').trim().toLowerCase()).filter(Boolean)),
    ];
    const students = admissionNos.length
      ? await db
          .selectFrom('member_profiles as m')
          .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
          .select(['m.id', 'm.admission_no'])
          .where('m.institution_id', '=', inst.id)
          .where('ut.category', '=', 'STUDENT')
          .where(sql<string>`LOWER(m.admission_no)`, 'in', admissionNos)
          .execute()
      : [];
    const byAdmission = new Map(students.map((s) => [String(s.admission_no).toLowerCase(), s]));
    const count = new Map<string, number>();
    for (const r of data) {
      const k = (r[1] ?? '').trim().toLowerCase();
      if (k) count.set(k, (count.get(k) ?? 0) + 1);
    }
    const startOfDay = new Date(`${today}T00:00:00+05:30`);
    const earlier = await db
      .selectFrom('fee_uploads')
      .select('report')
      .where('institution_id', '=', inst.id)
      .where('status', '=', 'COMMITTED')
      .where('committed_at', '>=', startOfDay)
      .execute();
    const doneToday = new Set(
      earlier.flatMap((u) =>
        ((typeof u.report === 'string' ? JSON.parse(u.report) : u.report) as RowReport[])
          .filter((r) => r.accepted)
          .map((r) => `${r.admissionNo.toLowerCase()}|${r.totalPaise}|${r.instalments}`),
      ),
    );

    const report: RowReport[] = data.map((cells, i) => {
      const cell = (name: (typeof COLUMNS)[number]) => (cells[COLUMNS.indexOf(name)] ?? '').trim();
      const errors: { column: string; message: string }[] = [];
      const err = (column: string, code: MessageKey, params?: Record<string, string | number>) =>
        errors.push({ column, message: renderMessage(code, params) });
      const name = cell('Student name');
      const admissionNo = cell('Admission number');
      const grade = cell('Grade');
      if (!name) err('Student name', 'VALIDATION.REQUIRED');
      if (!admissionNo) err('Admission number', 'VALIDATION.REQUIRED');
      if (!grade) err('Grade', 'VALIDATION.REQUIRED');
      const student = admissionNo ? byAdmission.get(admissionNo.toLowerCase()) : undefined;
      if (admissionNo && !student) err('Admission number', 'FEE.UPLOAD_NO_STUDENT');
      const repeats = count.get(admissionNo.toLowerCase()) ?? 0;
      if (admissionNo && repeats > 1)
        err('Admission number', 'FEE.UPLOAD_REPEATED', { n: repeats });
      const total = toPaise(cell('Total'));
      if (total === null || total <= 0) err('Total', 'VALIDATION.AMOUNT');
      const instText = cell('Instalments');
      const instalments = instText ? Number(instText) : 1;
      if (!Number.isInteger(instalments) || instalments < 1 || instalments > maxInstalments) {
        err('Instalments', 'FEE.INSTALMENTS_MAX', { max: maxInstalments });
      }
      const parts =
        total && total > 0 && Number.isInteger(instalments) && instalments >= 1
          ? splitTotal(total, Math.min(instalments, maxInstalments))
          : [];
      const fineText = cell('Late fine');
      const fine = fineText ? toPaise(fineText) : 0;
      if (fine === null) err('Late fine', 'VALIDATION.AMOUNT');
      else if (parts.length && fine > Math.min(...parts)) {
        err('Late fine', 'FEE.FINE_TOO_HIGH', { max: formatInr(Math.min(...parts)) });
      }
      const dueText = cell('Due date');
      const due = dueText ? toDate(dueText) : yearTo;
      if (!due) err('Due date', 'VALIDATION.DATE');
      else if (due < yearFrom || due > yearTo) {
        err('Due date', 'FEE.DUE_OUTSIDE_YEAR', {
          label: name || admissionNo || `Row ${i + 2}`,
          year: y.label,
          from: yearFrom,
          to: yearTo,
        });
      }
      const paidText = cell('Paid').toLowerCase();
      const paid = paidText === 'yes' || paidText === 'y' || paidText === 'paid';
      if (paidText && !paid && !['no', 'n', 'unpaid'].includes(paidText)) {
        err('Paid', 'VALIDATION.FORMAT');
      }
      const paidDate = cell('Paid date') ? toDate(cell('Paid date')) : null;
      if (paid && !cell('Paid date')) err('Paid date', 'VALIDATION.REQUIRED');
      else if (cell('Paid date') && (!paidDate || paidDate > today)) {
        err('Paid date', 'VALIDATION.DATE');
      }
      const reference = cell('Reference');
      if (reference.length > 40) err('Reference', 'VALIDATION.FORMAT');
      const remarks = cell('Remarks');
      if (remarks.length > 300) err('Remarks', 'VALIDATION.FORMAT');
      if (
        student &&
        total &&
        doneToday.has(`${admissionNo.toLowerCase()}|${total}|${instalments}`)
      ) {
        err('Admission number', 'FEE.UPLOAD_SAME_DAY');
      }
      const accepted = errors.length === 0;
      return {
        row: i + 2,
        name: name || '—',
        admissionNo,
        classSection: [grade, cell('Section')].filter(Boolean).join(' '),
        totalPaise: total ?? 0,
        instalments: Number.isInteger(instalments) ? instalments : 0,
        dueDate: due,
        dueDefaulted: !dueText,
        paid,
        accepted,
        errors,
        ...(accepted && student && due
          ? {
              input: {
                studentRowId: String(student.id),
                parts,
                dueDate: due,
                finePaise: fine ?? 0,
                paid: paid && paidDate ? { date: paidDate, reference: reference || null } : null,
                remarks: remarks || null,
              },
            }
          : {}),
      };
    });
    const accepted = report.filter((r) => r.accepted);
    const pub = newPublicIdPair();
    await db
      .insertInto('fee_uploads')
      .values({
        public_id: pub.bin,
        institution_id: inst.id,
        year_id: String(y.id),
        file_name: input.fileName.slice(0, 200),
        rows_total: report.length,
        rows_accepted: accepted.length,
        rows_rejected: report.length - accepted.length,
        records_planned: accepted.reduce((a, r) => a + (r.input?.parts.length ?? 0), 0),
        report: JSON.stringify(report),
        created_by: isUuid(p.subject) ? uuidToBin(p.subject) : null,
        created_at: this.now(),
      })
      .execute();
    return this.status(p, pub.id);
  }

  private view(
    u: {
      public_id: Buffer;
      file_name: string;
      status: 'VALIDATED' | 'COMMITTED';
      rows_total: number;
      rows_accepted: number;
      rows_rejected: number;
      records_planned: number;
      created_at: Date | string;
      committed_at: Date | string | null;
      committed_count: number | null;
      created_by: Buffer | null;
      year_label: string;
    },
    by: string | null,
  ) {
    return {
      id: binToUuid(u.public_id),
      fileName: u.file_name,
      year: u.year_label,
      status: u.status,
      total: u.rows_total,
      accepted: u.rows_accepted,
      rejected: u.rows_rejected,
      recordsPlanned: u.records_planned,
      recordsCreated: u.committed_count,
      uploadedBy: by,
      uploadedAt: iso(u.created_at),
      committedAt: iso(u.committed_at),
    };
  }

  private uploads(db: Kysely<Database>, institutionId: string) {
    return db
      .selectFrom('fee_uploads as u')
      .innerJoin('academic_years as y', 'y.id', 'u.year_id')
      .leftJoin('platform_accounts as a', 'a.public_id', 'u.created_by')
      .select([
        'u.id',
        'u.public_id',
        'u.file_name',
        'u.status',
        'u.rows_total',
        'u.rows_accepted',
        'u.rows_rejected',
        'u.records_planned',
        'u.report',
        'u.created_at',
        'u.created_by',
        'u.committed_at',
        'u.committed_count',
        'y.label as year_label',
        'a.first_name',
        'a.last_name',
      ])
      .where('u.institution_id', '=', institutionId);
  }

  // --- FEE-040 ------------------------------------------------------------------------------------
  async list(p: Principal) {
    const inst = await this.own(p);
    const rows = await this.uploads(this.deps.db, inst.id)
      .orderBy('u.id', 'desc')
      .limit(100)
      .execute();
    return {
      items: rows.map((u) =>
        this.view(u, [u.first_name, u.last_name].filter(Boolean).join(' ') || null),
      ),
    };
  }

  // --- FEE-041 ------------------------------------------------------------------------------------
  async status(p: Principal, uploadId: string) {
    const inst = await this.own(p);
    if (!isUuid(uploadId)) throw new NotFoundError();
    const u = await this.uploads(this.deps.db, inst.id)
      .where('u.public_id', '=', uuidToBin(uploadId))
      .executeTakeFirst();
    if (!u) throw new NotFoundError();
    const report = (typeof u.report === 'string' ? JSON.parse(u.report) : u.report) as RowReport[];
    return {
      ...this.view(u, [u.first_name, u.last_name].filter(Boolean).join(' ') || null),
      rows: report.map((r) => ({
        row: r.row,
        name: r.name,
        admissionNo: r.admissionNo,
        classSection: r.classSection,
        total: toMoneyDto(r.totalPaise),
        instalments: (r.input?.parts ?? []).map((a) => toMoneyDto(a)),
        dueDate: r.dueDate,
        dueDefaulted: r.dueDefaulted,
        paid: r.paid,
        accepted: r.accepted,
        errors: r.errors,
      })),
    };
  }

  // --- FEE-015 ------------------------------------------------------------------------------------
  async commit(p: Principal, uploadId: string, input: { mode: 'ALL' | 'ACCEPTED' }) {
    if (!isUuid(uploadId)) throw new NotFoundError();
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    const at = this.now();
    const created = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const u = await trx
        .selectFrom('fee_uploads')
        .selectAll()
        .where('institution_id', '=', inst.id)
        .where('public_id', '=', uuidToBin(uploadId))
        .forUpdate()
        .executeTakeFirst();
      if (!u) throw new NotFoundError();
      if (u.status === 'COMMITTED') throw new CustomAPIError(409, 'UPL.ALREADY_COMMITTED');
      if (input.mode === 'ALL' && u.rows_rejected > 0) {
        throw new CustomAPIError(409, 'UPL.HAS_REJECTED', { params: { n: u.rows_rejected } });
      }
      const y = await trx
        .selectFrom('academic_years')
        .select(['label', 'status'])
        .where('id', '=', u.year_id)
        .executeTakeFirstOrThrow();
      if (y.status === 'CLOSED') {
        throw new CustomAPIError(409, 'FEE.YEAR_CLOSED', { params: { year: y.label } });
      }
      const report = (
        typeof u.report === 'string' ? JSON.parse(u.report) : u.report
      ) as RowReport[];
      const rows = report.filter((r) => r.accepted && r.input);
      if (!rows.length) throw new CustomAPIError(422, 'UPL.NOTHING_ACCEPTED');
      let head = await trx
        .selectFrom('fee_heads')
        .select(['id', 'name'])
        .where('institution_id', '=', inst.id)
        .where('name', '=', 'Tuition')
        .executeTakeFirst();
      if (!head) {
        await trx
          .insertInto('fee_heads')
          .ignore()
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: inst.id,
            name: 'Tuition',
            sort_order: 1,
          })
          .execute();
        head = await trx
          .selectFrom('fee_heads')
          .select(['id', 'name'])
          .where('institution_id', '=', inst.id)
          .where('name', '=', 'Tuition')
          .executeTakeFirstOrThrow();
      }
      let n = 0;
      for (const r of rows) {
        const x = r.input!;
        const st = await trx
          .selectFrom('member_profiles')
          .select('id')
          .where('id', '=', x.studentRowId)
          .where('institution_id', '=', inst.id)
          .forUpdate()
          .executeTakeFirst();
        if (!st) {
          throw new CustomAPIError(409, 'UPL.ROW_CHANGED', {
            params: { row: r.row, reason: renderMessage('FEE.UPLOAD_NO_STUDENT') },
          });
        }
        const seq = await trx
          .selectFrom('fee_records')
          .select(sql<number>`COALESCE(MAX(instalment_seq), 0)`.as('m'))
          .where('institution_id', '=', inst.id)
          .where('student_profile_id', '=', x.studentRowId)
          .where('year_id', '=', u.year_id)
          .executeTakeFirst();
        const base = Number(seq?.m ?? 0);
        for (const [k, amount] of x.parts.entries()) {
          const ins = await trx
            .insertInto('fee_records')
            .values({
              public_id: newPublicIdPair().bin,
              institution_id: inst.id,
              year_id: String(u.year_id),
              student_profile_id: x.studentRowId,
              source: 'UPLOAD',
              upload_id: String(u.id),
              instalment_seq: base + k + 1,
              label: `Instalment ${k + 1}`,
              due_date: x.dueDate,
              amount_paise: amount,
              late_fine_paise: x.finePaise,
              ...(x.paid
                ? {
                    status: 'PAID' as const,
                    paid_paise: amount,
                    paid_at: new Date(`${x.paid.date}T12:00:00+05:30`),
                    paid_reference: x.paid.reference,
                  }
                : {}),
              remarks: x.remarks,
              created_by: by,
              created_at: at,
              updated_at: at,
            })
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('fee_record_heads')
            .values({
              record_id: String(ins.insertId),
              head_id: String(head.id),
              name: head.name,
              amount_paise: amount,
            })
            .execute();
          n++;
        }
      }
      const done = await trx
        .updateTable('fee_uploads')
        .set({ status: 'COMMITTED', committed_at: at, committed_count: n })
        .where('id', '=', u.id)
        .where('status', '=', 'VALIDATED')
        .executeTakeFirst();
      if (!Number(done.numUpdatedRows)) throw new CustomAPIError(409, 'UPL.ALREADY_COMMITTED');
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'FEE_RECORDS_UPLOADED',
        entityType: 'fee_upload',
        entityRef: uploadId,
        after: { students: rows.length, records: n, skipped: u.rows_rejected },
      });
      return n;
    });
    return { created, skipped: (await this.status(p, uploadId)).rejected };
  }
}

/**
 * Statement reconciliation (SRS 15.6; REC-001…004; FR-REC-02/03; OI-REC-07 adopted for the campus
 * platform, Q16(a)).
 *
 * - The officer uploads an external statement as CSV — the sponsor bank's virtual-account credits,
 *   the payout bank's statement or the payment gateway's — in the layout below (an example contract
 *   until the banks and the gateway are chosen, Q17).
 * - The file is taken whole or not at all: every row is checked first (mandatory columns, date,
 *   amount, a row repeated in the file or already in an earlier statement) and one bad row rejects
 *   the file with each row's reason. The same file twice is refused.
 * - Each row is matched to the platform's record — the bank credit (UTR + bank transaction id), the
 *   settlement payout (UTR), the admission gateway payment (payment id). A row with no record, a
 *   different amount or a different outcome becomes a mismatch; a platform record of the statement's
 *   days that no statement holds becomes one too, and is closed when a later statement has it.
 * - Mismatches are resolved with remarks: explained, adjusted, or by a refund or chargeback request
 *   (the money moves only when that request is decided, through the ledger).
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS } from '../config/registers';
import type {
  Database,
  ReconMismatchKind,
  ReconMismatchStatus,
  ReconResolution,
  ReconStatementKind,
} from '../models/ringpe_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { parseCsv } from '../utils/csv';
import { formatDate } from '../utils/format';
import type { FieldError } from '../utils/validators';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { MoneyError, parseAmount, toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import type { RefundsService } from './refunds.service';
import { defaultValues, type SettingValues } from './settings.service';

/** The statement layouts (example contract): columns in any order, extra columns ignored. */
export const STATEMENT_LAYOUTS = {
  VA_CREDITS: {
    columns: ['Date', 'UTR', 'Bank Txn ID', 'VA Number', 'Amount', 'Mode', 'Sender'],
    required: ['Date', 'UTR', 'Bank Txn ID', 'VA Number', 'Amount'],
  },
  PAYOUTS: {
    columns: ['Date', 'UTR', 'Amount', 'Status', 'Beneficiary'],
    required: ['Date', 'UTR', 'Amount', 'Status'],
  },
  GATEWAY: {
    columns: ['Date', 'Payment ID', 'Order ID', 'Amount', 'Status'],
    required: ['Date', 'Payment ID', 'Amount', 'Status'],
  },
} as const satisfies Record<
  ReconStatementKind,
  { columns: readonly string[]; required: readonly string[] }
>;

/** Statement outcomes that mean the money moved. */
const SUCCESS: Record<ReconStatementKind, readonly string[]> = {
  VA_CREDITS: [],
  PAYOUTS: ['SUCCESS', 'PAID', 'CREDITED', 'COMPLETED', 'PROCESSED'],
  GATEWAY: ['CAPTURED', 'SUCCESS', 'PAID', 'SETTLED'],
};
const MATCH_TYPE: Record<ReconStatementKind, string> = {
  VA_CREDITS: 'bank_credit',
  PAYOUTS: 'settlement',
  GATEWAY: 'admission_payment',
};
const KEY = /^[A-Za-z0-9/_-]{4,80}$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const ymd = (d: Date | string | null | undefined) =>
  d === null || d === undefined
    ? null
    : typeof d === 'string'
      ? d.slice(0, 10)
      : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** A statement date: 2026-10-04, 04-10-2026, 04/10/2026 or 04-Oct-2026. */
export function statementDate(value: string): string | null {
  const v = value.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) [y, m, d] = [+r[1]!, +r[2]!, +r[3]!];
  else if ((r = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(v))) [d, m, y] = [+r[1]!, +r[2]!, +r[3]!];
  else if ((r = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/.exec(v))) {
    const month = MONTHS.indexOf(r[2]!.toLowerCase());
    if (month < 0) return null;
    [d, m, y] = [+r[1]!, month + 1, +r[3]!];
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

interface Row {
  readonly n: number;
  readonly key: string;
  readonly date: string;
  readonly amount: number;
  readonly status: string | null;
  readonly raw: Record<string, string>;
  readonly va?: string;
}

interface Platform {
  readonly id: string;
  readonly institutionId: string | null;
  readonly ref: string;
  readonly amount: number;
  /** Whether the platform recorded the money as moved. */
  readonly moved: boolean;
}

export class ReconciliationService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly refunds: RefundsService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    return uuidToBin(p.subject);
  }

  private async maxRows() {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[LIMITS.reconUploadMaxRows.key] ?? LIMITS.reconUploadMaxRows.value);
  }

  // --- REC-001: upload -----------------------------------------------------------------------------------
  async upload(
    p: Principal,
    input: { kind: ReconStatementKind; fileName: string; content: Buffer },
  ) {
    const by = this.by(p);
    const kind = input.kind;
    const db = this.deps.db;
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const seenFile = await db
      .selectFrom('recon_statements')
      .select('uploaded_at')
      .where('kind', '=', kind)
      .where('sha256', '=', sha256)
      .executeTakeFirst();
    if (seenFile) {
      throw new CustomAPIError(409, 'REC.FILE_DUPLICATE', {
        params: { date: formatDate(seenFile.uploaded_at) },
      });
    }
    const rows = await this.parse(kind, input.content.toString('utf8'));
    const matches = await this.platformFor(kind, rows);
    const at = this.now();
    const pub = newPublicIdPair();
    const dates = rows.map((r) => r.date).sort();
    const periodFrom = dates[0]!;
    const periodTo = dates.at(-1)!;
    const fileName = input.fileName.slice(0, 200) || 'statement.csv';
    try {
      return await db.transaction().execute(async (trx) => {
        const ins = await trx
          .insertInto('recon_statements')
          .values({
            public_id: pub.bin,
            kind,
            file_name: fileName,
            sha256,
            rows_total: rows.length,
            rows_matched: 0,
            rows_mismatched: 0,
            period_from: periodFrom,
            period_to: periodTo,
            uploaded_by: by,
            uploaded_at: at,
          })
          .executeTakeFirstOrThrow();
        const statementId = String(ins.insertId);
        const vaInstitutions = await this.vaInstitutions(trx, kind, rows);
        let matched = 0;
        let mismatched = 0;
        const found: string[] = [];
        for (let k = 0; k < rows.length; k += 500) {
          const chunk = rows.slice(k, k + 500);
          await trx
            .insertInto('recon_statement_rows')
            .values(
              chunk.map((r) => {
                const m = matches.get(r.key);
                return {
                  statement_id: statementId,
                  kind,
                  row_no: r.n,
                  row_key: r.key,
                  txn_date: r.date,
                  amount_paise: r.amount,
                  status_text: r.status,
                  raw: JSON.stringify(r.raw),
                  institution_id:
                    m?.institutionId ?? (r.va ? (vaInstitutions.get(r.va) ?? null) : null),
                  matched_type: m ? MATCH_TYPE[kind] : null,
                  matched_id: m?.id ?? null,
                };
              }),
            )
            .execute();
        }
        const rowIds = new Map(
          (
            await trx
              .selectFrom('recon_statement_rows')
              .select(['id', 'row_key'])
              .where('statement_id', '=', statementId)
              .execute()
          ).map((r) => [r.row_key, String(r.id)]),
        );
        const mismatches: {
          row: Row | null;
          kind: ReconMismatchKind;
          platform: Platform | null;
          institutionId: string | null;
        }[] = [];
        for (const r of rows) {
          const m = matches.get(r.key);
          if (!m) {
            mismatches.push({
              row: r,
              kind: 'MISSING_ON_PLATFORM',
              platform: null,
              institutionId: r.va ? (vaInstitutions.get(r.va) ?? null) : null,
            });
            mismatched++;
            continue;
          }
          found.push(m.id);
          const statementMoved = kind === 'VA_CREDITS' || SUCCESS[kind].includes(r.status ?? '');
          if (m.amount !== r.amount) {
            mismatches.push({
              row: r,
              kind: 'AMOUNT',
              platform: m,
              institutionId: m.institutionId,
            });
            mismatched++;
          } else if (statementMoved !== m.moved) {
            mismatches.push({
              row: r,
              kind: 'STATUS',
              platform: m,
              institutionId: m.institutionId,
            });
            mismatched++;
          } else matched++;
        }
        // Platform records of the statement's days that no statement holds (yet).
        for (const m of await this.unstated(trx, kind, periodFrom, periodTo)) {
          mismatches.push({
            row: null,
            kind: 'MISSING_IN_STATEMENT',
            platform: m,
            institutionId: m.institutionId,
          });
        }
        for (const x of mismatches) {
          await trx
            .insertInto('recon_mismatches')
            .values({
              public_id: newPublicIdPair().bin,
              statement_id: statementId,
              row_id: x.row ? (rowIds.get(x.row.key) ?? null) : null,
              institution_id: x.institutionId,
              kind: x.kind,
              platform_type: x.platform ? MATCH_TYPE[kind] : null,
              platform_id: x.platform?.id ?? null,
              platform_ref: x.platform?.ref ?? null,
              statement_paise: x.row?.amount ?? null,
              platform_paise: x.platform?.amount ?? null,
              created_at: at,
            })
            .execute();
        }
        // A record reported missing earlier is closed now that a statement has it.
        if (found.length) {
          await trx
            .updateTable('recon_mismatches')
            .set({
              status: 'RESOLVED',
              resolution: 'EXPLAINED',
              remarks: `Found in statement ${fileName}`.slice(0, 500),
              resolved_at: at,
              row_version: sql<number>`row_version + 1`,
            })
            .where('kind', '=', 'MISSING_IN_STATEMENT')
            .where('status', '=', 'OPEN')
            .where('platform_type', '=', MATCH_TYPE[kind])
            .where('platform_id', 'in', found)
            .where('statement_id', '<>', statementId)
            .execute();
        }
        await trx
          .updateTable('recon_statements')
          .set({ rows_matched: matched, rows_mismatched: mismatched })
          .where('id', '=', statementId)
          .execute();
        await recordAudit(trx, {
          action: 'RECON_STATEMENT_UPLOADED',
          entityType: 'recon_statement',
          entityRef: pub.id,
          after: { kind, fileName, rows: rows.length, matched, mismatches: mismatches.length },
        });
        return {
          ...(await this.statement(trx, pub.id)),
          code: 'REC.UPLOADED' as const,
        };
      });
    } catch (e) {
      // Two uploads of the same file (or rows) at once: the unique keys refuse the second.
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'REC.FILE_DUPLICATE', { params: { date: formatDate(at) } });
      }
      throw e;
    }
  }

  /** Every row checked before anything is stored; one bad row rejects the file (OI-REC-07). */
  private async parse(kind: ReconStatementKind, text: string): Promise<Row[]> {
    const layout = STATEMENT_LAYOUTS[kind];
    const table = parseCsv(text);
    const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    const index = new Map<string, number>();
    for (const c of layout.columns) {
      const i = header.indexOf(c.toLowerCase());
      if (i >= 0) index.set(c, i);
    }
    if (layout.required.some((c) => !index.has(c))) {
      throw new ValidationError([{ field: 'file', code: 'UPL.HEADER_MISMATCH' }]);
    }
    const body = table.slice(1);
    if (!body.length) throw new ValidationError([{ field: 'file', code: 'UPL.NO_ROWS' }]);
    const max = await this.maxRows();
    if (body.length > max) {
      throw new ValidationError([{ field: 'file', code: 'UPL.TOO_MANY_ROWS', params: { max } }]);
    }
    const errors: FieldError[] = [];
    const rows: Row[] = [];
    const inFile = new Set<string>();
    body.forEach((cells, k) => {
      const n = k + 1;
      const raw: Record<string, string> = {};
      for (const [c, i] of index) raw[c] = (cells[i] ?? '').trim();
      const field = `rows.${n}`;
      if (layout.required.some((c) => !raw[c])) {
        errors.push({ field, code: 'REC.ROW_NULL', params: { n } });
        return;
      }
      const date = statementDate(raw['Date']!);
      if (!date) {
        errors.push({ field, code: 'REC.ROW_DATE', params: { n, value: raw['Date']! } });
        return;
      }
      let amount: number;
      try {
        amount = parseAmount(raw['Amount']!.replace(/[₹,\s]/g, ''));
      } catch (e) {
        if (!(e instanceof MoneyError)) throw e;
        errors.push({ field, code: 'REC.ROW_AMOUNT', params: { n } });
        return;
      }
      const keyColumn = kind === 'GATEWAY' ? 'Payment ID' : 'UTR';
      const keyValue = raw[keyColumn]!.toUpperCase();
      if (!KEY.test(keyValue)) {
        errors.push({ field, code: 'REC.ROW_FORMAT', params: { n, column: keyColumn } });
        return;
      }
      let key = keyValue;
      if (kind === 'VA_CREDITS') {
        const txn = raw['Bank Txn ID']!.toUpperCase();
        if (!KEY.test(txn)) {
          errors.push({ field, code: 'REC.ROW_FORMAT', params: { n, column: 'Bank Txn ID' } });
          return;
        }
        key = `${keyValue}/${txn}`.slice(0, 80);
      }
      if (inFile.has(key)) {
        errors.push({ field, code: 'REC.ROW_REPEATED', params: { n, key } });
        return;
      }
      inFile.add(key);
      rows.push({
        n,
        key,
        date,
        amount,
        status: raw['Status'] ? raw['Status'].toUpperCase().slice(0, 40) : null,
        raw,
        ...(kind === 'VA_CREDITS' ? { va: raw['VA Number']!.toUpperCase() } : {}),
      });
    });
    // Rows already in an earlier statement.
    for (let k = 0; k < rows.length; k += 500) {
      const chunk = rows.slice(k, k + 500);
      const seen = await this.deps.db
        .selectFrom('recon_statement_rows')
        .select('row_key')
        .where('kind', '=', kind)
        .where(
          'row_key',
          'in',
          chunk.map((r) => r.key),
        )
        .execute();
      const keys = new Set(seen.map((s) => s.row_key.toUpperCase()));
      for (const r of chunk) {
        if (keys.has(r.key)) {
          errors.push({
            field: `rows.${r.n}`,
            code: 'REC.ROW_SEEN',
            params: { n: r.n, key: r.key },
          });
        }
      }
    }
    if (errors.length) {
      errors.sort((a, b) => Number(a.field.slice(5)) - Number(b.field.slice(5)));
      throw new CustomAPIError(422, 'REC.FILE_REJECTED', { errors });
    }
    return rows;
  }

  /** The platform's record of each row, by the row's key. */
  private async platformFor(kind: ReconStatementKind, rows: readonly Row[]) {
    const out = new Map<string, Platform>();
    const db = this.deps.db;
    for (let k = 0; k < rows.length; k += 500) {
      const chunk = rows.slice(k, k + 500);
      if (kind === 'VA_CREDITS') {
        const found = await db
          .selectFrom('bank_credits')
          .select(['id', 'institution_id', 'utr', 'bank_txn_id', 'amount_paise', 'status'])
          .where(
            'utr',
            'in',
            chunk.map((r) => r.key.split('/')[0]!),
          )
          .execute();
        for (const b of found) {
          out.set(`${b.utr}/${b.bank_txn_id}`.toUpperCase().slice(0, 80), {
            id: String(b.id),
            institutionId: b.institution_id === null ? null : String(b.institution_id),
            ref: b.utr,
            amount: Number(b.amount_paise),
            moved: b.status !== 'FAILED',
          });
        }
      } else if (kind === 'PAYOUTS') {
        const found = await db
          .selectFrom('settlements')
          .select(['id', 'institution_id', 'settlement_no', 'payout_utr', 'payout_paise'])
          .where(
            'payout_utr',
            'in',
            chunk.map((r) => r.key),
          )
          .execute();
        for (const s of found) {
          out.set(s.payout_utr!, {
            id: String(s.id),
            institutionId: String(s.institution_id),
            ref: s.settlement_no,
            amount: Number(s.payout_paise ?? 0),
            moved: true,
          });
        }
      } else {
        const found = await db
          .selectFrom('admission_payments')
          .select([
            'id',
            'institution_id',
            'gateway_payment_id',
            'receipt_no',
            'amount_paise',
            'status',
          ])
          .where(
            'gateway_payment_id',
            'in',
            chunk.map((r) => r.key),
          )
          .execute();
        for (const a of found) {
          out.set(a.gateway_payment_id!.toUpperCase(), {
            id: String(a.id),
            institutionId: String(a.institution_id),
            ref: a.receipt_no ?? a.gateway_payment_id!,
            amount: Number(a.amount_paise),
            moved: a.status === 'PAID',
          });
        }
      }
    }
    return out;
  }

  /** The institution of each virtual account named in a credits statement. */
  private async vaInstitutions(
    db: Transaction<Database>,
    kind: ReconStatementKind,
    rows: readonly Row[],
  ) {
    const out = new Map<string, string>();
    if (kind !== 'VA_CREDITS') return out;
    const vas = [...new Set(rows.map((r) => r.va!.toUpperCase()).filter(Boolean))];
    if (!vas.length) return out;
    // A VAN starts with one of a school's corporate codes (client 2026-10-14). The code, not the
    // holder's current class, says whose it is: a statement may hold credits from before a change.
    const codes = (
      await db
        .selectFrom('institution_corporate_codes')
        .select(['corporate_code', 'institution_id'])
        .execute()
    ).sort((x, y) => y.corporate_code.length - x.corporate_code.length);
    for (const va of vas) {
      const c = codes.find(
        (x) => va.startsWith(x.corporate_code) && va.length > x.corporate_code.length,
      );
      if (c) out.set(va, String(c.institution_id));
    }
    return out;
  }

  /** Platform records of the statement's days that no statement row holds and none reported yet. */
  private async unstated(
    trx: Transaction<Database>,
    kind: ReconStatementKind,
    from: string,
    to: string,
  ): Promise<Platform[]> {
    const start = new Date(`${from}T00:00:00+05:30`);
    const end = new Date(Date.parse(`${to}T00:00:00+05:30`) + 86_400_000);
    const type = MATCH_TYPE[kind];
    const notHeld = (idCol: string) =>
      sql<boolean>`NOT EXISTS (SELECT 1 FROM recon_statement_rows r WHERE r.matched_type = ${type} AND r.matched_id = ${sql.ref(idCol)})
        AND NOT EXISTS (SELECT 1 FROM recon_mismatches x WHERE x.kind = 'MISSING_IN_STATEMENT' AND x.platform_type = ${type} AND x.platform_id = ${sql.ref(idCol)})`;
    if (kind === 'VA_CREDITS') {
      const rows = await trx
        .selectFrom('bank_credits as b')
        .select(['b.id', 'b.institution_id', 'b.utr', 'b.amount_paise'])
        .where('b.status', '<>', 'FAILED')
        .where('b.credited_at', '>=', start)
        .where('b.credited_at', '<', end)
        .where(notHeld('b.id'))
        .limit(5000)
        .execute();
      return rows.map((b) => ({
        id: String(b.id),
        institutionId: b.institution_id === null ? null : String(b.institution_id),
        ref: b.utr,
        amount: Number(b.amount_paise),
        moved: true,
      }));
    }
    if (kind === 'PAYOUTS') {
      const rows = await trx
        .selectFrom('settlements as s')
        .select(['s.id', 's.institution_id', 's.settlement_no', 's.payout_paise'])
        .where('s.payout_utr', 'is not', null)
        .where('s.payout_at', '>=', start)
        .where('s.payout_at', '<', end)
        .where(notHeld('s.id'))
        .limit(5000)
        .execute();
      return rows.map((s) => ({
        id: String(s.id),
        institutionId: String(s.institution_id),
        ref: s.settlement_no,
        amount: Number(s.payout_paise ?? 0),
        moved: true,
      }));
    }
    const rows = await trx
      .selectFrom('admission_payments as a')
      .select([
        'a.id',
        'a.institution_id',
        'a.receipt_no',
        'a.gateway_payment_id',
        'a.amount_paise',
      ])
      .where('a.mode', '=', 'ONLINE')
      .where('a.status', '=', 'PAID')
      .where('a.paid_at', '>=', start)
      .where('a.paid_at', '<', end)
      .where(notHeld('a.id'))
      .limit(5000)
      .execute();
    return rows.map((a) => ({
      id: String(a.id),
      institutionId: String(a.institution_id),
      ref: a.receipt_no ?? a.gateway_payment_id ?? '',
      amount: Number(a.amount_paise),
      moved: true,
    }));
  }

  // --- REC-002: uploads ----------------------------------------------------------------------------------
  private statementRows(db: Kysely<Database> | Transaction<Database>) {
    return db
      .selectFrom('recon_statements as s')
      .leftJoin('platform_accounts as a', 'a.public_id', 's.uploaded_by')
      .selectAll('s')
      .select([
        'a.first_name',
        'a.last_name',
        (eb) =>
          eb
            .selectFrom('recon_mismatches as x')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('x.statement_id', '=', 's.id')
            .where('x.status', '=', 'OPEN')
            .as('open_mismatches'),
        (eb) =>
          eb
            .selectFrom('recon_mismatches as x')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('x.statement_id', '=', 's.id')
            .as('mismatches'),
      ]);
  }

  private statementView(
    s: Awaited<ReturnType<ReturnType<ReconciliationService['statementRows']>['execute']>>[number],
  ) {
    return {
      id: binToUuid(s.public_id),
      kind: s.kind,
      fileName: s.file_name,
      rows: s.rows_total,
      matched: s.rows_matched,
      mismatchedRows: s.rows_mismatched,
      mismatches: Number(s.mismatches ?? 0),
      openMismatches: Number(s.open_mismatches ?? 0),
      periodFrom: ymd(s.period_from),
      periodTo: ymd(s.period_to),
      uploadedBy: nameOf(s.first_name, s.last_name) || null,
      uploadedAt: iso(s.uploaded_at),
    };
  }

  private async statement(db: Kysely<Database> | Transaction<Database>, id: string) {
    const s = await this.statementRows(db)
      .where('s.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!s) throw new NotFoundError();
    return this.statementView(s);
  }

  async statements(f: { kind?: ReconStatementKind | undefined; cursor?: string | undefined }) {
    let q = this.statementRows(this.deps.db);
    if (f.kind) q = q.where('s.kind', '=', f.kind);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('s.id', '<', f.cursor);
    const rows = await q.orderBy('s.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((s) => this.statementView(s)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
      layouts: STATEMENT_LAYOUTS,
    };
  }

  // --- REC-003: mismatches -------------------------------------------------------------------------------
  private mismatchRows(db: Kysely<Database> | Transaction<Database>) {
    return db
      .selectFrom('recon_mismatches as x')
      .innerJoin('recon_statements as s', 's.id', 'x.statement_id')
      .leftJoin('recon_statement_rows as r', 'r.id', 'x.row_id')
      .leftJoin('institutions as i', 'i.id', 'x.institution_id')
      .leftJoin('platform_accounts as a', 'a.public_id', 'x.resolved_by')
      .leftJoin('refunds as rf', 'rf.id', 'x.refund_id')
      .leftJoin('chargebacks as cb', 'cb.id', 'x.chargeback_id')
      .selectAll('x')
      .select([
        's.public_id as statement_public_id',
        's.kind as statement_kind',
        's.file_name',
        'r.row_no',
        'r.row_key',
        'r.txn_date',
        'r.status_text',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'a.first_name',
        'a.last_name',
        'rf.public_id as refund_public_id',
        'cb.public_id as chargeback_public_id',
        // The wallet movement of a bank credit: what a refund or chargeback names.
        (eb) =>
          eb
            .selectFrom('bank_credits as bc')
            .innerJoin('ledger_transactions as lt', 'lt.id', 'bc.ledger_txn_id')
            .select('lt.reference')
            .whereRef('bc.id', '=', 'x.platform_id')
            .limit(1)
            .as('ledger_reference'),
      ]);
  }

  private mismatchView(
    x: Awaited<ReturnType<ReturnType<ReconciliationService['mismatchRows']>['execute']>>[number],
  ) {
    return {
      id: binToUuid(x.public_id),
      kind: x.kind,
      status: x.status,
      statement: {
        id: binToUuid(x.statement_public_id),
        kind: x.statement_kind,
        fileName: x.file_name,
        rowNo: x.row_no ?? null,
        key: x.row_key ?? null,
        date: ymd(x.txn_date ?? null),
        status: x.status_text ?? null,
        amount: x.statement_paise === null ? null : toMoneyDto(Number(x.statement_paise)),
      },
      platform: x.platform_type
        ? {
            type: x.platform_type,
            reference: x.platform_ref,
            ledgerReference:
              x.platform_type === 'bank_credit' ? (x.ledger_reference ?? null) : null,
            amount: x.platform_paise === null ? null : toMoneyDto(Number(x.platform_paise)),
          }
        : null,
      institution: x.institution_public_id
        ? { id: binToUuid(x.institution_public_id), name: x.institution_name }
        : null,
      resolution: x.resolution,
      remarks: x.remarks,
      refundId: x.refund_public_id ? binToUuid(x.refund_public_id) : null,
      chargebackId: x.chargeback_public_id ? binToUuid(x.chargeback_public_id) : null,
      resolved: x.resolved_at
        ? { by: nameOf(x.first_name, x.last_name) || null, at: iso(x.resolved_at) }
        : null,
      createdAt: iso(x.created_at),
      version: x.row_version,
    };
  }

  async mismatches(f: {
    status?: ReconMismatchStatus | undefined;
    kind?: ReconMismatchKind | undefined;
    type?: ReconStatementKind | undefined;
    institutionId?: string | undefined;
    cursor?: string | undefined;
  }) {
    let q = this.mismatchRows(this.deps.db);
    if (f.status) q = q.where('x.status', '=', f.status);
    if (f.kind) q = q.where('x.kind', '=', f.kind);
    if (f.type) q = q.where('s.kind', '=', f.type);
    if (f.institutionId) {
      if (!isUuid(f.institutionId)) throw new NotFoundError();
      q = q.where('i.public_id', '=', uuidToBin(f.institutionId));
    }
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('x.id', '<', f.cursor);
    const rows = await q.orderBy('x.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((x) => this.mismatchView(x)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  async mismatch(id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'REC.MISMATCH_NOT_FOUND');
    const x = await this.mismatchRows(this.deps.db)
      .where('x.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!x) throw new CustomAPIError(404, 'REC.MISMATCH_NOT_FOUND');
    return this.mismatchView(x);
  }

  // --- REC-004: resolution -------------------------------------------------------------------------------
  async resolve(
    p: Principal,
    id: string,
    expected: number,
    input: {
      action: ReconResolution;
      remarks: string;
      transactionRef?: string | undefined;
      amountPaise?: number | undefined;
      reasonCode?: string | undefined;
    },
  ) {
    const remarks = await this.deps.refunds.remarks(input.remarks);
    const by = this.by(p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'REC.MISMATCH_NOT_FOUND');
    await this.deps.db.transaction().execute(async (trx) => {
      const x = await trx
        .selectFrom('recon_mismatches')
        .selectAll()
        .where('public_id', '=', uuidToBin(id))
        .forUpdate()
        .executeTakeFirst();
      if (!x) throw new CustomAPIError(404, 'REC.MISMATCH_NOT_FOUND');
      if (x.status !== 'OPEN') {
        throw new CustomAPIError(409, 'REC.TRANSITION_INVALID', { params: { status: 'Resolved' } });
      }
      if (x.row_version !== expected) throw new PreconditionFailedError();
      let refundId: string | null = null;
      let chargebackId: string | null = null;
      if (input.action === 'REFUND') {
        refundId = (
          await this.deps.refunds.createRefund(trx, {
            transactionRef: input.transactionRef,
            amountPaise: input.amountPaise,
            reason: remarks,
            source: 'MISMATCH',
            requestedBy: by,
          })
        ).rowId;
      } else if (input.action === 'CHARGEBACK') {
        chargebackId = (
          await this.deps.refunds.createChargeback(trx, {
            transactionRef: input.transactionRef,
            reasonCode: input.reasonCode,
            amountPaise: input.amountPaise,
            remarks,
            raisedBy: by,
          })
        ).rowId;
      }
      await trx
        .updateTable('recon_mismatches')
        .set({
          status: 'RESOLVED',
          resolution: input.action,
          remarks,
          refund_id: refundId,
          chargeback_id: chargebackId,
          resolved_by: by,
          resolved_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', x.id)
        .where('status', '=', 'OPEN')
        .execute();
      await recordAudit(trx, {
        institutionId: x.institution_id,
        action: 'RECON_MISMATCH_RESOLVED',
        entityType: 'recon_mismatch',
        entityRef: id,
        after: { resolution: input.action, remarks },
      });
    });
    return this.mismatch(id);
  }
}

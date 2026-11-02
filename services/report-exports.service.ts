/**
 * Report exports (OI-GAS-17; COM-008, RPT-004, RPT-005; status register: data export, RC-26).
 *
 * - An export carries exactly the rows the report's filters select and the report's columns
 *   (RNG-COM-180), up to a setting's number of rows (it says when it was cut short). It is prepared off
 *   the request: REQUESTED → RUNNING → READY or FAILED, and READY → EXPIRED once its download window
 *   (a setting) has passed.
 * - The file is private and reached only through a short-lived signed link; only the person who
 *   asked for it, in the same institution, can read the export (another's id answers 404).
 * - CSV with a byte-order mark (names in Indian scripts open correctly); cells that a spreadsheet would
 *   run as a formula are neutralised (utils/csv).
 */
import type { Kysely } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type { Database } from '../models/campusone_models';
import { CustomAPIError } from '../utils/CustomAPIError';
import { toCsv } from '../utils/csv';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import type { FileService } from './file.service';
import type { SettingsService } from './settings.service';

type Cell = string | number | null;

/** How one report is exported. */
export interface ExportGenerator {
  readonly header: readonly string[] | ((params: Record<string, unknown>) => readonly string[]);
  readonly rows: (
    /** None: an operator export. */
    institutionId: string | null,
    params: Record<string, unknown>,
    max: number,
  ) => AsyncIterable<readonly Cell[]>;
  readonly fileName: (params: Record<string, unknown>) => string;
}

/** UTF-8 byte-order mark: spreadsheets then read Indian scripts correctly. */
const BOM = String.fromCharCode(0xfeff);
/** A request left this long without being picked up is prepared again; a run this long has failed. */
const STALE_MS = 10 * 60_000;

export class ReportExportsService {
  private readonly generators = new Map<string, ExportGenerator>();

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly files: FileService;
      readonly settings?: SettingsService;
      readonly onError?: (e: unknown) => void;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: LimitDefinition<number>) {
    return this.deps.settings ? this.deps.settings.get(l) : l.value;
  }

  register(report: string, g: ExportGenerator) {
    this.generators.set(report, g);
  }

  /** Records the request and prepares it off the request (202). */
  async request(
    p: Principal,
    institutionId: string | null,
    report: string,
    params: Record<string, unknown>,
  ) {
    if (!this.generators.has(report)) throw new CustomAPIError(404, 'RPT.EXPORT_NOT_FOUND');
    const id = newPublicIdPair();
    await this.deps.db
      .insertInto('report_exports')
      .values({
        public_id: id.bin,
        institution_id: institutionId,
        report,
        params: JSON.stringify(params),
        requested_by: uuidToBin(p.subject),
        requested_at: this.now(),
      })
      .execute();
    this.prepareSoon(id.id);
    return { exportId: id.id, status: 'REQUESTED' as const };
  }

  private prepareSoon(id: string) {
    setImmediate(() => {
      this.prepare(id).catch((e) => this.deps.onError?.(e));
    });
  }

  /** Claims a requested export once and writes its file. */
  async prepare(id: string) {
    const db = this.deps.db;
    const x = await db
      .selectFrom('report_exports')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!x) return;
    const claim = await db
      .updateTable('report_exports')
      .set({ status: 'RUNNING', started_at: this.now() })
      .where('id', '=', x.id)
      .where('status', '=', 'REQUESTED')
      .executeTakeFirst();
    if (Number(claim.numUpdatedRows) !== 1) return;
    const g = this.generators.get(x.report);
    try {
      if (!g) throw new Error(`no generator for ${x.report}`);
      const params = (typeof x.params === 'string' ? JSON.parse(x.params) : x.params) as Record<
        string,
        unknown
      >;
      const max = await this.limit(LIMITS.reportExportMaxRows);
      const rows: (readonly Cell[])[] = [
        typeof g.header === 'function' ? g.header(params) : g.header,
      ];
      let truncated = false;
      const scope = x.institution_id === null ? null : String(x.institution_id);
      for await (const r of g.rows(scope, params, max + 1)) {
        if (rows.length > max) {
          truncated = true;
          break;
        }
        rows.push(r);
      }
      const file = await this.deps.files.storeGenerated({
        institutionId: scope,
        purpose: 'export',
        name: g.fileName(params),
        mimeType: 'text/csv',
        data: Buffer.from(`${BOM}${toCsv(rows)}`, 'utf8'),
        createdBy: x.requested_by,
      });
      const keepDays = await this.limit(LIMITS.reportExportKeepDays);
      const at = this.now();
      await db
        .updateTable('report_exports')
        .set({
          status: 'READY',
          file_id: file.id,
          row_count: rows.length - 1,
          truncated: truncated ? 1 : 0,
          ready_at: at,
          expires_at: new Date(at.getTime() + keepDays * 86_400_000),
        })
        .where('id', '=', x.id)
        .where('status', '=', 'RUNNING')
        .execute();
    } catch (e) {
      await db
        .updateTable('report_exports')
        .set({ status: 'FAILED', error_code: 'EXPORT_FAILED' })
        .where('id', '=', x.id)
        .where('status', '=', 'RUNNING')
        .execute();
      throw e;
    }
  }

  /** RPT-005: the export's state and, once ready, a short-lived download link. */
  async get(p: Principal, id: string, institutionId: string | null) {
    const db = this.deps.db;
    if (!isUuid(id)) throw new CustomAPIError(404, 'RPT.EXPORT_NOT_FOUND');
    let q = db
      .selectFrom('report_exports as x')
      .leftJoin('files as f', 'f.id', 'x.file_id')
      .select([
        'x.id',
        'x.public_id',
        'x.report',
        'x.status',
        'x.row_count',
        'x.truncated',
        'x.requested_at',
        'x.started_at',
        'x.ready_at',
        'x.expires_at',
        'f.public_id as file_public_id',
        'f.original_name',
        'f.size_bytes',
      ])
      .where('x.public_id', '=', uuidToBin(id))
      .where('x.requested_by', '=', uuidToBin(p.subject));
    q =
      institutionId === null
        ? q.where('x.institution_id', 'is', null)
        : q.where('x.institution_id', '=', institutionId);
    const x = await q.executeTakeFirst();
    if (!x) throw new CustomAPIError(404, 'RPT.EXPORT_NOT_FOUND');
    const at = this.now();
    let status = x.status;
    if (status === 'READY' && x.expires_at && new Date(x.expires_at) <= at) {
      await db
        .updateTable('report_exports')
        .set({ status: 'EXPIRED' })
        .where('id', '=', x.id)
        .where('status', '=', 'READY')
        .execute();
      status = 'EXPIRED';
    } else if (
      status === 'REQUESTED' &&
      at.getTime() - new Date(x.requested_at).getTime() > 60_000
    ) {
      this.prepareSoon(id); // nobody picked it up (a restart): prepare it now
    } else if (
      status === 'RUNNING' &&
      x.started_at &&
      at.getTime() - new Date(x.started_at).getTime() > STALE_MS
    ) {
      await db
        .updateTable('report_exports')
        .set({ status: 'FAILED', error_code: 'EXPORT_INTERRUPTED' })
        .where('id', '=', x.id)
        .where('status', '=', 'RUNNING')
        .execute();
      status = 'FAILED';
    }
    return {
      exportId: binToUuid(x.public_id),
      report: x.report,
      status,
      rows: x.row_count,
      truncated: Boolean(Number(x.truncated)),
      requestedAt: new Date(x.requested_at).toISOString(),
      readyAt: x.ready_at ? new Date(x.ready_at).toISOString() : null,
      expiresAt: x.expires_at ? new Date(x.expires_at).toISOString() : null,
      file:
        status === 'READY' && x.file_public_id
          ? {
              name: x.original_name,
              sizeBytes: Number(x.size_bytes),
              ...this.deps.files.linkFor(binToUuid(x.file_public_id)),
            }
          : null,
    };
  }
}

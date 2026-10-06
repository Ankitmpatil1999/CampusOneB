/**
 * Data export and cancellation from the customer portal (FR-SAS-04, OI-SAS-05, OQ-30; SAS-022…025;
 * prototype s.data).
 *
 * - An export is a ZIP of CSV files, one per data class the institution chose; it is written at
 *   once (an institution's records fit in seconds), kept in private storage and downloaded through a
 *   short-lived signed link until it expires (setting `sas.export.keepDays`). One export at a time.
 *   Classes whose module isn't built yet carry a note instead of rows. Personal numbers (PAN,
 *   identity documents, bank accounts) are never exported. The format is an example default until
 *   the client decides OI-SAS-05 (CSV in a ZIP, as the prototype offers first).
 * - A cancellation request waits for RingPe, who confirms it with the lifecycle action Cancel or
 *   declines it; the institution may withdraw it meanwhile. Unpaid invoices must be paid first.
 *   Deletion after cancellation waits for the retention decision (OQ-30): nothing is deleted.
 */
import type { Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository as repo } from '../repositories/institutions.repository';
import { recordAudit } from './audit.service';
import type { FileService } from './file.service';
import { defaultValues, type SettingValues } from './settings.service';
import {
  ConflictError,
  CustomAPIError,
  NotFoundError,
  ValidationError,
} from '../utils/CustomAPIError';
import { toCsv } from '../utils/csv';
import { istBusinessDate } from '../utils/format';
import { toMoneyDto } from '../utils/money';
import { addDays } from './billing.service';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { zip } from '../utils/zip';

export const EXPORT_CLASSES = [
  'members',
  'financial',
  'academic',
  'attendance',
  'communication',
] as const;
export type ExportClass = (typeof EXPORT_CLASSES)[number];

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const day = (d: Date | string | null | undefined) =>
  !d ? '' : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const csv = (rows: (string | number | null | undefined)[][]) =>
  Buffer.from(String.fromCharCode(0xfeff) + toCsv(rows), 'utf8');
const paise = (v: number | string) => (Number(v) / 100).toFixed(2);

export class PortalDataService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly files: FileService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private async inst(p: Principal, db: Kysely<Database> = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await repo.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  private by(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    return uuidToBin(p.subject);
  }

  // --- SAS-022 / SAS-023 / SAS-048 ----------------------------------------------------------------
  async exports(p: Principal) {
    const row = await this.inst(p);
    const rows = await this.deps.db
      .selectFrom('data_exports as x')
      .leftJoin('files as f', 'f.id', 'x.file_id')
      .select([
        'x.public_id',
        'x.status',
        'x.row_counts',
        'x.requested_at',
        'x.ready_at',
        'x.expires_at',
        'x.error_code',
        'f.public_id as file_public_id',
        'f.original_name',
        'f.size_bytes',
      ])
      .where('x.institution_id', '=', row.id)
      .orderBy('x.id', 'desc')
      .limit(20)
      .execute();
    const now = this.now();
    return {
      items: rows.map((x) => {
        const expired =
          x.status === 'READY' && x.expires_at !== null && new Date(x.expires_at) <= now;
        const status = expired ? 'EXPIRED' : x.status;
        return {
          id: binToUuid(x.public_id),
          status,
          counts: (typeof x.row_counts === 'string'
            ? JSON.parse(x.row_counts)
            : x.row_counts) as Record<string, number> | null,
          requestedAt: iso(x.requested_at)!,
          readyAt: iso(x.ready_at),
          expiresAt: iso(x.expires_at),
          file:
            status === 'READY' && x.file_public_id
              ? {
                  name: x.original_name ?? 'export.zip',
                  sizeBytes: Number(x.size_bytes ?? 0),
                  url: this.deps.files.linkFor(binToUuid(x.file_public_id)).url,
                }
              : null,
          error: x.error_code,
        };
      }),
    };
  }

  async exportStatus(p: Principal, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const all = await this.exports(p);
    const x = all.items.find((i) => i.id === id.toLowerCase());
    if (!x) throw new NotFoundError();
    return x;
  }

  /** Writes the archive now; one export at a time per institution. */
  async requestExport(p: Principal, input: { classes: readonly ExportClass[] }) {
    const classes = EXPORT_CLASSES.filter((c) => input.classes.includes(c));
    if (!classes.length) {
      throw new ValidationError([{ field: 'classes', code: 'VALIDATION.REQUIRED' }]);
    }
    const row = await this.inst(p);
    const by = this.by(p);
    const pub = newPublicIdPair();
    try {
      await this.deps.db
        .insertInto('data_exports')
        .values({
          public_id: pub.bin,
          institution_id: row.id,
          status: 'RUNNING',
          requested_by: by,
          requested_at: this.now(),
        })
        .execute();
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ConflictError('SAS.EXPORT_RUNNING');
      }
      throw e;
    }
    try {
      const { files, counts } = await this.archive(row.id, classes);
      const at = this.now();
      const name = `ringpe-export-${row.short_name.toLowerCase()}-${istBusinessDate(at)}.zip`;
      const stored = await this.deps.files.storeGenerated({
        institutionId: row.id,
        purpose: 'export',
        name,
        mimeType: 'application/zip',
        data: zip(files, at),
        createdBy: by,
      });
      const keep = await this.limit(LIMITS.exportKeepDays);
      await this.deps.db
        .updateTable('data_exports')
        .set({
          status: 'READY',
          file_id: stored.id,
          row_counts: JSON.stringify(counts),
          ready_at: at,
          expires_at: new Date(at.getTime() + keep * 86_400_000),
        })
        .where('public_id', '=', pub.bin)
        .execute();
      await repo.addEvent(this.deps.db, {
        institutionId: row.id,
        action: 'DATA_EXPORTED',
        from: null,
        to: null,
        reason: `Data export: ${classes.join(', ')}`,
        actor: by,
        at,
      });
      await recordAudit(this.deps.db, {
        institutionId: row.id,
        action: 'DATA_EXPORTED',
        entityType: 'data_export',
        entityRef: pub.id,
        after: { classes, counts },
      });
    } catch (e) {
      await this.deps.db
        .updateTable('data_exports')
        .set({ status: 'FAILED', error_code: 'GEN.INTERNAL' })
        .where('public_id', '=', pub.bin)
        .execute();
      throw e;
    }
    return this.exportStatus(p, pub.id);
  }

  /** One CSV per table of each chosen class, plus a README. */
  private async archive(institutionId: string, classes: readonly ExportClass[]) {
    const db = this.deps.db;
    const files: { name: string; data: Buffer }[] = [];
    const counts: Record<string, number> = {};
    const add = (name: string, rows: (string | number | null | undefined)[][]) => {
      files.push({ name, data: csv(rows) });
      counts[name] = rows.length - 1;
    };
    const notes: string[] = [];
    if (classes.includes('members')) {
      const members = await db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .leftJoin('departments as d', 'd.id', 'm.department_id')
        .select([
          'm.id',
          'm.public_id',
          'm.member_seq',
          'm.first_name',
          'm.last_name',
          'm.gender',
          'm.date_of_birth',
          'm.admission_no',
          'm.employee_no',
          'm.contact_mobile',
          'm.contact_email',
          'm.joined_on',
          'm.status',
          'm.status_reason',
          'ut.name as user_type',
          'd.name as department',
        ])
        .where('m.institution_id', '=', institutionId)
        .orderBy('m.member_seq')
        .execute();
      add('members/members.csv', [
        [
          'Member ID',
          'First name',
          'Last name',
          'Gender',
          'Date of birth',
          'User type',
          'Department',
          'Admission number',
          'Employee ID',
          'Mobile',
          'E-mail',
          'Joined on',
          'Status',
          'Status reason',
        ],
        ...members.map((m) => [
          m.member_seq,
          m.first_name,
          m.last_name,
          m.gender,
          day(m.date_of_birth),
          m.user_type,
          m.department,
          m.admission_no,
          m.employee_no,
          m.contact_mobile,
          m.contact_email,
          day(m.joined_on),
          m.status,
          m.status_reason,
        ]),
      ]);
      const seq = new Map(members.map((m) => [String(m.id), m.member_seq]));
      const guardians = await db
        .selectFrom('guardianships')
        .select(['guardian_profile_id', 'ward_profile_id', 'relation', 'is_primary_contact'])
        .where('institution_id', '=', institutionId)
        .execute();
      add('members/guardians.csv', [
        ['Parent member ID', 'Child member ID', 'Relation', 'Primary contact'],
        ...guardians.map((g) => [
          seq.get(String(g.guardian_profile_id)),
          seq.get(String(g.ward_profile_id)),
          g.relation,
          Number(g.is_primary_contact) ? 'Yes' : 'No',
        ]),
      ]);
      const types = await db
        .selectFrom('user_types as t')
        .leftJoin('departments as d', 'd.user_type_id', 't.id')
        .select(['t.name', 't.category', 'd.name as department'])
        .where('t.institution_id', '=', institutionId)
        .orderBy('t.name')
        .execute();
      add('members/user-types.csv', [
        ['User type', 'Kind', 'Department'],
        ...types.map((t) => [t.name, t.category, t.department]),
      ]);
    }
    if (classes.includes('financial')) {
      const invoices = await db
        .selectFrom('invoices')
        .select([
          'invoice_no',
          'trigger_kind',
          'period_label',
          'amount_paise',
          'tax_paise',
          'total_paise',
          'issued_on',
          'due_on',
          'status',
          'paid_at',
        ])
        .where('institution_id', '=', institutionId)
        .orderBy('id')
        .execute();
      add('financial/invoices.csv', [
        [
          'Invoice',
          'For',
          'Period',
          'Amount (Rs.)',
          'GST (Rs.)',
          'Total (Rs.)',
          'Issued',
          'Due',
          'Status',
          'Paid at',
        ],
        ...invoices.map((i) => [
          i.invoice_no,
          i.trigger_kind,
          i.period_label,
          paise(i.amount_paise),
          paise(i.tax_paise),
          paise(i.total_paise),
          day(i.issued_on),
          day(i.due_on),
          i.status,
          iso(i.paid_at),
        ]),
      ]);
      notes.push(
        'financial: wallet ledgers, payments, fees and settlements join this export with their modules.',
      );
    }
    if (classes.includes('academic')) {
      const sections = await db
        .selectFrom('classes as c')
        .leftJoin('sections as s', 's.class_id', 'c.id')
        .select(['c.name as class_name', 'c.sort_order', 's.name as section', 's.capacity'])
        .where('c.institution_id', '=', institutionId)
        .orderBy('c.sort_order')
        .execute();
      add('academic/classes.csv', [
        ['Class', 'Order', 'Section', 'Capacity'],
        ...sections.map((s) => [s.class_name, Number(s.sort_order) + 1, s.section, s.capacity]),
      ]);
      const years = await db
        .selectFrom('academic_years')
        .select(['label', 'starts_on', 'ends_on', 'status', 'is_current'])
        .where('institution_id', '=', institutionId)
        .orderBy('starts_on')
        .execute();
      add('academic/academic-years.csv', [
        ['Year', 'Starts', 'Ends', 'Status', 'Current'],
        ...years.map((y) => [
          y.label,
          day(y.starts_on),
          day(y.ends_on),
          y.status,
          Number(y.is_current) ? 'Yes' : 'No',
        ]),
      ]);
      notes.push('academic: timetables, homework, exams and marks join with the academics module.');
    }
    if (classes.includes('attendance')) {
      notes.push('attendance: no records yet — attendance arrives with its module.');
    }
    if (classes.includes('communication')) {
      notes.push(
        'communication: announcements and the communication log arrive with their module (message bodies are never exported).',
      );
    }
    files.push({
      name: 'README.txt',
      data: Buffer.from(
        [
          'RingPe data export',
          `Classes: ${classes.join(', ')}`,
          'CSV files are UTF-8 with a byte-order mark (Excel: open directly).',
          'Personal numbers (PAN, identity documents, bank accounts) are never exported.',
          ...notes,
        ].join('\r\n'),
        'utf8',
      ),
    });
    return { files, counts };
  }

  // --- SAS-024 / SAS-025 / SAS-049 ----------------------------------------------------------------
  async cancellation(p: Principal) {
    const row = await this.inst(p);
    const [request, open, sub, wallets] = await Promise.all([
      this.deps.db
        .selectFrom('cancellation_requests')
        .selectAll()
        .where('institution_id', '=', row.id)
        .orderBy('id', 'desc')
        .executeTakeFirst(),
      this.unpaid(row.id),
      repo.subscription(this.deps.db, row.id),
      // Member wallet money to refund before closing (4.10): every wallet with a balance.
      this.deps.db
        .selectFrom('wallets as w')
        .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
        .select((eb) => [
          eb.fn.countAll<string>().as('n'),
          eb.fn.coalesce(eb.fn.sum<string>('b.available_paise'), eb.lit(0)).as('total'),
        ])
        .where('w.institution_id', '=', row.id)
        .where('b.available_paise', '>', '0')
        .executeTakeFirst(),
    ]);
    return {
      status: row.status,
      renewsOn: sub?.renews_on ? day(sub.renews_on) : null,
      unpaid: open,
      walletsToRefund: {
        count: Number(wallets?.n ?? 0),
        amount: toMoneyDto(BigInt(wallets?.total ?? 0)),
      },
      request: request
        ? {
            id: binToUuid(request.public_id),
            status: request.status,
            effectiveOn: day(request.effective_on),
            reason: request.reason,
            requestedAt: iso(request.requested_at)!,
            resolvedAt: iso(request.resolved_at),
            resolution: request.resolution,
            version: request.row_version,
          }
        : null,
    };
  }

  private async unpaid(institutionId: string) {
    const rows = await this.deps.db
      .selectFrom('invoices')
      .select(['invoice_no', 'total_paise', 'status'])
      .where('institution_id', '=', institutionId)
      .where('status', 'not in', ['PAID', 'VOID'])
      .execute();
    return rows.map((r) => ({
      invoiceNo: r.invoice_no,
      total: paise(r.total_paise),
      status: r.status,
    }));
  }

  async requestCancellation(
    p: Principal,
    input: {
      when: 'END_OF_CYCLE' | 'ASAP' | 'DATE';
      effectiveOn?: string | undefined;
      reason: string;
    },
  ) {
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 300) {
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.FORMAT' }]);
    }
    const by = this.by(p);
    const at = this.now();
    const today = istBusinessDate(at);
    const maxDays = await this.limit(LIMITS.cancelMaxDaysAhead);
    const max = addDays(today, maxDays);
    return this.deps.db.transaction().execute(async (trx) => {
      const row = await this.inst(p, trx, true);
      if (row.status === 'CANCELLED') {
        throw new CustomAPIError(409, 'INS.TRANSITION_INVALID', {
          params: { status: 'Cancelled' },
        });
      }
      const open = await this.unpaid(row.id);
      if (open.length) {
        throw new CustomAPIError(409, 'SAS.UNPAID_INVOICES', {
          params: { invoices: open.map((o) => o.invoiceNo).join(', ') },
        });
      }
      const sub = await repo.subscription(trx, row.id);
      const effectiveOn =
        input.when === 'END_OF_CYCLE' && sub?.renews_on
          ? day(sub.renews_on)
          : input.when === 'DATE' && input.effectiveOn
            ? input.effectiveOn
            : today;
      if (effectiveOn < today || effectiveOn > max) {
        throw new ValidationError([
          { field: 'effectiveOn', code: 'SAS.CANCEL_DATE', params: { max } },
        ]);
      }
      const pub = newPublicIdPair();
      try {
        await trx
          .insertInto('cancellation_requests')
          .values({
            public_id: pub.bin,
            institution_id: row.id,
            effective_on: effectiveOn,
            reason,
            requested_by: by,
            requested_at: at,
          })
          .execute();
      } catch (e) {
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
          throw new ConflictError('SAS.CANCEL_PENDING');
        }
        throw e;
      }
      await repo.addEvent(trx, {
        institutionId: row.id,
        action: 'CANCELLATION_REQUESTED',
        from: null,
        to: null,
        reason: `Effective ${effectiveOn}: ${reason}`,
        actor: by,
        at,
      });
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'CANCELLATION_REQUESTED',
        entityType: 'cancellation_request',
        entityRef: pub.id,
        after: { effectiveOn },
        reason,
      });
      return { id: pub.id, effectiveOn, status: 'PENDING' as const };
    });
  }

  async withdrawCancellation(p: Principal, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const by = this.by(p);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const row = await this.inst(p, trx, true);
      const r = await trx
        .updateTable('cancellation_requests')
        .set({
          status: 'WITHDRAWN',
          resolved_by: by,
          resolved_at: at,
          row_version: (eb) => eb('row_version', '+', 1),
        })
        .where('institution_id', '=', row.id)
        .where('public_id', '=', uuidToBin(id))
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new NotFoundError();
      await repo.addEvent(trx, {
        institutionId: row.id,
        action: 'CANCELLATION_WITHDRAWN',
        from: null,
        to: null,
        reason: 'Withdrawn by the institution',
        actor: by,
        at,
      });
    });
  }

  /** Back office: the pending request of an institution is declined with a reason (SAS-049). */
  async declineCancellation(operator: Principal, institutionPublicId: string, reason: string) {
    if (!isUuid(institutionPublicId)) throw new NotFoundError();
    const text = reason.trim();
    if (text.length < 5)
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.FORMAT' }]);
    const by = this.by(operator);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const row = await repo.byPublicId(trx, uuidToBin(institutionPublicId), true);
      if (!row) throw new NotFoundError();
      const r = await trx
        .updateTable('cancellation_requests')
        .set({ status: 'DECLINED', resolved_by: by, resolved_at: at, resolution: text })
        .where('institution_id', '=', row.id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new NotFoundError();
      await repo.addEvent(trx, {
        institutionId: row.id,
        action: 'CANCELLATION_DECLINED',
        from: null,
        to: null,
        reason: text,
        actor: by,
        at,
      });
    });
  }
}

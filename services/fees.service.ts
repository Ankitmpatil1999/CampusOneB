/**
 * Fee heads, entry fees and fee structures (SRS 13.2, 13.19 CR-11/CR-12; FEE-001…009; prototype
 * c.fees).
 *
 * - Fee heads are the institution's master, seeded on first use (OI-FEE-25, disposition B).
 * - Entry fees: one application fee (with its mandatory flag) and one admission fee per academic
 *   year, beside the structures (OI-FEE-29); edited with If-Match once set.
 * - A structure is held as versions (RNG-FEE-161/162): a draft is edited freely; submitting sends it
 *   to a checker (or applies it directly for an administrator, ADR-0015); approval activates it and
 *   supersedes the previous one; a rejection returns it to draft with the remarks. Editing an approved
 *   structure opens a new draft version; records already raised keep their version (RNG-FEE-163).
 * - One formula (RNG-FEE-164/165): `headParts` splits a head by the instalment shares in whole rupees
 *   with the remainder on the last; an instalment is the sum of its mandatory parts; the total is the
 *   sum of the mandatory heads. A stated total that differs is refused with nothing written.
 * - A class is served by one structure a year (RNG-FEE-158): checked on save, on submit and again
 *   when the version is activated.
 * - Assignment (RNG-FEE-167…169) lists what will be raised, then raises one record per remaining
 *   instalment per student (instalments already due are skipped — BR-30, Q14 M10), with the head
 *   breakdown; one assignment per student and year.
 */
import type { Kysely, Transaction } from 'kysely';
import { notifyFeeAssigned } from './fee-notices.service';
import { sql } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  ConflictError,
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { formatDate, formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { retryOnLock } from '../utils/retry';
import { raiseApproval } from './approvals.service';
import { recordAudit } from './audit.service';
import type { MembersService } from './members.service';
import { defaultValues, type SettingValues } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

/** The heads an institution starts with (OI-FEE-25, disposition B). */
export const DEFAULT_FEE_HEADS = [
  'Tuition',
  'Annual',
  'Transport',
  'Laboratory',
  'Activity',
  'Hostel',
  'Other',
] as const;

/**
 * A head's part of each instalment: whole rupees by share, the remainder on the last (RNG-FEE-164).
 * The parts always add up to the head's amount.
 */
export function headParts(amountPaise: number, sharesBp: readonly number[]): number[] {
  const parts = sharesBp.map((bp) => Math.floor((amountPaise * bp) / 1_000_000) * 100);
  const last = parts.length - 1;
  parts[last] = amountPaise - parts.slice(0, last).reduce((a, b) => a + b, 0);
  return parts;
}

/** The one formula: instalments are the sums of the mandatory parts; the total is their sum. */
export function structureTotals(
  heads: readonly { amountPaise: number; optional: boolean }[],
  sharesBp: readonly number[],
) {
  const mandatory = heads.filter((h) => !h.optional);
  const parts = mandatory.map((h) => headParts(h.amountPaise, sharesBp));
  const instalments = sharesBp.map((_, i) => parts.reduce((a, p) => a + p[i]!, 0));
  return {
    total: mandatory.reduce((a, h) => a + h.amountPaise, 0),
    optional: heads.filter((h) => h.optional).reduce((a, h) => a + h.amountPaise, 0),
    instalments,
  };
}

/** "33.33" → 3333 basis points; null when not a share above 0 with two decimals at most. */
export function shareBp(share: string) {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(share.trim())) return null;
  const [w, f = ''] = share.trim().split('.');
  const bp = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return bp > 0 && bp <= 10_000 ? bp : null;
}
const pctText = (bp: number) => (bp % 100 ? (bp / 100).toFixed(2) : String(bp / 100));

export interface StructureInput {
  readonly yearId: string;
  readonly name: string;
  readonly classIds: readonly string[];
  readonly heads: readonly {
    headId: string;
    amountPaise: number;
    optional?: boolean | undefined;
  }[];
  readonly instalments: readonly { label: string; dueDate: string; share: string }[];
  readonly lateFinePaise: number;
  /** The total the screen showed; refused when it isn't the server's (RNG-FEE-165). */
  readonly statedTotalPaise?: number | undefined;
}

export class FeesService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly members: MembersService;
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

  private async inst(p: Principal, db: Db = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!i) throw new NotFoundError();
    return { id: String(i.id), name: i.name };
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  /** A year of the institution; one named in the path that isn't found is a 404 (tenant isolation). */
  private async year(db: Db, institutionId: string, yearId: string, inPath = false) {
    const missing = () =>
      inPath
        ? new NotFoundError()
        : new ValidationError([{ field: 'yearId', code: 'VALIDATION.FORMAT' }]);
    if (!isUuid(yearId)) throw missing();
    const y = await db
      .selectFrom('academic_years')
      .select(['id', 'public_id', 'label', 'starts_on', 'ends_on', 'status'])
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(yearId))
      .executeTakeFirst();
    if (!y) throw missing();
    return {
      id: String(y.id),
      publicId: binToUuid(y.public_id),
      label: y.label,
      start: istBusinessDate(new Date(y.starts_on)),
      end: istBusinessDate(new Date(y.ends_on)),
      status: y.status,
    };
  }

  // --- FEE-001 / FEE-002 ----------------------------------------------------------------------------
  private async ensureHeads(institutionId: string) {
    const any = await this.deps.db
      .selectFrom('fee_heads')
      .select('id')
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (any) return;
    await this.deps.db
      .insertInto('fee_heads')
      .ignore()
      .values(
        DEFAULT_FEE_HEADS.map((name, i) => ({
          public_id: newPublicIdPair().bin,
          institution_id: institutionId,
          name,
          sort_order: i + 1,
        })),
      )
      .execute();
  }

  async heads(p: Principal) {
    const i = await this.inst(p);
    await this.ensureHeads(i.id);
    const rows = await this.deps.db
      .selectFrom('fee_heads as h')
      .select([
        'h.id',
        'h.public_id',
        'h.name',
        'h.status',
        sql<number>`(SELECT COUNT(DISTINCT v.structure_id) FROM fee_structure_heads sh
          JOIN fee_structure_versions v ON v.id = sh.version_id
          WHERE sh.head_id = h.id AND v.state <> 'SUPERSEDED')`.as('used'),
      ])
      .where('h.institution_id', '=', i.id)
      .orderBy('h.sort_order')
      .orderBy('h.id')
      .execute();
    return {
      items: rows.map((h) => ({
        id: binToUuid(h.public_id),
        name: h.name,
        status: h.status,
        structures: Number(h.used),
      })),
    };
  }

  async addHead(p: Principal, input: { name: string }) {
    const i = await this.inst(p);
    await this.ensureHeads(i.id);
    const raw = input.name.trim();
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const pub = newPublicIdPair();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const max = await trx
          .selectFrom('fee_heads')
          .select(sql<number>`COALESCE(MAX(sort_order), 0)`.as('m'))
          .where('institution_id', '=', i.id)
          .executeTakeFirst();
        await trx
          .insertInto('fee_heads')
          .values({
            public_id: pub.bin,
            institution_id: i.id,
            name,
            sort_order: Number(max?.m ?? 0) + 1,
            created_by: this.by(p),
          })
          .execute();
        await recordAudit(trx, {
          institutionId: i.id,
          action: 'FEE_HEAD_ADDED',
          entityType: 'fee_head',
          entityRef: pub.id,
          after: { name },
        });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'FEE.HEAD_TAKEN', { params: { name } });
      }
      throw e;
    }
    return { id: pub.id, name, status: 'ACTIVE' as const, structures: 0 };
  }

  // --- FEE-008 / FEE-009 ----------------------------------------------------------------------------
  async entryFees(p: Principal) {
    const i = await this.inst(p);
    const rows = await this.deps.db
      .selectFrom('academic_years as y')
      .leftJoin('entry_fees as e', (j) =>
        j.onRef('e.year_id', '=', 'y.id').onRef('e.institution_id', '=', 'y.institution_id'),
      )
      .select([
        'y.public_id',
        'y.label',
        'y.status',
        'y.is_current',
        'y.starts_on',
        'e.application_fee_paise',
        'e.application_mandatory',
        'e.admission_fee_paise',
        'e.row_version',
        'e.updated_at',
      ])
      .where('y.institution_id', '=', i.id)
      .orderBy('y.starts_on', 'desc')
      .execute();
    return {
      items: rows.map((r) => ({
        year: {
          id: binToUuid(r.public_id),
          label: r.label,
          status: r.status,
          current: !!Number(r.is_current),
        },
        fees:
          r.application_fee_paise === null
            ? null
            : {
                applicationFee: toMoneyDto(Number(r.application_fee_paise)),
                applicationMandatory: !!Number(r.application_mandatory),
                admissionFee: toMoneyDto(Number(r.admission_fee_paise)),
                updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
                version: r.row_version ?? 1,
              },
      })),
    };
  }

  async setEntryFees(
    p: Principal,
    yearId: string,
    expected: number | null,
    input: {
      applicationFeePaise: number;
      applicationMandatory: boolean;
      admissionFeePaise: number;
    },
  ) {
    const i = await this.inst(p);
    const y = await this.year(this.deps.db, i.id, yearId, true);
    if (y.status === 'CLOSED')
      throw new CustomAPIError(409, 'FEE.YEAR_CLOSED', { params: { year: y.label } });
    const now = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const cur = await trx
        .selectFrom('entry_fees')
        .selectAll()
        .where('institution_id', '=', i.id)
        .where('year_id', '=', y.id)
        .forUpdate()
        .executeTakeFirst();
      if (cur) {
        if (expected === null) throw new CustomAPIError(428, 'GEN.PRECONDITION_REQUIRED');
        if (cur.row_version !== expected) throw new PreconditionFailedError();
        await trx
          .updateTable('entry_fees')
          .set({
            application_fee_paise: input.applicationFeePaise,
            application_mandatory: input.applicationMandatory,
            admission_fee_paise: input.admissionFeePaise,
            updated_by: this.by(p),
            updated_at: now,
            row_version: sql<number>`row_version + 1`,
          })
          .where('institution_id', '=', i.id)
          .where('year_id', '=', y.id)
          .execute();
      } else {
        await trx
          .insertInto('entry_fees')
          .values({
            institution_id: i.id,
            year_id: y.id,
            application_fee_paise: input.applicationFeePaise,
            application_mandatory: input.applicationMandatory,
            admission_fee_paise: input.admissionFeePaise,
            updated_by: this.by(p),
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      await recordAudit(trx, {
        institutionId: i.id,
        action: 'ENTRY_FEES_SET',
        entityType: 'academic_year',
        entityRef: y.publicId,
        after: input,
        ...(cur
          ? {
              before: {
                applicationFeePaise: Number(cur.application_fee_paise),
                applicationMandatory: !!Number(cur.application_mandatory),
                admissionFeePaise: Number(cur.admission_fee_paise),
              },
            }
          : {}),
      });
    });
    const out = (await this.entryFees(p)).items.find((x) => x.year.id === y.publicId)!;
    return out;
  }

  // --- structures: reading --------------------------------------------------------------------------
  private async versionView(
    db: Db,
    v: {
      id: string;
      public_id: Buffer;
      version_no: number;
      state: string;
      total_paise: string;
      optional_paise: string;
      late_fine_paise: string;
      returned_remarks: string | null;
      approval_id: string | null;
      created_at: Date;
      submitted_at: Date | null;
      activated_at: Date | null;
      row_version: number;
    },
  ) {
    const [classes, heads, instalments, approval] = await Promise.all([
      db
        .selectFrom('fee_structure_classes as fc')
        .innerJoin('classes as c', 'c.id', 'fc.class_id')
        .select(['c.public_id', 'c.name', 'c.sort_order'])
        .where('fc.version_id', '=', v.id)
        .orderBy('c.sort_order')
        .execute(),
      db
        .selectFrom('fee_structure_heads as sh')
        .innerJoin('fee_heads as h', 'h.id', 'sh.head_id')
        .select(['h.public_id', 'h.name', 'sh.optional', 'sh.amount_paise'])
        .where('sh.version_id', '=', v.id)
        .orderBy('sh.sort_order')
        .execute(),
      db
        .selectFrom('fee_structure_instalments')
        .selectAll()
        .where('version_id', '=', v.id)
        .orderBy('seq')
        .execute(),
      v.approval_id
        ? db
            .selectFrom('approval_requests')
            .select(['public_id', 'request_seq'])
            .where('id', '=', v.approval_id)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      id: binToUuid(v.public_id),
      no: v.version_no,
      state: v.state,
      classes: classes.map((c) => ({ id: binToUuid(c.public_id), name: c.name })),
      heads: heads.map((h) => ({
        headId: binToUuid(h.public_id),
        name: h.name,
        optional: !!Number(h.optional),
        amount: toMoneyDto(Number(h.amount_paise)),
      })),
      instalments: instalments.map((x) => ({
        seq: x.seq,
        label: x.label,
        dueDate: istBusinessDate(new Date(x.due_date)),
        share: pctText(x.share_bp),
        amount: toMoneyDto(Number(x.amount_paise)),
      })),
      total: toMoneyDto(Number(v.total_paise)),
      optional: toMoneyDto(Number(v.optional_paise)),
      lateFine: toMoneyDto(Number(v.late_fine_paise)),
      returnedRemarks: v.returned_remarks,
      approval: approval
        ? {
            id: binToUuid(approval.public_id),
            no: `APR-${String(approval.request_seq ?? 0).padStart(4, '0')}`,
          }
        : null,
      createdAt: iso(v.created_at)!,
      submittedAt: iso(v.submitted_at),
      activatedAt: iso(v.activated_at),
      version: v.row_version,
    };
  }

  private versionsOf(db: Db, structureIds: readonly string[]) {
    return structureIds.length
      ? db
          .selectFrom('fee_structure_versions')
          .selectAll()
          .where('structure_id', 'in', structureIds)
          .orderBy('version_no', 'desc')
          .execute()
      : Promise.resolve([]);
  }

  private async structureView(
    db: Db,
    s: { id: string; public_id: Buffer; name: string; year_public_id: Buffer; year_label: string },
    versions: Awaited<ReturnType<FeesService['versionsOf']>>,
  ) {
    const mine = versions.filter((v) => String(v.structure_id) === String(s.id));
    const open = mine.find((v) => v.state === 'DRAFT' || v.state === 'PENDING');
    const active = mine.find((v) => v.state === 'ACTIVE');
    const current = open ?? active ?? mine[0]!;
    const assigned = await db
      .selectFrom('fee_assignments')
      .select([
        sql<number>`COUNT(*)`.as('students'),
        sql<number>`(SELECT COUNT(*) FROM fee_records r WHERE r.assignment_id IN
          (SELECT a2.id FROM fee_assignments a2 WHERE a2.structure_id = ${s.id} AND a2.status = 'ACTIVE'))`.as(
          'records',
        ),
      ])
      .where('structure_id', '=', s.id)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return {
      id: binToUuid(s.public_id),
      name: s.name,
      year: { id: binToUuid(s.year_public_id), label: s.year_label },
      status: current.state,
      current: await this.versionView(db, current),
      active: active && active !== current ? await this.versionView(db, active) : null,
      versions: mine.map((v) => ({
        no: v.version_no,
        state: v.state,
        total: toMoneyDto(Number(v.total_paise)),
        activatedAt: v.activated_at ? new Date(v.activated_at).toISOString() : null,
      })),
      assigned: {
        students: Number(assigned?.students ?? 0),
        records: Number(assigned?.records ?? 0),
      },
    };
  }

  private structureRows(db: Db, institutionId: string) {
    return db
      .selectFrom('fee_structures as s')
      .innerJoin('academic_years as y', 'y.id', 's.year_id')
      .select([
        's.id',
        's.public_id',
        's.name',
        's.year_id',
        'y.public_id as year_public_id',
        'y.label as year_label',
      ])
      .where('s.institution_id', '=', institutionId);
  }

  // --- FEE-003 --------------------------------------------------------------------------------------
  async structures(p: Principal, f: { yearId?: string | undefined; status?: string | undefined }) {
    const i = await this.inst(p);
    let q = this.structureRows(this.deps.db, i.id);
    if (f.yearId) {
      if (!isUuid(f.yearId)) return { items: [], kpis: null };
      q = q.where('y.public_id', '=', uuidToBin(f.yearId));
    }
    const rows = await q.orderBy('s.name').execute();
    const versions = await this.versionsOf(
      this.deps.db,
      rows.map((r) => String(r.id)),
    );
    const items = [];
    for (const r of rows) items.push(await this.structureView(this.deps.db, r, versions));
    const shown = f.status ? items.filter((x) => x.status === f.status) : items;
    const classes = await this.deps.db
      .selectFrom('classes')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('institution_id', '=', i.id)
      .executeTakeFirst();
    const covered = new Set(
      items
        .filter((x) => x.status !== 'DRAFT')
        .flatMap((x) => (x.active ?? x.current).classes.map((c) => c.id)),
    );
    return {
      items: shown,
      kpis: {
        structures: items.length,
        approved: items.filter((x) => x.status === 'ACTIVE' || !!x.active).length,
        pending: items.filter((x) => x.status === 'PENDING').length,
        classesCovered: covered.size,
        classes: Number(classes?.n ?? 0),
      },
      maxInstalments: await this.limit(LIMITS.feeInstalmentsMax),
    };
  }

  async structure(p: Principal, id: string) {
    const i = await this.inst(p);
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.structureRows(this.deps.db, i.id)
      .where('s.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    return this.structureView(this.deps.db, r, await this.versionsOf(this.deps.db, [String(r.id)]));
  }

  // --- validation -----------------------------------------------------------------------------------
  /** Checks the input and prices it (the one formula); throws the first refusal of each kind. */
  private async check(db: Db, institutionId: string, input: StructureInput) {
    const y = await this.year(db, institutionId, input.yearId);
    if (y.status === 'CLOSED')
      throw new CustomAPIError(409, 'FEE.YEAR_CLOSED', { params: { year: y.label } });
    const max = await this.limit(LIMITS.feeInstalmentsMax);
    if (input.instalments.length > max) {
      throw new CustomAPIError(422, 'FEE.INSTALMENTS_MAX', { params: { max } });
    }
    // Classes of this institution.
    const classIds = [...new Set(input.classIds.map((c) => c.toLowerCase()))];
    if (classIds.some((c) => !isUuid(c))) {
      throw new ValidationError([{ field: 'classIds', code: 'VALIDATION.FORMAT' }]);
    }
    const classes = await db
      .selectFrom('classes')
      .select(['id', 'public_id', 'name'])
      .where('institution_id', '=', institutionId)
      .where(
        'public_id',
        'in',
        classIds.map((c) => uuidToBin(c)),
      )
      .execute();
    if (classes.length !== classIds.length) {
      throw new ValidationError([{ field: 'classIds', code: 'VALIDATION.FORMAT' }]);
    }
    // Heads of the master, each once.
    const headIds = input.heads.map((h) => h.headId.toLowerCase());
    if (headIds.some((h) => !isUuid(h))) throw new CustomAPIError(422, 'FEE.HEAD_UNKNOWN');
    const heads = await db
      .selectFrom('fee_heads')
      .select(['id', 'public_id', 'name', 'status'])
      .where('institution_id', '=', institutionId)
      .where(
        'public_id',
        'in',
        headIds.map((h) => uuidToBin(h)),
      )
      .execute();
    const byId = new Map(heads.map((h) => [binToUuid(h.public_id), h]));
    const seen = new Set<string>();
    for (const h of input.heads) {
      const row = byId.get(h.headId.toLowerCase());
      if (!row || row.status !== 'ACTIVE') throw new CustomAPIError(422, 'FEE.HEAD_UNKNOWN');
      if (seen.has(row.id)) {
        throw new CustomAPIError(422, 'FEE.HEAD_REPEATED', { params: { name: row.name } });
      }
      seen.add(row.id);
    }
    if (!input.heads.some((h) => !h.optional)) {
      throw new ValidationError([{ field: 'heads', code: 'VALIDATION.REQUIRED' }]);
    }
    // Instalments: shares, dates inside the year and in order.
    const shares: number[] = [];
    input.instalments.forEach((x, n) => {
      const bp = shareBp(x.share);
      if (bp === null) {
        throw new ValidationError([{ field: `instalments.${n}.share`, code: 'VALIDATION.FORMAT' }]);
      }
      shares.push(bp);
      if (x.dueDate < y.start || x.dueDate > y.end) {
        throw new CustomAPIError(422, 'FEE.DUE_OUTSIDE_YEAR', {
          params: {
            label: x.label,
            year: y.label,
            from: formatDate(y.start),
            to: formatDate(y.end),
          },
        });
      }
      const prev = input.instalments[n - 1];
      if (prev && x.dueDate <= prev.dueDate) {
        throw new CustomAPIError(422, 'FEE.DUE_ORDER', {
          params: { label: x.label, previous: prev.label },
        });
      }
    });
    const sum = shares.reduce((a, b) => a + b, 0);
    if (sum !== 10_000) {
      throw new CustomAPIError(422, 'FEE.SHARES_NOT_100', { params: { total: pctText(sum) } });
    }
    const priced = structureTotals(
      input.heads.map((h) => ({ amountPaise: h.amountPaise, optional: !!h.optional })),
      shares,
    );
    const smallest = Math.min(...priced.instalments);
    if (input.lateFinePaise > smallest) {
      throw new CustomAPIError(422, 'FEE.FINE_TOO_HIGH', { params: { max: formatInr(smallest) } });
    }
    if (input.statedTotalPaise !== undefined && input.statedTotalPaise !== priced.total) {
      throw new CustomAPIError(422, 'FEE.TOTAL_MISMATCH', {
        params: { sent: formatInr(input.statedTotalPaise), total: formatInr(priced.total) },
      });
    }
    return {
      y,
      classes: classes.map((c) => ({ id: String(c.id), name: c.name })),
      heads: input.heads.map((h, n) => ({
        id: byId.get(h.headId.toLowerCase())!.id,
        amountPaise: h.amountPaise,
        optional: !!h.optional,
        sort: n + 1,
      })),
      shares,
      priced,
    };
  }

  /** RNG-FEE-158: a class is served by one structure a year (approved or waiting for approval). */
  private async clash(
    db: Db,
    institutionId: string,
    yearId: string,
    structureId: string | null,
    classes: readonly { id: string; name: string }[],
    yearLabel: string,
  ) {
    if (!classes.length) return;
    let q = db
      .selectFrom('fee_structure_classes as fc')
      .innerJoin('fee_structure_versions as v', 'v.id', 'fc.version_id')
      .innerJoin('fee_structures as s', 's.id', 'v.structure_id')
      .select(['fc.class_id', 's.name'])
      .where('s.institution_id', '=', institutionId)
      .where('s.year_id', '=', yearId)
      .where('v.state', 'in', ['ACTIVE', 'PENDING'])
      .where(
        'fc.class_id',
        'in',
        classes.map((c) => c.id),
      );
    if (structureId) q = q.where('s.id', '<>', structureId);
    const hit = await q.executeTakeFirst();
    if (hit) {
      const c = classes.find((x) => x.id === String(hit.class_id))!;
      throw new CustomAPIError(409, 'FEE.CLASS_TAKEN', {
        params: { class: c.name, structure: hit.name, year: yearLabel },
      });
    }
  }

  private async writeVersion(
    trx: Transaction<Database>,
    versionId: string,
    c: Awaited<ReturnType<FeesService['check']>>,
    input: StructureInput,
  ) {
    await trx.deleteFrom('fee_structure_classes').where('version_id', '=', versionId).execute();
    await trx.deleteFrom('fee_structure_heads').where('version_id', '=', versionId).execute();
    await trx.deleteFrom('fee_structure_instalments').where('version_id', '=', versionId).execute();
    await trx
      .insertInto('fee_structure_classes')
      .values(c.classes.map((x) => ({ version_id: versionId, class_id: x.id })))
      .execute();
    await trx
      .insertInto('fee_structure_heads')
      .values(
        c.heads.map((h) => ({
          version_id: versionId,
          head_id: h.id,
          optional: h.optional,
          amount_paise: h.amountPaise,
          sort_order: h.sort,
        })),
      )
      .execute();
    await trx
      .insertInto('fee_structure_instalments')
      .values(
        input.instalments.map((x, n) => ({
          version_id: versionId,
          seq: n + 1,
          label: x.label.trim(),
          due_date: x.dueDate,
          share_bp: c.shares[n]!,
          amount_paise: c.priced.instalments[n]!,
        })),
      )
      .execute();
  }

  // --- FEE-004 --------------------------------------------------------------------------------------
  async create(p: Principal, input: StructureInput) {
    const i = await this.inst(p);
    const c = await this.check(this.deps.db, i.id, input);
    await this.clash(this.deps.db, i.id, c.y.id, null, c.classes, c.y.label);
    const s = newPublicIdPair();
    const v = newPublicIdPair();
    const name = input.name.trim();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const r = await trx
          .insertInto('fee_structures')
          .values({
            public_id: s.bin,
            institution_id: i.id,
            year_id: c.y.id,
            name,
            created_by: this.by(p),
            created_at: this.now(),
          })
          .executeTakeFirstOrThrow();
        const vr = await trx
          .insertInto('fee_structure_versions')
          .values({
            public_id: v.bin,
            institution_id: i.id,
            structure_id: String(r.insertId),
            version_no: 1,
            total_paise: c.priced.total,
            optional_paise: c.priced.optional,
            late_fine_paise: input.lateFinePaise,
            created_by: this.by(p),
            created_at: this.now(),
          })
          .executeTakeFirstOrThrow();
        await this.writeVersion(trx, String(vr.insertId), c, input);
        await recordAudit(trx, {
          institutionId: i.id,
          action: 'FEE_STRUCTURE_CREATED',
          entityType: 'fee_structure',
          entityRef: s.id,
          after: { name, year: c.y.label, total: c.priced.total },
        });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'FEE.STRUCTURE_NAME_TAKEN', {
          params: { name, year: c.y.label },
        });
      }
      throw e;
    }
    return this.structure(p, s.id);
  }

  // --- FEE-005 --------------------------------------------------------------------------------------
  /** Edits the draft; on an approved structure, opens a new draft version (RNG-FEE-161). */
  async update(p: Principal, id: string, expected: number, input: StructureInput) {
    const i = await this.inst(p);
    if (!isUuid(id)) throw new NotFoundError();
    // The structure first: another institution's id is a 404 whatever the body says.
    const own = await this.deps.db
      .selectFrom('fee_structures')
      .select('id')
      .where('institution_id', '=', i.id)
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!own) throw new NotFoundError();
    const c = await this.check(this.deps.db, i.id, input);
    const name = input.name.trim();
    try {
      await retryOnLock(() =>
        this.deps.db.transaction().execute(async (trx) => {
          const s = await trx
            .selectFrom('fee_structures')
            .selectAll()
            .where('institution_id', '=', i.id)
            .where('public_id', '=', uuidToBin(id))
            .forUpdate()
            .executeTakeFirst();
          if (!s) throw new NotFoundError();
          if (String(s.year_id) !== c.y.id) {
            throw new ValidationError([{ field: 'yearId', code: 'VALIDATION.FORMAT' }]);
          }
          await this.clash(trx, i.id, c.y.id, String(s.id), c.classes, c.y.label);
          const versions = await trx
            .selectFrom('fee_structure_versions')
            .selectAll()
            .where('structure_id', '=', s.id)
            .orderBy('version_no', 'desc')
            .forUpdate()
            .execute();
          const open = versions.find((v) => v.state === 'DRAFT' || v.state === 'PENDING');
          if (open?.state === 'PENDING') throw new CustomAPIError(409, 'FEE.STRUCTURE_LOCKED');
          const head = open ?? versions[0]!;
          if (head.row_version !== expected) throw new PreconditionFailedError();
          if (name !== s.name) {
            await trx.updateTable('fee_structures').set({ name }).where('id', '=', s.id).execute();
          }
          let versionId: string;
          if (open) {
            versionId = String(open.id);
            await trx
              .updateTable('fee_structure_versions')
              .set({
                total_paise: c.priced.total,
                optional_paise: c.priced.optional,
                late_fine_paise: input.lateFinePaise,
                returned_remarks: null,
                row_version: sql<number>`row_version + 1`,
              })
              .where('id', '=', open.id)
              .execute();
          } else {
            const r = await trx
              .insertInto('fee_structure_versions')
              .values({
                public_id: newPublicIdPair().bin,
                institution_id: i.id,
                structure_id: String(s.id),
                version_no: versions[0]!.version_no + 1,
                total_paise: c.priced.total,
                optional_paise: c.priced.optional,
                late_fine_paise: input.lateFinePaise,
                created_by: this.by(p),
                created_at: this.now(),
              })
              .executeTakeFirstOrThrow();
            versionId = String(r.insertId);
          }
          await this.writeVersion(trx, versionId, c, input);
          await recordAudit(trx, {
            institutionId: i.id,
            action: 'FEE_STRUCTURE_EDITED',
            entityType: 'fee_structure',
            entityRef: id,
            after: { name, total: c.priced.total, newVersion: !open },
          });
        }),
      );
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'FEE.STRUCTURE_NAME_TAKEN', {
          params: { name, year: c.y.label },
        });
      }
      throw e;
    }
    return this.structure(p, id);
  }

  // --- FEE-006 --------------------------------------------------------------------------------------
  async submit(p: Principal, id: string, input: { note?: string | null | undefined }) {
    if (!isUuid(id)) throw new NotFoundError();
    const by = this.by(p);
    if (!by) throw new NotFoundError();
    const at = this.now();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const i = await this.inst(p, trx, true);
      const s = await this.structureRows(trx, i.id)
        .where('s.public_id', '=', uuidToBin(id))
        .executeTakeFirst();
      if (!s) throw new NotFoundError();
      const v = await trx
        .selectFrom('fee_structure_versions')
        .selectAll()
        .where('structure_id', '=', s.id)
        .where('state', 'in', ['DRAFT', 'PENDING'])
        .forUpdate()
        .executeTakeFirst();
      if (!v) throw new CustomAPIError(409, 'FEE.NOTHING_TO_SUBMIT');
      if (v.state === 'PENDING') throw new CustomAPIError(409, 'FEE.ALREADY_PENDING');
      const classes = await trx
        .selectFrom('fee_structure_classes as fc')
        .innerJoin('classes as c', 'c.id', 'fc.class_id')
        .select(['c.id', 'c.name'])
        .where('fc.version_id', '=', v.id)
        .execute();
      await this.clash(
        trx,
        i.id,
        String(s.year_id),
        String(s.id),
        classes.map((c) => ({ id: String(c.id), name: c.name })),
        s.year_label,
      );
      const counts = await trx
        .selectFrom('fee_structure_instalments')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('version_id', '=', v.id)
        .executeTakeFirst();
      const direct = await this.deps.members.adminSelfApplies(
        trx as unknown as Kysely<Database>,
        p,
      );
      const raised = await raiseApproval(trx, {
        institutionId: i.id,
        module: 'FEE_STRUCTURE',
        summary:
          `${s.name} (version ${v.version_no}) — ${Number(counts?.n ?? 0)} instalments, total ${formatInr(Number(v.total_paise))}, late fine ${formatInr(Number(v.late_fine_paise))}${input.note?.trim() ? ` — ${input.note.trim()}` : ''}`.slice(
            0,
            300,
          ),
        payload: { structure: id, version: binToUuid(v.public_id) },
        makerType: 'staff',
        makerRef: by,
        subjectType: 'fee_structure',
        subjectRef: s.public_id,
        at,
        appliedDirectly: direct,
      });
      await trx
        .updateTable('fee_structure_versions')
        .set({
          state: 'PENDING',
          approval_id: raised.rowId,
          submitted_by: by,
          submitted_at: at,
          returned_remarks: null,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', v.id)
        .execute();
      if (direct) {
        await this.applyApproved(trx, { structure: id, version: binToUuid(v.public_id) }, at);
      }
      return { approvalId: raised.id, no: raised.no, appliedDirectly: direct };
    });
    return { ...out, structure: await this.structure(p, id) };
  }

  /** The approved effect (MKR-003): re-checks, then activates and supersedes (RNG-FEE-161/162). */
  async applyApproved(trx: Transaction<Database>, payload: Record<string, unknown>, at: Date) {
    const versionId = String(payload['version'] ?? '');
    if (!isUuid(versionId)) throw new NotFoundError();
    const v = await trx
      .selectFrom('fee_structure_versions as v')
      .innerJoin('fee_structures as s', 's.id', 'v.structure_id')
      .innerJoin('academic_years as y', 'y.id', 's.year_id')
      .select([
        'v.id',
        'v.structure_id',
        'v.state',
        'v.institution_id',
        's.year_id',
        's.public_id',
        'y.label',
      ])
      .where('v.public_id', '=', uuidToBin(versionId))
      .forUpdate()
      .executeTakeFirst();
    if (!v) throw new NotFoundError();
    if (v.state !== 'PENDING') throw new ConflictError('MKR.ALREADY_DECIDED');
    const classes = await trx
      .selectFrom('fee_structure_classes as fc')
      .innerJoin('classes as c', 'c.id', 'fc.class_id')
      .select(['c.id', 'c.name'])
      .where('fc.version_id', '=', v.id)
      .execute();
    await this.clash(
      trx,
      String(v.institution_id),
      String(v.year_id),
      String(v.structure_id),
      classes.map((c) => ({ id: String(c.id), name: c.name })),
      v.label,
    );
    await trx
      .updateTable('fee_structure_versions')
      .set({ state: 'SUPERSEDED', superseded_at: at, row_version: sql<number>`row_version + 1` })
      .where('structure_id', '=', v.structure_id)
      .where('state', '=', 'ACTIVE')
      .execute();
    await trx
      .updateTable('fee_structure_versions')
      .set({ state: 'ACTIVE', activated_at: at, row_version: sql<number>`row_version + 1` })
      .where('id', '=', v.id)
      .execute();
    await recordAudit(trx, {
      institutionId: String(v.institution_id),
      action: 'FEE_STRUCTURE_ACTIVATED',
      entityType: 'fee_structure',
      entityRef: binToUuid(v.public_id),
      after: { version: versionId },
    });
  }

  /** A checker's rejection returns the version to draft with the remarks (prototype "Returned by"). */
  async applyReturned(
    trx: Transaction<Database>,
    payload: Record<string, unknown>,
    remarks: string,
    at: Date,
  ) {
    const versionId = String(payload['version'] ?? '');
    if (!isUuid(versionId)) return;
    await trx
      .updateTable('fee_structure_versions')
      .set({
        state: 'DRAFT',
        returned_remarks: remarks.slice(0, 500),
        row_version: sql<number>`row_version + 1`,
      })
      .where('public_id', '=', uuidToBin(versionId))
      .where('state', '=', 'PENDING')
      .execute();
    void at;
  }

  /** What the checker sees (RNG-FEE-177): the totals and instalments before and after. */
  async approvalChanges(db: Db, payload: Record<string, unknown>) {
    const versionId = String(payload['version'] ?? '');
    if (!isUuid(versionId)) return [];
    const v = await db
      .selectFrom('fee_structure_versions')
      .selectAll()
      .where('public_id', '=', uuidToBin(versionId))
      .executeTakeFirst();
    if (!v) return [];
    const active = await db
      .selectFrom('fee_structure_versions')
      .selectAll()
      .where('structure_id', '=', v.structure_id)
      .where('state', '=', 'ACTIVE')
      .where('id', '<>', v.id)
      .executeTakeFirst();
    const inst = async (id: string) =>
      (
        await db
          .selectFrom('fee_structure_instalments')
          .select(['label', 'amount_paise', 'due_date'])
          .where('version_id', '=', id)
          .orderBy('seq')
          .execute()
      )
        .map(
          (x) =>
            `${x.label} ${formatInr(Number(x.amount_paise))} · ${formatDate(istBusinessDate(new Date(x.due_date)))}`,
        )
        .join('; ');
    return [
      {
        label: 'Total (mandatory heads)',
        from: active ? formatInr(Number(active.total_paise)) : '—',
        to: formatInr(Number(v.total_paise)),
      },
      {
        label: 'Instalments',
        from: active ? await inst(String(active.id)) : '—',
        to: await inst(String(v.id)),
      },
      {
        label: 'Late fine',
        from: active ? formatInr(Number(active.late_fine_paise)) : '—',
        to: formatInr(Number(v.late_fine_paise)),
      },
    ];
  }

  // --- FEE-007 --------------------------------------------------------------------------------------
  async assign(
    p: Principal,
    id: string,
    input: {
      classIds?: readonly string[] | undefined;
      optional?: readonly { studentId: string; headIds: readonly string[] }[] | undefined;
      preview: boolean;
    },
  ) {
    const i = await this.inst(p);
    if (!isUuid(id)) throw new NotFoundError();
    const s = await this.structureRows(this.deps.db, i.id)
      .where('s.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!s) throw new NotFoundError();
    const v = await this.deps.db
      .selectFrom('fee_structure_versions')
      .selectAll()
      .where('structure_id', '=', s.id)
      .where('state', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!v) throw new CustomAPIError(409, 'FEE.STRUCTURE_NOT_APPROVED');
    const view = await this.versionView(this.deps.db, v);
    const wanted = input.classIds?.length
      ? view.classes.filter((c) => input.classIds!.map((x) => x.toLowerCase()).includes(c.id))
      : view.classes;
    const today = istBusinessDate(this.now());
    const instalments = await this.deps.db
      .selectFrom('fee_structure_instalments')
      .selectAll()
      .where('version_id', '=', v.id)
      .orderBy('seq')
      .execute();
    const due = (x: { due_date: Date | string }) => istBusinessDate(new Date(x.due_date));
    const future = instalments.filter((x) => due(x) >= today);
    const heads = await this.deps.db
      .selectFrom('fee_structure_heads as sh')
      .innerJoin('fee_heads as h', 'h.id', 'sh.head_id')
      .select(['sh.head_id', 'h.public_id', 'h.name', 'sh.optional', 'sh.amount_paise'])
      .where('sh.version_id', '=', v.id)
      .orderBy('sh.sort_order')
      .execute();
    const shares = instalments.map((x) => x.share_bp);
    const parts = new Map(
      heads.map((h) => [String(h.head_id), headParts(Number(h.amount_paise), shares)]),
    );
    const optionalOf = new Map(
      (input.optional ?? []).map((o) => [
        o.studentId.toLowerCase(),
        new Set(o.headIds.map((h) => h.toLowerCase())),
      ]),
    );
    // Students of the classes in the structure's year; those holding an assignment are skipped.
    const classRows = await this.deps.db
      .selectFrom('classes')
      .select(['id', 'public_id'])
      .where('institution_id', '=', i.id)
      .where(
        'public_id',
        'in',
        wanted.length ? wanted.map((c) => uuidToBin(c.id)) : [Buffer.alloc(16)],
      )
      .execute();
    const classIdOf = new Map(classRows.map((c) => [String(c.id), binToUuid(c.public_id)]));
    const students = classRows.length
      ? await this.deps.db
          .selectFrom('enrolments as e')
          .innerJoin('sections as sec', 'sec.id', 'e.section_id')
          .innerJoin('member_profiles as m', 'm.id', 'e.student_profile_id')
          .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
          .leftJoin('fee_assignments as fa', (j) =>
            j
              .onRef('fa.student_profile_id', '=', 'm.id')
              .onRef('fa.year_id', '=', 'e.year_id')
              .on('fa.status', '=', 'ACTIVE'),
          )
          .select(['m.id', 'm.public_id', 'sec.class_id', 'fa.id as assignment_id'])
          .where('e.institution_id', '=', i.id)
          .where('e.year_id', '=', String(s.year_id))
          .where(
            'sec.class_id',
            'in',
            classRows.map((c) => String(c.id)),
          )
          .where('m.status', '=', 'ACTIVE')
          .where('ut.category', '=', 'STUDENT')
          .execute()
      : [];
    const priceFor = (studentPublicId: string) => {
      const opted = optionalOf.get(studentPublicId) ?? new Set<string>();
      const taken = heads.filter((h) => !Number(h.optional) || opted.has(binToUuid(h.public_id)));
      return future.map((x) => {
        const idx = instalments.findIndex((y) => y.seq === x.seq);
        const lines = taken.map((h) => ({ head: h, amount: parts.get(String(h.head_id))![idx]! }));
        return { x, lines, amount: lines.reduce((a, l) => a + l.amount, 0) };
      });
    };
    const perClass = wanted.map((c) => {
      const mine = students.filter((st) => classIdOf.get(String(st.class_id)) === c.id);
      const todo = mine.filter((st) => !st.assignment_id);
      const amount = todo.reduce(
        (a, st) => a + priceFor(binToUuid(st.public_id)).reduce((b, r) => b + r.amount, 0),
        0,
      );
      return {
        class: c,
        students: mine.length,
        already: mine.length - todo.length,
        toAssign: todo.length,
        records: todo.length * future.length,
        amount: toMoneyDto(amount),
        amountPaise: amount,
      };
    });
    const summary = {
      version: view.no,
      instalments: instalments.map((x) => ({
        seq: x.seq,
        label: x.label,
        dueDate: due(x),
        raised: due(x) >= today,
      })),
      perClass: perClass.map(({ amountPaise: _a, ...rest }) => rest),
      totals: {
        students: perClass.reduce((a, c) => a + c.toAssign, 0),
        records: perClass.reduce((a, c) => a + c.records, 0),
        amount: toMoneyDto(perClass.reduce((a, c) => a + c.amountPaise, 0)),
      },
    };
    if (input.preview) return { preview: true, ...summary };

    const todo = students.filter((st) => !st.assignment_id);
    let created = 0;
    let assigned = 0;
    const at = this.now();
    await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const live = await trx
          .selectFrom('fee_structure_versions')
          .select('state')
          .where('id', '=', v.id)
          .forShare()
          .executeTakeFirstOrThrow();
        if (live.state !== 'ACTIVE') throw new CustomAPIError(409, 'FEE.STRUCTURE_NOT_APPROVED');
        created = 0;
        assigned = 0;
        const totals = new Map<string, number>();
        for (const st of todo) {
          const studentId = binToUuid(st.public_id);
          const opted = [...(optionalOf.get(studentId) ?? [])];
          let assignmentId: string;
          try {
            const a = await trx
              .insertInto('fee_assignments')
              .values({
                public_id: newPublicIdPair().bin,
                institution_id: i.id,
                year_id: String(s.year_id),
                student_profile_id: String(st.id),
                structure_id: String(s.id),
                version_id: String(v.id),
                optional_heads: opted.length ? JSON.stringify(opted) : null,
                assigned_by: this.by(p),
                assigned_at: at,
              })
              .executeTakeFirstOrThrow();
            assignmentId = String(a.insertId);
          } catch (e) {
            if ((e as { errno?: number }).errno === 1062) continue; // assigned meanwhile
            throw e;
          }
          assigned++;
          for (const r of priceFor(studentId)) {
            const rec = await trx
              .insertInto('fee_records')
              .values({
                public_id: newPublicIdPair().bin,
                institution_id: i.id,
                year_id: String(s.year_id),
                student_profile_id: String(st.id),
                source: 'STRUCTURE',
                assignment_id: assignmentId,
                version_id: String(v.id),
                instalment_seq: r.x.seq,
                label: r.x.label,
                due_date: due(r.x),
                amount_paise: r.amount,
                late_fine_paise: Number(v.late_fine_paise),
                created_by: this.by(p),
                created_at: at,
                updated_at: at,
              })
              .executeTakeFirstOrThrow();
            await trx
              .insertInto('fee_record_heads')
              .values(
                r.lines.map((l) => ({
                  record_id: String(rec.insertId),
                  head_id: String(l.head.head_id),
                  name: l.head.name,
                  amount_paise: l.amount,
                })),
              )
              .execute();
            created++;
            totals.set(String(st.id), (totals.get(String(st.id)) ?? 0) + Number(r.amount));
          }
        }
        // Client 2026-10-16: the student and parents are told (in the app, and by e-mail).
        await notifyFeeAssigned(trx, String(i.id), String(s.year_id), totals, at);
        await recordAudit(trx, {
          institutionId: i.id,
          action: 'FEE_STRUCTURE_ASSIGNED',
          entityType: 'fee_structure',
          entityRef: id,
          after: { version: view.no, students: assigned, records: created },
        });
      }),
    );
    return { preview: false, ...summary, recordsCreated: created, studentsAssigned: assigned };
  }
}

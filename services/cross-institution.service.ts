/**
 * Cross-institution reporting for platform operators (SRS 26.9.1 and 24, CR-18; RNG-GOV-030…035,
 * RNG-RPT-118…128; RPT-009…012).
 *
 * - Operators only, and only with `xi.aggregate`; anything else is refused with nothing returned — and
 *   the refusal is recorded (RNG-GOV-033, RNG-RPT-125).
 * - Aggregates only (RNG-GOV-031): counts, sums and rates per institution for a stated selection —
 *   named institutions, or those of a status — of at most 25 (setting), never an absent filter
 *   (RNG-GOV-034), for a stated period and reason. The figures use the owning modules' definitions
 *   (RNG-RPT-119/120): members, admissions, attendance, fees, wallets, settlement, communication,
 *   tickets.
 * - A drill-through into one institution of a comparison is a separate recorded access with its own
 *   reason, for the role holding `xi.drill` (the platform administrator, Q10a); it returns that
 *   institution's breakdowns, still aggregates (RNG-GOV-032, RNG-RPT-123).
 * - Every access — returned or refused — is in the access record with the actor, role, institutions,
 *   period, figures, reason and time, which operators holding `access.view` read and export
 *   (RNG-GOV-035).
 */
import { sql, type Kysely } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { NIL_UUID_BIN, binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { getContext } from '../utils/request-context';
import { retryOnLock } from '../utils/retry';
import type { SettingsService } from './settings.service';

export const XI_FIGURES = [
  'members',
  'admissions',
  'attendance',
  'fees',
  'wallets',
  'settlement',
  'communication',
  'tickets',
] as const;
export type XiFigure = (typeof XI_FIGURES)[number];

interface Column {
  readonly key: string;
  readonly label: string;
  readonly unit: 'count' | 'paise' | 'percent' | 'days';
  readonly definition: string;
}

/** Each figure's columns with the owning module's definition (RNG-RPT-120). */
export const XI_COLUMNS: Record<XiFigure, readonly Column[]> = {
  members: [
    {
      key: 'membersActive',
      label: 'Active members',
      unit: 'count',
      definition: 'Members whose status is Active when read (IDN 6.20–6.22)',
    },
    {
      key: 'membersInactive',
      label: 'Inactive members',
      unit: 'count',
      definition: 'Members whose status is Inactive when read',
    },
    {
      key: 'membersSuspended',
      label: 'Suspended members',
      unit: 'count',
      definition: 'Members whose status is Suspended when read',
    },
  ],
  admissions: [
    {
      key: 'applicationsReceived',
      label: 'Applications received',
      unit: 'count',
      definition: 'Applications submitted in the period (ADM 19.4)',
    },
    {
      key: 'admissionsCompleted',
      label: 'Admissions completed',
      unit: 'count',
      definition: 'Applications approved in the period (ADM 19.8)',
    },
  ],
  attendance: [
    {
      key: 'attendancePercent',
      label: 'Student attendance',
      unit: 'percent',
      definition:
        'Share of student day records in the period marked Present, Late or Half day (ATT 21.11)',
    },
    {
      key: 'attendanceDays',
      label: 'Days recorded',
      unit: 'days',
      definition: 'School days in the period with at least one attendance record',
    },
  ],
  fees: [
    {
      key: 'feesRaised',
      label: 'Fees raised',
      unit: 'paise',
      definition: 'Instalments falling due in the period, not cancelled (FEE 13.4)',
    },
    {
      key: 'feesCollected',
      label: 'Fees collected',
      unit: 'paise',
      definition: 'Fee collections received in the period, fines included',
    },
  ],
  wallets: [
    {
      key: 'walletFunding',
      label: 'Wallet funding',
      unit: 'paise',
      definition: 'Amounts credited to member wallets in the period (WAL 8.2, REC 15.4)',
    },
    {
      key: 'walletSpend',
      label: 'Wallet spend',
      unit: 'paise',
      definition: 'Amounts debited from member wallets in the period (WAL 8.5)',
    },
  ],
  settlement: [
    {
      key: 'settled',
      label: 'Settled',
      unit: 'paise',
      definition:
        'Net settled to merchants by settlements approved for dates in the period (STL 14.2)',
    },
    {
      key: 'platformFee',
      label: 'Platform fee',
      unit: 'paise',
      definition: 'Platform fee taken by those settlements (STL 14.7, SAS 25.4)',
    },
  ],
  communication: [
    {
      key: 'dispatches',
      label: 'Messages sent',
      unit: 'count',
      definition: 'Dispatch attempts in the communication log in the period (COM 23.18.1)',
    },
    {
      key: 'dispatchFailedPercent',
      label: 'Failed',
      unit: 'percent',
      definition: 'Share of those attempts that failed',
    },
  ],
  tickets: [
    {
      key: 'ticketsRaised',
      label: 'Tickets raised',
      unit: 'count',
      definition: 'Tickets raised in the period (GRV 16.7)',
    },
    {
      key: 'ticketsOpen',
      label: 'Tickets open',
      unit: 'count',
      definition:
        'Tickets raised by the end of the period and not closed by then, nor resolved when read',
    },
  ],
};

export interface XiSelection {
  readonly institutionIds?: readonly string[] | undefined;
  readonly status?: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | undefined;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const yy = (d: Date) => istBusinessDate(d).slice(2, 4);

type Values = Record<string, number | null>;

export class CrossInstitutionService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: LimitDefinition<number>) {
    return this.deps.settings ? this.deps.settings.get(l) : l.value;
  }

  /** The operator's role code, or the surface for anyone else (recorded with the access). */
  private async roleOf(p: Principal) {
    if (p.surface !== 'ops' || !isUuid(p.subject)) return p.surface;
    const r = await this.deps.db
      .selectFrom('operator_accounts as o')
      .innerJoin('platform_accounts as a', 'a.id', 'o.account_id')
      .innerJoin('roles as r', 'r.id', 'o.role_id')
      .select('r.code')
      .where('a.public_id', '=', uuidToBin(p.subject))
      .executeTakeFirst();
    return r?.code ?? 'ops';
  }

  /** Records one access (RNG-GOV-033) and returns its ids. */
  private async record(
    p: Principal,
    a: {
      kind: 'Comparison' | 'Drill-through' | 'Leaderboard';
      parentId?: string | null;
      selection: string;
      from: string | null;
      to: string | null;
      outcome: 'Returned' | 'Refused';
      reason: string;
      note?: string | null;
      institutionIds: readonly string[];
      figures: readonly string[];
    },
  ) {
    const db = this.deps.db;
    const at = this.now();
    const id = newPublicIdPair();
    const role = await this.roleOf(p);
    const correlation = getContext()?.correlationId;
    return retryOnLock(() =>
      db.transaction().execute(async (trx) => {
        // The record is append-only, so its number is fixed before the insert: the last row is locked
        // and the number follows it (ACC-YY-NNNN, unique and increasing).
        const last = await trx
          .selectFrom('cross_institution_access_record')
          .select('id')
          .orderBy('id', 'desc')
          .limit(1)
          .forUpdate()
          .executeTakeFirst();
        const accessNo = `ACC-${yy(at)}-${String(Number(last?.id ?? 0) + 1).padStart(4, '0')}`;
        const ins = await trx
          .insertInto('cross_institution_access_record')
          .values({
            public_id: id.bin,
            access_no: accessNo,
            parent_access_id: a.parentId ?? null,
            kind: a.kind,
            actor_ref: isUuid(p.subject) ? uuidToBin(p.subject) : Buffer.alloc(16),
            actor_role: role.slice(0, 40),
            selection: a.selection.slice(0, 300),
            period_from_on: a.from,
            period_to_on: a.to,
            outcome: a.outcome,
            reason: a.reason.slice(0, 300),
            note: a.note?.slice(0, 300) ?? null,
            occurred_at: at,
            correlation_id:
              correlation && isUuid(correlation) ? uuidToBin(correlation) : NIL_UUID_BIN,
          })
          .executeTakeFirstOrThrow();
        const rowId = String(ins.insertId);
        if (a.institutionIds.length) {
          await trx
            .insertInto('cross_institution_access_institutions')
            .values(a.institutionIds.map((i) => ({ access_id: rowId, institution_id: i })))
            .execute();
        }
        if (a.figures.length) {
          await trx
            .insertInto('cross_institution_access_figures')
            .values(a.figures.map((f) => ({ access_id: rowId, figure_key: f })))
            .execute();
        }
        return { rowId, accessId: id.id, accessNo };
      }),
    );
  }

  /**
   * The platform-wide quiz leaderboard (CR-01, FIN-017): operators with `xi.aggregate` only, every look
   * recorded with its reason — refusals included. Returns whether it may be shown.
   */
  async leaderboardAccess(
    p: Principal,
    q: { period: string; reason: string; institutionIds?: readonly string[] },
  ) {
    const entitled = p.surface === 'ops' && p.subTasks.includes('xi.aggregate');
    const reason = q.reason.trim();
    if (entitled && (reason.length < 10 || reason.length > 300)) {
      throw new ValidationError([{ field: 'reason', code: 'RPT.XI_REASON' }]);
    }
    await this.record(p, {
      kind: 'Leaderboard',
      selection: `Quiz leaderboard (${q.period === 'year' ? 'this academic year' : 'all time'})`,
      from: null,
      to: null,
      outcome: entitled ? 'Returned' : 'Refused',
      reason: reason || '(none given)',
      note: entitled ? null : 'RPT.XI_NOT_ENTITLED',
      institutionIds: q.institutionIds ?? [],
      figures: ['quiz'],
    });
    if (!entitled) throw new CustomAPIError(403, 'RPT.XI_NOT_ENTITLED');
  }

  /** Refuses and records it (RNG-GOV-033: refusals included). */
  private async refuse(
    p: Principal,
    code: 'RPT.XI_NOT_ENTITLED' | 'RPT.XI_SELECTION_TOO_LARGE',
    a: Parameters<CrossInstitutionService['record']>[1],
    status: number,
    params?: Record<string, number>,
  ): Promise<never> {
    await this.record(p, { ...a, outcome: 'Refused', note: code });
    throw new CustomAPIError(status, code, params ? { params } : {});
  }

  /**
   * Refuses — and records — a session without the entitlement before its request is even read
   * (RNG-RPT-125: nothing returned, the attempt recorded). The stated selection, period and reason
   * are recorded as far as they can be read.
   */
  async guard(p: Principal, kind: 'Comparison' | 'Drill-through', raw: unknown) {
    const need = kind === 'Comparison' ? 'xi.aggregate' : 'xi.drill';
    if (p.surface === 'ops' && p.subTasks.includes(need)) return;
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    const period = (b['period'] && typeof b['period'] === 'object' ? b['period'] : {}) as Record<
      string,
      unknown
    >;
    const from = DAY.test(text(period['from'])) ? text(period['from']) : null;
    const to = DAY.test(text(period['to'])) ? text(period['to']) : null;
    await this.record(p, {
      kind,
      selection:
        kind === 'Comparison' ? 'Stated selection (refused before reading)' : 'Drill-through',
      from,
      to,
      outcome: 'Refused',
      reason: text(b['reason']).trim() || '(none given)',
      note: 'RPT.XI_NOT_ENTITLED',
      institutionIds: [],
      figures: [],
    });
    throw new CustomAPIError(403, 'RPT.XI_NOT_ENTITLED');
  }

  private period(from: string, to: string) {
    const errors = [];
    if (!DAY.test(from)) errors.push({ field: 'period.from', code: 'VALIDATION.DATE' });
    if (!DAY.test(to)) errors.push({ field: 'period.to', code: 'VALIDATION.DATE' });
    if (!errors.length && from > to) errors.push({ field: 'period.to', code: 'COM.REPORT_RANGE' });
    if (errors.length) throw new ValidationError(errors);
  }

  private reasonOf(r: string) {
    const reason = r.trim();
    if (reason.length < 10 || reason.length > 300) {
      throw new ValidationError([{ field: 'reason', code: 'RPT.XI_REASON' }]);
    }
    return reason;
  }

  /** The institutions a selection names (never all by omission: RNG-GOV-034). */
  private async select(s: XiSelection) {
    let q = this.deps.db
      .selectFrom('institutions')
      .select(['id', 'public_id', 'name', 'short_name', 'identifier', 'status']);
    if (s.institutionIds?.length) {
      const ids = s.institutionIds.filter(isUuid);
      if (!ids.length) return [];
      q = q.where(
        'public_id',
        'in',
        ids.map((x) => uuidToBin(x)),
      );
    } else if (s.status) q = q.where('status', '=', s.status);
    else throw new ValidationError([{ field: 'selection', code: 'RPT.XI_SELECTION' }]);
    return q.orderBy('name').execute();
  }

  /** The figures for each institution over the period (grouped queries, one per figure). */
  private async figures(
    institutionIds: readonly string[],
    figures: readonly XiFigure[],
    from: string,
    to: string,
  ) {
    const db = this.deps.db;
    const out = new Map<string, Values>(institutionIds.map((i) => [i, {}]));
    const put = (inst: unknown, k: string, v: number | null) => {
      const row = out.get(String(inst));
      if (row) row[k] = v;
    };
    const ids = institutionIds as string[];
    const start = new Date(`${from}T00:00:00+05:30`);
    const end = new Date(Date.parse(`${to}T00:00:00+05:30`) + 86_400_000);
    for (const i of ids) {
      for (const f of figures) for (const c of XI_COLUMNS[f]) out.get(i)![c.key] = 0;
    }
    if (!ids.length) return out;
    if (figures.includes('members')) {
      const rows = await db
        .selectFrom('member_profiles')
        .select(['institution_id', 'status', sql<number>`COUNT(*)`.as('n')])
        .where('institution_id', 'in', ids)
        .groupBy(['institution_id', 'status'])
        .execute();
      for (const r of rows) {
        const k =
          r.status === 'ACTIVE'
            ? 'membersActive'
            : r.status === 'INACTIVE'
              ? 'membersInactive'
              : 'membersSuspended';
        put(r.institution_id, k, Number(r.n));
      }
    }
    if (figures.includes('admissions')) {
      const rows = await db
        .selectFrom('admission_applications')
        .select([
          'institution_id',
          sql<number>`SUM(submitted_at >= ${start} AND submitted_at < ${end})`.as('received'),
          sql<number>`SUM(status = 'APPROVED' AND decided_at >= ${start} AND decided_at < ${end})`.as(
            'admitted',
          ),
        ])
        .where('institution_id', 'in', ids)
        .groupBy('institution_id')
        .execute();
      for (const r of rows) {
        put(r.institution_id, 'applicationsReceived', Number(r.received ?? 0));
        put(r.institution_id, 'admissionsCompleted', Number(r.admitted ?? 0));
      }
    }
    if (figures.includes('attendance')) {
      const rows = await db
        .selectFrom('attendance_days as d')
        .innerJoin('member_profiles as m', 'm.id', 'd.profile_id')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .select([
          'd.institution_id',
          sql<number>`COUNT(*)`.as('n'),
          sql<number>`SUM(d.status IN ('PRESENT','LATE','HALF_DAY'))`.as('attended'),
          sql<number>`COUNT(DISTINCT d.att_date)`.as('days'),
        ])
        .where('d.institution_id', 'in', ids)
        .where('ut.category', '=', 'STUDENT')
        .where('d.att_date', '>=', from)
        .where('d.att_date', '<=', to)
        .groupBy('d.institution_id')
        .execute();
      for (const i of ids) put(i, 'attendancePercent', null);
      for (const r of rows) {
        const n = Number(r.n);
        put(
          r.institution_id,
          'attendancePercent',
          n ? Math.round((Number(r.attended) * 1000) / n) / 10 : null,
        );
        put(r.institution_id, 'attendanceDays', Number(r.days));
      }
    }
    if (figures.includes('fees')) {
      const raised = await db
        .selectFrom('fee_records')
        .select(['institution_id', sql<number>`SUM(amount_paise)`.as('n')])
        .where('institution_id', 'in', ids)
        .where('status', '!=', 'CANCELLED')
        .where('due_date', '>=', from)
        .where('due_date', '<=', to)
        .groupBy('institution_id')
        .execute();
      for (const r of raised) put(r.institution_id, 'feesRaised', Number(r.n ?? 0));
      const collected = await db
        .selectFrom('fee_collections')
        .select(['institution_id', sql<number>`SUM(amount_paise + fine_paise)`.as('n')])
        .where('institution_id', 'in', ids)
        .where('collected_at', '>=', start)
        .where('collected_at', '<', end)
        .groupBy('institution_id')
        .execute();
      for (const r of collected) put(r.institution_id, 'feesCollected', Number(r.n ?? 0));
    }
    if (figures.includes('wallets')) {
      const rows = await db
        .selectFrom('ledger_entries as e')
        .innerJoin('wallets as w', 'w.id', 'e.wallet_id')
        .select([
          'e.institution_id',
          sql<number>`SUM(IF(e.direction = 'C', e.amount_paise, 0))`.as('credits'),
          sql<number>`SUM(IF(e.direction = 'D', e.amount_paise, 0))`.as('debits'),
        ])
        .where('e.institution_id', 'in', ids)
        .where('w.kind', 'in', ['CAMPUS', 'ALLOWANCE', 'PERSONAL'])
        .where('e.posted_on', '>=', from)
        .where('e.posted_on', '<=', to)
        .groupBy('e.institution_id')
        .execute();
      for (const r of rows) {
        put(r.institution_id, 'walletFunding', Number(r.credits ?? 0));
        put(r.institution_id, 'walletSpend', Number(r.debits ?? 0));
      }
    }
    if (figures.includes('settlement')) {
      const rows = await db
        .selectFrom('settlements')
        .select([
          'institution_id',
          sql<number>`SUM(net_paise)`.as('net'),
          sql<number>`SUM(fee_paise)`.as('fee'),
        ])
        .where('institution_id', 'in', ids)
        .where('status', '=', 'APPROVED')
        .where('settlement_date', '>=', from)
        .where('settlement_date', '<=', to)
        .groupBy('institution_id')
        .execute();
      for (const r of rows) {
        put(r.institution_id, 'settled', Number(r.net ?? 0));
        put(r.institution_id, 'platformFee', Number(r.fee ?? 0));
      }
    }
    if (figures.includes('communication')) {
      const rows = await db
        .selectFrom('comm_log')
        .select([
          'institution_id',
          sql<number>`COUNT(*)`.as('n'),
          sql<number>`SUM(outcome = 'FAILED')`.as('failed'),
        ])
        .where('institution_id', 'in', ids)
        .where('logged_on', '>=', from)
        .where('logged_on', '<=', to)
        .groupBy('institution_id')
        .execute();
      for (const i of ids) put(i, 'dispatchFailedPercent', null);
      for (const r of rows) {
        const n = Number(r.n);
        put(r.institution_id, 'dispatches', n);
        put(
          r.institution_id,
          'dispatchFailedPercent',
          n ? Math.round((Number(r.failed) * 1000) / n) / 10 : null,
        );
      }
    }
    if (figures.includes('tickets')) {
      const rows = await db
        .selectFrom('tickets')
        .select([
          'institution_id',
          sql<number>`SUM(created_at >= ${start} AND created_at < ${end})`.as('raised'),
          sql<number>`SUM(created_at < ${end} AND (closed_at IS NULL OR closed_at >= ${end}) AND status <> 'RESOLVED')`.as(
            'open',
          ),
        ])
        .where('institution_id', 'in', ids)
        .groupBy('institution_id')
        .execute();
      for (const r of rows) {
        put(r.institution_id, 'ticketsRaised', Number(r.raised ?? 0));
        put(r.institution_id, 'ticketsOpen', Number(r.open ?? 0));
      }
    }
    return out;
  }

  /** RPT-009: the comparison for a stated selection, period and reason; recorded either way. */
  async compare(
    p: Principal,
    b: {
      selection: XiSelection;
      period: { from: string; to: string };
      figures?: readonly XiFigure[] | undefined;
      reason: string;
    },
  ) {
    const reason = this.reasonOf(b.reason);
    this.period(b.period.from, b.period.to);
    const figures = b.figures?.length ? [...new Set(b.figures)] : [...XI_FIGURES];
    const selected = await this.select(b.selection);
    const stated = b.selection.institutionIds?.length
      ? `Named: ${b.selection.institutionIds.length} institutions`
      : `Status: ${b.selection.status}`;
    const base = {
      kind: 'Comparison' as const,
      selection: stated,
      from: b.period.from,
      to: b.period.to,
      reason,
      institutionIds: selected.map((s) => String(s.id)),
      figures,
    };
    if (p.surface !== 'ops' || !p.subTasks.includes('xi.aggregate')) {
      return this.refuse(p, 'RPT.XI_NOT_ENTITLED', { ...base, outcome: 'Refused' }, 403);
    }
    const max = await this.limit(LIMITS.crossInstitutionSelectionMax);
    if (selected.length > max) {
      return this.refuse(p, 'RPT.XI_SELECTION_TOO_LARGE', { ...base, outcome: 'Refused' }, 422, {
        max,
      });
    }
    if (!selected.length)
      throw new ValidationError([{ field: 'selection', code: 'RPT.XI_SELECTION' }]);
    const values = await this.figures(base.institutionIds, figures, b.period.from, b.period.to);
    const rec = await this.record(p, { ...base, outcome: 'Returned' });
    const columns = figures.flatMap((f) => XI_COLUMNS[f].map((c) => ({ ...c, figure: f })));
    const rows = selected.map((s) => ({
      institutionId: binToUuid(s.public_id),
      name: s.name,
      shortName: s.short_name,
      identifier: s.identifier,
      status: s.status,
      values: values.get(String(s.id)) ?? {},
    }));
    const totals: Values = {};
    const averages: Values = {};
    for (const c of columns) {
      const xs = rows.map((r) => r.values[c.key]).filter((v): v is number => typeof v === 'number');
      totals[c.key] = c.unit === 'percent' ? null : xs.reduce((a, v) => a + v, 0);
      averages[c.key] = xs.length
        ? Math.round((xs.reduce((a, v) => a + v, 0) / xs.length) * 10) / 10
        : null;
    }
    const unknown = (b.selection.institutionIds ?? []).filter(
      (x) => !rows.some((r) => r.institutionId === x.toLowerCase()),
    );
    return {
      accessId: rec.accessId,
      accessNo: rec.accessNo,
      period: b.period,
      columns,
      rows,
      totals,
      averages,
      unavailable: unknown,
    };
  }

  /** RPT-010: one institution of a comparison, its breakdowns; a separate recorded access. */
  async drill(p: Principal, accessId: string, b: { institutionId: string; reason: string }) {
    const db = this.deps.db;
    const reason = this.reasonOf(b.reason);
    const parent = isUuid(accessId)
      ? await db
          .selectFrom('cross_institution_access_record')
          .selectAll()
          .where('public_id', '=', uuidToBin(accessId))
          .where('kind', '=', 'Comparison')
          .where('outcome', '=', 'Returned')
          .executeTakeFirst()
      : undefined;
    if (!parent || !isUuid(p.subject) || !parent.actor_ref.equals(uuidToBin(p.subject))) {
      throw new CustomAPIError(404, 'RPT.ACCESS_NOT_FOUND');
    }
    const inst = isUuid(b.institutionId)
      ? await db
          .selectFrom('institutions as i')
          .innerJoin('cross_institution_access_institutions as x', 'x.institution_id', 'i.id')
          .select(['i.id', 'i.public_id', 'i.name'])
          .where('x.access_id', '=', parent.id)
          .where('i.public_id', '=', uuidToBin(b.institutionId))
          .executeTakeFirst()
      : undefined;
    if (!inst) throw new CustomAPIError(404, 'RPT.XI_NOT_IN_SELECTION');
    const from = parent.period_from_on ? istDay(parent.period_from_on) : null;
    const to = parent.period_to_on ? istDay(parent.period_to_on) : null;
    const figures = (
      await db
        .selectFrom('cross_institution_access_figures')
        .select('figure_key')
        .where('access_id', '=', parent.id)
        .execute()
    ).map((f) => f.figure_key as XiFigure);
    const base = {
      kind: 'Drill-through' as const,
      parentId: String(parent.id),
      selection: `Drill-through: ${inst.name}`,
      from,
      to,
      reason,
      institutionIds: [String(inst.id)],
      figures,
    };
    if (p.surface !== 'ops' || !p.subTasks.includes('xi.drill')) {
      return this.refuse(p, 'RPT.XI_NOT_ENTITLED', { ...base, outcome: 'Refused' }, 403);
    }
    const breakdowns = await this.breakdowns(String(inst.id), figures, from!, to!);
    const rec = await this.record(p, { ...base, outcome: 'Returned' });
    return {
      accessId: rec.accessId,
      accessNo: rec.accessNo,
      institution: { institutionId: binToUuid(inst.public_id), name: inst.name },
      period: { from, to },
      figures: breakdowns,
    };
  }

  /** The drill-through's breakdowns of one institution (aggregates by type, class, status, kind). */
  private async breakdowns(
    institutionId: string,
    figures: readonly XiFigure[],
    from: string,
    to: string,
  ) {
    const db = this.deps.db;
    const out: Record<string, { label: string; value: number }[]> = {};
    if (figures.includes('members')) {
      const rows = await db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .select(['ut.name', 'm.status', sql<number>`COUNT(*)`.as('n')])
        .where('m.institution_id', '=', institutionId)
        .groupBy(['ut.name', 'm.status'])
        .orderBy('ut.name')
        .execute();
      out['membersByType'] = rows.map((r) => ({
        label: `${r.name} · ${r.status.toLowerCase()}`,
        value: Number(r.n),
      }));
    }
    if (figures.includes('attendance')) {
      const rows = await db
        .selectFrom('attendance_days as d')
        .innerJoin('sections as s', 's.id', 'd.section_id')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .select([
          'c.name as class_name',
          sql<number>`COUNT(*)`.as('n'),
          sql<number>`SUM(d.status IN ('PRESENT','LATE','HALF_DAY'))`.as('attended'),
        ])
        .where('d.institution_id', '=', institutionId)
        .where('d.att_date', '>=', from)
        .where('d.att_date', '<=', to)
        .groupBy(['c.name', 'c.sort_order'])
        .orderBy('c.sort_order')
        .execute();
      out['attendanceByClass'] = rows.map((r) => ({
        label: r.class_name,
        value: Number(r.n) ? Math.round((Number(r.attended) * 1000) / Number(r.n)) / 10 : 0,
      }));
    }
    if (figures.includes('fees')) {
      const rows = await db
        .selectFrom('fee_records')
        .select(['status', sql<number>`SUM(amount_paise)`.as('n')])
        .where('institution_id', '=', institutionId)
        .where('due_date', '>=', from)
        .where('due_date', '<=', to)
        .groupBy('status')
        .execute();
      out['feesByStatus'] = rows.map((r) => ({ label: r.status, value: Number(r.n ?? 0) }));
    }
    if (figures.includes('communication')) {
      const rows = await db
        .selectFrom('comm_log')
        .select(['kind', sql<number>`COUNT(*)`.as('n')])
        .where('institution_id', '=', institutionId)
        .where('logged_on', '>=', from)
        .where('logged_on', '<=', to)
        .groupBy('kind')
        .execute();
      out['dispatchesByKind'] = rows.map((r) => ({ label: r.kind, value: Number(r.n) }));
    }
    if (figures.includes('tickets')) {
      const rows = await db
        .selectFrom('tickets')
        .select(['status', sql<number>`COUNT(*)`.as('n')])
        .where('institution_id', '=', institutionId)
        .where('created_at', '<', new Date(Date.parse(`${to}T00:00:00+05:30`) + 86_400_000))
        .groupBy('status')
        .execute();
      out['ticketsByStatus'] = rows.map((r) => ({ label: r.status, value: Number(r.n) }));
    }
    const totals = await this.figures([institutionId], figures, from, to);
    return { values: totals.get(institutionId) ?? {}, breakdowns: out };
  }

  /** RPT-011: the access record, refusals included (RNG-GOV-035). */
  async records(q: {
    actor?: string | undefined;
    outcome?: 'Returned' | 'Refused' | undefined;
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = await this.recordRows(q, limit + 1);
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return {
      items: shown.map((x) => {
        const { rowId, ...rest } = x;
        void rowId;
        return rest;
      }),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(`a:${last.rowId}`, 'utf8').toString('base64url')
          : null,
    };
  }

  async recordRows(
    q: {
      actor?: string | undefined;
      outcome?: 'Returned' | 'Refused' | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
    },
    limit: number,
  ) {
    const db = this.deps.db;
    let before: string | undefined;
    if (q.cursor) {
      const m = /^a:(\d{1,20})$/.exec(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (!m?.[1]) throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
      before = m[1];
    }
    for (const [k, v] of [
      ['from', q.from],
      ['to', q.to],
    ] as const) {
      if (v && !DAY.test(v)) throw new ValidationError([{ field: k, code: 'VALIDATION.DATE' }]);
    }
    if (q.actor && !isUuid(q.actor)) {
      throw new ValidationError([{ field: 'actor', code: 'VALIDATION.FORMAT' }]);
    }
    let r = db
      .selectFrom('cross_institution_access_record as x')
      .leftJoin('platform_accounts as a', 'a.public_id', 'x.actor_ref')
      .leftJoin('cross_institution_access_record as parent', 'parent.id', 'x.parent_access_id')
      .select([
        'x.id',
        'x.public_id',
        'x.access_no',
        'x.kind',
        'x.actor_ref',
        'x.actor_role',
        'x.selection',
        'x.period_from_on',
        'x.period_to_on',
        'x.outcome',
        'x.reason',
        'x.note',
        'x.occurred_at',
        'a.first_name',
        'a.last_name',
        'parent.access_no as parent_no',
        (eb) =>
          eb
            .selectFrom('cross_institution_access_institutions as xi')
            .innerJoin('institutions as i', 'i.id', 'xi.institution_id')
            .select(sql<string>`GROUP_CONCAT(i.name ORDER BY i.name SEPARATOR '; ')`.as('n'))
            .whereRef('xi.access_id', '=', 'x.id')
            .as('institutions'),
        (eb) =>
          eb
            .selectFrom('cross_institution_access_figures as xf')
            .select(
              sql<string>`GROUP_CONCAT(xf.figure_key ORDER BY xf.figure_key SEPARATOR ', ')`.as(
                'f',
              ),
            )
            .whereRef('xf.access_id', '=', 'x.id')
            .as('figures'),
      ]);
    if (q.actor) r = r.where('x.actor_ref', '=', uuidToBin(q.actor));
    if (q.outcome) r = r.where('x.outcome', '=', q.outcome);
    if (q.from) r = r.where('x.occurred_at', '>=', new Date(`${q.from}T00:00:00+05:30`));
    if (q.to) {
      r = r.where(
        'x.occurred_at',
        '<',
        new Date(Date.parse(`${q.to}T00:00:00+05:30`) + 86_400_000),
      );
    }
    if (before) r = r.where('x.id', '<', before);
    const rows = await r.orderBy('x.id', 'desc').limit(limit).execute();
    return rows.map((x) => ({
      rowId: String(x.id),
      accessId: binToUuid(x.public_id),
      accessNo: x.access_no,
      kind: x.kind,
      parentAccessNo: x.parent_no ?? null,
      actor: {
        id: binToUuid(x.actor_ref),
        name: [x.first_name, x.last_name].filter(Boolean).join(' ') || null,
        role: x.actor_role,
      },
      selection: x.selection,
      institutions: x.institutions ? String(x.institutions).split('; ') : [],
      figures: x.figures ? String(x.figures).split(', ') : [],
      period: {
        from: x.period_from_on ? istDay(x.period_from_on) : null,
        to: x.period_to_on ? istDay(x.period_to_on) : null,
      },
      outcome: x.outcome,
      reason: x.reason,
      note: x.note,
      at: new Date(x.occurred_at).toISOString(),
    }));
  }
}

/** A DATE column read back as YYYY-MM-DD (mysql2 returns it at local midnight). */
function istDay(d: Date | string) {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

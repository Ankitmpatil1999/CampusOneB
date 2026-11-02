/**
 * The transport fee by distance (client 2026-10-21).
 *
 * - **The rule** (per school, set by the Institution Administrator — transport.fees): **per km** — a
 *   rate per km of the round trip, per year — or **by distance range** (client 2026-10-22: "1 to 5 km
 *   ₹10,000, 5 to 10 km ₹15,000") — a yearly amount for each range of the stop's distance; and the
 *   day of the month the dues fall on. Off until it is switched on. Changing it never changes dues
 *   already raised.
 * - **The amount:** the stop's distance from the school along its route (the route's first stop,
 *   seq 0, is the school end): per km, × 2 (both ways) × the rate; by range, the amount of the range
 *   the distance falls in (a distance beyond the last range is not charged) — the yearly fee, in whole
 *   rupees. It is split into the academic year's months, whole rupees each, the remainder on the last.
 * - **When:** as soon as a member — a student or a staff member — is allocated a stop, one due per month
 *   the allocation covers is raised at once (client: "all months at once"), each on the rule's day of
 *   that month (never before today). The dues stay if the member later stops using the bus.
 * - **A farther stop mid-year** (client: "only the months left"): from the month the new allocation
 *   starts, each month's due rises to the new monthly amount; months already charged at least as much
 *   stay as they are (a nearer stop changes nothing for the year). A due nobody has touched — unpaid,
 *   not financed, no payment link, no collection retry and no change waiting for approval — is raised
 *   in place; otherwise the difference is a separate due for that month.
 * - The dues are fee records (source TRANSPORT, head "Transport"): the student, the parents or the
 *   staff member pay them from the wallet in the app, or at the office in cash, as any fee.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, TransportFeeMode, TransportFeeRange } from '../models/campusone_models';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import { formatInr, istBusinessDate } from '../utils/format';
import { isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { institutionOf, yearFor } from './academic-year';
import { recordAudit } from './audit.service';
import { notifyFeeAssigned } from './fee-notices.service';

type Db = Kysely<Database> | Transaction<Database>;

/** The highest yearly rate per km accepted (₹1,00,000). */
export const MAX_RATE_PAISE = 10_000_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d));
const monthOf = (d: string) => `${d.slice(0, 7)}-01`;

/** The first day of every month from `from`'s month to `to`'s, inclusive (YYYY-MM-01). */
export function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = monthOf(to);
  for (;;) {
    const s = `${y}-${String(m).padStart(2, '0')}-01`;
    if (s > end) break;
    out.push(s);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** A yearly amount in `n` monthly parts: whole rupees each, the remainder on the last. */
export function monthlyParts(yearlyPaise: number, n: number): number[] {
  if (n <= 0) return [];
  const each = Math.floor(yearlyPaise / n / 100) * 100;
  const parts = Array.from({ length: n }, () => each);
  parts[n - 1] = yearlyPaise - each * (n - 1);
  return parts;
}

/** Distance (one way, km) × 2 × the yearly rate per km, in whole rupees. */
export function yearlyFee(distanceKm: number, ratePaisePerKm: number): number {
  return Math.round((distanceKm * 2 * ratePaisePerKm) / 100) * 100;
}

/** At most this many ranges; the farthest range up to this many km. */
export const MAX_RANGES = 20;
export const MAX_RANGE_KM = 500;

/**
 * The yearly fee of a range for a distance: the first range whose upper end reaches it (ranges sorted
 * by `uptoKm`, each from the one before it); null beyond the last range.
 */
export function rangeFee(distanceKm: number, ranges: readonly TransportFeeRange[]): number | null {
  const sorted = [...ranges].sort((a, b) => a.uptoKm - b.uptoKm);
  return sorted.find((r) => distanceKm <= r.uptoKm)?.yearlyPaise ?? null;
}

/** The yearly fee under the rule, in paise (0 when nothing is charged). */
export function yearlyUnder(rule: Rule, distanceKm: number): number {
  if (distanceKm <= 0) return 0;
  if (rule.mode === 'RANGE') return rangeFee(distanceKm, rule.ranges) ?? 0;
  return yearlyFee(distanceKm, rule.ratePaise);
}

/** "Transport Oct 2026". */
export function transportLabel(month: string, extra = false) {
  const label = `Transport ${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  return extra ? `${label} (extra)` : label;
}

/** The stop's distance from the school (the route's seq 0) along the route, one way, in km. */
export async function distanceFromSchool(db: Db, routeId: string, stopId: string) {
  const stops = await db
    .selectFrom('transport_route_stops')
    .select(['seq', 'stop_id', 'distance_km'])
    .where('route_id', '=', routeId)
    .orderBy('seq')
    .execute();
  let km = 0;
  for (const s of stops) {
    if (s.seq > 0) km += Number(s.distance_km);
    if (String(s.stop_id) === String(stopId)) return Math.round(km * 100) / 100;
  }
  return 0;
}

export interface Rule {
  readonly active: boolean;
  readonly mode: TransportFeeMode;
  readonly ratePaise: number;
  readonly ranges: readonly TransportFeeRange[];
  readonly dueDay: number;
  readonly version: number;
}

const rangesOf = (v: unknown): TransportFeeRange[] => {
  const raw = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => ({
      uptoKm: Number((x as { uptoKm?: unknown }).uptoKm),
      yearlyPaise: Number((x as { yearlyPaise?: unknown }).yearlyPaise),
    }))
    .filter((x) => Number.isFinite(x.uptoKm) && Number.isFinite(x.yearlyPaise))
    .sort((a, b) => a.uptoKm - b.uptoKm);
};

/** Whether the rule charges anything. */
const charges = (rule: Rule) =>
  rule.active && (rule.mode === 'RANGE' ? rule.ranges.length > 0 : rule.ratePaise > 0);

export async function feeRuleOf(db: Db, institutionId: string): Promise<Rule> {
  const r = await db
    .selectFrom('transport_fee_rules')
    .selectAll()
    .where('institution_id', '=', institutionId)
    .executeTakeFirst();
  return r
    ? {
        active: !!Number(r.active),
        mode: r.mode ?? 'PER_KM',
        ratePaise: Number(r.rate_paise_per_km),
        ranges: rangesOf(r.ranges),
        dueDay: r.due_day,
        version: r.row_version,
      }
    : { active: false, mode: 'PER_KM', ratePaise: 0, ranges: [], dueDay: 5, version: 0 };
}

/** The "Transport" fee head of the school (made on first use, as fee heads are). */
async function transportHead(db: Db, institutionId: string) {
  const find = () =>
    db
      .selectFrom('fee_heads')
      .select(['id', 'name'])
      .where('institution_id', '=', institutionId)
      .where('name', '=', 'Transport')
      .executeTakeFirst();
  const found = await find();
  if (found) return found;
  await db
    .insertInto('fee_heads')
    .ignore()
    .values({
      public_id: newPublicIdPair().bin,
      institution_id: institutionId,
      name: 'Transport',
      sort_order: 3,
    })
    .execute();
  return (await find())!;
}

export interface RaiseResult {
  /** Dues created or raised. */
  readonly records: number;
  /** What was added to the member's dues, in paise. */
  readonly amountPaise: number;
  readonly distanceKm: number;
}

const NOTHING = (distanceKm = 0): RaiseResult => ({ records: 0, amountPaise: 0, distanceKm });

/**
 * Raises (or raises further) a member's transport dues for an allocation, inside the caller's
 * transaction (the allocation's own, so both commit together). Re-runnable: a month already charged
 * at least the monthly amount is left alone.
 */
export async function raiseTransportFees(
  trx: Db,
  v: {
    readonly institutionId: string;
    readonly yearId: string;
    readonly profileRowId: string;
    readonly allocationId: string;
    readonly routeId: string;
    readonly stopId: string;
    readonly from: string;
    readonly to: string;
  },
  who: { readonly by: Buffer | null; readonly at: Date; readonly notify?: boolean },
): Promise<RaiseResult> {
  const rule = await feeRuleOf(trx, v.institutionId);
  if (!charges(rule)) return NOTHING();
  const year = await trx
    .selectFrom('academic_years')
    .select(['starts_on', 'ends_on', 'status'])
    .where('id', '=', v.yearId)
    .where('institution_id', '=', v.institutionId)
    .executeTakeFirst();
  if (!year || year.status === 'CLOSED') return NOTHING();
  const distanceKm = await distanceFromSchool(trx, v.routeId, v.stopId);
  const yearly = yearlyUnder(rule, distanceKm);
  if (yearly <= 0) return NOTHING(distanceKm);
  const yearStart = ymd(year.starts_on);
  const yearEnd = ymd(year.ends_on);
  const months = monthsOf(yearStart, yearEnd);
  const parts = monthlyParts(yearly, months.length);
  const first = monthOf(v.from < yearStart ? yearStart : v.from);
  const last = monthOf(v.to > yearEnd ? yearEnd : v.to);
  const today = istBusinessDate(who.at);

  // The member's transport dues of the year, locked: one raise at a time per member.
  const existing = await trx
    .selectFrom('fee_records')
    .select([
      'id',
      'public_id',
      'transport_month',
      'amount_paise',
      'paid_paise',
      'status',
      'financed',
      'row_version',
    ])
    .where('institution_id', '=', v.institutionId)
    .where('student_profile_id', '=', v.profileRowId)
    .where('year_id', '=', v.yearId)
    .where('source', '=', 'TRANSPORT')
    .where('status', '<>', 'CANCELLED')
    .forUpdate()
    .execute();
  const byMonth = new Map<string, typeof existing>();
  for (const r of existing) {
    const m = r.transport_month ? ymd(r.transport_month) : '';
    byMonth.set(m, [...(byMonth.get(m) ?? []), r]);
  }

  // What each covered month needs: a new due, a rise, or nothing.
  const plan: { month: string; target: number; have: typeof existing; add: number }[] = [];
  months.forEach((month, i) => {
    if (month < first || month > last) return;
    const have = byMonth.get(month) ?? [];
    const charged = have.reduce((n, r) => n + Number(r.amount_paise), 0);
    const target = parts[i]!;
    if (target > charged) plan.push({ month, target, have, add: target - charged });
  });
  if (!plan.length) return NOTHING(distanceKm);

  const head = await transportHead(trx, v.institutionId);
  const charge = newPublicIdPair();
  const c = await trx
    .insertInto('transport_fee_charges')
    .values({
      public_id: charge.bin,
      institution_id: v.institutionId,
      year_id: v.yearId,
      profile_id: v.profileRowId,
      allocation_id: v.allocationId,
      distance_km: distanceKm,
      mode: rule.mode,
      rate_paise_per_km: rule.mode === 'RANGE' ? 0 : rule.ratePaise,
      yearly_paise: yearly,
      months: months.length,
      created_by: who.by,
      created_at: who.at,
    })
    .executeTakeFirstOrThrow();
  const chargeId = String(c.insertId);
  const seqRow = await trx
    .selectFrom('fee_records')
    .select(sql<number>`COALESCE(MAX(instalment_seq), 0)`.as('m'))
    .where('institution_id', '=', v.institutionId)
    .where('student_profile_id', '=', v.profileRowId)
    .where('year_id', '=', v.yearId)
    .executeTakeFirst();
  let seq = Number(seqRow?.m ?? 0);
  const dueOf = (month: string) => {
    const d = `${month.slice(0, 8)}${String(rule.dueDay).padStart(2, '0')}`;
    const due = d < today ? today : d;
    return due > yearEnd ? yearEnd : due;
  };

  let records = 0;
  let added = 0;
  for (const p of plan) {
    // A due nobody has touched is raised in place.
    const only = p.have.length === 1 ? p.have[0]! : null;
    if (
      only &&
      only.status === 'DUE' &&
      Number(only.paid_paise) === 0 &&
      !Number(only.financed) &&
      !(await touched(trx, String(only.id), only.public_id))
    ) {
      const r = await trx
        .updateTable('fee_records')
        .set({
          amount_paise: p.target,
          transport_charge_id: chargeId,
          updated_at: who.at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', only.id)
        .where('row_version', '=', only.row_version)
        .where('status', '=', 'DUE')
        .where('paid_paise', '=', '0')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 1) {
        await trx
          .updateTable('fee_record_heads')
          .set({ amount_paise: p.target })
          .where('record_id', '=', only.id)
          .where('head_id', '=', String(head.id))
          .execute();
        records++;
        added += p.add;
        continue;
      }
    }
    seq += 1;
    const rec = await trx
      .insertInto('fee_records')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: v.institutionId,
        year_id: v.yearId,
        student_profile_id: v.profileRowId,
        source: 'TRANSPORT',
        instalment_seq: seq,
        label: transportLabel(p.month, p.have.length > 0),
        due_date: dueOf(p.month),
        amount_paise: p.add,
        late_fine_paise: 0,
        remarks:
          rule.mode === 'RANGE'
            ? `${distanceKm} km from the school: ${formatInr(yearly)} a year (distance range)`
            : `${distanceKm} km × 2 × ${formatInr(rule.ratePaise)} a km a year`,
        transport_charge_id: chargeId,
        transport_month: p.month,
        created_by: who.by,
        created_at: who.at,
        updated_at: who.at,
      })
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('fee_record_heads')
      .values({
        record_id: String(rec.insertId),
        head_id: String(head.id),
        name: head.name,
        amount_paise: p.add,
      })
      .execute();
    records++;
    added += p.add;
  }
  await recordAudit(trx, {
    institutionId: v.institutionId,
    action: 'TRANSPORT_FEE_RAISED',
    entityType: 'transport_fee_charge',
    entityRef: charge.id,
    after: {
      distanceKm,
      yearly: formatInr(yearly),
      months: plan.map((p) => p.month.slice(0, 7)),
      added: formatInr(added),
    },
  });
  if (who.notify !== false && added > 0) {
    await notifyFeeAssigned(
      trx,
      v.institutionId,
      v.yearId,
      new Map([[v.profileRowId, added]]),
      who.at,
    );
  }
  return { records, amountPaise: added, distanceKm };
}

/** A payment link, a collection retry or a change waiting for approval holds the due. */
async function touched(db: Db, recordId: string, publicId: Buffer) {
  const [link, attempt, change] = await Promise.all([
    db
      .selectFrom('fee_payment_requests')
      .select('id')
      .where('record_id', '=', recordId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst(),
    db
      .selectFrom('fee_collection_attempts')
      .select('id')
      .where('record_id', '=', recordId)
      .where('status', '=', 'PENDING')
      .executeTakeFirst(),
    db
      .selectFrom('approval_requests')
      .select('id')
      .where('module', '=', 'FEE_RECORD_CHANGE')
      .where('subject_ref', '=', publicId)
      .where('status', '=', 'PENDING')
      .executeTakeFirst(),
  ]);
  return !!(link || attempt || change);
}

export class TransportFeesService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  /** TRN-041: the school's rule, with the current year's months (for the console's preview). */
  async rule(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rule = await feeRuleOf(this.deps.db, inst.id);
    const year = await yearFor(this.deps.db, inst.id).catch(() => null);
    return {
      active: rule.active,
      mode: rule.mode,
      ratePerKm: toMoneyDto(rule.ratePaise),
      ratePaisePerKm: rule.ratePaise,
      // Each range from the one before it (or 0 km) up to uptoKm, one way (client 2026-10-22).
      ranges: rule.ranges.map((r, i) => ({
        fromKm: i ? rule.ranges[i - 1]!.uptoKm : 0,
        uptoKm: r.uptoKm,
        yearly: toMoneyDto(r.yearlyPaise),
        yearlyPaise: r.yearlyPaise,
      })),
      dueDay: rule.dueDay,
      year: year
        ? {
            id: year.publicId,
            label: year.label,
            months: monthsOf(year.startsOn, year.endsOn).length,
          }
        : null,
      version: rule.version,
    };
  }

  /** TRN-042: set the rule (If-Match: the version read; 0 before it was first saved). */
  async setRule(
    p: Principal,
    expected: number,
    input: {
      active: boolean;
      mode?: TransportFeeMode | undefined;
      /** Kept as it is when not sent (the other mode's values survive a switch). */
      ratePaisePerKm?: number | undefined;
      ranges?: readonly { uptoKm: number; yearlyPaise: number }[] | undefined;
      dueDay: number;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const mode = input.mode ?? 'PER_KM';
    const stored = await feeRuleOf(this.deps.db, inst.id);
    const rate = input.ratePaisePerKm ?? stored.ratePaise;
    if (
      !Number.isInteger(rate) ||
      rate < 0 ||
      rate > MAX_RATE_PAISE ||
      (mode === 'PER_KM' && input.active && rate === 0)
    ) {
      throw new ValidationError([{ field: 'ratePaisePerKm', code: 'TRN.FEE_RATE' }]);
    }
    // Ranges: each with a larger upper km than the one before, and a yearly amount.
    const ranges = [...(input.ranges ?? stored.ranges)];
    const badRange = ranges.findIndex(
      (r, i) =>
        !Number.isFinite(r.uptoKm) ||
        r.uptoKm <= (i ? ranges[i - 1]!.uptoKm : 0) ||
        r.uptoKm > MAX_RANGE_KM ||
        Math.abs(Math.round(r.uptoKm * 100) - r.uptoKm * 100) > 1e-6 ||
        !Number.isInteger(r.yearlyPaise) ||
        r.yearlyPaise <= 0 ||
        r.yearlyPaise > MAX_RATE_PAISE * 10,
    );
    if (
      ranges.length > MAX_RANGES ||
      badRange >= 0 ||
      (mode === 'RANGE' && input.active && !ranges.length)
    ) {
      throw new ValidationError([
        { field: badRange >= 0 ? `ranges.${badRange}` : 'ranges', code: 'TRN.FEE_RANGES' },
      ]);
    }
    if (!Number.isInteger(input.dueDay) || input.dueDay < 1 || input.dueDay > 28)
      throw new ValidationError([{ field: 'dueDay', code: 'TRN.FEE_DUE_DAY' }]);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const cur = await trx
        .selectFrom('transport_fee_rules')
        .select(['row_version', 'rate_paise_per_km', 'active'])
        .where('institution_id', '=', inst.id)
        .forUpdate()
        .executeTakeFirst();
      if ((cur?.row_version ?? 0) !== expected) throw new PreconditionFailedError();
      const values = {
        mode,
        ranges: ranges.length
          ? JSON.stringify(ranges.map((r) => ({ uptoKm: r.uptoKm, yearlyPaise: r.yearlyPaise })))
          : null,
        rate_paise_per_km: rate,
        due_day: input.dueDay,
        active: input.active ? 1 : 0,
        updated_by: this.by(p),
        updated_at: at,
      };
      if (cur) {
        await trx
          .updateTable('transport_fee_rules')
          .set({ ...values, row_version: sql<number>`row_version + 1` })
          .where('institution_id', '=', inst.id)
          .execute();
      } else {
        await trx
          .insertInto('transport_fee_rules')
          .values({ institution_id: inst.id, ...values })
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TRANSPORT_FEE_RULE_SET',
        entityType: 'transport_fee_rule',
        entityRef: inst.id,
        before: cur
          ? { active: !!Number(cur.active), rate: formatInr(Number(cur.rate_paise_per_km)) }
          : null,
        after: {
          active: input.active,
          mode,
          ...(mode === 'RANGE'
            ? { ranges: ranges.map((r) => `up to ${r.uptoKm} km: ${formatInr(r.yearlyPaise)}`) }
            : { rate: formatInr(rate) }),
          dueDay: input.dueDay,
        },
      });
    });
    return this.rule(p);
  }

  /**
   * TRN-043: raises the dues of every allocation of the current year still in force — for a rule
   * switched on after the buses were allocated. Re-runnable: months already charged are left alone.
   */
  async apply(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rule = await feeRuleOf(this.deps.db, inst.id);
    if (!charges(rule)) throw new CustomAPIError(409, 'TRN.FEE_RULE_OFF');
    const year = await yearFor(this.deps.db, inst.id);
    const today = istBusinessDate(this.now());
    const allocations = await this.deps.db
      .selectFrom('transport_allocations')
      .select(['id', 'profile_id', 'route_id', 'stop_id', 'effective_from', 'effective_to'])
      .where('institution_id', '=', inst.id)
      .where('year_id', '=', year.id)
      .where('active', '=', 1)
      .where('effective_to', '>=', today)
      .orderBy('effective_from')
      .execute();
    let members = 0;
    let records = 0;
    let amount = 0;
    for (const a of allocations) {
      const out = await this.deps.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('member_profiles')
          .select('id')
          .where('id', '=', String(a.profile_id))
          .forUpdate()
          .execute();
        return raiseTransportFees(
          trx,
          {
            institutionId: inst.id,
            yearId: year.id,
            profileRowId: String(a.profile_id),
            allocationId: String(a.id),
            routeId: String(a.route_id),
            stopId: String(a.stop_id),
            from: ymd(a.effective_from),
            to: ymd(a.effective_to),
          },
          { by: this.by(p), at: this.now() },
        );
      });
      if (out.records) {
        members++;
        records += out.records;
        amount += out.amountPaise;
      }
    }
    return { allocations: allocations.length, members, records, amount: toMoneyDto(amount) };
  }
}

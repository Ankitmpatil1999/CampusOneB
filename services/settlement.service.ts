/**
 * Merchant settlement (SRS 14; STL-001…013; RNG-STL-045…075; Q14 M1–M4, M17; docs/03 §10.2).
 *
 * - The nightly run (23:30 IST) takes, per institution, every successful credit to an active
 *   merchant's wallet up to the window's end that no live settlement holds yet (payments of every
 *   channel, tuition, events, transfers into the merchant wallet), computes the platform fee per line
 *   (₹1.00 up to and including ₹100, otherwise 0.5 %, settings `stl.fee.*`; tuition per
 *   `stl.fee.chargeTuition`), creates one Pending settlement with its lines and the four statement
 *   files, marks the tuition collections settled and rolls the wallets' day balances over — all in one
 *   transaction per institution. Nothing moves money here.
 * - A missed run is caught up by the next one (the lines are "not yet settled", not "in the window").
 *   A rejected settlement frees its lines; the next run collects them once more (M17). A suspended
 *   merchant's credits wait until it is active again (M4).
 * - Approval: Pending → Stage-1 approved (maker) → Approved (a different checker); rejection from
 *   either by someone who approved neither. Remarks 3–500 characters.
 * - Payout (write-once UTR on an Approved settlement, no status change, RNG-STL-052): per merchant the
 *   wallet is debited the gross — the net to the bank payout clearing, the fee to the platform fee
 *   account — as ledger pairs. A merchant suspended by then is carried forward (M4).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS } from '../config/registers';
import type { JobContext } from '../schedulers';
import type { Database, SettlementStatus } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { toCsv } from '../utils/csv';
import { formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { formatAmount, toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { tellMembers } from './member-notices';
import type { LedgerService } from './ledger.service';
import { defaultValues, type SettingValues } from './settings.service';
import { usesProfile } from './member-roles';

type Db = Kysely<Database> | Transaction<Database>;

/** Where the statement files go (the API's file service, or the worker's storage). */
export interface StatementStore {
  store(input: {
    institutionId: string;
    name: string;
    data: Buffer;
  }): Promise<{ publicId: string }>;
}

/** The movements that are a merchant's collections (RNG-STL-061; Q14 M1: never bank credits). */
const COLLECTION_TYPES = ['PAYMENT', 'TUITION', 'EVENT', 'TRANSFER', 'ALLOWANCE_PAYMENT'] as const;
/** Money taken back from a merchant after it was collected (Q14 M3): deducted in its settlement. */
const ADJUSTMENT_TYPES = ['REFUND', 'CHARGEBACK'] as const;
const UTR = /^[A-Z0-9]{16,22}$/;
const STATEMENTS = [
  'transactions',
  'merchant_summary',
  'summary_report',
  'settlement_report',
] as const;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const day = (d: Date | string) =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : istBusinessDate(new Date(d));
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
/** A stored plan rule as fee rules. */
function ruleOf(v: {
  flat_paise: string;
  threshold_paise: string;
  boundary: 'INCLUSIVE' | 'EXCLUSIVE';
  basis_points: number;
  applies_to: unknown;
}): FeeRules {
  const appliesTo = (
    typeof v.applies_to === 'string' ? JSON.parse(v.applies_to) : v.applies_to
  ) as string[];
  return {
    thresholdPaise: Number(v.threshold_paise),
    flatPaise: Number(v.flat_paise),
    basisPoints: v.basis_points,
    chargeTuition: appliesTo.includes('TUITION'),
    boundary: v.boundary,
    appliesTo,
  };
}
/** The window's end: 23:30 IST on the settlement date (14.7.1). */
export const windowEnd = (date: string) => new Date(`${date}T23:30:00+05:30`);

export interface FeeRules {
  readonly thresholdPaise: number;
  readonly flatPaise: number;
  readonly basisPoints: number;
  readonly chargeTuition: boolean;
  /** Is an amount equal to the threshold charged the flat fee? (OQ-06; default inclusive). */
  readonly boundary?: 'INCLUSIVE' | 'EXCLUSIVE';
  /** The ledger types the fee applies to (a plan's rule, STL-009); default every collection. */
  readonly appliesTo?: readonly string[];
}

/** The platform fee of one successful line (RNG-STL-063; Q14 M1/M2). Never more than the line. */
export function platformFee(type: string, amountPaise: number, rules: FeeRules): number {
  if (rules.appliesTo && !rules.appliesTo.includes(type)) return 0;
  if (type === 'TUITION' && !rules.chargeTuition) return 0;
  const flat =
    rules.boundary === 'EXCLUSIVE'
      ? amountPaise < rules.thresholdPaise
      : amountPaise <= rules.thresholdPaise;
  const fee = flat
    ? rules.flatPaise
    : Math.floor((amountPaise * rules.basisPoints + 5_000) / 10_000);
  return Math.min(fee, amountPaise);
}

export class SettlementService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly ledger: LedgerService;
      readonly store: StatementStore;
      readonly links?: { linkFor(fileId: string): { url: string; expiresAt: string } };
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

  async rules(): Promise<FeeRules> {
    return {
      thresholdPaise: await this.limit(LIMITS.platformFeeThresholdPaise),
      flatPaise: await this.limit(LIMITS.platformFeeFlatPaise),
      basisPoints: await this.limit(LIMITS.platformFeeBasisPoints),
      chargeTuition: (await this.limit(LIMITS.platformFeeChargeTuition)) === 1,
    };
  }

  /** The institution's plan rule in force on the date (STL-009), else the platform settings. */
  async rulesFor(institutionId: string, date: string): Promise<FeeRules> {
    const r = await this.deps.db
      .selectFrom('subscriptions as s')
      .innerJoin('platform_fee_rules as r', 'r.plan_id', 's.plan_id')
      .select(['r.flat_paise', 'r.threshold_paise', 'r.boundary', 'r.basis_points', 'r.applies_to'])
      .where('s.institution_id', '=', institutionId)
      .where('r.effective_from', '<=', date)
      .orderBy('r.version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!r) return this.rules();
    return ruleOf(r);
  }

  // --- the run (job settlement-run, 14.7) ---------------------------------------------------------------
  async run(
    ctx: Pick<JobContext, 'item' | 'periodKey'> & { scope?: { institutionId: string } | undefined },
  ) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.periodKey)
      ? ctx.periodKey
      : istBusinessDate(this.now());
    let q = this.deps.db
      .selectFrom('institutions')
      .select('id')
      .where('status', '=', 'ACTIVE')
      .orderBy('id');
    if (ctx.scope) q = q.where('id', '=', ctx.scope.institutionId);
    const institutions = await q.execute();
    for (const i of institutions) {
      const id = String(i.id);
      try {
        const out = await this.settleInstitution(id, date);
        ctx.item({
          institutionId: id,
          status: out.created ? 'SUCCESS' : 'SKIPPED',
          processed: out.lines,
          failed: 0,
          note: out.created
            ? `${out.lines} lines, ${formatInr(out.netPaise)} to settle`
            : 'A settlement for this date already exists',
        });
      } catch (e) {
        ctx.item({
          institutionId: id,
          status: 'FAILED',
          processed: 0,
          failed: 1,
          note: 'Settlement failed; the next run tries again',
          errorCode: e instanceof CustomAPIError ? e.code : 'GEN.INTERNAL',
        });
      }
    }
  }

  /** One institution's settlement for a date (its lines, files, tuition marks, roll-over). */
  async settleInstitution(institutionId: string, date: string) {
    const db = this.deps.db;
    const live = await db
      .selectFrom('settlements')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('settlement_date', '=', date)
      .where('status', '<>', 'FAILED')
      .executeTakeFirst();
    if (live) return { created: false, lines: 0, netPaise: 0 };
    const to = windowEnd(date);
    const rules = await this.rulesFor(institutionId, date);
    const credits = await db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_transactions as t', (j) =>
        j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
      )
      .innerJoin('wallets as w', 'w.id', 'e.wallet_id')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select((eb) => [
        't.id as txn_id',
        't.posted_on',
        't.reference',
        't.type',
        't.narration',
        't.posted_at',
        'e.amount_paise',
        'e.direction',
        'm.id as merchant_id',
        eb
          .selectFrom('settlement_lines as l')
          .select(sql<number>`COUNT(*)`.as('n'))
          .whereRef('l.ledger_txn_id', '=', 't.id')
          .as('times'),
      ])
      .where('w.institution_id', '=', institutionId)
      .where('w.kind', '=', 'MERCHANT')
      .where('w.status', '=', 'ACTIVE')
      .where('m.status', '=', 'ACTIVE')
      // Collections credited to the merchant, and refunds or chargebacks taken back from it — the
      // latter are adjustments deducted in this settlement (Q14 M3).
      .where((eb) =>
        eb.or([
          eb.and([eb('e.direction', '=', 'C'), eb('t.type', 'in', [...COLLECTION_TYPES])]),
          eb.and([eb('e.direction', '=', 'D'), eb('t.type', 'in', [...ADJUSTMENT_TYPES])]),
        ]),
      )
      .where('t.posted_at', '<=', to)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('settlement_lines as l')
              .select('l.id')
              .whereRef('l.ledger_txn_id', '=', 't.id')
              .where('l.active', '=', 1),
          ),
        ),
      )
      .orderBy('t.posted_at')
      .execute();
    // A line of a rejected settlement is collected once more (M17), not again after that.
    const lines = credits
      .filter((c) => Number(c.times ?? 0) < 2)
      .map((c) => {
        const amount = Number(c.amount_paise);
        const sign = c.direction === 'D' ? -1 : 1;
        const fee = sign === 1 ? platformFee(c.type, amount, rules) : 0;
        return {
          txnId: String(c.txn_id),
          postedOn: day(c.posted_on),
          reference: c.reference,
          type: c.type,
          sign,
          merchantId: String(c.merchant_id),
          amount,
          fee,
          net: amount - fee,
          remarks: c.narration,
          at: new Date(c.posted_at),
          recollected: Number(c.times ?? 0) >= 1,
        };
      });
    // Nothing to settle: no empty settlement to approve, but the day's balances still roll over (8.15).
    if (!lines.length) {
      await db.transaction().execute((trx) => this.rollOver(trx, institutionId, date));
      return { created: false, lines: 0, netPaise: 0 };
    }
    const inst = await db
      .selectFrom('institutions')
      .select(['identifier', 'name'])
      .where('id', '=', institutionId)
      .executeTakeFirstOrThrow();
    const merchants = await this.merchantNames(db, institutionId, [
      ...new Set(lines.map((l) => l.merchantId)),
    ]);
    const gross = lines.filter((l) => l.sign === 1).reduce((a, l) => a + l.amount, 0);
    const fee = lines.reduce((a, l) => a + l.fee, 0);
    const adjustments = lines.filter((l) => l.sign === -1).reduce((a, l) => a + l.amount, 0);
    const net = gross - fee - adjustments;
    const pub = newPublicIdPair();
    const n = await db
      .selectFrom('settlements')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('institution_id', '=', institutionId)
      .where('settlement_date', '=', date)
      .executeTakeFirst();
    const settlementNo = `STL-${date.replace(/-/g, '')}-${inst.identifier}-${Number(n?.n ?? 0) + 1}`;
    // The four statements (RNG-STL-066…070), values quoted so a comma can't shift a column.
    const files = await this.writeStatements(
      institutionId,
      inst.identifier,
      settlementNo,
      date,
      lines,
      merchants,
    );
    const at = this.now();
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('institutions')
        .select('id')
        .where('id', '=', institutionId)
        .forUpdate()
        .execute();
      const ins = await trx
        .insertInto('settlements')
        .values({
          public_id: pub.bin,
          institution_id: institutionId,
          settlement_no: settlementNo,
          settlement_date: date,
          window_to: to,
          line_count: lines.length,
          merchant_count: merchants.size,
          gross_paise: gross,
          fee_paise: fee,
          adjustment_paise: adjustments,
          net_paise: net,
          recollected_count: lines.filter((l) => l.recollected).length,
          files: JSON.stringify(files),
          created_at: at,
          updated_at: at,
        })
        .executeTakeFirstOrThrow();
      const settlementId = String(ins.insertId);
      for (let k = 0; k < lines.length; k += 500) {
        await trx
          .insertInto('settlement_lines')
          .values(
            lines.slice(k, k + 500).map((l) => ({
              public_id: newPublicIdPair().bin,
              settlement_id: settlementId,
              institution_id: institutionId,
              merchant_profile_id: l.merchantId,
              ledger_txn_id: l.txnId,
              posted_on: l.postedOn,
              reference: l.reference,
              txn_type: l.type,
              sign: l.sign,
              amount_paise: l.amount,
              fee_paise: l.fee,
              net_paise: l.net,
              remarks: l.remarks,
              txn_at: l.at,
              recollected: l.recollected ? 1 : 0,
            })),
          )
          .execute();
      }
      // Tuition collections in the settlement are settled (RNG-STL-065).
      const ids = lines.filter((l) => l.type === 'TUITION').map((l) => l.txnId);
      for (let k = 0; k < ids.length; k += 500) {
        await trx
          .updateTable('fee_collections')
          .set({ status: 'SETTLED', settlement_ref: settlementNo })
          .where('institution_id', '=', institutionId)
          .where('payment_attempt_id', 'in', (eb) =>
            eb
              .selectFrom('payment_attempts')
              .select('id')
              .where('ledger_txn_id', 'in', ids.slice(k, k + 500)),
          )
          .execute();
      }
      await this.rollOver(trx, institutionId, date);
      await recordAudit(trx, {
        institutionId,
        action: 'SETTLEMENT_CREATED',
        entityType: 'settlement',
        entityRef: pub.id,
        after: { settlementNo, lines: lines.length, gross: formatInr(gross), fee: formatInr(fee) },
      });
    });
    return { created: true, lines: lines.length, netPaise: net };
  }

  /**
   * The day's opening and closing balance of every wallet of the institution (8.15): closing is the
   * balance at the cut-off (today's balance less what was posted after it), opening the previous
   * day's closing (or the closing less the day's movements). Written once per wallet and date.
   */
  private async rollOver(trx: Transaction<Database>, institutionId: string, date: string) {
    const to = windowEnd(date);
    const from = new Date(to.getTime() - 86_400_000);
    const prevDate = istBusinessDate(new Date(from.getTime() + 330 * 60_000 - 60_000));
    const rows = await trx
      .selectFrom('wallets as w')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .leftJoin('ledger_entries as e', (j) =>
        j.onRef('e.wallet_id', '=', 'w.id').on('e.posted_on', '>=', istBusinessDate(from)),
      )
      .leftJoin('ledger_transactions as t', (j) =>
        j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
      )
      .leftJoin('wallet_day_balances as prev', (j) =>
        j.onRef('prev.wallet_id', '=', 'w.id').on('prev.business_date', '=', prevDate),
      )
      .select([
        'w.id',
        'b.available_paise',
        'prev.closing_paise as prev_closing',
        sql<string>`COALESCE(SUM(CASE WHEN t.posted_at > ${to} THEN IF(e.direction = 'C', e.amount_paise, -e.amount_paise) ELSE 0 END), 0)`.as(
          'after',
        ),
        sql<string>`COALESCE(SUM(CASE WHEN t.posted_at > ${from} AND t.posted_at <= ${to} THEN IF(e.direction = 'C', e.amount_paise, -e.amount_paise) ELSE 0 END), 0)`.as(
          'during',
        ),
      ])
      .where('w.institution_id', '=', institutionId)
      .groupBy(['w.id', 'b.available_paise', 'prev.closing_paise'])
      .execute();
    for (let k = 0; k < rows.length; k += 500) {
      const chunk = rows.slice(k, k + 500);
      if (!chunk.length) continue;
      await trx
        .insertInto('wallet_day_balances')
        .ignore()
        .values(
          chunk.map((r) => {
            const closing = Number(r.available_paise) - Number(r.after);
            const opening =
              r.prev_closing !== null && r.prev_closing !== undefined
                ? Number(r.prev_closing)
                : closing - Number(r.during);
            return {
              wallet_id: String(r.id),
              business_date: date,
              institution_id: institutionId,
              opening_paise: opening,
              closing_paise: closing,
            };
          }),
        )
        .execute();
    }
  }

  private async merchantNames(db: Db, institutionId: string, ids: readonly string[]) {
    const out = new Map<string, { uniqueId: string; name: string }>();
    if (!ids.length) return out;
    const rows = await db
      .selectFrom('member_profiles as m')
      .leftJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .select(['m.id', 'm.first_name', 'm.last_name', 'mer.display_name', 'mer.unique_id'])
      .where('m.institution_id', '=', institutionId)
      .where('m.id', 'in', ids)
      .execute();
    for (const r of rows) {
      out.set(String(r.id), {
        uniqueId: r.unique_id ?? String(r.id),
        name: r.display_name ?? nameOf(r.first_name, r.last_name) ?? 'N/A',
      });
    }
    return out;
  }

  private async writeStatements(
    institutionId: string,
    identifier: string,
    settlementNo: string,
    date: string,
    lines: readonly {
      reference: string;
      sign: number;
      merchantId: string;
      at: Date;
      type: string;
      amount: number;
      fee: number;
      net: number;
      remarks: string | null;
    }[],
    merchants: ReadonlyMap<string, { uniqueId: string; name: string }>,
  ) {
    const stamp = (d: Date) =>
      new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const m = (id: string) => merchants.get(id) ?? { uniqueId: id, name: 'N/A' };
    const amt = (p: number) => formatAmount(p);
    const rupee = (p: number) => `₹ ${amt(p)}`;
    const byMerchant = new Map<string, typeof lines>();
    for (const l of lines)
      byMerchant.set(l.merchantId, [...(byMerchant.get(l.merchantId) ?? []), l]);
    // Collections add, adjustments (refunds, chargebacks) deduct (Q14 M3).
    const sum = (ls: typeof lines, k: 'amount' | 'fee' | 'net') =>
      ls.reduce(
        (a, l) => a + (k === 'amount' && l.sign < 0 ? 0 : l[k] * (k === 'net' ? l.sign : 1)),
        0,
      );
    const signed = (l: (typeof lines)[number], p: number) => (l.sign < 0 ? '-' : '') + amt(p);
    const state = (l: (typeof lines)[number]) => (l.sign < 0 ? 'adjustment' : 'success');
    const all = { amount: sum(lines, 'amount'), fee: sum(lines, 'fee'), net: sum(lines, 'net') };
    const csvs: Record<(typeof STATEMENTS)[number], string> = {
      transactions: toCsv([
        [
          'TransactionID',
          'MerchantID',
          'TransactionDate',
          'Status',
          'Amount',
          'Type',
          'Remarks',
          'Fee',
          'NetAmount',
        ],
        ...lines.map((l) => [
          l.reference,
          m(l.merchantId).uniqueId,
          stamp(l.at),
          state(l),
          signed(l, l.amount),
          l.type,
          l.remarks ?? '',
          amt(l.fee),
          signed(l, l.net),
        ]),
      ]),
      merchant_summary: toCsv([
        [
          'MerchantID',
          'TotalTransactions',
          'SuccessTransactions',
          'TotalAmount',
          'Fee',
          'NetSettlementAmount',
          'SettlementDate',
          'SettlementID',
          'SettlementStatus',
        ],
        ...[...byMerchant].map(([id, ls]) => [
          m(id).uniqueId,
          ls.length,
          ls.length,
          amt(sum(ls, 'amount')),
          amt(sum(ls, 'fee')),
          amt(sum(ls, 'net')),
          date,
          settlementNo,
          'pending',
        ]),
      ]),
      summary_report: toCsv([
        [
          'Merchant ID',
          'Merchant Name',
          'No. of Success Transactions',
          'Total Amount (₹)',
          'Commission/Deductions (₹)',
          'Net to Merchant (₹)',
        ],
        ...[...byMerchant].map(([id, ls]) => [
          m(id).uniqueId,
          m(id).name,
          ls.length,
          rupee(sum(ls, 'amount')),
          rupee(sum(ls, 'fee')),
          rupee(sum(ls, 'net')),
        ]),
        ['Total', '-', lines.length, rupee(all.amount), rupee(all.fee), rupee(all.net)],
        [],
        [
          'Date',
          'Settlement ID',
          'Total Transactions',
          'Total Amount (₹)',
          'Total Commission/Deductions (₹)',
          'Aggregate Settlement Amount (₹)',
        ],
        [date, settlementNo, lines.length, rupee(all.amount), rupee(all.fee), rupee(all.net)],
      ]),
      settlement_report: toCsv([
        ['TransactionID', 'MerchantID', 'TransactionDate', 'Status', 'Amount', 'Fee', 'NetAmount'],
        ...lines.map((l) => [
          l.reference,
          m(l.merchantId).uniqueId,
          stamp(l.at),
          state(l),
          signed(l, l.amount),
          amt(l.fee),
          signed(l, l.net),
        ]),
        [],
        [
          'Total Transactions',
          '-',
          lines.length,
          '-',
          rupee(all.amount),
          rupee(all.fee),
          rupee(all.net),
        ],
      ]),
    };
    const ymd = date.replace(/-/g, '');
    const out: { fileNo: number; kind: string; name: string; fileId: string }[] = [];
    for (const [k, kind] of STATEMENTS.entries()) {
      const name = `settlement_${kind}_org_${identifier}_${ymd}.csv`;
      const f = await this.deps.store.store({
        institutionId,
        name,
        data: Buffer.from(String.fromCharCode(0xfeff) + csvs[kind], 'utf8'),
      });
      out.push({ fileNo: k + 1, kind, name, fileId: f.publicId });
    }
    return out;
  }

  // --- reading -----------------------------------------------------------------------------------------
  private rows(db: Db) {
    return db
      .selectFrom('settlements as s')
      .innerJoin('institutions as i', 'i.id', 's.institution_id')
      .leftJoin('platform_accounts as a1', 'a1.public_id', 's.stage1_by')
      .leftJoin('platform_accounts as a2', 'a2.public_id', 's.final_by')
      .leftJoin('platform_accounts as a3', 'a3.public_id', 's.rejected_by')
      .leftJoin('platform_accounts as a4', 'a4.public_id', 's.payout_by')
      .selectAll('s')
      .select([
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'i.identifier as institution_identifier',
        'a1.first_name as s1_first',
        'a1.last_name as s1_last',
        'a2.first_name as f_first',
        'a2.last_name as f_last',
        'a3.first_name as r_first',
        'a3.last_name as r_last',
        'a4.first_name as p_first',
        'a4.last_name as p_last',
      ]);
  }

  private view(r: Awaited<ReturnType<ReturnType<SettlementService['rows']>['execute']>>[number]) {
    return {
      id: binToUuid(r.public_id),
      settlementNo: r.settlement_no,
      institution: {
        id: binToUuid(r.institution_public_id),
        name: r.institution_name,
        identifier: r.institution_identifier,
      },
      date: day(r.settlement_date),
      windowTo: iso(r.window_to),
      status: r.status,
      lines: r.line_count,
      merchants: r.merchant_count,
      gross: toMoneyDto(Number(r.gross_paise)),
      fee: toMoneyDto(Number(r.fee_paise)),
      adjustments: toMoneyDto(Number(r.adjustment_paise)),
      net: toMoneyDto(Number(r.net_paise)),
      recollected: r.recollected_count,
      stage1: r.stage1_at
        ? { by: nameOf(r.s1_first, r.s1_last), at: iso(r.stage1_at), remarks: r.stage1_remarks }
        : null,
      final: r.final_at
        ? { by: nameOf(r.f_first, r.f_last), at: iso(r.final_at), remarks: r.final_remarks }
        : null,
      rejection: r.rejected_at
        ? { by: nameOf(r.r_first, r.r_last), at: iso(r.rejected_at), remarks: r.rejection_remarks }
        : null,
      payout: r.payout_utr
        ? {
            utr: r.payout_utr,
            amount: toMoneyDto(Number(r.payout_paise ?? 0)),
            at: iso(r.payout_at),
            by: nameOf(r.p_first, r.p_last),
          }
        : null,
      createdAt: iso(r.created_at),
      version: r.row_version,
    };
  }

  private async one(db: Db, id: string, institutionId?: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'STL.NOT_FOUND');
    let q = this.rows(db).where('s.public_id', '=', uuidToBin(id));
    if (institutionId) q = q.where('s.institution_id', '=', institutionId);
    const r = await q.executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'STL.NOT_FOUND');
    return r;
  }

  /** Per merchant: its lines' totals, whether it is suspended now, and what is payable now. */
  private async merchants(settlementRowId: string, institutionId: string) {
    const rows = await this.deps.db
      .selectFrom('settlement_lines as l')
      .innerJoin('member_profiles as m', 'm.id', 'l.merchant_profile_id')
      .leftJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .leftJoin('wallets as w', (j) =>
        j.onRef('w.owner_profile_id', '=', 'm.id').on('w.kind', '=', 'MERCHANT'),
      )
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.status as profile_status',
        'mer.display_name',
        'mer.unique_id',
        'w.status as wallet_status',
        sql<number>`COUNT(*)`.as('lines'),
        sql<string>`SUM(IF(l.sign = 1, l.amount_paise, 0))`.as('gross'),
        sql<string>`SUM(l.fee_paise)`.as('fee'),
        sql<string>`SUM(CAST(l.net_paise AS SIGNED) * l.sign)`.as('net'),
        sql<string>`SUM(IF(l.sign = -1, l.amount_paise, 0))`.as('adjustments'),
        sql<number>`SUM(l.active = 0 AND l.carried = 1)`.as('carried'),
        sql<number>`SUM(l.payout_reference IS NOT NULL)`.as('paid'),
      ])
      .where('l.settlement_id', '=', settlementRowId)
      .where('l.institution_id', '=', institutionId)
      .groupBy([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.status',
        'mer.display_name',
        'mer.unique_id',
        'w.status',
      ])
      .orderBy('mer.display_name')
      .execute();
    return rows.map((r) => ({
      rowId: String(r.id),
      id: binToUuid(r.public_id),
      uniqueId: r.unique_id,
      name: r.display_name ?? nameOf(r.first_name, r.last_name),
      lines: Number(r.lines),
      gross: Number(r.gross),
      fee: Number(r.fee),
      adjustments: Number(r.adjustments),
      net: Number(r.net),
      suspended: r.profile_status !== 'ACTIVE' || r.wallet_status !== 'ACTIVE',
      carried: Number(r.carried) > 0,
      paid: Number(r.paid) > 0,
    }));
  }

  private async detailView(
    r: Awaited<ReturnType<ReturnType<SettlementService['rows']>['execute']>>[number],
    withLines: boolean,
  ) {
    const merchants = await this.merchants(String(r.id), String(r.institution_id));
    const payable = merchants
      .filter((m) => !m.suspended && !m.carried && m.net >= 0)
      .reduce((a, m) => a + m.net, 0);
    const lines = withLines
      ? await this.deps.db
          .selectFrom('settlement_lines as l')
          .innerJoin('member_profiles as m', 'm.id', 'l.merchant_profile_id')
          .select([
            'l.public_id',
            'l.reference',
            'l.txn_type',
            'l.sign',
            'l.amount_paise',
            'l.fee_paise',
            'l.net_paise',
            'l.remarks',
            'l.txn_at',
            'l.recollected',
            'l.active',
            'l.carried',
            'l.payout_reference',
            'm.public_id as merchant_public_id',
          ])
          .where('l.settlement_id', '=', r.id)
          .orderBy('l.txn_at')
          .limit(1000)
          .execute()
      : [];
    const files = (typeof r.files === 'string' ? JSON.parse(r.files) : r.files) as
      { fileNo: number; kind: string; name: string; fileId: string }[] | null;
    return {
      ...this.view(r),
      payableNow: toMoneyDto(r.status === 'APPROVED' && !r.payout_utr ? payable : 0),
      merchantsList: merchants.map(({ rowId: _r, ...m }) => ({
        ...m,
        gross: toMoneyDto(m.gross),
        fee: toMoneyDto(m.fee),
        adjustments: toMoneyDto(m.adjustments),
        net: toMoneyDto(m.net),
      })),
      linesList: lines.map((l) => ({
        id: binToUuid(l.public_id),
        reference: l.reference,
        merchantId: binToUuid(l.merchant_public_id),
        type: l.txn_type,
        adjustment: Number(l.sign) < 0,
        amount: toMoneyDto(Number(l.amount_paise)),
        fee: toMoneyDto(Number(l.fee_paise)),
        net: toMoneyDto(Number(l.net_paise)),
        remarks: l.remarks,
        at: iso(l.txn_at),
        recollected: !!Number(l.recollected),
        carried: !!Number(l.carried),
        payoutReference: l.payout_reference,
      })),
      statements: (files ?? []).map((f) => ({ fileNo: f.fileNo, kind: f.kind, name: f.name })),
    };
  }

  // --- STL-001 / STL-002 / STL-007 (back office) -------------------------------------------------------
  async list(f: {
    status?: SettlementStatus | undefined;
    institutionId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
  }) {
    let q = this.rows(this.deps.db);
    if (f.status) q = q.where('s.status', '=', f.status);
    if (f.institutionId) {
      if (!isUuid(f.institutionId)) return { items: [], nextCursor: null };
      q = q.where('i.public_id', '=', uuidToBin(f.institutionId));
    }
    if (f.from) q = q.where('s.settlement_date', '>=', f.from);
    if (f.to) q = q.where('s.settlement_date', '<=', f.to);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('s.id', '<', f.cursor);
    const rows = await q.orderBy('s.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((r) => this.view(r)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  async detail(id: string) {
    return this.detailView(await this.one(this.deps.db, id), true);
  }

  async statement(id: string, fileNo: number, institutionId?: string) {
    const r = await this.one(this.deps.db, id, institutionId);
    const files = (typeof r.files === 'string' ? JSON.parse(r.files) : r.files) as
      { fileNo: number; name: string; fileId: string }[] | null;
    const f = files?.find((x) => x.fileNo === fileNo);
    if (!f || !this.deps.links) throw new NotFoundError();
    return { name: f.name, ...this.deps.links.linkFor(f.fileId) };
  }

  // --- STL-003 / STL-004 / STL-005 ---------------------------------------------------------------------
  private async remarks(text: string) {
    const min = await this.limit(LIMITS.settlementRemarksMin);
    const t = text.trim();
    if (t.length < min || t.length > 500) {
      throw new ValidationError([{ field: 'remarks', code: 'STL.REMARKS' }]);
    }
    return t;
  }

  private by(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    return uuidToBin(p.subject);
  }

  async stage1(p: Principal, id: string, expected: number, input: { remarks: string }) {
    const remarks = await this.remarks(input.remarks);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.locked(trx, id);
      if (r.status !== 'PENDING') throw new CustomAPIError(409, 'STL.NOT_PENDING');
      if (r.row_version !== expected) throw new PreconditionFailedError();
      const at = this.now();
      await trx
        .updateTable('settlements')
        .set({
          status: 'APPROVAL_STAGE_1',
          stage1_by: by,
          stage1_at: at,
          stage1_remarks: remarks,
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', r.id)
        .where('status', '=', 'PENDING')
        .execute();
      await recordAudit(trx, {
        institutionId: String(r.institution_id),
        action: 'SETTLEMENT_STAGE1_APPROVED',
        entityType: 'settlement',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.detail(id);
  }

  async final(p: Principal, id: string, expected: number, input: { remarks: string }) {
    const remarks = await this.remarks(input.remarks);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.locked(trx, id);
      if (r.status !== 'APPROVAL_STAGE_1') throw new CustomAPIError(409, 'STL.NOT_STAGE1');
      if (r.stage1_by && Buffer.from(r.stage1_by).equals(by)) {
        throw new CustomAPIError(409, 'STL.SAME_APPROVER');
      }
      if (r.row_version !== expected) throw new PreconditionFailedError();
      const at = this.now();
      await trx
        .updateTable('settlements')
        .set({
          status: 'APPROVED',
          final_by: by,
          final_at: at,
          final_remarks: remarks,
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', r.id)
        .where('status', '=', 'APPROVAL_STAGE_1')
        .execute();
      await recordAudit(trx, {
        institutionId: String(r.institution_id),
        action: 'SETTLEMENT_APPROVED',
        entityType: 'settlement',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.detail(id);
  }

  /** Rejection: the settlement fails, its lines are freed for the next run (once, M17). */
  async reject(p: Principal, id: string, expected: number, input: { remarks: string }) {
    const remarks = await this.remarks(input.remarks);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.locked(trx, id);
      if (r.status !== 'PENDING' && r.status !== 'APPROVAL_STAGE_1') {
        throw new CustomAPIError(409, 'STL.CANNOT_REJECT');
      }
      if (r.stage1_by && Buffer.from(r.stage1_by).equals(by)) {
        throw new CustomAPIError(409, 'STL.REJECTER_APPROVED');
      }
      if (r.row_version !== expected) throw new PreconditionFailedError();
      const at = this.now();
      await trx
        .updateTable('settlements')
        .set({
          status: 'FAILED',
          rejected_by: by,
          rejected_at: at,
          rejection_remarks: remarks,
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', r.id)
        .where('status', 'in', ['PENDING', 'APPROVAL_STAGE_1'])
        .execute();
      await trx
        .updateTable('settlement_lines')
        .set({ active: 0 })
        .where('settlement_id', '=', r.id)
        .execute();
      await trx
        .updateTable('fee_collections')
        .set({ status: 'COLLECTED', settlement_ref: null })
        .where('institution_id', '=', String(r.institution_id))
        .where('settlement_ref', '=', r.settlement_no)
        .execute();
      await recordAudit(trx, {
        institutionId: String(r.institution_id),
        action: 'SETTLEMENT_REJECTED',
        entityType: 'settlement',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.detail(id);
  }

  private async locked(trx: Transaction<Database>, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'STL.NOT_FOUND');
    const r = await trx
      .selectFrom('settlements')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'STL.NOT_FOUND');
    return r;
  }

  // --- STL-006 -----------------------------------------------------------------------------------------
  /**
   * The bank paid the merchants: the UTR and amount are recorded once, and each merchant's share is
   * posted (the wallet debited the gross: the net to the payout clearing, the fee to the platform fee
   * account). A merchant suspended by now is carried forward to a later settlement (M4); the amount
   * must be what remains to be paid.
   */
  async payout(p: Principal, id: string, input: { utr: string; amountPaise: number }) {
    const utr = input.utr.trim().toUpperCase();
    if (!UTR.test(utr)) throw new ValidationError([{ field: 'utr', code: 'STL.UTR_FORMAT' }]);
    const by = this.by(p);
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const r = await this.locked(trx, id);
        if (r.payout_utr) {
          throw new CustomAPIError(409, 'STL.UTR_SET', { params: { utr: r.payout_utr } });
        }
        if (r.status !== 'APPROVED') throw new CustomAPIError(409, 'STL.NOT_APPROVED');
        const merchants = await this.merchants(String(r.id), String(r.institution_id));
        const paying = merchants.filter((m) => !m.suspended && !m.carried && m.net >= 0);
        const payable = paying.reduce((a, m) => a + m.net, 0);
        if (input.amountPaise !== payable) {
          throw new CustomAPIError(422, 'STL.PAYOUT_AMOUNT', {
            params: { amount: formatInr(payable) },
          });
        }
        const institutionId = String(r.institution_id);
        const at = this.now();
        // Suspended merchants (M4), and merchants whose adjustments exceed their collections (M3):
        // carried forward, their lines free for a later run.
        for (const m of merchants.filter((x) => (x.suspended || x.net < 0) && !x.carried)) {
          await trx
            .updateTable('settlement_lines')
            .set({ active: 0, carried: 1 })
            .where('settlement_id', '=', r.id)
            .where('merchant_profile_id', '=', m.rowId)
            .execute();
        }
        for (const m of paying) {
          const wallet = await trx
            .selectFrom('wallets')
            .select('id')
            .where('owner_profile_id', '=', m.rowId)
            .where('kind', '=', 'MERCHANT')
            .executeTakeFirstOrThrow();
          let reference: string | null = null;
          try {
            if (m.net > 0) {
              const out = await this.deps.ledger.post(trx, {
                institutionId,
                type: 'SETTLEMENT_PAYOUT',
                channel: 'BACK_OFFICE',
                amountPaise: m.net,
                idempotencyKey: `STL-PAYOUT:${r.id}:${m.rowId}`,
                debit: { walletId: String(wallet.id) },
                credit: { account: 'PAYOUT_CLEARING', institutionId },
                narration: `Settlement ${r.settlement_no} · UTR ${utr}`.slice(0, 140),
                businessRef: { type: 'settlement', id: String(r.id) },
                actorRef: by,
                at,
              });
              reference = out.reference;
            }
            if (m.fee > 0) {
              await this.deps.ledger.post(trx, {
                institutionId,
                type: 'PLATFORM_FEE',
                channel: 'BACK_OFFICE',
                amountPaise: m.fee,
                idempotencyKey: `STL-FEE:${r.id}:${m.rowId}`,
                debit: { walletId: String(wallet.id) },
                credit: { account: 'PLATFORM_FEE', institutionId },
                narration: `Platform fee · ${r.settlement_no}`.slice(0, 140),
                businessRef: { type: 'settlement', id: String(r.id) },
                actorRef: by,
                at,
              });
            }
          } catch (e) {
            if (e instanceof CustomAPIError && e.code === 'PAY.INSUFFICIENT_BALANCE') {
              throw new CustomAPIError(409, 'STL.MERCHANT_BALANCE', {
                params: { merchant: m.name },
              });
            }
            throw e;
          }
          await trx
            .updateTable('settlement_lines')
            .set({ payout_reference: reference })
            .where('settlement_id', '=', r.id)
            .where('merchant_profile_id', '=', m.rowId)
            .where('active', '=', 1)
            .execute();
        }
        await trx
          .updateTable('settlements')
          .set({
            payout_utr: utr,
            payout_paise: input.amountPaise,
            payout_at: at,
            payout_by: by,
            updated_at: at,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', r.id)
          .where('payout_utr', 'is', null)
          .execute();
        await recordAudit(trx, {
          institutionId,
          action: 'SETTLEMENT_PAID_OUT',
          entityType: 'settlement',
          entityRef: id,
          after: { utr, amount: formatInr(input.amountPaise), merchants: paying.length },
        });
        // Each merchant paid is told (client 2026-10-22).
        for (const m of paying.filter((x) => x.net > 0)) {
          await tellMembers(
            trx,
            {
              institutionId,
              profileRowIds: [m.rowId],
              titleKey: 'NTF.SETTLEMENT_PAID',
              params: { amount: formatInr(m.net) },
              body: `Settlement ${r.settlement_no} · UTR ${utr}`,
              category: 'PAYMENT',
              link: '/merchant/settlements',
            },
            at,
          );
        }
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) throw new CustomAPIError(409, 'STL.UTR_TAKEN');
      throw e;
    }
    return this.detail(id);
  }

  // --- STL-008 -------------------------------------------------------------------------------------------
  async feeRules() {
    const rules = await this.rules();
    const today = istBusinessDate(this.now());
    const view = (r: FeeRules) => ({
      thresholdAmount: toMoneyDto(r.thresholdPaise),
      flatFee: toMoneyDto(r.flatPaise),
      boundary: r.boundary ?? 'INCLUSIVE',
      basisPoints: r.basisPoints,
      percent: (r.basisPoints / 100).toFixed(2),
      chargeTuition: r.chargeTuition,
      appliesTo: [
        ...(r.appliesTo ?? COLLECTION_TYPES.filter((t) => t !== 'TUITION' || r.chargeTuition)),
      ],
    });
    const plans = await this.deps.db
      .selectFrom('plans')
      .select(['id', 'public_id', 'name'])
      .orderBy('id')
      .execute();
    const versions = await this.deps.db
      .selectFrom('platform_fee_rules')
      .selectAll()
      .orderBy('plan_id')
      .orderBy('version', 'desc')
      .execute();
    return {
      default: view(rules),
      collectionTypes: COLLECTION_TYPES,
      plans: plans.map((pl) => {
        const own = versions.filter((v) => String(v.plan_id) === String(pl.id));
        const current = own.find((v) => day(v.effective_from) <= today);
        return {
          id: binToUuid(pl.public_id),
          name: pl.name,
          rule: current ? view(ruleOf(current)) : view(rules),
          override: !!current,
          version: own[0]?.version ?? 0,
          versions: own.map((v) => ({
            version: v.version,
            effectiveFrom: day(v.effective_from),
            ...view(ruleOf(v)),
            remarks: v.remarks,
            createdAt: iso(v.created_at),
          })),
        };
      }),
    };
  }

  /**
   * STL-009: a new version of a plan's rule, effective from tomorrow or later and after the last
   * version; versions are never edited (If-Match: the plan's latest version, 0 for none).
   */
  async setPlanRule(
    p: Principal,
    planId: string,
    expected: number,
    input: {
      flatPaise: number;
      thresholdPaise: number;
      boundary: 'INCLUSIVE' | 'EXCLUSIVE';
      basisPoints: number;
      appliesTo: readonly string[];
      effectiveFrom: string;
      remarks: string;
    },
  ) {
    if (!isUuid(planId)) throw new NotFoundError();
    const plan = await this.deps.db
      .selectFrom('plans')
      .select(['id', 'name'])
      .where('public_id', '=', uuidToBin(planId))
      .executeTakeFirst();
    if (!plan) throw new NotFoundError();
    const types = [...new Set(input.appliesTo)];
    if (!types.length || types.some((t) => !(COLLECTION_TYPES as readonly string[]).includes(t))) {
      throw new ValidationError([{ field: 'appliesTo', code: 'STL.RULE_TYPES' }]);
    }
    const remarks = await this.remarks(input.remarks);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      await trx.selectFrom('plans').select('id').where('id', '=', plan.id).forUpdate().execute();
      const last = await trx
        .selectFrom('platform_fee_rules')
        .select(['version', 'effective_from'])
        .where('plan_id', '=', String(plan.id))
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      if ((last?.version ?? 0) !== expected) throw new PreconditionFailedError();
      const tomorrow = istBusinessDate(new Date(this.now().getTime() + 86_400_000));
      const floor = last && day(last.effective_from) >= tomorrow ? day(last.effective_from) : null;
      if (input.effectiveFrom < tomorrow || (floor && input.effectiveFrom <= floor)) {
        throw new ValidationError([
          {
            field: 'effectiveFrom',
            code: 'STL.RULE_EFFECTIVE',
            params: { date: floor ?? tomorrow },
          },
        ]);
      }
      await trx
        .insertInto('platform_fee_rules')
        .values({
          plan_id: String(plan.id),
          version: (last?.version ?? 0) + 1,
          flat_paise: input.flatPaise,
          threshold_paise: input.thresholdPaise,
          boundary: input.boundary,
          basis_points: input.basisPoints,
          applies_to: JSON.stringify(types),
          effective_from: input.effectiveFrom,
          remarks,
          created_by: by,
          created_at: this.now(),
        })
        .execute();
      await recordAudit(trx, {
        action: 'PLATFORM_FEE_RULE_CHANGED',
        entityType: 'plan',
        entityRef: planId,
        after: {
          version: (last?.version ?? 0) + 1,
          flat: formatInr(input.flatPaise),
          threshold: formatInr(input.thresholdPaise),
          boundary: input.boundary,
          basisPoints: input.basisPoints,
          appliesTo: types,
          effectiveFrom: input.effectiveFrom,
        },
        reason: remarks,
      });
    });
    return (await this.feeRules()).plans.find((x) => x.id === planId.toLowerCase())!;
  }

  // --- STL-010 / STL-011 (institution, read-only) -------------------------------------------------------
  private async inst(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!i) throw new NotFoundError();
    return i;
  }

  async consoleList(
    p: Principal,
    f: {
      status?: SettlementStatus | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const i = await this.inst(p);
    let q = this.rows(this.deps.db).where('s.institution_id', '=', i.id);
    if (f.status) q = q.where('s.status', '=', f.status);
    if (f.from) q = q.where('s.settlement_date', '>=', f.from);
    if (f.to) q = q.where('s.settlement_date', '<=', f.to);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('s.id', '<', f.cursor);
    const rows = await q.orderBy('s.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((r) => this.view(r)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  async consoleDetail(p: Principal, id: string) {
    const i = await this.inst(p);
    return this.detailView(await this.one(this.deps.db, id, i.id), true);
  }

  async consoleStatement(p: Principal, id: string, fileNo: number) {
    const i = await this.inst(p);
    return this.statement(id, fileNo, i.id);
  }

  // --- STL-012 / STL-013 (the merchant) ------------------------------------------------------------------
  private async merchantSelf(p: Principal) {
    if (!isUuid(p.subject) || !p.profileId || !isUuid(p.profileId)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select(['m.id', 'm.institution_id', 'ut.category'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(p.profileId))
      .executeTakeFirst();
    if (!m || m.category !== 'MERCHANT') throw new NotFoundError();
    return { rowId: String(m.id), institutionId: String(m.institution_id) };
  }

  /** Merchant statement labels (27.2 "as shown on the merchant statement"). */
  private static merchantStatus(s: SettlementStatus) {
    return {
      PENDING: 'Pending Review',
      APPROVAL_STAGE_1: 'Provisional Approval',
      APPROVED: 'Final Approval',
      FAILED: 'Validation Failed',
    }[s];
  }

  async merchantList(p: Principal) {
    const me = await this.merchantSelf(p);
    const rows = await this.deps.db
      .selectFrom('settlement_lines as l')
      .innerJoin('settlements as s', 's.id', 'l.settlement_id')
      .select([
        's.public_id',
        's.settlement_no',
        's.settlement_date',
        's.status',
        's.payout_utr',
        's.payout_at',
        sql<number>`COUNT(*)`.as('lines'),
        sql<string>`SUM(IF(l.sign = 1, l.amount_paise, 0))`.as('gross'),
        sql<string>`SUM(l.fee_paise)`.as('fee'),
        sql<string>`SUM(CAST(l.net_paise AS SIGNED) * l.sign)`.as('net'),
        sql<string>`SUM(IF(l.sign = -1, l.amount_paise, 0))`.as('adjustments'),
        sql<number>`SUM(l.payout_reference IS NOT NULL)`.as('paid'),
        sql<number>`SUM(l.carried)`.as('carried'),
      ])
      .where('l.institution_id', '=', me.institutionId)
      .where('l.merchant_profile_id', '=', me.rowId)
      .groupBy([
        's.id',
        's.public_id',
        's.settlement_no',
        's.settlement_date',
        's.status',
        's.payout_utr',
        's.payout_at',
      ])
      .orderBy('s.settlement_date', 'desc')
      .limit(100)
      .execute();
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        settlementNo: r.settlement_no,
        date: day(r.settlement_date),
        status: r.status,
        statusLabel: SettlementService.merchantStatus(r.status),
        lines: Number(r.lines),
        gross: toMoneyDto(Number(r.gross)),
        fee: toMoneyDto(Number(r.fee)),
        adjustments: toMoneyDto(Number(r.adjustments)),
        net: toMoneyDto(Number(r.net)),
        paidOut: Number(r.paid) > 0 ? { utr: r.payout_utr, at: iso(r.payout_at) } : null,
        carriedForward: Number(r.carried) > 0,
      })),
    };
  }

  async merchantDetail(p: Principal, id: string) {
    const me = await this.merchantSelf(p);
    const list = await this.merchantList(p);
    const head = list.items.find((x) => x.id === id.toLowerCase());
    if (!head) throw new CustomAPIError(404, 'STL.NOT_FOUND');
    const lines = await this.deps.db
      .selectFrom('settlement_lines as l')
      .innerJoin('settlements as s', 's.id', 'l.settlement_id')
      .select([
        'l.reference',
        'l.txn_type',
        'l.sign',
        'l.amount_paise',
        'l.fee_paise',
        'l.net_paise',
        'l.remarks',
        'l.txn_at',
        'l.carried',
      ])
      .where('s.public_id', '=', uuidToBin(id))
      .where('l.merchant_profile_id', '=', me.rowId)
      .orderBy('l.txn_at')
      .execute();
    return {
      ...head,
      transactions: lines.map((l) => ({
        reference: l.reference,
        type: l.txn_type,
        adjustment: Number(l.sign) < 0,
        amount: toMoneyDto(Number(l.amount_paise)),
        fee: toMoneyDto(Number(l.fee_paise)),
        net: toMoneyDto(Number(l.net_paise)),
        remarks: l.remarks,
        at: iso(l.txn_at),
        carried: !!Number(l.carried),
      })),
    };
  }
}

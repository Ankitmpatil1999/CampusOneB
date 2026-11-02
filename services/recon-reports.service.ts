/**
 * Reconciliation reports (SRS 15.2–15.5; REC-010, REC-011, REC-013…016; PAY-025; FR-REC-01/04,
 * FR-RPT-01; OI-REC-02…05 adopted).
 *
 * - Back office: the MIS per institution (transactions, merchant collections, bank credits,
 *   settlements, refunds, chargebacks) and the pool balances.
 * - Institution console: its transactions with a date range, counts per status and an export
 *   (OI-REC-02); the payer ↔ merchant matching with mismatch flags (OI-REC-04); a merchant's
 *   statement with the fee and net of its settlement lines, "not settled" otherwise (OI-REC-03); its
 *   pool balance (OI-REC-05).
 * - Pool balance: what the sponsor bank's pool account should hold according to the ledger (credits
 *   in, less payouts and chargebacks out) against what is held for wallets and the platform. A
 *   difference means stored balances drifted from the ledger. The bank's own balance needs its
 *   balance feed (OI-REC-05, Q17) and is shown as not available until then.
 * - Everything here reads; nothing changes a balance.
 */
import { sql, type Kysely } from 'kysely';
import type { Database, LedgerAccountKind, PaymentAttemptStatus } from '../models/campusone_models';
import { NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { toCsv } from '../utils/csv';
import { toMoneyDto } from '../utils/money';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

/** The movements that are a merchant's collections (as in the settlement run, RNG-STL-061). */
const COLLECTION_TYPES = ['PAYMENT', 'TUITION', 'EVENT', 'TRANSFER', 'ALLOWANCE_PAYMENT'] as const;
const STATUS_LABEL: Record<PaymentAttemptStatus, string> = {
  SUCCESS: 'Success',
  FAILURE: 'Failure',
  PENDING: 'Pending',
};
const TYPE_LABEL: Record<string, string> = {
  PAYMENT: 'Payment',
  TUITION: 'Tuition fee',
  EVENT: 'Event',
  TRANSFER: 'Transfer',
  ALLOWANCE_PAYMENT: 'Allowance payment',
  REFUND: 'Refund',
  CHARGEBACK: 'Chargeback',
  REVERSAL: 'Reversal',
  SETTLEMENT_PAYOUT: 'Settlement payout',
  PLATFORM_FEE: 'Platform fee',
  BANK_CREDIT: 'Money added',
};
const OTHER_ACCOUNTS: readonly LedgerAccountKind[] = [
  'PLATFORM_FEE',
  'HELD_SUSPENSE',
  'REFUND_CLEARING',
  'COUPON_REIMBURSEMENT',
  'ADJUSTMENT',
  'ALLOWANCE_FUNDING',
];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const ymd = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(new Date(d));
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

export class ReconReportsService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** A date range in India time: by default the month so far. */
  private range(f: { from?: string | undefined; to?: string | undefined }) {
    const today = istBusinessDate(this.now());
    const to = f.to ?? today;
    const from = f.from ?? `${to.slice(0, 8)}01`;
    if (!DAY.test(from)) throw new ValidationError([{ field: 'from', code: 'VALIDATION.DATE' }]);
    if (!DAY.test(to) || from > to) {
      throw new ValidationError([{ field: 'to', code: 'VALIDATION.DATE' }]);
    }
    return {
      from,
      to,
      start: new Date(`${from}T00:00:00+05:30`),
      end: new Date(Date.parse(`${to}T00:00:00+05:30`) + 86_400_000),
    };
  }

  private async institution(publicId: string | undefined) {
    if (!publicId || !isUuid(publicId)) throw new NotFoundError();
    const i = await this.deps.db
      .selectFrom('institutions')
      .select(['id', 'public_id', 'name'])
      .where('public_id', '=', uuidToBin(publicId))
      .executeTakeFirst();
    if (!i) throw new NotFoundError();
    return { id: String(i.id), publicId: binToUuid(i.public_id), name: i.name };
  }

  private consoleInst(p: Principal) {
    return this.institution(p.institutionId);
  }

  // --- REC-010: MIS by institution -----------------------------------------------------------------------
  async mis(f: {
    from?: string | undefined;
    to?: string | undefined;
    institutionId?: string | undefined;
  }) {
    const r = this.range(f);
    const db = this.deps.db;
    const only = f.institutionId ? await this.institution(f.institutionId) : null;
    let inst = db.selectFrom('institutions').select(['id', 'public_id', 'name']).orderBy('name');
    if (only) inst = inst.where('id', '=', only.id);
    const institutions = await inst.execute();
    const scope = <T extends { where: (...a: never[]) => T }>(q: T, col: string) =>
      only ? (q.where as (c: string, op: string, v: string) => T)(col, '=', only.id) : q;

    const attempts = await scope(
      db
        .selectFrom('payment_attempts')
        .select([
          'institution_id',
          'status',
          sql<number>`COUNT(*)`.as('n'),
          sql<string>`SUM(amount_paise)`.as('amount'),
        ])
        .where('attempted_at', '>=', r.start)
        .where('attempted_at', '<', r.end)
        .groupBy(['institution_id', 'status']),
      'institution_id',
    ).execute();
    const collections = await scope(
      db
        .selectFrom('ledger_entries as e')
        .innerJoin('ledger_transactions as t', (j) =>
          j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
        )
        .innerJoin('wallets as w', 'w.id', 'e.wallet_id')
        .select([
          'e.institution_id',
          sql<number>`COUNT(*)`.as('n'),
          sql<string>`SUM(e.amount_paise)`.as('amount'),
        ])
        .where('w.kind', '=', 'MERCHANT')
        .where('e.direction', '=', 'C')
        .where('t.type', 'in', [...COLLECTION_TYPES])
        .where('e.posted_on', '>=', r.from)
        .where('e.posted_on', '<=', r.to)
        .groupBy('e.institution_id'),
      'e.institution_id',
    ).execute();
    const credits = await scope(
      db
        .selectFrom('bank_credits')
        .select([
          'institution_id',
          sql<number>`COUNT(*)`.as('n'),
          sql<string>`SUM(amount_paise)`.as('amount'),
        ])
        .where('status', '<>', 'FAILED')
        .where('credited_at', '>=', r.start)
        .where('credited_at', '<', r.end)
        .groupBy('institution_id'),
      'institution_id',
    ).execute();
    const settlements = await scope(
      db
        .selectFrom('settlements')
        .select([
          'institution_id',
          sql<number>`COUNT(*)`.as('n'),
          sql<string>`SUM(IF(status <> 'FAILED', gross_paise, 0))`.as('gross'),
          sql<string>`SUM(IF(status <> 'FAILED', fee_paise, 0))`.as('fee'),
          sql<string>`SUM(IF(status <> 'FAILED', adjustment_paise, 0))`.as('adjustments'),
          sql<string>`SUM(IF(status <> 'FAILED', net_paise, 0))`.as('net'),
          sql<string>`SUM(COALESCE(payout_paise, 0))`.as('paid'),
        ])
        .where('settlement_date', '>=', r.from)
        .where('settlement_date', '<=', r.to)
        .groupBy('institution_id'),
      'institution_id',
    ).execute();
    const refunds = await scope(
      db
        .selectFrom('refunds')
        .select([
          'institution_id',
          sql<number>`COUNT(*)`.as('n'),
          sql<string>`SUM(amount_paise)`.as('amount'),
        ])
        .where('status', '=', 'PROCESSED')
        .where('decided_at', '>=', r.start)
        .where('decided_at', '<', r.end)
        .groupBy('institution_id'),
      'institution_id',
    ).execute();
    const chargebacks = await scope(
      db
        .selectFrom('chargebacks')
        .select([
          'institution_id',
          sql<number>`COUNT(*)`.as('n'),
          sql<string>`SUM(amount_paise)`.as('amount'),
        ])
        .where('outcome', '=', 'REVERSED')
        .where('completed_at', '>=', r.start)
        .where('completed_at', '<', r.end)
        .groupBy('institution_id'),
      'institution_id',
    ).execute();

    const by = <T extends { institution_id: string | null }>(rows: readonly T[], id: string) =>
      rows.filter((x) => String(x.institution_id) === id);
    const pair = (rows: readonly { n: number; amount: string | null }[]) => ({
      count: rows.reduce((a, x) => a + Number(x.n), 0),
      amount: toMoneyDto(rows.reduce((a, x) => a + Number(x.amount ?? 0), 0)),
    });
    const items = institutions.map((i) => {
      const id = String(i.id);
      const a = by(attempts, id);
      const s = by(settlements, id)[0];
      return {
        institution: { id: binToUuid(i.public_id), name: i.name },
        transactions: {
          success: pair(a.filter((x) => x.status === 'SUCCESS')),
          failure: pair(a.filter((x) => x.status === 'FAILURE')),
          pending: pair(a.filter((x) => x.status === 'PENDING')),
        },
        merchantCollections: pair(by(collections, id)),
        bankCredits: pair(by(credits, id)),
        settlements: {
          count: Number(s?.n ?? 0),
          gross: toMoneyDto(Number(s?.gross ?? 0)),
          fee: toMoneyDto(Number(s?.fee ?? 0)),
          adjustments: toMoneyDto(Number(s?.adjustments ?? 0)),
          net: toMoneyDto(Number(s?.net ?? 0)),
          paidOut: toMoneyDto(Number(s?.paid ?? 0)),
        },
        refunds: pair(by(refunds, id)),
        chargebacks: pair(by(chargebacks, id)),
      };
    });
    return { from: r.from, to: r.to, items };
  }

  // --- REC-011 / REC-016: pool balances ------------------------------------------------------------------
  private async pools(institutionId: string | null, date: string | undefined) {
    if (date !== undefined && !DAY.test(date)) {
      throw new ValidationError([{ field: 'date', code: 'VALIDATION.DATE' }]);
    }
    const db = this.deps.db;
    let accounts = db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_accounts as a', 'a.id', 'e.account_id')
      .select([
        'e.institution_id',
        'a.kind',
        sql<string>`SUM(IF(e.direction = 'D', e.amount_paise, -e.amount_paise))`.as('dr'),
      ])
      .where('e.institution_id', 'is not', null)
      .groupBy(['e.institution_id', 'a.kind']);
    if (institutionId) accounts = accounts.where('e.institution_id', '=', institutionId);
    if (date) accounts = accounts.where('e.posted_on', '<=', date);
    const balances = await accounts.execute();
    // The stored wallet balances: now, or the day's closing balances (8.15) for a past date.
    const stored = new Map<string, number>();
    if (date) {
      let q = db
        .selectFrom('wallet_day_balances')
        .select(['institution_id', sql<string>`SUM(closing_paise)`.as('total')])
        .where('business_date', '=', date)
        .groupBy('institution_id');
      if (institutionId) q = q.where('institution_id', '=', institutionId);
      for (const r of await q.execute()) stored.set(String(r.institution_id), Number(r.total));
    } else {
      let q = db
        .selectFrom('wallets as w')
        .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
        .select([
          'w.institution_id',
          sql<string>`SUM(b.available_paise + b.held_paise)`.as('total'),
        ])
        .where('w.institution_id', 'is not', null)
        .groupBy('w.institution_id');
      if (institutionId) q = q.where('w.institution_id', '=', institutionId);
      for (const r of await q.execute()) stored.set(String(r.institution_id), Number(r.total));
    }
    let inst = db.selectFrom('institutions').select(['id', 'public_id', 'name']).orderBy('name');
    if (institutionId) inst = inst.where('id', '=', institutionId);
    const institutions = await inst.execute();
    return {
      asOf: date ?? istBusinessDate(this.now()),
      bankFeed: false,
      items: institutions.map((i) => {
        const id = String(i.id);
        const dr = (k: LedgerAccountKind) =>
          Number(balances.find((b) => String(b.institution_id) === id && b.kind === k)?.dr ?? 0);
        const received = dr('BANK_POOL');
        const paidOut = -dr('PAYOUT_CLEARING');
        const chargebacks = -dr('CHARGEBACK_CLEARING');
        const expected = received - paidOut - chargebacks;
        const walletsLedger = -dr('WALLET');
        const walletsStored = stored.has(id) ? stored.get(id)! : date ? null : 0;
        const others = OTHER_ACCOUNTS.map((k) => ({ kind: k, balance: -dr(k) })).filter(
          (o) => o.balance !== 0,
        );
        const held = (walletsStored ?? walletsLedger) + others.reduce((a, o) => a + o.balance, 0);
        const money = (v: number) => ({ ...toMoneyDto(Math.abs(v)), negative: v < 0 });
        return {
          institution: { id: binToUuid(i.public_id), name: i.name },
          received: money(received),
          paidOut: money(paidOut),
          chargebacks: money(chargebacks),
          poolExpected: money(expected),
          wallets: walletsStored === null ? null : money(walletsStored),
          walletsPerLedger: money(walletsLedger),
          otherAccounts: others.map((o) => ({ kind: o.kind, balance: money(o.balance) })),
          heldFor: money(held),
          difference: money(expected - held),
          bankReported: null,
        };
      }),
    };
  }

  async pool(f: { date?: string | undefined; institutionId?: string | undefined }) {
    const only = f.institutionId ? await this.institution(f.institutionId) : null;
    return this.pools(only?.id ?? null, f.date);
  }

  async consolePool(p: Principal, f: { date?: string | undefined }) {
    const i = await this.consoleInst(p);
    const out = await this.pools(i.id, f.date);
    return { asOf: out.asOf, bankFeed: out.bankFeed, ...out.items[0]! };
  }

  // --- REC-013: the institution's transactions -----------------------------------------------------------
  private attempts(
    institutionId: string,
    f: {
      start: Date;
      end: Date;
      channel?: string | undefined;
      q?: string | undefined;
    },
  ) {
    let q = this.deps.db
      .selectFrom('payment_attempts as pa')
      .innerJoin('member_profiles as mp', 'mp.id', 'pa.payer_profile_id')
      .innerJoin('member_profiles as mq', 'mq.id', 'pa.payee_profile_id')
      .leftJoin('merchants as mer', 'mer.profile_id', 'pa.payee_profile_id')
      .where('pa.institution_id', '=', institutionId)
      .where('pa.attempted_at', '>=', f.start)
      .where('pa.attempted_at', '<', f.end)
      // Captures with a POS operator tag are outside this view (RNG-REC-009).
      .where('pa.order_ref', 'is', null);
    if (f.channel) q = q.where('pa.channel', '=', f.channel);
    if (f.q) q = q.where('pa.reference', 'like', `%${f.q.replace(/[%_\\]/g, '')}%`);
    return q;
  }

  async transactions(
    p: Principal,
    f: {
      from?: string | undefined;
      to?: string | undefined;
      status?: PaymentAttemptStatus | undefined;
      channel?: string | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
    limit = 50,
  ) {
    const i = await this.consoleInst(p);
    const r = this.range(f);
    const base = this.attempts(i.id, { ...r, channel: f.channel, q: f.q?.trim().toUpperCase() });
    const counts = await base
      .select(['pa.status', sql<number>`COUNT(*)`.as('n')])
      .groupBy('pa.status')
      .execute();
    let q = base.select([
      'pa.id',
      'pa.public_id',
      'pa.reference',
      'pa.channel',
      'pa.amount_paise',
      'pa.status',
      'pa.attempted_at',
      'pa.completed_at',
      'pa.remarks',
      'mp.first_name as payer_first',
      'mp.last_name as payer_last',
      'mq.first_name as payee_first',
      'mq.last_name as payee_last',
      'mer.display_name',
    ]);
    if (f.status) q = q.where('pa.status', '=', f.status);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('pa.id', '<', f.cursor);
    const rows = await q
      .orderBy('pa.id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const total = counts.reduce((a, c) => a + Number(c.n), 0);
    const count = (s: PaymentAttemptStatus) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const share = (n: number) => (total ? Math.round((n * 1000) / total) / 10 : 0);
    return {
      from: r.from,
      to: r.to,
      tiles: {
        total,
        success: { count: count('SUCCESS'), share: share(count('SUCCESS')) },
        failure: { count: count('FAILURE'), share: share(count('FAILURE')) },
        pending: { count: count('PENDING'), share: share(count('PENDING')) },
      },
      items: page.map((x) => ({
        id: binToUuid(x.public_id),
        at: iso(x.completed_at ?? x.attempted_at),
        description: x.channel === 'TRANSFER' ? 'Transfer' : 'Payment',
        payer: nameOf(x.payer_first, x.payer_last),
        payee: x.display_name ?? nameOf(x.payee_first, x.payee_last),
        reference: x.reference,
        amount: toMoneyDto(Number(x.amount_paise)),
        status: x.status,
        statusLabel: STATUS_LABEL[x.status],
        channel: x.channel,
        remarks: x.remarks,
      })),
      nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null,
    };
  }

  /** The same rows as a CSV file (FR-RPT-01 export), at most 10,000. */
  async transactionsCsv(p: Principal, f: Parameters<ReconReportsService['transactions']>[1]) {
    const out = await this.transactions(p, { ...f, cursor: undefined }, 10_000);
    const csv = toCsv([
      ['Date', 'Description', 'Payer', 'Payee', 'Reference', 'Amount', 'Status', 'Channel'],
      ...out.items.map((x) => [
        x.at ? istBusinessDate(new Date(x.at)) : '',
        x.description,
        x.payer,
        x.payee,
        x.reference,
        x.amount.amount,
        x.statusLabel,
        x.channel,
      ]),
    ]);
    return { name: `transactions-${out.from}-to-${out.to}.csv`, csv };
  }

  // --- REC-014: payer ↔ merchant matching ----------------------------------------------------------------
  async consoleMis(
    p: Principal,
    f: {
      from?: string | undefined;
      to?: string | undefined;
      status?: PaymentAttemptStatus | undefined;
      view?: 'matched' | 'unmatched' | 'mismatched' | undefined;
      cursor?: string | undefined;
    },
  ) {
    const i = await this.consoleInst(p);
    const r = this.range(f);
    const side = (dir: 'D' | 'C') =>
      this.deps.db
        .selectFrom('ledger_entries')
        .select(['ledger_txn_id', 'amount_paise'])
        .where('institution_id', '=', i.id)
        .where('direction', '=', dir)
        .where('posted_on', '>=', r.from);
    const payerSide = side('D').as('d');
    const merchantSide = side('C').as('c');
    let q = this.deps.db
      .selectFrom('payment_attempts as pa')
      .innerJoin('merchants as mer', 'mer.profile_id', 'pa.payee_profile_id')
      .innerJoin('member_profiles as mp', 'mp.id', 'pa.payer_profile_id')
      .leftJoin(payerSide, 'd.ledger_txn_id', 'pa.ledger_txn_id')
      .leftJoin(merchantSide, 'c.ledger_txn_id', 'pa.ledger_txn_id')
      .where('pa.institution_id', '=', i.id)
      .where('mer.institution_id', '=', i.id)
      .where('pa.attempted_at', '>=', r.start)
      .where('pa.attempted_at', '<', r.end);
    if (f.status) q = q.where('pa.status', '=', f.status);
    const match = sql<string>`CASE
      WHEN c.ledger_txn_id IS NULL THEN 'UNMATCHED'
      WHEN pa.status <> 'SUCCESS' OR d.amount_paise <> c.amount_paise OR c.amount_paise <> pa.amount_paise THEN 'MISMATCHED'
      ELSE 'MATCHED' END`;
    const counts = await q
      .select([match.as('m'), sql<number>`COUNT(*)`.as('n')])
      .groupBy('m')
      .execute();
    let rows = q.select([
      'pa.id',
      'pa.reference',
      'pa.amount_paise',
      'pa.status',
      'pa.attempted_at',
      'pa.ledger_txn_id',
      'mp.first_name',
      'mp.last_name',
      'mer.display_name',
      'd.amount_paise as payer_paise',
      'c.amount_paise as merchant_paise',
      match.as('m'),
      (eb) =>
        eb
          .selectFrom('settlement_lines as l')
          .select('l.id')
          .whereRef('l.ledger_txn_id', '=', 'pa.ledger_txn_id')
          .where('l.active', '=', 1)
          .limit(1)
          .as('line'),
    ]);
    if (f.view) rows = rows.where(match, '=', f.view.toUpperCase());
    if (f.cursor && /^\d+$/.test(f.cursor)) rows = rows.where('pa.id', '<', f.cursor);
    const list = await rows.orderBy('pa.id', 'desc').limit(101).execute();
    const page = list.slice(0, 100);
    const n = (m: string) => Number(counts.find((c) => c.m === m)?.n ?? 0);
    return {
      from: r.from,
      to: r.to,
      counts: { matched: n('MATCHED'), unmatched: n('UNMATCHED'), mismatched: n('MISMATCHED') },
      items: page.map((x) => ({
        reference: x.reference,
        at: iso(x.attempted_at),
        match: x.m as 'MATCHED' | 'UNMATCHED' | 'MISMATCHED',
        payer: {
          name: nameOf(x.first_name, x.last_name),
          amount: toMoneyDto(Number(x.payer_paise ?? x.amount_paise)),
          status: STATUS_LABEL[x.status],
        },
        merchant:
          x.merchant_paise === null
            ? null
            : {
                name: x.display_name,
                amount: toMoneyDto(Number(x.merchant_paise)),
                status: STATUS_LABEL.SUCCESS,
              },
        settled: x.line !== null,
      })),
      nextCursor: list.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  // --- REC-015: a merchant's statement -------------------------------------------------------------------
  private async merchantOf(institutionId: string, merchantId: string | undefined) {
    if (!merchantId || !isUuid(merchantId)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .innerJoin('wallets as w', (j) =>
        j.onRef('w.owner_profile_id', '=', 'm.id').on('w.kind', '=', 'MERCHANT'),
      )
      .select(['m.id', 'm.public_id', 'mer.display_name', 'mer.unique_id', 'w.id as wallet_id'])
      .where('m.public_id', '=', uuidToBin(merchantId))
      .where('m.institution_id', '=', institutionId)
      .where('mer.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    return m;
  }

  async merchantStatement(
    p: Principal,
    f: {
      merchantId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const i = await this.consoleInst(p);
    const r = this.range(f);
    const m = await this.merchantOf(i.id, f.merchantId);
    const base = this.deps.db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_transactions as t', (j) =>
        j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
      )
      .leftJoin('settlement_lines as l', (j) =>
        j.onRef('l.ledger_txn_id', '=', 'e.ledger_txn_id').on('l.active', '=', 1),
      )
      .leftJoin('settlements as s', 's.id', 'l.settlement_id')
      .where('e.institution_id', '=', i.id)
      .where('e.wallet_id', '=', String(m.wallet_id))
      .where('e.posted_on', '>=', r.from)
      .where('e.posted_on', '<=', r.to);
    const totals = await base
      .select([
        sql<string>`SUM(IF(e.direction = 'C' AND t.type IN ('PAYMENT','TUITION','EVENT','TRANSFER','ALLOWANCE_PAYMENT'), e.amount_paise, 0))`.as(
          'collections',
        ),
        sql<string>`SUM(IF(l.sign = 1, l.fee_paise, 0))`.as('fees'),
        sql<string>`SUM(IF(e.direction = 'D' AND t.type IN ('REFUND','CHARGEBACK'), e.amount_paise, 0))`.as(
          'adjustments',
        ),
        sql<string>`SUM(IF(e.direction = 'D' AND t.type = 'SETTLEMENT_PAYOUT', e.amount_paise, 0))`.as(
          'paid',
        ),
      ])
      .executeTakeFirst();
    let q = base.select([
      'e.id',
      'e.direction',
      'e.amount_paise',
      'e.balance_after_paise',
      't.reference',
      't.type',
      't.narration',
      't.posted_at',
      'l.sign',
      'l.fee_paise',
      'l.net_paise',
      's.settlement_no',
      's.status as settlement_status',
      's.payout_utr',
    ]);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('e.id', '<', f.cursor);
    const rows = await q.orderBy('e.id', 'desc').limit(101).execute();
    const page = rows.slice(0, 100);
    return {
      merchant: {
        id: binToUuid(m.public_id),
        name: m.display_name,
        uniqueId: m.unique_id,
      },
      from: r.from,
      to: r.to,
      totals: {
        collections: toMoneyDto(Number(totals?.collections ?? 0)),
        fees: toMoneyDto(Number(totals?.fees ?? 0)),
        adjustments: toMoneyDto(Number(totals?.adjustments ?? 0)),
        paidOut: toMoneyDto(Number(totals?.paid ?? 0)),
      },
      items: page.map((x) => ({
        reference: x.reference,
        at: iso(x.posted_at),
        type: x.type,
        typeLabel: TYPE_LABEL[x.type] ?? x.type,
        direction: x.direction === 'C' ? 'CREDIT' : 'DEBIT',
        amount: toMoneyDto(Number(x.amount_paise)),
        balanceAfter:
          x.balance_after_paise === null ? null : toMoneyDto(Number(x.balance_after_paise)),
        // The fee and net of its settlement line; "not settled" while no live settlement holds it.
        settlement: x.settlement_no
          ? {
              settlementNo: x.settlement_no,
              status: x.settlement_status,
              paidOut: !!x.payout_utr,
              fee: toMoneyDto(Number(x.fee_paise ?? 0)),
              net: toMoneyDto(Number(x.net_paise ?? 0)),
            }
          : null,
        remarks: x.narration,
      })),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  // --- PAY-025: merchant reports -------------------------------------------------------------------------
  async merchantReport(
    p: Principal,
    f: { from?: string | undefined; to?: string | undefined; merchantId?: string | undefined },
  ) {
    const i = await this.consoleInst(p);
    const r = this.range(f);
    let q = this.deps.db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_transactions as t', (j) =>
        j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
      )
      .innerJoin('wallets as w', 'w.id', 'e.wallet_id')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .innerJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .leftJoin('settlement_lines as l', (j) =>
        j.onRef('l.ledger_txn_id', '=', 'e.ledger_txn_id').on('l.active', '=', 1),
      )
      .select([
        'm.public_id',
        'mer.display_name',
        'mer.unique_id',
        'e.posted_on',
        sql<number>`COUNT(*)`.as('n'),
        sql<string>`SUM(e.amount_paise)`.as('amount'),
        sql<string>`SUM(IF(l.id IS NULL, 0, e.amount_paise))`.as('settled'),
        sql<string>`SUM(COALESCE(l.fee_paise, 0))`.as('fee'),
      ])
      .where('e.institution_id', '=', i.id)
      .where('w.kind', '=', 'MERCHANT')
      .where('e.direction', '=', 'C')
      .where('t.type', 'in', [...COLLECTION_TYPES])
      .where('e.posted_on', '>=', r.from)
      .where('e.posted_on', '<=', r.to)
      .groupBy(['m.public_id', 'mer.display_name', 'mer.unique_id', 'e.posted_on'])
      .orderBy('mer.display_name')
      .orderBy('e.posted_on', 'desc');
    if (f.merchantId) {
      if (!isUuid(f.merchantId)) throw new NotFoundError();
      q = q.where('m.public_id', '=', uuidToBin(f.merchantId));
    }
    const rows = await q.execute();
    const merchants = new Map<
      string,
      {
        id: string;
        name: string;
        uniqueId: string;
        count: number;
        amount: number;
        settled: number;
        fee: number;
        days: { date: string; count: number; amount: number; settled: number; fee: number }[];
      }
    >();
    for (const x of rows) {
      const id = binToUuid(x.public_id);
      const m =
        merchants.get(id) ??
        merchants
          .set(id, {
            id,
            name: x.display_name,
            uniqueId: x.unique_id,
            count: 0,
            amount: 0,
            settled: 0,
            fee: 0,
            days: [],
          })
          .get(id)!;
      const day = {
        date: ymd(x.posted_on),
        count: Number(x.n),
        amount: Number(x.amount),
        settled: Number(x.settled),
        fee: Number(x.fee),
      };
      m.days.push(day);
      m.count += day.count;
      m.amount += day.amount;
      m.settled += day.settled;
      m.fee += day.fee;
    }
    const view = (v: { count: number; amount: number; settled: number; fee: number }) => ({
      count: v.count,
      amount: toMoneyDto(v.amount),
      settled: toMoneyDto(v.settled),
      unsettled: toMoneyDto(v.amount - v.settled),
      fee: toMoneyDto(v.fee),
    });
    return {
      from: r.from,
      to: r.to,
      items: [...merchants.values()].map((m) => ({
        merchant: { id: m.id, name: m.name, uniqueId: m.uniqueId },
        ...view(m),
        days: m.days.map((d) => ({ date: d.date, ...view(d) })),
      })),
    };
  }
}

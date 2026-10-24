/**
 * Wallets and statements (SRS 8.2–8.5, 8.8, 8.13; WAL-001…005, WAL-008/009, RPT-006; prototype
 * m.home, m.activity, m.txn, m.addmoney and the console member drawer's wallet tab).
 *
 * - A member sees the wallets of the profiles on their account (a parent the children registered
 *   under the parent's number, CR-04); `for` picks the profile, otherwise the active one.
 * - A statement is read from the ledger entries of the wallet, newest first, with the balance after
 *   each entry and the other party's name.
 * - The virtual account is the institution's corporate code + the campus wallet number at the
 *   sponsor bank (example bank details until the client names the bank — C-11).
 * - Balances are never cached (OI-WAL-02).
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { PAYMENT_CHANNELS, REFERENCE_PATTERN } from '../config/registers';
import type { Database, LedgerTxnType } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { kindOf } from '../repositories/members.repository';
import { NotFoundError } from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import { formatDateTime, formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import { PdfDocument, rupeesInWords } from '../utils/pdf';
import type { Principal } from '../utils/principal';
import { vansOf } from './vans';

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const name = (first: string | null, last: string | null) =>
  titleCase([first, last].filter(Boolean).join(' '));
const iso = (d: Date | string) => new Date(d).toISOString();
const CHANNEL_LABEL = Object.fromEntries(PAYMENT_CHANNELS.map((c) => [c.code, c.label]));
const TYPE_LABEL: Readonly<Record<LedgerTxnType, string>> = {
  PAYMENT: 'Payment',
  TRANSFER: 'Transfer',
  BANK_CREDIT: 'Money added',
  TUITION: 'Fee payment',
  ALLOWANCE_CREDIT: 'Allowance credited',
  ALLOWANCE_PAYMENT: 'Allowance payment',
  COUPON_REDEMPTION: 'Coupon',
  EVENT: 'Event payment',
  REFUND: 'Refund',
  REVERSAL: 'Reversal',
  CHARGEBACK: 'Chargeback',
  SETTLEMENT_PAYOUT: 'Settlement',
  PLATFORM_FEE: 'Platform fee',
  ADJUSTMENT: 'Adjustment',
  HOLD_RELEASE: 'Released',
  ALLOWANCE_EXPIRY: 'Allowance lapsed',
};

type Db = Kysely<Database>;

export class WalletsService {
  constructor(
    private readonly deps: {
      readonly db: Db;
      readonly vaBank: { readonly name: string; readonly ifsc: string; readonly example: boolean };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async accountId(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const a = await this.deps.db
      .selectFrom('platform_accounts')
      .select('id')
      .where('public_id', '=', uuidToBin(p.subject))
      .executeTakeFirst();
    if (!a) throw new NotFoundError();
    return String(a.id);
  }

  /** The member's profile: `for`, the session's active profile, or the first on the account. */
  private async memberProfile(p: Principal, forProfile?: string) {
    const accountId = await this.accountId(p);
    const profiles = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'm.id',
        'm.public_id',
        'm.member_seq',
        'm.first_name',
        'm.last_name',
        'm.status',
        'i.id as institution_id',
        'i.name as institution_name',
        'i.short_name',
        'ut.name as user_type',
        'ut.category',
      ])
      .where((eb) =>
        // The account's profiles, or a student's own login (client 2026-10-23).
        eb.or([eb('m.account_id', '=', accountId), eb('m.own_account_id', '=', accountId)]),
      )
      .orderBy('m.id')
      .execute();
    const wanted = forProfile ?? p.profileId;
    const chosen = wanted
      ? profiles.find((x) => binToUuid(x.public_id) === wanted.toLowerCase())
      : profiles[0];
    if (!chosen) throw new NotFoundError();
    return { accountId, profile: chosen, profiles };
  }

  private async walletsOf(profileId: string) {
    const db = this.deps.db;
    const today = istBusinessDate(this.now());
    const month = `${today.slice(0, 7)}-01`;
    const rows = await db
      .selectFrom('wallets as w')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .select([
        'w.id',
        'w.public_id',
        'w.kind',
        'w.wallet_no',
        'w.status',
        'b.available_paise',
        'b.held_paise',
      ])
      .where('w.owner_profile_id', '=', profileId)
      .orderBy('w.kind')
      .execute();
    const spend = rows.length
      ? await db
          .selectFrom('ledger_entries')
          .select([
            'wallet_id',
            sql<string>`SUM(CASE WHEN posted_on = ${today} THEN amount_paise ELSE 0 END)`.as(
              'today',
            ),
            sql<string>`SUM(amount_paise)`.as('month'),
          ])
          .where(
            'wallet_id',
            'in',
            rows.map((r) => String(r.id)),
          )
          .where('direction', '=', 'D')
          .where('posted_on', '>=', month)
          .groupBy('wallet_id')
          .execute()
      : [];
    const vans = await vansOf(
      db,
      rows.map((r) => String(r.id)),
    );
    return rows.map((w) => {
      const s = spend.find((x) => String(x.wallet_id) === String(w.id));
      return {
        id: binToUuid(w.public_id),
        kind: w.kind,
        walletNo: w.wallet_no,
        status: w.status,
        balance: toMoneyDto(Number(w.available_paise)),
        held: toMoneyDto(Number(w.held_paise)),
        virtualAccount: vans.get(String(w.id))?.van ?? null,
        spentToday: toMoneyDto(Number(s?.today ?? 0)),
        spentThisMonth: toMoneyDto(Number(s?.month ?? 0)),
      };
    });
  }

  private profileDto(pr: {
    public_id: Buffer;
    member_seq: number;
    first_name: string;
    last_name: string | null;
    status: string;
    institution_name: string;
    short_name: string;
    user_type: string;
    category: string;
  }) {
    return {
      id: binToUuid(pr.public_id),
      memberNo: `${pr.short_name}-${String(pr.member_seq).padStart(5, '0')}`,
      name: name(pr.first_name, pr.last_name),
      userType: pr.user_type,
      kind: kindOf(pr.category),
      status: pr.status,
      institution: pr.institution_name,
    };
  }

  // --- WAL-001 ------------------------------------------------------------------------------------
  async myWallets(p: Principal, forProfile?: string) {
    const { profile } = await this.memberProfile(p, forProfile);
    return {
      profile: this.profileDto(profile),
      wallets: await this.walletsOf(String(profile.id)),
    };
  }

  /** A wallet of a profile on the member's account. */
  private async ownWallet(p: Principal, walletId: string) {
    if (!isUuid(walletId)) throw new NotFoundError();
    const accountId = await this.accountId(p);
    const w = await this.deps.db
      .selectFrom('wallets as w')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .innerJoin('institutions as i', 'i.id', 'w.institution_id')
      .select([
        'w.id',
        'w.kind',
        'w.wallet_no',
        'w.status',
        'm.first_name',
        'm.last_name',
        'i.name as institution_name',
      ])
      .where('w.public_id', '=', uuidToBin(walletId))
      .where((eb) =>
        // The account's profiles, or a student's own login (client 2026-10-23).
        eb.or([eb('m.account_id', '=', accountId), eb('m.own_account_id', '=', accountId)]),
      )
      .executeTakeFirst();
    if (!w) throw new NotFoundError();
    return w;
  }

  // --- WAL-002 / WAL-009 --------------------------------------------------------------------------
  private async statementOf(
    walletId: string,
    q: {
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const db = this.deps.db;
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
    let s = db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_transactions as t', (j) =>
        j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
      )
      .select([
        'e.id',
        'e.ledger_txn_id',
        'e.direction',
        'e.amount_paise',
        'e.balance_after_paise',
        't.reference',
        't.type',
        't.channel',
        't.narration',
        't.posted_at',
      ])
      .where('e.wallet_id', '=', walletId);
    if (q.from) s = s.where('e.posted_on', '>=', q.from);
    if (q.to) s = s.where('e.posted_on', '<=', q.to);
    const before = idCursor.decode(q.cursor);
    if (before) s = s.where('e.id', '<', before);
    const rows = await s
      .orderBy('e.id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    // The other side of each transaction: a wallet's holder, or the institution.
    const others = page.length
      ? await db
          .selectFrom('ledger_entries as o')
          .leftJoin('wallets as w', 'w.id', 'o.wallet_id')
          .leftJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
          .select(['o.ledger_txn_id', 'm.first_name', 'm.last_name', 'w.kind'])
          .where(
            'o.ledger_txn_id',
            'in',
            page.map((r) => String(r.ledger_txn_id)),
          )
          .where((eb) => eb.or([eb('o.wallet_id', 'is', null), eb('o.wallet_id', '!=', walletId)]))
          .execute()
      : [];
    const last = page.at(-1);
    const items = page.map((r) => {
      const other = others.find((o) => String(o.ledger_txn_id) === String(r.ledger_txn_id));
      const amount = Number(r.amount_paise);
      return {
        id: String(r.id),
        reference: r.reference,
        type: r.type,
        title: TYPE_LABEL[r.type] ?? r.type,
        channel: r.channel,
        channelLabel: CHANNEL_LABEL[r.channel] ?? r.channel,
        direction: r.direction === 'D' ? ('DEBIT' as const) : ('CREDIT' as const),
        amount: toMoneyDto(amount),
        balanceAfter:
          r.balance_after_paise === null ? null : toMoneyDto(Number(r.balance_after_paise)),
        counterparty: other?.first_name ? name(other.first_name, other.last_name) : null,
        narration: r.narration,
        at: iso(r.posted_at),
      };
    });
    const signed = (x: (typeof page)[number]) =>
      (x.direction === 'D' ? -1 : 1) * Number(x.amount_paise);
    return {
      items,
      closingBalance:
        page[0]?.balance_after_paise != null
          ? toMoneyDto(Number(page[0].balance_after_paise))
          : null,
      openingBalance:
        last?.balance_after_paise != null
          ? toMoneyDto(Number(last.balance_after_paise) - signed(last))
          : null,
      nextCursor: rows.length > limit && last ? idCursor.encode(last.id) : null,
    };
  }

  async statement(
    p: Principal,
    walletId: string,
    q: { from?: string; to?: string; cursor?: string; limit?: number },
  ) {
    const w = await this.ownWallet(p, walletId);
    return this.statementOf(String(w.id), q);
  }

  // --- WAL-003 ------------------------------------------------------------------------------------
  /**
   * The wallet's VAN with the bank and IFSC of its code — the code of the holder's class, or the
   * school's default (client 2026-10-14). A code whose bank or IFSC isn't filled in yet shows the
   * platform's values (VA_BANK_NAME / VA_BANK_IFSC).
   */
  async virtualAccount(p: Principal, walletId: string) {
    const w = await this.ownWallet(p, walletId);
    const van = (await vansOf(this.deps.db, [String(w.id)])).get(String(w.id));
    if (!van) throw new NotFoundError();
    const filled = !!van.code.bankName && !!van.code.ifsc;
    return {
      vaNumber: van.van,
      beneficiary: `${name(w.first_name, w.last_name)} · ${w.institution_name}`,
      bankName: filled ? van.code.bankName! : this.deps.vaBank.name,
      ifsc: filled ? van.code.ifsc! : this.deps.vaBank.ifsc,
      example: filled ? false : this.deps.vaBank.example,
    };
  }

  // --- WAL-004 / WAL-005 --------------------------------------------------------------------------
  /** A movement the member is party to (a wallet of a profile on their account). */
  async transaction(p: Principal, reference: string) {
    if (!REFERENCE_PATTERN.test(reference)) throw new NotFoundError();
    const accountId = await this.accountId(p);
    const db = this.deps.db;
    const t = await db
      .selectFrom('ledger_transactions')
      .selectAll()
      .where('reference', '=', reference)
      .executeTakeFirst();
    if (!t) throw new NotFoundError();
    const entries = await db
      .selectFrom('ledger_entries as e')
      .leftJoin('wallets as w', 'w.id', 'e.wallet_id')
      .leftJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select([
        'e.direction',
        'e.wallet_id',
        'e.balance_after_paise',
        'w.wallet_no',
        'w.kind',
        'm.account_id',
        'm.first_name',
        'm.last_name',
      ])
      .where('e.ledger_txn_id', '=', String(t.id))
      .where('e.posted_on', '=', t.posted_on)
      .execute();
    const mine = entries.find((e) => e.account_id !== null && String(e.account_id) === accountId);
    if (!mine) throw new NotFoundError();
    const party = (dir: 'D' | 'C') => {
      const e = entries.find((x) => x.direction === dir);
      if (!e) return null;
      return {
        name: e.first_name ? name(e.first_name, e.last_name) : 'RingPe',
        walletNo: e.wallet_no ? `••••${e.wallet_no.slice(-4)}` : null,
        kind: e.kind,
      };
    };
    return {
      reference: t.reference,
      type: t.type,
      title: TYPE_LABEL[t.type] ?? t.type,
      channel: t.channel,
      channelLabel: CHANNEL_LABEL[t.channel] ?? t.channel,
      status: 'SUCCESS' as const,
      amount: toMoneyDto(Number(t.amount_paise)),
      direction: mine.direction === 'D' ? ('DEBIT' as const) : ('CREDIT' as const),
      balanceAfter:
        mine.balance_after_paise === null ? null : toMoneyDto(Number(mine.balance_after_paise)),
      from: party('D'),
      to: party('C'),
      narration: t.narration,
      at: iso(t.posted_at),
    };
  }

  async receiptPdf(p: Principal, reference: string) {
    const r = await this.transaction(p, reference);
    const doc = new PdfDocument(`RingPe receipt ${r.reference}`);
    const brand: [number, number, number] = [15, 110, 120];
    doc.text(48, 64, 'RingPe', { size: 20, bold: true, color: brand });
    doc.text(48, 84, 'Payment receipt', { size: 12, color: [90, 100, 110] });
    doc.text(547, 64, r.title, { size: 12, bold: true, align: 'right' });
    doc.text(547, 84, formatDateTime(r.at), { size: 10, align: 'right', color: [90, 100, 110] });
    doc.line(48, 100, 547, 100, { color: [220, 226, 230] });
    const amountPaise = Math.round(Number(r.amount.amount) * 100);
    doc.text(48, 140, formatInr(amountPaise).replace('₹', 'Rs. '), { size: 26, bold: true });
    doc.text(48, 160, rupeesInWords(amountPaise), { size: 9, color: [90, 100, 110] });
    const rows: [string, string][] = [
      ['Reference', r.reference],
      ['Status', 'Successful'],
      ['Channel', r.channelLabel],
      ['From', r.from ? `${r.from.name}${r.from.walletNo ? ` (${r.from.walletNo})` : ''}` : '—'],
      ['To', r.to ? `${r.to.name}${r.to.walletNo ? ` (${r.to.walletNo})` : ''}` : '—'],
      ['Note', r.narration ?? '—'],
    ];
    let y = 200;
    for (const [k, v] of rows) {
      doc.text(48, y, k, { size: 10, color: [90, 100, 110] });
      doc.text(180, y, v, { size: 10 });
      y += 22;
    }
    doc.line(48, y + 4, 547, y + 4, { color: [220, 226, 230] });
    doc.text(48, y + 26, 'This receipt is generated by RingPe and needs no signature.', {
      size: 8,
      color: [120, 130, 140],
    });
    return { fileName: `${r.reference}.pdf`, pdf: doc.toBuffer() };
  }

  // --- WAL-008 / WAL-009 --------------------------------------------------------------------------
  private async consoleMember(p: Principal, memberId: string) {
    if (!p.institutionId || !isUuid(p.institutionId) || !isUuid(memberId)) {
      throw new NotFoundError();
    }
    const inst = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!inst) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles')
      .select('id')
      .where('institution_id', '=', inst.id)
      .where('public_id', '=', uuidToBin(memberId))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    return String(m.id);
  }

  async memberWallets(p: Principal, memberId: string) {
    const id = await this.consoleMember(p, memberId);
    return { wallets: await this.walletsOf(id) };
  }

  async memberStatement(
    p: Principal,
    memberId: string,
    q: { walletId?: string; from?: string; to?: string; cursor?: string; limit?: number },
  ) {
    const id = await this.consoleMember(p, memberId);
    let w = this.deps.db.selectFrom('wallets').select('id').where('owner_profile_id', '=', id);
    w =
      q.walletId && isUuid(q.walletId)
        ? w.where('public_id', '=', uuidToBin(q.walletId))
        : w.where('kind', 'in', ['CAMPUS', 'MERCHANT']);
    const wallet = await w.executeTakeFirst();
    if (!wallet) throw new NotFoundError();
    return this.statementOf(String(wallet.id), q);
  }

  // --- RPT-006 ------------------------------------------------------------------------------------
  /** The member home: the profile, its wallets, the latest movements and the unread count. */
  async home(p: Principal, forProfile?: string) {
    const { accountId, profile, profiles } = await this.memberProfile(p, forProfile);
    const wallets = await this.walletsOf(String(profile.id));
    const main = await this.deps.db
      .selectFrom('wallets')
      .select('id')
      .where('owner_profile_id', '=', String(profile.id))
      .where('kind', 'in', ['CAMPUS', 'MERCHANT'])
      .executeTakeFirst();
    const recent = main ? (await this.statementOf(String(main.id), { limit: 5 })).items : [];
    const unread = await this.deps.db
      .selectFrom('notifications')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('account_id', '=', accountId)
      .where('surface', '=', 'MEMBER')
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return {
      profile: this.profileDto(profile),
      profiles: profiles.map((x) => this.profileDto(x)),
      wallets,
      recent,
      unreadNotifications: Number(unread?.n ?? 0),
    };
  }
}

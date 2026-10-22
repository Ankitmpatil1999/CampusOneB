/**
 * Money in by bank transfer to a member's virtual account (SRS 8.13, BR-16, CR-08, RC-12; WAL-010…013;
 * prototype E.bankCredit).
 *
 * - validate (before the bank credits): the account must be ours and its wallet able to take money;
 *   an inactive wallet is refused (002) so the bank returns the money at once.
 * - notify (after the bank credits): one credit per UTR + bank transaction id (a repeat returns the
 *   first answer). An active wallet is credited through the ledger (bank pool → wallet, RPEB
 *   reference). A suspended or inactive wallet's credit is HELD: posted to the institution's
 *   held-suspense account, never to the wallet, until the suspension is lifted (released by the
 *   held-credit job) or the money is returned on an approved instruction (BANK_CREDIT_RETURN).
 * - The member and their guardians are told in the same transaction.
 */
import { emit, rooms } from '../utils/outbox';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { BANK_RESPONSES, renderMessage } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import type { JobContext } from '../schedulers';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import { formatInr } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { MoneyError, parseAmount, toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { raiseApproval } from './approvals.service';
import { recordAudit } from './audit.service';
import type { LedgerService } from './ledger.service';
import { notify } from './notifications.service';
import { resolveVan } from './vans';

type Db = Kysely<Database> | Transaction<Database>;

export interface BankCreditInput {
  readonly requestId: string;
  readonly corporateCode: string;
  readonly vaNumber: string;
  readonly amount: string;
  readonly utr: string;
  readonly bankTxnId: string;
  readonly mode?: 'UPI' | 'IMPS' | 'NEFT' | 'RTGS' | 'OTHER' | undefined;
  readonly sender?:
    | {
        readonly name?: string | undefined;
        readonly accountLast4?: string | undefined;
        readonly ifsc?: string | undefined;
      }
    | undefined;
  readonly creditedAt?: string | undefined;
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const answer = (r: { code: string; message: string }) => ({
  code: r.code,
  message: renderMessage(r.message as never),
});

export class BankCreditsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly ledger: LedgerService;
      /**
       * Called after money reaches a member's wallet, outside the credit's transaction (Q14 M9: the
       * student's pending fee collections are tried at once). A failure never undoes the credit.
       */
      readonly afterCredit?: (institutionId: string, profileId: string) => Promise<unknown>;
      readonly now?: () => Date;
    },
  ) {}

  private async credited(institutionId: string, profileId: string) {
    if (!this.deps.afterCredit) return;
    try {
      await this.deps.afterCredit(institutionId, profileId);
    } catch {
      // The scheduled run tries again; the credit itself is already committed.
    }
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The VAN's wallet, holder and institution (services/vans.ts: the code must be the one the
   * wallet's VAN uses now, and the corporate code given must be that code).
   */
  private async account(db: Db, corporateCode: string, vaNumber: string) {
    const van = await resolveVan(db, vaNumber);
    if (!van || van.code.code !== corporateCode.trim().toUpperCase()) return undefined;
    const w = await db
      .selectFrom('wallets as w')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select([
        'w.id as wallet_id',
        'w.status as wallet_status',
        'm.id as profile_id',
        'm.first_name',
        'm.last_name',
        'm.account_id',
      ])
      .where('w.id', '=', van.walletId)
      .executeTakeFirst();
    if (!w) return undefined;
    return {
      ...w,
      institution_id: van.institutionId,
      corporate_code: van.code.code,
      corporate_code_id: van.code.id,
      va_status: 'ACTIVE' as const,
    };
  }

  private amountOf(text: string) {
    try {
      const p = parseAmount(text);
      return p > 0 ? p : null;
    } catch (e) {
      if (e instanceof MoneyError) return null;
      throw e;
    }
  }

  // --- WAL-012 ------------------------------------------------------------------------------------
  async validate(input: BankCreditInput) {
    const db = this.deps.db;
    const acc = await this.account(db, input.corporateCode, input.vaNumber);
    if (!acc || acc.va_status !== 'ACTIVE') return answer(BANK_RESPONSES.INVALID_VA);
    if (this.amountOf(input.amount) === null) return answer(BANK_RESPONSES.INVALID_AMOUNT);
    const dup = await db
      .selectFrom('bank_credits')
      .select('id')
      .where('utr', '=', input.utr)
      .where('bank_txn_id', '=', input.bankTxnId)
      .executeTakeFirst();
    if (dup) return answer(BANK_RESPONSES.DUPLICATE);
    // A suspended wallet still takes the money: it is held (CR-08). An inactive one is refused.
    if (acc.wallet_status === 'INACTIVE') return answer(BANK_RESPONSES.INVALID_VA);
    return answer(BANK_RESPONSES.OK);
  }

  // --- WAL-013 ------------------------------------------------------------------------------------
  async notify(input: BankCreditInput, clientRowId: string | null) {
    const at = this.now();
    let landed: { institutionId: string; profileId: string } | null = null;
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const seen = await trx
        .selectFrom('bank_credits as c')
        .leftJoin('ledger_transactions as t', (j) => j.onRef('t.id', '=', 'c.ledger_txn_id'))
        .select(['c.response_code', 'c.public_id', 't.reference'])
        .where('c.utr', '=', input.utr)
        .where('c.bank_txn_id', '=', input.bankTxnId)
        .executeTakeFirst();
      if (seen) {
        return {
          code: seen.response_code,
          message: renderMessage(
            seen.response_code === '000'
              ? 'WAL.BANK_OK'
              : seen.response_code === '003'
                ? 'WAL.BANK_INVALID_AMOUNT'
                : 'WAL.BANK_INVALID_VA',
          ),
          creditRef: seen.reference ?? binToUuid(seen.public_id),
          replayed: true,
        };
      }
      const acc = await this.account(trx, input.corporateCode, input.vaNumber);
      const amount = this.amountOf(input.amount);
      const pub = newPublicIdPair();
      const base = {
        public_id: pub.bin,
        va_number: input.vaNumber.trim().toUpperCase(),
        corporate_code_id: acc?.corporate_code_id ?? null,
        utr: input.utr,
        bank_txn_id: input.bankTxnId,
        mode: input.mode ?? 'OTHER',
        sender_name: input.sender?.name?.slice(0, 120) ?? null,
        sender_account_last4: input.sender?.accountLast4?.slice(-4) ?? null,
        sender_ifsc: input.sender?.ifsc?.toUpperCase().slice(0, 11) ?? null,
        credited_at: input.creditedAt ? new Date(input.creditedAt) : at,
        api_client_id: clientRowId,
        received_at: at,
      };
      if (!acc || acc.va_status !== 'ACTIVE' || amount === null) {
        const r =
          !acc || acc.va_status !== 'ACTIVE'
            ? BANK_RESPONSES.INVALID_VA
            : BANK_RESPONSES.INVALID_AMOUNT;
        await trx
          .insertInto('bank_credits')
          .values({
            ...base,
            institution_id: acc ? String(acc.institution_id) : null,
            wallet_id: acc ? String(acc.wallet_id) : null,
            amount_paise: amount ?? 1,
            status: 'FAILED',
            response_code: r.code,
            status_reason:
              r === BANK_RESPONSES.INVALID_VA ? 'Unknown or closed account' : 'Invalid amount',
            resolved_at: at,
          })
          .execute();
        return { ...answer(r), creditRef: pub.id, replayed: false };
      }
      const institutionId = String(acc.institution_id);
      const held = acc.wallet_status !== 'ACTIVE';
      const posted = await this.deps.ledger.post(trx, {
        institutionId,
        type: 'BANK_CREDIT',
        channel: 'BANK_VA',
        amountPaise: amount,
        idempotencyKey: `BANK:${input.utr}:${input.bankTxnId}`,
        debit: { account: 'BANK_POOL', institutionId },
        credit: held
          ? { account: 'HELD_SUSPENSE', institutionId }
          : { walletId: String(acc.wallet_id) },
        narration: held ? `Held: ${input.utr}` : `Bank credit ${input.utr}`,
        at,
      });
      await trx
        .insertInto('bank_credits')
        .values({
          ...base,
          institution_id: institutionId,
          wallet_id: String(acc.wallet_id),
          amount_paise: amount,
          status: held ? 'HELD' : 'PROCESSED',
          response_code: BANK_RESPONSES.OK.code,
          ledger_txn_id: posted.txnId,
          status_reason: held ? `Wallet ${acc.wallet_status.toLowerCase()} (CR-08)` : null,
          resolved_at: held ? null : at,
        })
        .execute();
      await this.tell(trx, {
        institutionId,
        profileId: String(acc.profile_id),
        accountId: acc.account_id ? String(acc.account_id) : null,
        name: titleCase([acc.first_name, acc.last_name].filter(Boolean).join(' ')),
        amountPaise: amount,
        held,
        reference: posted.reference,
        at,
      });
      if (!held) landed = { institutionId, profileId: String(acc.profile_id) };
      return { ...answer(BANK_RESPONSES.OK), creditRef: posted.reference, replayed: false };
    });
    if (landed) {
      const l: { institutionId: string; profileId: string } = landed;
      await this.credited(l.institutionId, l.profileId);
    }
    return out;
  }

  /** The holder and their guardians hear of money added (or held). */
  private async tell(
    trx: Transaction<Database>,
    v: {
      institutionId: string;
      profileId: string;
      accountId: string | null;
      name: string;
      amountPaise: number;
      held: boolean;
      reference: string;
      at: Date;
    },
  ) {
    const amount = formatInr(v.amountPaise);
    if (!v.held) {
      await emit(trx, {
        institutionId: v.institutionId,
        type: 'wallet.credited',
        rooms: [rooms.profile(v.profileId)],
        data: { reference: v.reference },
      });
    }
    const base = {
      institutionId: v.institutionId,
      surface: 'MEMBER' as const,
      category: 'PAYMENT' as const,
      body: v.reference,
      link: `/transactions/${v.reference}`,
    };
    const guardians = (
      await trx
        .selectFrom('guardianships as g')
        .innerJoin('member_profiles as m', 'm.id', 'g.guardian_profile_id')
        .select('m.account_id')
        .where('g.ward_profile_id', '=', v.profileId)
        .where('m.account_id', 'is not', null)
        .execute()
    )
      .map((g) => g.account_id)
      .filter((a): a is string => a !== null && a !== v.accountId);
    if (v.held) {
      const to = [...(v.accountId ? [v.accountId] : []), ...guardians];
      if (to.length) {
        await notify(
          trx,
          {
            ...base,
            accountIds: to,
            titleKey: 'NTF.CREDIT_HELD',
            params: { amount, name: v.name },
          },
          v.at,
        );
      }
      return;
    }
    if (v.accountId) {
      await notify(
        trx,
        { ...base, accountIds: [v.accountId], titleKey: 'NTF.MONEY_ADDED', params: { amount } },
        v.at,
      );
    }
    if (guardians.length) {
      await notify(
        trx,
        {
          ...base,
          accountIds: guardians,
          titleKey: 'NTF.WARD_MONEY_ADDED',
          params: { amount, name: v.name },
        },
        v.at,
      );
    }
  }

  // --- WAL-010 ------------------------------------------------------------------------------------
  async held(
    p: Principal,
    f: { status?: 'HELD' | 'PROCESSED' | 'RETURNED' | undefined; cursor?: string | undefined },
  ) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await this.deps.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!inst) throw new NotFoundError();
    let q = this.deps.db
      .selectFrom('bank_credits as c')
      .innerJoin('wallets as w', 'w.id', 'c.wallet_id')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select([
        'c.id',
        'c.public_id',
        'c.amount_paise',
        'c.va_number',
        'c.utr',
        'c.mode',
        'c.sender_name',
        'c.credited_at',
        'c.status',
        'c.status_reason',
        'c.resolved_at',
        'w.wallet_no',
        'w.status as wallet_status',
        'm.public_id as member_id',
        'm.first_name',
        'm.last_name',
      ])
      .where('c.institution_id', '=', String(inst.id))
      // Credits that were held at some point: still held, released later, or returned.
      .where((eb) =>
        eb.or([
          eb('c.status', 'in', ['HELD', 'RETURNED']),
          eb.and([eb('c.status', '=', 'PROCESSED'), eb('c.release_txn_id', 'is not', null)]),
        ]),
      );
    if (f.status) q = q.where('c.status', '=', f.status);
    const after = f.cursor ? idCursor.decode(f.cursor) : null;
    if (after) q = q.where('c.id', '<', after);
    const rows = await q.orderBy('c.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((r) => ({
        id: binToUuid(r.public_id),
        amount: toMoneyDto(Number(r.amount_paise)),
        member: {
          id: binToUuid(r.member_id),
          name: titleCase([r.first_name, r.last_name].filter(Boolean).join(' ')),
        },
        wallet: { number: `•••• ${r.wallet_no.slice(-4)}`, status: r.wallet_status },
        vaNumber: r.va_number,
        utr: r.utr,
        mode: r.mode,
        sender: r.sender_name,
        creditedAt: iso(r.credited_at)!,
        status: r.status,
        reason: r.status_reason,
        resolvedAt: iso(r.resolved_at),
      })),
      nextCursor: rows.length > 50 ? idCursor.encode(String(page[page.length - 1]!.id)) : null,
    };
  }

  // --- WAL-011 ------------------------------------------------------------------------------------
  /** An operator asks to return a held credit to the remitter; another operator approves (RC-07). */
  async requestReturn(
    p: Principal,
    holdId: string,
    input: { reason: string; instructionRef: string },
  ) {
    if (!isUuid(holdId) || !isUuid(p.subject)) throw new NotFoundError();
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const c = await trx
        .selectFrom('bank_credits as c')
        .leftJoin('institutions as i', 'i.id', 'c.institution_id')
        .select(['c.id', 'c.public_id', 'c.status', 'c.amount_paise', 'c.utr', 'i.name'])
        .where('c.public_id', '=', uuidToBin(holdId))
        .forUpdate()
        .executeTakeFirst();
      if (!c) throw new NotFoundError();
      if (c.status !== 'HELD') throw new CustomAPIError(409, 'WAL.HOLD_NOT_OPEN');
      const open = await trx
        .selectFrom('approval_requests')
        .select('id')
        .where('module', '=', 'BANK_CREDIT_RETURN')
        .where('subject_ref', '=', c.public_id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (open) throw new CustomAPIError(409, 'MKR.ALREADY_DECIDED');
      const raised = await raiseApproval(trx, {
        institutionId: null,
        module: 'BANK_CREDIT_RETURN',
        summary: `Return ${formatInr(Number(c.amount_paise))} (UTR ${c.utr}) to the remitter${c.name ? ` — ${c.name}` : ''}: ${input.reason}`,
        payload: {
          credit: binToUuid(c.public_id),
          reason: input.reason,
          instructionRef: input.instructionRef,
        },
        makerType: 'operator',
        makerRef: uuidToBin(p.subject),
        subjectType: 'bank_credit',
        subjectRef: c.public_id,
        at,
      });
      return { approvalId: raised.id, no: raised.no };
    });
  }

  /** The approved return (called by the approvals service in the deciding transaction). */
  async applyReturn(trx: Transaction<Database>, payload: Record<string, unknown>, at: Date) {
    const id = String(payload['credit'] ?? '');
    if (!isUuid(id)) throw new NotFoundError();
    const c = await trx
      .selectFrom('bank_credits')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .forUpdate()
      .executeTakeFirst();
    if (!c || !c.institution_id) throw new NotFoundError();
    if (c.status !== 'HELD') throw new CustomAPIError(409, 'WAL.HOLD_NOT_OPEN');
    const posted = await this.deps.ledger.post(trx, {
      institutionId: String(c.institution_id),
      type: 'REFUND',
      channel: 'BACK_OFFICE',
      amountPaise: Number(c.amount_paise),
      idempotencyKey: `HOLD-RETURN:${c.id}`,
      debit: { account: 'HELD_SUSPENSE', institutionId: String(c.institution_id) },
      credit: { account: 'BANK_POOL', institutionId: String(c.institution_id) },
      narration: `Returned to remitter: ${c.utr}`,
      at,
    });
    await trx
      .updateTable('bank_credits')
      .set({
        status: 'RETURNED',
        release_txn_id: posted.txnId,
        return_instruction: String(payload['instructionRef'] ?? '').slice(0, 60) || null,
        status_reason: String(payload['reason'] ?? '').slice(0, 300) || null,
        resolved_at: at,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', c.id)
      .execute();
    await recordAudit(trx, {
      institutionId: String(c.institution_id),
      action: 'BANK_CREDIT_RETURNED',
      entityType: 'bank_credit',
      entityRef: id,
      after: { reference: posted.reference, instruction: payload['instructionRef'] },
    });
  }

  // --- Job: release held credits once the wallet is active again (RC-12 HELD → PROCESSED) -----------
  async releaseHeld(ctx: Pick<JobContext, 'item'>) {
    const due = await this.deps.db
      .selectFrom('bank_credits as c')
      .innerJoin('wallets as w', 'w.id', 'c.wallet_id')
      .select(['c.id', 'c.institution_id'])
      .where('c.status', '=', 'HELD')
      .where('w.status', '=', 'ACTIVE')
      .orderBy('c.id')
      .execute();
    const byInstitution = new Map<string, { done: number; failed: number }>();
    for (const d of due) {
      const k = String(d.institution_id);
      const tally = byInstitution.get(k) ?? { done: 0, failed: 0 };
      try {
        const releasedTo = await this.deps.db.transaction().execute(async (trx) => {
          const c = await trx
            .selectFrom('bank_credits as c')
            .innerJoin('wallets as w', 'w.id', 'c.wallet_id')
            .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
            .select([
              'c.id',
              'c.status',
              'c.amount_paise',
              'c.utr',
              'c.wallet_id',
              'c.institution_id',
              'w.status as wallet_status',
              'm.id as profile_id',
              'm.account_id',
              'm.first_name',
              'm.last_name',
            ])
            .where('c.id', '=', d.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (c.status !== 'HELD' || c.wallet_status !== 'ACTIVE') return null;
          const at = this.now();
          const posted = await this.deps.ledger.post(trx, {
            institutionId: String(c.institution_id),
            type: 'HOLD_RELEASE',
            channel: 'JOB',
            amountPaise: Number(c.amount_paise),
            idempotencyKey: `HOLD-RELEASE:${c.id}`,
            debit: { account: 'HELD_SUSPENSE', institutionId: String(c.institution_id) },
            credit: { walletId: String(c.wallet_id) },
            narration: `Released: ${c.utr}`,
            at,
          });
          await trx
            .updateTable('bank_credits')
            .set({
              status: 'PROCESSED',
              release_txn_id: posted.txnId,
              resolved_at: at,
              row_version: sql<number>`row_version + 1`,
            })
            .where('id', '=', c.id)
            .execute();
          await this.tell(trx, {
            institutionId: String(c.institution_id),
            profileId: String(c.profile_id),
            accountId: c.account_id ? String(c.account_id) : null,
            name: titleCase([c.first_name, c.last_name].filter(Boolean).join(' ')),
            amountPaise: Number(c.amount_paise),
            held: false,
            reference: posted.reference,
            at,
          });
          return String(c.profile_id);
        });
        if (releasedTo) await this.credited(k, releasedTo);
        tally.done += 1;
      } catch {
        tally.failed += 1;
      }
      byInstitution.set(k, tally);
    }
    for (const [institutionId, t] of byInstitution) {
      ctx.item({
        institutionId,
        status: t.failed ? 'FAILED' : 'SUCCESS',
        processed: t.done,
        failed: t.failed,
        note: `${t.done} held credit${t.done === 1 ? '' : 's'} released`,
      });
    }
    return { released: [...byInstitution.values()].reduce((a, t) => a + t.done, 0) };
  }
}

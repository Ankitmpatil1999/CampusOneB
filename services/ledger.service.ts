/**
 * The ledger (docs/03 §8, docs/04 §3.3, §9.1; ADR-0004; RNG-GOV-015…017): the only code that changes
 * a wallet balance.
 *
 * - `post` writes one transaction with a balanced pair of entries (debit = credit) and moves the
 *   balances in the same database transaction — the caller's.
 * - Idempotent: a key already posted for the institution returns the first posting unchanged
 *   (`replayed`), whatever the amount in the retry.
 * - The wallet rows are locked `FOR UPDATE` in ascending wallet id, then the debit is checked
 *   against the locked balance; the guarded update refuses an overdraw a second time.
 * - Append-only: corrections are new transactions (`REVERSAL` with `reversalOf`), never updates.
 * - Wallet status and every business rule are the caller's (the payment engine, the bank credit
 *   path); the ledger only keeps the books right.
 */
import { sql, type Transaction } from 'kysely';
import { newReference, type PaymentChannelCode } from '../config/registers';
import type { Database, LedgerAccountKind, LedgerTxnType } from '../models/campusone_models';
import { getContext } from '../utils/request-context';
import { CustomAPIError } from '../utils/CustomAPIError';
import { istBusinessDate, formatInr } from '../utils/format';
import { NIL_UUID_BIN, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';

/** One side of a posting: a wallet, or one of the institution's own accounts. */
export type PostingSide =
  | { readonly walletId: string }
  | { readonly account: LedgerAccountKind; readonly institutionId: string | null };

export interface PostInput {
  readonly institutionId: string | null;
  readonly type: LedgerTxnType;
  readonly channel: PaymentChannelCode;
  readonly amountPaise: number;
  readonly idempotencyKey: string;
  readonly debit: PostingSide;
  readonly credit: PostingSide;
  readonly narration: string;
  readonly businessRef?: { readonly type: string; readonly id: string } | undefined;
  readonly reversalOf?: string | undefined;
  readonly actorRef?: Buffer | null | undefined;
  readonly at?: Date | undefined;
  /** The caller's reference (the payment record's), so the receipt and the ledger share one. */
  readonly reference?: string | undefined;
}

export interface Posted {
  readonly txnId: string;
  readonly publicId: string;
  readonly reference: string;
  readonly postedOn: string;
  readonly postedAt: Date;
  readonly replayed: boolean;
  /** Balances after the posting, by wallet id (only wallets on either side). */
  readonly balances: Readonly<Record<string, number>>;
}

const isWallet = (s: PostingSide): s is { walletId: string } => 'walletId' in s;
const day = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

export class LedgerService {
  constructor(private readonly deps: { readonly now?: () => Date } = {}) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** The ledger account of a side (created the first time an institution account is used). */
  private async accountOf(trx: Transaction<Database>, side: PostingSide) {
    if (isWallet(side)) {
      const a = await trx
        .selectFrom('ledger_accounts')
        .select('id')
        .where('wallet_id', '=', side.walletId)
        .executeTakeFirst();
      if (a) return String(a.id);
      const w = await trx
        .selectFrom('wallets')
        .select(['institution_id', 'wallet_no'])
        .where('id', '=', side.walletId)
        .executeTakeFirst();
      if (!w) throw new CustomAPIError(404, 'PAY.PARTY_UNKNOWN');
      const r = await trx
        .insertInto('ledger_accounts')
        .values({
          institution_id: w.institution_id,
          kind: 'WALLET',
          wallet_id: side.walletId,
          name: `Wallet ${w.wallet_no}`,
        })
        .executeTakeFirstOrThrow();
      return String(r.insertId);
    }
    const own = side as { account: LedgerAccountKind; institutionId: string | null };
    const find = () => {
      let q = trx
        .selectFrom('ledger_accounts')
        .select('id')
        .where('kind', '=', own.account)
        .where('wallet_id', 'is', null);
      q =
        own.institutionId === null
          ? q.where('institution_id', 'is', null)
          : q.where('institution_id', '=', own.institutionId);
      return q.executeTakeFirst();
    };
    const found = await find();
    if (found) return String(found.id);
    await trx
      .insertInto('ledger_accounts')
      .ignore()
      .values({
        institution_id: own.institutionId,
        kind: own.account,
        wallet_id: null,
        name: own.account.replace(/_/g, ' ').toLowerCase(),
      })
      .execute();
    return String((await find())!.id);
  }

  async post(trx: Transaction<Database>, input: PostInput): Promise<Posted> {
    const amount = input.amountPaise;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new CustomAPIError(422, 'PAY.AMOUNT_INVALID');
    }
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 100) throw new CustomAPIError(422, 'VALIDATION.FORMAT');
    const scope = input.institutionId ?? '0';

    // A key already posted returns the first posting (exactly once).
    const seen = await trx
      .selectFrom('ledger_idempotency as i')
      .innerJoin('ledger_transactions as t', (j) =>
        j.onRef('t.id', '=', 'i.ledger_txn_id').onRef('t.posted_on', '=', 'i.posted_on'),
      )
      .select(['t.id', 't.public_id', 't.reference', 't.posted_on', 't.posted_at'])
      .where('i.institution_id', '=', scope)
      .where('i.idempotency_key', '=', key)
      .executeTakeFirst();
    if (seen) {
      return {
        txnId: String(seen.id),
        publicId: binHex(seen.public_id),
        reference: seen.reference,
        postedOn: day(seen.posted_on),
        postedAt: new Date(seen.posted_at),
        replayed: true,
        balances: {},
      };
    }

    const debitWallet = isWallet(input.debit) ? input.debit.walletId : null;
    const creditWallet = isWallet(input.credit) ? input.credit.walletId : null;
    if (debitWallet !== null && debitWallet === creditWallet) {
      throw new CustomAPIError(409, 'PAY.SELF_PAYMENT');
    }
    const [debitAccount, creditAccount] = [
      await this.accountOf(trx, input.debit),
      await this.accountOf(trx, input.credit),
    ];
    if (debitAccount === creditAccount) throw new CustomAPIError(409, 'PAY.SELF_PAYMENT');

    // Row locks in ascending wallet id (no deadlock between two opposite payments).
    const wallets = [debitWallet, creditWallet]
      .filter((w): w is string => w !== null)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const locked = new Map<string, number>();
    for (const w of wallets) {
      const row = await trx
        .selectFrom('wallet_balances')
        .select(['available_paise'])
        .where('wallet_id', '=', w)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new CustomAPIError(404, 'PAY.PARTY_UNKNOWN');
      locked.set(w, Number(row.available_paise));
    }
    if (debitWallet !== null) {
      const balance = locked.get(debitWallet)!;
      if (balance < amount) {
        throw new CustomAPIError(409, 'PAY.INSUFFICIENT_BALANCE', {
          params: {
            balance: formatInr(balance),
            shortfall: formatInr(amount - balance),
          },
        });
      }
    }

    const at = input.at ?? this.now();
    const postedOn = istBusinessDate(at);
    const pub = newPublicIdPair();
    const reference = input.reference ?? newReference(input.type, at);
    const ctx = getContext();
    const correlation =
      ctx?.correlationId && isUuid(ctx.correlationId) ? uuidToBin(ctx.correlationId) : NIL_UUID_BIN;
    const txn = await trx
      .insertInto('ledger_transactions')
      .values({
        posted_on: postedOn,
        public_id: pub.bin,
        institution_id: input.institutionId,
        reference,
        type: input.type,
        channel: input.channel,
        amount_paise: amount,
        idempotency_key: key,
        business_ref_type: input.businessRef?.type ?? null,
        business_ref_id: input.businessRef?.id ?? null,
        reversal_of_txn_id: input.reversalOf ?? null,
        narration: input.narration.slice(0, 140),
        posted_at: at,
        actor_ref: input.actorRef ?? null,
        correlation_id: correlation,
      })
      .executeTakeFirstOrThrow();
    const txnId = String(txn.insertId);

    const balances: Record<string, number> = {};
    if (debitWallet !== null) {
      const r = await trx
        .updateTable('wallet_balances')
        .set({
          available_paise: sql<string>`available_paise - ${amount}`,
          row_version: sql<number>`row_version + 1`,
          last_ledger_txn_id: txnId,
          updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        })
        .where('wallet_id', '=', debitWallet)
        .where('available_paise', '>=', String(amount))
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) {
        throw new CustomAPIError(409, 'PAY.INSUFFICIENT_BALANCE', {
          params: { balance: formatInr(0), shortfall: formatInr(amount) },
        });
      }
      balances[debitWallet] = locked.get(debitWallet)! - amount;
    }
    if (creditWallet !== null) {
      await trx
        .updateTable('wallet_balances')
        .set({
          available_paise: sql<string>`available_paise + ${amount}`,
          row_version: sql<number>`row_version + 1`,
          last_ledger_txn_id: txnId,
          updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        })
        .where('wallet_id', '=', creditWallet)
        .execute();
      balances[creditWallet] = locked.get(creditWallet)! + amount;
    }

    await trx
      .insertInto('ledger_entries')
      .values([
        {
          posted_on: postedOn,
          institution_id: input.institutionId,
          ledger_txn_id: txnId,
          account_id: debitAccount,
          wallet_id: debitWallet,
          direction: 'D',
          amount_paise: amount,
          balance_after_paise: debitWallet !== null ? balances[debitWallet]! : null,
          narration: input.narration.slice(0, 140),
        },
        {
          posted_on: postedOn,
          institution_id: input.institutionId,
          ledger_txn_id: txnId,
          account_id: creditAccount,
          wallet_id: creditWallet,
          direction: 'C',
          amount_paise: amount,
          balance_after_paise: creditWallet !== null ? balances[creditWallet]! : null,
          narration: input.narration.slice(0, 140),
        },
      ])
      .execute();
    await trx
      .insertInto('ledger_idempotency')
      .values({
        institution_id: scope,
        idempotency_key: key,
        ledger_txn_id: txnId,
        posted_on: postedOn,
      })
      .execute();
    return {
      txnId,
      publicId: pub.id,
      reference,
      postedOn,
      postedAt: at,
      replayed: false,
      balances,
    };
  }
}

const binHex = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

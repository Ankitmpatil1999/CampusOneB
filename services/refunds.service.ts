/**
 * Refunds and chargebacks (SRS 15.6 Operations H–K; REC-005…009, REC-018/019; RC-19; OI-REC-06;
 * Q14 M3, M16; docs/03 §10.2).
 *
 * - Money moves only through the ledger, as a new pair that references the original movement
 *   (`reversalOf`); the original is never changed (RNG-GOV-014).
 * - Refund: requested for a movement between two wallets (an officer, a mismatch resolution or a
 *   grievance), then processed or rejected by another officer (maker ≠ checker). Processing posts
 *   Dr the wallet that was credited, Cr the wallet that paid, and tells the payer (only then).
 * - Chargeback: raised once per movement, accepted or disputed, then completed — reversed (Dr the
 *   wallet that was credited, Cr the chargeback clearing account) or upheld (nothing moves).
 * - A refund or chargeback taken from a merchant's wallet is an adjustment in its next settlement
 *   (Q14 M3), so the payout never pays out money that went back.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS } from '../config/registers';
import type {
  ChargebackOutcome,
  ChargebackStatus,
  Database,
  RefundSource,
  RefundStatus,
} from '../models/campusone_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { formatInr } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import type { LedgerService } from './ledger.service';
import { notify } from './notifications.service';
import { defaultValues, type SettingValues } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

/** Movements between two wallets that can be refunded. */
const REFUNDABLE = ['PAYMENT', 'TUITION', 'EVENT', 'TRANSFER', 'ALLOWANCE_PAYMENT'] as const;
/** Movements that credited a wallet and can be charged back (a bank credit, or a payment). */
const CHARGEABLE = ['BANK_CREDIT', ...REFUNDABLE] as const;
const REASON_CODE = /^[A-Za-z0-9-]{1,20}$/;
const REMARKS_MAX = 500;
const REFUND_LABEL: Record<RefundStatus, string> = {
  REQUESTED: 'requested',
  PROCESSED: 'processed',
  REJECTED: 'rejected',
};
const CHARGEBACK_LABEL: Record<ChargebackStatus, string> = {
  RAISED: 'Raised',
  ACCEPTED: 'Accepted',
  DISPUTED: 'Disputed',
  COMPLETED: 'Completed',
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** The movement a refund or chargeback is for, with the wallets on both sides. */
interface Movement {
  readonly id: string;
  readonly institutionId: string;
  readonly reference: string;
  readonly type: string;
  readonly amount: number;
  readonly debitWallet: string | null;
  readonly creditWallet: string | null;
}

export class RefundsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly ledger: LedgerService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    return uuidToBin(p.subject);
  }

  /** Remarks of the configured minimum (example 3) to 500 characters (OI-REC-06). */
  async remarks(value: string | undefined, field = 'remarks') {
    const v = await (this.deps.settings?.values() ?? Promise.resolve(defaultValues()));
    const min = Number(v[LIMITS.reconRemarksMin.key] ?? LIMITS.reconRemarksMin.value);
    const text = (value ?? '').trim();
    if (text.length < min || text.length > REMARKS_MAX) {
      throw new ValidationError([{ field, code: 'REC.REMARKS' }]);
    }
    return text;
  }

  /** The movement by its reference, with the wallet debited and the wallet credited. */
  async movement(db: Db, reference: string | undefined): Promise<Movement> {
    const ref = (reference ?? '').trim().toUpperCase();
    if (!ref)
      throw new ValidationError([{ field: 'transactionRef', code: 'REC.REFERENCE_REQUIRED' }]);
    const t = await db
      .selectFrom('ledger_transactions as t')
      .select(['t.id', 't.institution_id', 't.reference', 't.type', 't.amount_paise'])
      .where('t.reference', '=', ref)
      .executeTakeFirst();
    if (!t || t.institution_id === null) throw new CustomAPIError(404, 'REC.TXN_UNKNOWN');
    const entries = await db
      .selectFrom('ledger_entries')
      .select(['direction', 'wallet_id'])
      .where('ledger_txn_id', '=', t.id)
      .execute();
    return {
      id: String(t.id),
      institutionId: String(t.institution_id),
      reference: t.reference,
      type: t.type,
      amount: Number(t.amount_paise),
      debitWallet: entries.find((e) => e.direction === 'D')?.wallet_id ?? null,
      creditWallet: entries.find((e) => e.direction === 'C')?.wallet_id ?? null,
    };
  }

  /** Has the movement's money gone back already (a reversal, or a chargeback that may reverse it)? */
  private async returned(db: Db, m: Movement, except?: { chargebackId?: string }) {
    const reversal = await db
      .selectFrom('ledger_transactions')
      .select('id')
      .where('institution_id', '=', m.institutionId)
      .where('reversal_of_txn_id', '=', m.id)
      .where('type', '=', 'REVERSAL')
      .executeTakeFirst();
    if (reversal) return true;
    let q = db
      .selectFrom('chargebacks')
      .select('id')
      .where('ledger_txn_id', '=', m.id)
      .where((eb) => eb.or([eb('outcome', 'is', null), eb('outcome', '=', 'REVERSED')]));
    if (except?.chargebackId) q = q.where('id', '<>', except.chargebackId);
    return !!(await q.executeTakeFirst());
  }

  private amountOf(m: Movement, amountPaise: number | undefined) {
    const amount = amountPaise ?? m.amount;
    if (amount > m.amount) {
      throw new CustomAPIError(422, 'REC.AMOUNT_ABOVE', {
        params: { amount: formatInr(m.amount) },
      });
    }
    return amount;
  }

  // --- refunds -------------------------------------------------------------------------------------------

  /**
   * A refund request (REC-018, a mismatch resolution, a grievance): one live refund per movement, for
   * at most its amount, between the two wallets of a payment or transfer.
   */
  async createRefund(
    trx: Transaction<Database>,
    input: {
      transactionRef: string | undefined;
      amountPaise?: number | undefined;
      reason: string;
      source: RefundSource;
      requestedBy: Buffer | null;
    },
  ) {
    const m = await this.movement(trx, input.transactionRef);
    if (!(REFUNDABLE as readonly string[]).includes(m.type) || !m.debitWallet || !m.creditWallet) {
      throw new CustomAPIError(409, 'REC.NOT_REFUNDABLE');
    }
    const amount = this.amountOf(m, input.amountPaise);
    const live = await trx
      .selectFrom('refunds')
      .select('status')
      .where('ledger_txn_id', '=', m.id)
      .where('status', '<>', 'REJECTED')
      .executeTakeFirst();
    if (live) {
      throw new CustomAPIError(409, 'REC.REFUND_EXISTS', {
        params: { status: REFUND_LABEL[live.status] },
      });
    }
    if (await this.returned(trx, m)) throw new CustomAPIError(409, 'REC.ALREADY_RETURNED');
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      const ins = await trx
        .insertInto('refunds')
        .values({
          public_id: pub.bin,
          institution_id: m.institutionId,
          ledger_txn_id: m.id,
          original_reference: m.reference,
          from_wallet_id: m.creditWallet,
          to_wallet_id: m.debitWallet,
          amount_paise: amount,
          source: input.source,
          reason: input.reason,
          requested_by: input.requestedBy,
          requested_at: at,
        })
        .executeTakeFirstOrThrow();
      await recordAudit(trx, {
        institutionId: m.institutionId,
        action: 'REFUND_REQUESTED',
        entityType: 'refund',
        entityRef: pub.id,
        after: { reference: m.reference, amount: formatInr(amount), source: input.source },
      });
      return { rowId: String(ins.insertId), id: pub.id };
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'REC.REFUND_EXISTS', { params: { status: 'requested' } });
      }
      throw e;
    }
  }

  async requestRefund(
    p: Principal,
    input: { transactionRef: string; amountPaise?: number | undefined; reason: string },
  ) {
    const reason = await this.remarks(input.reason, 'reason');
    const by = this.by(p);
    const out = await this.deps.db
      .transaction()
      .execute((trx) =>
        this.createRefund(trx, { ...input, reason, source: 'MANUAL', requestedBy: by }),
      );
    return this.refund(out.id);
  }

  /** Process (the ledger pair, the payer told) or reject — never by the requester (REC-009). */
  async decideRefund(
    p: Principal,
    id: string,
    expected: number,
    input: { decision: 'PROCESS' | 'REJECT'; remarks: string },
  ) {
    const remarks = await this.remarks(input.remarks);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      if (!isUuid(id)) throw new CustomAPIError(404, 'REC.REFUND_NOT_FOUND');
      const r = await trx
        .selectFrom('refunds')
        .select(['id', 'row_version'])
        .where('public_id', '=', uuidToBin(id))
        .executeTakeFirst();
      if (!r) throw new CustomAPIError(404, 'REC.REFUND_NOT_FOUND');
      await this.decide(trx, String(r.id), by, remarks, this.now(), {
        decision: input.decision,
        expected,
      });
    });
    return this.refund(id);
  }

  /**
   * Processes a requested refund inside the caller's transaction — a grievance's approved Priority-1
   * resolution (Q14 M16): the checker who approved it is the processor.
   */
  async process(trx: Transaction<Database>, rowId: string, by: Buffer, remarks: string, at: Date) {
    return this.decide(trx, rowId, by, remarks.slice(0, 500), at, { decision: 'PROCESS' });
  }

  /** Process (the ledger pair; the payer told) or reject — never by the requester (maker ≠ checker). */
  private async decide(
    trx: Transaction<Database>,
    rowId: string,
    by: Buffer,
    remarks: string,
    at: Date,
    o: { decision: 'PROCESS' | 'REJECT'; expected?: number },
  ) {
    const r = await trx
      .selectFrom('refunds')
      .selectAll()
      .where('id', '=', rowId)
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'REC.REFUND_NOT_FOUND');
    if (r.status !== 'REQUESTED') {
      throw new CustomAPIError(409, 'REC.TRANSITION_INVALID', {
        params: { status: REFUND_LABEL[r.status] },
      });
    }
    if (o.expected !== undefined && r.row_version !== o.expected) {
      throw new PreconditionFailedError();
    }
    if (r.requested_by && Buffer.from(r.requested_by).equals(by)) {
      throw new CustomAPIError(409, 'REC.SAME_OFFICER');
    }
    const institutionId = String(r.institution_id);
    let reference: string | null = null;
    if (o.decision === 'PROCESS') {
      const m: Movement = {
        id: String(r.ledger_txn_id),
        institutionId,
        reference: r.original_reference,
        type: '',
        amount: Number(r.amount_paise),
        debitWallet: String(r.to_wallet_id),
        creditWallet: String(r.from_wallet_id),
      };
      if (await this.returned(trx, m)) throw new CustomAPIError(409, 'REC.ALREADY_RETURNED');
      const to = await trx
        .selectFrom('wallets')
        .select(['status', 'owner_profile_id'])
        .where('id', '=', r.to_wallet_id)
        .executeTakeFirstOrThrow();
      if (to.status === 'INACTIVE') throw new CustomAPIError(409, 'REC.WALLET_CLOSED');
      try {
        const out = await this.deps.ledger.post(trx, {
          institutionId,
          type: 'REFUND',
          channel: 'BACK_OFFICE',
          amountPaise: Number(r.amount_paise),
          idempotencyKey: `REFUND:${r.id}`,
          debit: { walletId: String(r.from_wallet_id) },
          credit: { walletId: String(r.to_wallet_id) },
          narration: `Refund of ${r.original_reference}`,
          businessRef: { type: 'refund', id: String(r.id) },
          reversalOf: String(r.ledger_txn_id),
          actorRef: by,
          at,
        });
        reference = out.reference;
      } catch (e) {
        if (e instanceof CustomAPIError && e.code === 'PAY.INSUFFICIENT_BALANCE') {
          throw new CustomAPIError(409, 'REC.REFUND_BALANCE', {
            params: {
              name: await this.ownerName(trx, String(r.from_wallet_id)),
              amount: formatInr(Number(r.amount_paise)),
            },
          });
        }
        throw e;
      }
      if (to.owner_profile_id) {
        await this.tell(trx, institutionId, String(to.owner_profile_id), {
          reference: r.original_reference,
          amount: formatInr(Number(r.amount_paise)),
          link: `/transactions/${reference}`,
          at,
        });
      }
    }
    await trx
      .updateTable('refunds')
      .set({
        status: o.decision === 'PROCESS' ? 'PROCESSED' : 'REJECTED',
        decided_by: by,
        decided_at: at,
        decision_remarks: remarks,
        refund_reference: reference,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', r.id)
      .where('status', '=', 'REQUESTED')
      .execute();
    await recordAudit(trx, {
      institutionId,
      action: o.decision === 'PROCESS' ? 'REFUND_PROCESSED' : 'REFUND_REJECTED',
      entityType: 'refund',
      entityRef: binToUuid(r.public_id),
      after: { remarks, reference },
    });
    return reference;
  }

  /** The payer (and a ward's guardians) are told only when the refund is processed (OI-REC-06). */
  private async tell(
    trx: Transaction<Database>,
    institutionId: string,
    profileId: string,
    v: { reference: string; amount: string; link: string; at: Date },
  ) {
    const owner = await trx
      .selectFrom('member_profiles')
      .select('account_id')
      .where('id', '=', profileId)
      .executeTakeFirst();
    const guardians = await trx
      .selectFrom('guardianships as g')
      .innerJoin('member_profiles as m', 'm.id', 'g.guardian_profile_id')
      .select('m.account_id')
      .where('g.ward_profile_id', '=', profileId)
      .where('m.account_id', 'is not', null)
      .execute();
    const accounts = [owner?.account_id, ...guardians.map((g) => g.account_id)].filter(
      (a): a is string => !!a,
    );
    if (!accounts.length) return;
    await notify(
      trx,
      {
        institutionId,
        accountIds: accounts.map(String),
        surface: 'MEMBER',
        category: 'PAYMENT',
        titleKey: 'NTF.REFUND_PROCESSED',
        params: { reference: v.reference, amount: v.amount },
        body: v.reference,
        link: v.link,
      },
      v.at,
    );
  }

  private async ownerName(db: Db, walletId: string) {
    const w = await db
      .selectFrom('wallets as w')
      .leftJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .leftJoin('merchants as mer', 'mer.profile_id', 'w.owner_profile_id')
      .select(['w.wallet_no', 'm.first_name', 'm.last_name', 'mer.display_name'])
      .where('w.id', '=', walletId)
      .executeTakeFirst();
    return w?.display_name ?? (nameOf(w?.first_name, w?.last_name) || (w?.wallet_no ?? ''));
  }

  private refundRows(db: Db) {
    return db
      .selectFrom('refunds as r')
      .innerJoin('institutions as i', 'i.id', 'r.institution_id')
      .innerJoin('wallets as wf', 'wf.id', 'r.from_wallet_id')
      .innerJoin('wallets as wt', 'wt.id', 'r.to_wallet_id')
      .leftJoin('member_profiles as mf', 'mf.id', 'wf.owner_profile_id')
      .leftJoin('merchants as merf', 'merf.profile_id', 'wf.owner_profile_id')
      .leftJoin('member_profiles as mt', 'mt.id', 'wt.owner_profile_id')
      .leftJoin('platform_accounts as a1', 'a1.public_id', 'r.requested_by')
      .leftJoin('platform_accounts as a2', 'a2.public_id', 'r.decided_by')
      .selectAll('r')
      .select([
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'wf.wallet_no as from_wallet_no',
        'wt.wallet_no as to_wallet_no',
        'mf.first_name as f_first',
        'mf.last_name as f_last',
        'merf.display_name as f_merchant',
        'mt.first_name as t_first',
        'mt.last_name as t_last',
        'a1.first_name as q_first',
        'a1.last_name as q_last',
        'a2.first_name as d_first',
        'a2.last_name as d_last',
      ]);
  }

  private refundView(
    r: Awaited<ReturnType<ReturnType<RefundsService['refundRows']>['execute']>>[number],
  ) {
    return {
      id: binToUuid(r.public_id),
      institution: { id: binToUuid(r.institution_public_id), name: r.institution_name },
      originalReference: r.original_reference,
      from: { walletNo: r.from_wallet_no, name: r.f_merchant ?? nameOf(r.f_first, r.f_last) },
      to: { walletNo: r.to_wallet_no, name: nameOf(r.t_first, r.t_last) },
      amount: toMoneyDto(Number(r.amount_paise)),
      status: r.status,
      source: r.source,
      reason: r.reason,
      requested: { by: nameOf(r.q_first, r.q_last) || null, at: iso(r.requested_at) },
      decided: r.decided_at
        ? { by: nameOf(r.d_first, r.d_last), at: iso(r.decided_at), remarks: r.decision_remarks }
        : null,
      refundReference: r.refund_reference,
      version: r.row_version,
    };
  }

  async refund(id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'REC.REFUND_NOT_FOUND');
    const r = await this.refundRows(this.deps.db)
      .where('r.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'REC.REFUND_NOT_FOUND');
    return this.refundView(r);
  }

  async refunds(f: { status?: RefundStatus | undefined; cursor?: string | undefined }) {
    let q = this.refundRows(this.deps.db);
    if (f.status) q = q.where('r.status', '=', f.status);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('r.id', '<', f.cursor);
    const rows = await q.orderBy('r.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((r) => this.refundView(r)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  // --- chargebacks ---------------------------------------------------------------------------------------

  /** Raise a chargeback against a movement that credited a wallet — once per movement (REC-006). */
  async createChargeback(
    trx: Transaction<Database>,
    input: {
      transactionRef: string | undefined;
      reasonCode: string | undefined;
      amountPaise?: number | undefined;
      remarks?: string | null | undefined;
      raisedBy: Buffer | null;
    },
  ) {
    const code = (input.reasonCode ?? '').trim().toUpperCase();
    if (!REASON_CODE.test(code)) {
      throw new ValidationError([{ field: 'reasonCode', code: 'REC.REASON_CODE' }]);
    }
    const m = await this.movement(trx, input.transactionRef);
    if (!(CHARGEABLE as readonly string[]).includes(m.type) || !m.creditWallet) {
      throw new CustomAPIError(409, 'REC.NOT_REFUNDABLE');
    }
    const amount = this.amountOf(m, input.amountPaise);
    const existing = await trx
      .selectFrom('chargebacks')
      .select('id')
      .where('ledger_txn_id', '=', m.id)
      .executeTakeFirst();
    if (existing) throw new CustomAPIError(409, 'REC.CHARGEBACK_EXISTS');
    const refund = await trx
      .selectFrom('refunds')
      .select('status')
      .where('ledger_txn_id', '=', m.id)
      .where('status', '<>', 'REJECTED')
      .executeTakeFirst();
    if (refund) {
      throw new CustomAPIError(409, 'REC.REFUND_EXISTS', {
        params: { status: REFUND_LABEL[refund.status] },
      });
    }
    if (await this.returned(trx, m)) throw new CustomAPIError(409, 'REC.ALREADY_RETURNED');
    const pub = newPublicIdPair();
    try {
      const ins = await trx
        .insertInto('chargebacks')
        .values({
          public_id: pub.bin,
          institution_id: m.institutionId,
          ledger_txn_id: m.id,
          original_reference: m.reference,
          wallet_id: m.creditWallet,
          amount_paise: amount,
          reason_code: code,
          remarks: input.remarks ?? null,
          raised_by: input.raisedBy,
          raised_at: this.now(),
        })
        .executeTakeFirstOrThrow();
      await recordAudit(trx, {
        institutionId: m.institutionId,
        action: 'CHARGEBACK_RAISED',
        entityType: 'chargeback',
        entityRef: pub.id,
        after: { reference: m.reference, amount: formatInr(amount), reasonCode: code },
      });
      return { rowId: String(ins.insertId), id: pub.id };
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'REC.CHARGEBACK_EXISTS');
      }
      throw e;
    }
  }

  async raiseChargeback(
    p: Principal,
    input: { transactionRef: string; reasonCode: string; amountPaise?: number | undefined },
  ) {
    const by = this.by(p);
    const out = await this.deps.db
      .transaction()
      .execute((trx) => this.createChargeback(trx, { ...input, raisedBy: by }));
    return this.chargeback(out.id);
  }

  private async lockedChargeback(trx: Transaction<Database>, id: string, expected: number) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'REC.CHARGEBACK_NOT_FOUND');
    const c = await trx
      .selectFrom('chargebacks')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw new CustomAPIError(404, 'REC.CHARGEBACK_NOT_FOUND');
    return {
      c,
      check(allowed: readonly ChargebackStatus[]) {
        if (!allowed.includes(c.status)) {
          throw new CustomAPIError(409, 'REC.TRANSITION_INVALID', {
            params: { status: CHARGEBACK_LABEL[c.status] },
          });
        }
        if (c.row_version !== expected) throw new PreconditionFailedError();
      },
    };
  }

  /** Accept or dispute a raised chargeback (REC-019). */
  async decideChargeback(
    p: Principal,
    id: string,
    expected: number,
    input: { decision: 'ACCEPT' | 'DISPUTE'; remarks: string },
  ) {
    const remarks = await this.remarks(input.remarks);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const { c, check } = await this.lockedChargeback(trx, id, expected);
      check(['RAISED']);
      const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DISPUTED';
      await trx
        .updateTable('chargebacks')
        .set({
          status,
          remarks,
          decided_by: by,
          decided_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', c.id)
        .where('status', '=', 'RAISED')
        .execute();
      await recordAudit(trx, {
        institutionId: String(c.institution_id),
        action: `CHARGEBACK_${status}`,
        entityType: 'chargeback',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.chargeback(id);
  }

  /** Complete: reversed (the ledger pair) or upheld (nothing moves) — REC-007. */
  async completeChargeback(
    p: Principal,
    id: string,
    expected: number,
    input: { outcome: ChargebackOutcome; remarks: string },
  ) {
    const remarks = await this.remarks(input.remarks);
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const { c, check } = await this.lockedChargeback(trx, id, expected);
      check(['ACCEPTED', 'DISPUTED']);
      if (c.status === 'ACCEPTED' && input.outcome !== 'REVERSED') {
        throw new ValidationError([{ field: 'outcome', code: 'REC.OUTCOME_ACCEPTED' }]);
      }
      const institutionId = String(c.institution_id);
      const at = this.now();
      let reference: string | null = null;
      if (input.outcome === 'REVERSED') {
        const reversal = await trx
          .selectFrom('ledger_transactions')
          .select('id')
          .where('institution_id', '=', institutionId)
          .where('reversal_of_txn_id', '=', c.ledger_txn_id)
          .where('type', '=', 'REVERSAL')
          .executeTakeFirst();
        if (reversal) throw new CustomAPIError(409, 'REC.ALREADY_RETURNED');
        try {
          const out = await this.deps.ledger.post(trx, {
            institutionId,
            type: 'CHARGEBACK',
            channel: 'BACK_OFFICE',
            amountPaise: Number(c.amount_paise),
            idempotencyKey: `CHARGEBACK:${c.id}`,
            debit: { walletId: String(c.wallet_id) },
            credit: { account: 'CHARGEBACK_CLEARING', institutionId },
            narration: `Chargeback ${c.reason_code} of ${c.original_reference}`,
            businessRef: { type: 'chargeback', id: String(c.id) },
            reversalOf: String(c.ledger_txn_id),
            actorRef: by,
            at,
          });
          reference = out.reference;
        } catch (e) {
          if (e instanceof CustomAPIError && e.code === 'PAY.INSUFFICIENT_BALANCE') {
            throw new CustomAPIError(409, 'REC.CHARGEBACK_BALANCE', {
              params: {
                name: await this.ownerName(trx, String(c.wallet_id)),
                amount: formatInr(Number(c.amount_paise)),
              },
            });
          }
          throw e;
        }
      }
      await trx
        .updateTable('chargebacks')
        .set({
          status: 'COMPLETED',
          outcome: input.outcome,
          remarks,
          completed_by: by,
          completed_at: at,
          reversal_reference: reference,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', c.id)
        .where('status', 'in', ['ACCEPTED', 'DISPUTED'])
        .execute();
      await recordAudit(trx, {
        institutionId,
        action: 'CHARGEBACK_COMPLETED',
        entityType: 'chargeback',
        entityRef: id,
        after: { outcome: input.outcome, remarks, reference },
      });
    });
    return this.chargeback(id);
  }

  private chargebackRows(db: Db) {
    return db
      .selectFrom('chargebacks as c')
      .innerJoin('institutions as i', 'i.id', 'c.institution_id')
      .innerJoin('wallets as w', 'w.id', 'c.wallet_id')
      .leftJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .leftJoin('merchants as mer', 'mer.profile_id', 'w.owner_profile_id')
      .leftJoin('platform_accounts as a1', 'a1.public_id', 'c.raised_by')
      .leftJoin('platform_accounts as a2', 'a2.public_id', 'c.decided_by')
      .leftJoin('platform_accounts as a3', 'a3.public_id', 'c.completed_by')
      .selectAll('c')
      .select([
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'w.wallet_no',
        'm.first_name',
        'm.last_name',
        'mer.display_name',
        'a1.first_name as r_first',
        'a1.last_name as r_last',
        'a2.first_name as d_first',
        'a2.last_name as d_last',
        'a3.first_name as c_first',
        'a3.last_name as c_last',
      ]);
  }

  private chargebackView(
    c: Awaited<ReturnType<ReturnType<RefundsService['chargebackRows']>['execute']>>[number],
  ) {
    return {
      id: binToUuid(c.public_id),
      institution: { id: binToUuid(c.institution_public_id), name: c.institution_name },
      originalReference: c.original_reference,
      wallet: { walletNo: c.wallet_no, name: c.display_name ?? nameOf(c.first_name, c.last_name) },
      amount: toMoneyDto(Number(c.amount_paise)),
      reasonCode: c.reason_code,
      status: c.status,
      outcome: c.outcome,
      remarks: c.remarks,
      raised: { by: nameOf(c.r_first, c.r_last) || null, at: iso(c.raised_at) },
      decided: c.decided_at ? { by: nameOf(c.d_first, c.d_last), at: iso(c.decided_at) } : null,
      completed: c.completed_at
        ? { by: nameOf(c.c_first, c.c_last), at: iso(c.completed_at) }
        : null,
      reversalReference: c.reversal_reference,
      version: c.row_version,
    };
  }

  async chargeback(id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'REC.CHARGEBACK_NOT_FOUND');
    const c = await this.chargebackRows(this.deps.db)
      .where('c.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!c) throw new CustomAPIError(404, 'REC.CHARGEBACK_NOT_FOUND');
    return this.chargebackView(c);
  }

  async chargebacks(f: { status?: ChargebackStatus | undefined; cursor?: string | undefined }) {
    let q = this.chargebackRows(this.deps.db);
    if (f.status) q = q.where('c.status', '=', f.status);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('c.id', '<', f.cursor);
    const rows = await q.orderBy('c.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((c) => this.chargebackView(c)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }
}

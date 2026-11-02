/**
 * The payment engine (SRS §9.11; docs/03 §8): the single entry point for a member paying a merchant —
 * static QR, dynamic QR and NFC requests now; events, vendor invoices, canteen orders, allowances and
 * tuition join it in their phases. Transfers (8.7) use it too.
 *
 * Order (the first failure stops the pipeline; docs/03 §8.2):
 *   1. a key already used returns the first attempt (exactly once);
 *   2. caller guards G2 (channel maximum), G4 (pending guard), G5 (wallet status), then G6 (PIN with
 *      its attempt counter, and the member's daily cap) — nothing is written on a refusal;
 *   3. one transaction: the named request is re-read FOR UPDATE; P1–P8 (a refusal rolls back, no
 *      record); the attempt is written PENDING with its RPEP reference; V1–V12; the two wallet rows
 *      are locked in ascending id and V13 checks the locked balance; a V refusal keeps the record as
 *      FAILURE (and a named request FAILED); otherwise the ledger pair is posted, the attempt becomes
 *      SUCCESS ("Paid"), the request SUCCESS, and the payer, the merchant and the payer's guardians
 *      are notified — all in the same transaction;
 *   4. deadlocks and lock-wait timeouts are retried up to 3 times with jitter (safe: the key makes the
 *      operation repeatable).
 */
import { emit, rooms } from '../utils/outbox';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import {
  getMessage,
  LIMITS,
  newReference,
  PAYMENT_CHANNELS,
  STAGE_OF_CHECK,
  stagesFor,
  TRANSFER_STAGES,
  type MessageKey,
  type PaymentChannelCode,
  type PaymentCheck,
  type PaymentStage,
} from '../config/registers';
import type { Database } from '../models/campusone_models';
import { CustomAPIError } from '../utils/CustomAPIError';
import { formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, newPublicIdPair } from '../utils/idGenerator';
import type { LedgerService, Posted } from './ledger.service';
import { approvedAsset } from './assets.service';
import { notify } from './notifications.service';
import {
  allowanceLimits,
  balanceCheck,
  guards,
  preChecks,
  validations,
  type AllowanceFacts,
  type PartyFacts,
  type PaymentFacts,
  type Refusal,
  type WalletFacts,
} from './payment-checks';
import type { PaymentSecurityService } from './payment-security.service';
import { opsMetrics } from '../utils/metrics';
import { isRetriableLockError } from '../utils/retry';
import { defaultValues, type SettingValues } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

interface FeeRecordRow {
  id: string;
  student_profile_id: string;
  status: string;
  amount_paise: string;
  late_fine_paise: string;
  fine_applied: number;
  paid_paise: string;
}

/** What is still owed on a fee record: its amount, the late fine once applied, less what was paid. */
export const outstandingOf = (
  r: Pick<FeeRecordRow, 'amount_paise' | 'late_fine_paise' | 'fine_applied' | 'paid_paise'>,
) =>
  Number(r.amount_paise) +
  (Number(r.fine_applied) ? Number(r.late_fine_paise) : 0) -
  Number(r.paid_paise);

export interface PayCommand {
  readonly channel: Extract<
    PaymentChannelCode,
    'STATIC_QR' | 'DYNAMIC_QR' | 'POS_QR' | 'NFC' | 'TRANSFER' | 'ALLOWANCE' | 'EVENT' | 'TUITION'
  >;
  /** A paid event (13.10, channel EVENT): its public id and period (end inclusive, OI-FEE-15). */
  readonly event?:
    | {
        readonly publicId: string;
        readonly active: boolean;
        readonly startDate: string;
        readonly endDate: string;
      }
    | undefined;
  /** The payer's wallet: the campus wallet, or the allowance wallet (SRS 10.7). */
  readonly instrument?: 'WALLET' | 'ALLOWANCE' | undefined;
  /** Internal ids: the session's institution, the payer (active profile) and the payee. */
  readonly institutionId: string;
  readonly payerProfileId: string;
  readonly payeeProfileId: string;
  readonly amountPaise: number;
  readonly remarks: string;
  readonly idempotencyKey: string;
  readonly qrCodeId?: string | undefined;
  readonly requestId?: string | undefined;
  /** A canteen order (12.8, P3): paid once, marked PAID in the payment's own transaction. */
  readonly orderId?: string | undefined;
  /** A fee record (13.15, channel TUITION): paid once for its outstanding amount, likewise. */
  readonly feeRecordId?: string | undefined;
  /** Who collected the fee record (the collection row's source). */
  readonly feeSource?: 'CONSOLE' | 'JOB' | 'MEMBER' | undefined;
  readonly vendor?: { readonly assetRef: string; readonly invoiceNo: string } | undefined;
  /** Every member debit is confirmed with the PIN (G6); scheduled collections are `system`. */
  readonly auth:
    | { readonly kind: 'pin'; readonly accountId: string; readonly pin: string }
    /** A campus card tapped on a merchant's device (9.5): no PIN, the daily cap still applies. */
    | { readonly kind: 'card'; readonly accountId: string | null }
    | { readonly kind: 'system' };
  readonly actorRef: Buffer | null;
}

export interface AttemptView {
  readonly id: string;
  readonly reference: string;
  readonly status: 'PENDING' | 'SUCCESS' | 'FAILURE';
  readonly amountPaise: number;
  readonly channel: string;
  readonly payerProfileId: string;
  readonly payeeProfileId: string;
  readonly failedCheck: string | null;
  readonly failureCode: string | null;
  readonly attemptedAt: Date;
  readonly completedAt: Date | null;
}

export interface PayResult {
  readonly attempt: AttemptView;
  readonly replayed: boolean;
  /** The payer's wallet balance after the payment (paise), when posted now. */
  readonly payerBalancePaise: number | null;
  readonly stages: readonly PaymentStage[];
}

/** A refusal at any step: problem+json with the step, the stage and, after V-steps, the attempt. */
export class PaymentRefusedError extends CustomAPIError {
  constructor(
    readonly refusal: Refusal,
    readonly attempt: { readonly id: string; readonly reference: string } | null = null,
  ) {
    opsMetrics.paymentRefused(refusal.check, refusal.stage);
    super(refusal.status, refusal.code, {
      ...(refusal.params ? { params: refusal.params } : {}),
      extensions: {
        check: refusal.check,
        stage: refusal.stage,
        ...(attempt ? { attempt } : {}),
      },
    });
  }
}

/**
 * A refusal answered to a counter (a merchant's phone, a terminal): the payer's balance and shortfall
 * are the payer's own, so a short balance reads as the counter message without amounts. The payer's
 * own channels keep the full message.
 */
export function forCounter(e: unknown): unknown {
  if (e instanceof CustomAPIError && e.code === 'PAY.INSUFFICIENT_BALANCE') {
    return new CustomAPIError(409, 'PAY.CARD_BALANCE_SHORT', { extensions: e.extensions });
  }
  return e;
}

const MODE = Object.fromEntries(PAYMENT_CHANNELS.map((c) => [c.code, c.mode]));
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

interface Outcome {
  readonly refusal: Refusal | null;
  readonly attempt: AttemptView;
  readonly posted: Posted | null;
  readonly payerWalletId: string | null;
}

class Replay extends Error {}

export class PaymentEngine {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly ledger: LedgerService;
      readonly paymentSecurity: PaymentSecurityService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limits() {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    const of = (l: { key: string; value: number }) => Number(v[l.key] ?? l.value);
    return {
      staticQrMaxPaise: of(LIMITS.staticQrMaxPaise),
      dynamicQrMaxPaise: of(LIMITS.dynamicQrMaxPaise),
      transferMaxPaise: of(LIMITS.transferMaxPaise),
      pendingGuardMaxPaise: of(LIMITS.pendingGuardMaxPaise),
      requestTtlSeconds: of(LIMITS.paymentRequestTtlSeconds),
    };
  }

  async pay(cmd: PayCommand): Promise<PayResult> {
    const db = this.deps.db;
    const limits = await this.limits();
    const stages =
      cmd.channel === 'TRANSFER'
        ? [...TRANSFER_STAGES]
        : stagesFor({
            vendor: !!cmd.vendor,
            request: cmd.requestId ? (cmd.channel === 'NFC' ? 'NFC' : 'DYNAMIC_QR') : null,
            event: !!cmd.event,
            order: !!cmd.orderId,
          });

    // 1. Exactly once: a key already used returns its attempt.
    const prior = await this.attemptByKey(db, cmd.institutionId, cmd.idempotencyKey);
    if (prior) return this.replay(prior, stages);

    // 2. Caller guards (no lock, nothing written).
    const now = this.now();
    const facts = await this.facts(
      db,
      cmd,
      now,
      limits.requestTtlSeconds,
      undefined,
      undefined,
      undefined,
    );
    const pending = await db
      .selectFrom('payment_attempts')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('payer_profile_id', '=', cmd.payerProfileId)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    const guard = guards(facts, { limits, pendingCount: Number(pending?.n ?? 0) });
    if (guard) throw new PaymentRefusedError(guard);
    if (cmd.auth.kind === 'pin' || (cmd.auth.kind === 'card' && cmd.auth.accountId)) {
      try {
        if (cmd.auth.kind === 'pin') {
          await this.deps.paymentSecurity.verifyPin(cmd.auth.accountId, cmd.auth.pin);
        }
        await this.deps.paymentSecurity.checkCap(db, cmd.auth.accountId!, cmd.amountPaise);
      } catch (e) {
        if (e instanceof CustomAPIError && !(e instanceof PaymentRefusedError)) {
          throw new CustomAPIError(e.statusCode, e.code, {
            params: e.params,
            errors: e.errors,
            extensions: {
              check: 'G6',
              stage: e.code === 'IDN.CAP_EXCEEDED' ? 'balance' : 'identify',
            },
          });
        }
        throw e;
      }
    }

    if (facts.allowance) {
      const limit = allowanceLimits(facts.allowance, cmd.amountPaise);
      if (limit) throw new PaymentRefusedError(limit);
    }

    // 3. The transaction (retried on a deadlock).
    let outcome: Outcome;
    try {
      outcome = await this.retrying(() =>
        db.transaction().execute((trx) => this.run(trx, cmd, limits.requestTtlSeconds)),
      );
    } catch (e) {
      if (e instanceof Replay) {
        const first = await this.attemptByKey(db, cmd.institutionId, cmd.idempotencyKey);
        if (first) return this.replay(first, stages);
      }
      throw e;
    }
    if (outcome.refusal) {
      throw new PaymentRefusedError(outcome.refusal, {
        id: outcome.attempt.id,
        reference: outcome.attempt.reference,
      });
    }
    const balance =
      outcome.posted && outcome.payerWalletId !== null
        ? (outcome.posted.balances[outcome.payerWalletId] ?? null)
        : null;
    return { attempt: outcome.attempt, replayed: false, payerBalancePaise: balance, stages };
  }

  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 3 || !isRetriableLockError(e)) throw e;
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
      }
    }
  }

  private async run(
    trx: Transaction<Database>,
    cmd: PayCommand,
    ttlSeconds: number,
  ): Promise<Outcome> {
    const now = this.now();
    // The named request, re-read under its row lock (G3/P6/P7 race with a second payer).
    const request = cmd.requestId
      ? await trx
          .selectFrom('payment_requests')
          .selectAll()
          .where('id', '=', cmd.requestId)
          .where('institution_id', '=', cmd.institutionId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    // The named order, under its row lock after the request's (P3: two collections of one order).
    const order = cmd.orderId
      ? await trx
          .selectFrom('pos_orders')
          .select(['id', 'public_id', 'outlet_id', 'status', 'total_paise'])
          .where('id', '=', cmd.orderId)
          .where('institution_id', '=', cmd.institutionId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    // The named fee record, under its row lock (two collections of one record queue here).
    const feeRecord = cmd.feeRecordId
      ? await trx
          .selectFrom('fee_records')
          .select([
            'id',
            'student_profile_id',
            'status',
            'amount_paise',
            'late_fine_paise',
            'fine_applied',
            'paid_paise',
          ])
          .where('id', '=', cmd.feeRecordId)
          .where('institution_id', '=', cmd.institutionId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    const f = await this.facts(
      trx,
      cmd,
      now,
      ttlSeconds,
      cmd.requestId ? (request ?? null) : undefined,
      cmd.orderId ? (order ?? null) : undefined,
      cmd.feeRecordId ? (feeRecord ?? null) : undefined,
    );

    const pre = preChecks(f);
    if (pre) throw new PaymentRefusedError(pre);

    // The record, PENDING, with the reference the receipt and the ledger share.
    const pub = newPublicIdPair();
    const allowance = cmd.instrument === 'ALLOWANCE';
    const reference = newReference(
      cmd.channel === 'TRANSFER'
        ? 'TRANSFER'
        : allowance
          ? 'ALLOWANCE_PAYMENT'
          : cmd.event
            ? 'EVENT'
            : cmd.channel === 'TUITION'
              ? 'TUITION'
              : 'PAYMENT',
      now,
    );
    let attemptId: string;
    try {
      const r = await trx
        .insertInto('payment_attempts')
        .values({
          public_id: pub.bin,
          institution_id: cmd.institutionId,
          reference,
          channel: cmd.channel,
          mode: MODE[cmd.channel] ?? null,
          instrument: allowance ? 'ALLOWANCE' : 'WALLET',
          payer_profile_id: cmd.payerProfileId,
          payee_profile_id: cmd.payeeProfileId,
          payer_wallet_id: f.payerWallet?.id ?? null,
          payee_wallet_id: f.payeeWallet?.id ?? null,
          amount_paise: cmd.amountPaise,
          status: 'PENDING',
          remarks: cmd.remarks.slice(0, 140),
          qr_code_id: cmd.qrCodeId ?? null,
          request_id: cmd.requestId ?? null,
          event_ref: cmd.event?.publicId ?? null,
          fee_record_id: cmd.feeRecordId ?? null,
          asset_ref: cmd.vendor?.assetRef ?? null,
          invoice_no: cmd.vendor?.invoiceNo ?? null,
          idempotency_key: cmd.idempotencyKey,
          actor_ref: cmd.actorRef,
          attempted_at: now,
        })
        .executeTakeFirstOrThrow();
      attemptId = String(r.insertId);
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) throw new Replay();
      throw e;
    }
    const view = (
      status: AttemptView['status'],
      refusal: Refusal | null,
      completedAt: Date | null,
    ): AttemptView => ({
      id: pub.id,
      reference,
      status,
      amountPaise: cmd.amountPaise,
      channel: cmd.channel,
      payerProfileId: cmd.payerProfileId,
      payeeProfileId: cmd.payeeProfileId,
      failedCheck: refusal?.check ?? null,
      failureCode: refusal?.code ?? null,
      attemptedAt: now,
      completedAt,
    });

    const refused = async (v: Refusal): Promise<Outcome> => {
      await trx
        .updateTable('payment_attempts')
        .set({
          status: 'FAILURE',
          failed_check: v.check,
          failure_code: v.code,
          failure_params: v.params ? JSON.stringify(v.params) : null,
          completed_at: now,
        })
        .where('id', '=', attemptId)
        .execute();
      if (request) {
        await trx
          .updateTable('payment_requests')
          .set({
            status: 'FAILED',
            consumed_at: now,
            payer_profile_id: cmd.payerProfileId,
            payment_attempt_id: attemptId,
            failure_code: v.code,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', request.id)
          .execute();
        await emit(trx, {
          institutionId: cmd.institutionId,
          type: 'payment.request.updated',
          rooms: [rooms.profile(String(request.merchant_profile_id))],
          data: { requestId: binToUuid(request.public_id), status: 'FAILED' },
        });
      }
      if (order) {
        // The order stays open with the reason; the counter can collect it again (RC-30).
        await trx
          .updateTable('pos_orders')
          .set({ last_failure_code: v.code })
          .where('id', '=', order.id)
          .where('status', '=', 'CREATED')
          .execute();
      }
      return { refusal: v, attempt: view('FAILURE', v, now), posted: null, payerWalletId: null };
    };

    const v = validations(f);
    if (v) return refused(v);
    const payerWallet = f.payerWallet!;
    const payeeWallet = f.payeeWallet!;

    // V13 under the row locks, taken in ascending wallet id (no deadlock between opposite payments).
    const ordered = [payerWallet.id, payeeWallet.id].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    );
    const locked = new Map<string, number>();
    for (const w of ordered) {
      const row = await trx
        .selectFrom('wallet_balances')
        .select('available_paise')
        .where('wallet_id', '=', w)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.set(w, Number(row.available_paise));
    }
    // P2 "paid once" again under the payer's lock: two payments of one event by one payer queue on
    // the payer's wallet, so the second sees the first (a locking read).
    if (cmd.event) {
      const paid = await trx
        .selectFrom('payment_attempts')
        .select('id')
        .where('institution_id', '=', cmd.institutionId)
        .where('event_ref', '=', cmd.event.publicId)
        .where('payer_profile_id', '=', cmd.payerProfileId)
        .where('status', '=', 'SUCCESS')
        .forShare()
        .executeTakeFirst();
      const p2 = paid ? preChecks({ ...f, event: { active: true, alreadyPaid: true } }) : null;
      if (p2) return refused(p2);
    }
    // P5 again under the payee's lock: payments to one vendor queue here, so an invoice paid by a
    // racing payment is seen (a locking read sees the latest commit) and paid once.
    if (cmd.vendor) {
      const paid = await trx
        .selectFrom('payment_attempts')
        .select('id')
        .where('institution_id', '=', cmd.institutionId)
        .where('payee_profile_id', '=', cmd.payeeProfileId)
        .where('invoice_no', '=', cmd.vendor.invoiceNo)
        .where('status', '=', 'SUCCESS')
        .forShare()
        .executeTakeFirst();
      const p5 = paid
        ? preChecks({ ...f, invoice: { invoiceNo: cmd.vendor.invoiceNo, alreadyPaid: true } })
        : null;
      if (p5) return refused(p5);
    }
    // G6 again under the payer's lock: allowance payments from one wallet queue here, so today's
    // count and amount include a payment that has just committed (a locking read).
    if (f.allowance) {
      const today = await this.allowanceToday(trx, cmd.payerProfileId, now, true);
      const limit = allowanceLimits({ ...f.allowance, ...today }, cmd.amountPaise);
      if (limit) return refused(limit);
    }
    const v13 = balanceCheck(locked.get(payerWallet.id)!, cmd.amountPaise, !!f.allowance);
    if (v13) return refused(v13);

    const posted = await this.deps.ledger.post(trx, {
      institutionId: cmd.institutionId,
      type:
        cmd.channel === 'TRANSFER'
          ? 'TRANSFER'
          : allowance
            ? 'ALLOWANCE_PAYMENT'
            : cmd.event
              ? 'EVENT'
              : cmd.channel === 'TUITION'
                ? 'TUITION'
                : 'PAYMENT',
      channel: cmd.channel,
      amountPaise: cmd.amountPaise,
      idempotencyKey: `MERCHANT-${attemptId}`,
      debit: { walletId: payerWallet.id },
      credit: { walletId: payeeWallet.id },
      narration:
        cmd.channel === 'TRANSFER'
          ? 'Transfer'
          : allowance
            ? 'Allowance payment'
            : cmd.event
              ? 'Event payment'
              : cmd.channel === 'TUITION'
                ? 'Tuition fee'
                : 'Merchant Payment',
      businessRef: { type: 'payment_attempt', id: attemptId },
      actorRef: cmd.actorRef,
      reference,
      at: now,
    });
    await trx
      .updateTable('payment_attempts')
      .set({
        status: 'SUCCESS',
        remarks: 'Paid',
        ledger_txn_id: posted.txnId,
        completed_at: now,
      })
      .where('id', '=', attemptId)
      .execute();
    if (request) {
      await trx
        .updateTable('payment_requests')
        .set({
          status: 'SUCCESS',
          consumed_at: now,
          payer_profile_id: cmd.payerProfileId,
          payment_attempt_id: attemptId,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', request.id)
        .execute();
    }
    if (order) {
      await trx
        .updateTable('pos_orders')
        .set({
          status: 'PAID',
          instrument: allowance ? 'ALLOWANCE' : 'WALLET',
          payer_profile_id: cmd.payerProfileId,
          payment_attempt_id: attemptId,
          paid_at: now,
          last_failure_code: null,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', order.id)
        .where('status', '=', 'CREATED')
        .execute();
      await emit(trx, {
        institutionId: cmd.institutionId,
        type: 'pos.order.updated',
        rooms: [rooms.profile(cmd.payeeProfileId)],
        data: { orderId: binToUuid(order.public_id), status: 'PAID', reference },
      });
    }
    if (feeRecord) {
      const fine = Number(feeRecord.fine_applied) ? Number(feeRecord.late_fine_paise) : 0;
      await trx
        .updateTable('fee_records')
        .set({
          paid_paise: sql<string>`paid_paise + ${cmd.amountPaise}`,
          status: 'PAID',
          paid_at: now,
          updated_at: now,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', feeRecord.id)
        .execute();
      await trx
        .insertInto('fee_collections')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: cmd.institutionId,
          record_id: String(feeRecord.id),
          payment_attempt_id: attemptId,
          amount_paise: cmd.amountPaise - Math.min(fine, cmd.amountPaise),
          fine_paise: Math.min(fine, cmd.amountPaise),
          source: cmd.feeSource ?? 'CONSOLE',
          collected_at: now,
        })
        .execute();
      await trx
        .updateTable('fee_collection_attempts')
        .set({ status: 'SUCCEEDED', payment_attempt_id: attemptId, closed_at: now })
        .where('record_id', '=', feeRecord.id)
        .where('status', '=', 'PENDING')
        .execute();
    }
    await this.tell(trx, cmd, f, reference, now);
    await emit(trx, {
      institutionId: cmd.institutionId,
      type: 'payment.completed',
      rooms: [rooms.profile(cmd.payerProfileId), rooms.profile(cmd.payeeProfileId)],
      data: { reference, channel: cmd.channel },
    });
    if (request) {
      await emit(trx, {
        institutionId: cmd.institutionId,
        type: 'payment.request.updated',
        rooms: [rooms.profile(String(request.merchant_profile_id))],
        data: { requestId: binToUuid(request.public_id), status: 'SUCCESS' },
      });
    }
    return {
      refusal: null,
      attempt: view('SUCCESS', null, now),
      posted,
      payerWalletId: payerWallet.id,
    };
  }

  /** The payer, the merchant and the payer's guardians hear of the payment (same transaction). */
  private async tell(
    trx: Transaction<Database>,
    cmd: PayCommand,
    f: PaymentFacts,
    reference: string,
    at: Date,
  ) {
    const amount = formatInr(cmd.amountPaise);
    const transfer = cmd.channel === 'TRANSFER';
    const accountOf = async (profileId: string) =>
      (
        await trx
          .selectFrom('member_profiles')
          .select('account_id')
          .where('id', '=', profileId)
          .executeTakeFirst()
      )?.account_id ?? null;
    const payerAccount = await accountOf(cmd.payerProfileId);
    const payeeAccount = await accountOf(cmd.payeeProfileId);
    const payerName = f.payer?.name ?? '';
    const payeeName = f.payee?.name ?? '';
    const base = {
      institutionId: cmd.institutionId,
      surface: 'MEMBER' as const,
      category: 'PAYMENT' as const,
    };
    if (payerAccount) {
      await notify(
        trx,
        {
          ...base,
          accountIds: [payerAccount],
          ...(transfer
            ? { titleKey: 'NTF.TRANSFER_SENT' as const, params: { amount, name: payeeName } }
            : { titleKey: 'NTF.PAYMENT_SENT' as const, params: { amount, merchant: payeeName } }),
          body: reference,
          link: `/transactions/${reference}`,
        },
        at,
      );
    }
    if (payeeAccount) {
      await notify(
        trx,
        {
          ...base,
          accountIds: [payeeAccount],
          titleKey: transfer ? 'NTF.TRANSFER_RECEIVED' : 'NTF.PAYMENT_RECEIVED',
          params: { amount, name: payerName },
          body: reference,
          link: `/transactions/${reference}`,
        },
        at,
      );
    }
    const guardians = await trx
      .selectFrom('guardianships as g')
      .innerJoin('member_profiles as m', 'm.id', 'g.guardian_profile_id')
      .select('m.account_id')
      .where('g.ward_profile_id', '=', cmd.payerProfileId)
      .where('m.account_id', 'is not', null)
      .execute();
    const accounts = guardians
      .map((g) => g.account_id)
      .filter((a): a is string => a !== null && a !== payerAccount);
    if (accounts.length) {
      await notify(
        trx,
        {
          ...base,
          accountIds: accounts,
          ...(transfer
            ? {
                titleKey: 'NTF.WARD_TRANSFER' as const,
                params: { name: payerName, amount, recipient: payeeName },
              }
            : {
                titleKey: 'NTF.WARD_PAYMENT' as const,
                params: { name: payerName, amount, merchant: payeeName },
              }),
          body: reference,
          link: `/transactions/${reference}`,
        },
        at,
      );
    }
  }

  /** The facts the checks read: both parties, their main wallets and the named purposes. */
  private async facts(
    db: Db,
    cmd: PayCommand,
    now: Date,
    ttlSeconds: number,
    request:
      | {
          status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
          expires_at: Date;
          payment_attempt_id: string | null;
        }
      | null
      | undefined,
    order: { status: 'CREATED' | 'PAID' | 'CANCELLED'; total_paise: string } | null | undefined,
    feeRecord: FeeRecordRow | null | undefined,
  ): Promise<PaymentFacts> {
    const [payer, payee] = await Promise.all([
      this.party(db, cmd.payerProfileId),
      this.party(db, cmd.payeeProfileId),
    ]);
    const allowance = cmd.instrument === 'ALLOWANCE';
    const [payerWallet, payeeWallet] = await Promise.all([
      payer
        ? allowance
          ? this.allowanceWallet(db, cmd.payerProfileId)
          : this.mainWallet(db, cmd.payerProfileId)
        : Promise.resolve(null),
      payee ? this.mainWallet(db, cmd.payeeProfileId) : Promise.resolve(null),
    ]);
    let invoice: PaymentFacts['invoice'];
    if (cmd.vendor) {
      const paid = await db
        .selectFrom('payment_attempts')
        .select('id')
        .where('institution_id', '=', cmd.institutionId)
        .where('payee_profile_id', '=', cmd.payeeProfileId)
        .where('invoice_no', '=', cmd.vendor.invoiceNo)
        .where('status', '=', 'SUCCESS')
        .executeTakeFirst();
      invoice = { invoiceNo: cmd.vendor.invoiceNo, alreadyPaid: !!paid };
    }
    return {
      channel: cmd.channel,
      institutionId: cmd.institutionId,
      payerProfileId: cmd.payerProfileId,
      payeeProfileId: cmd.payeeProfileId,
      amountPaise: cmd.amountPaise,
      remarks: cmd.remarks,
      payer,
      payee,
      payerWallet,
      payeeWallet,
      // P4: an Active asset of an Active group linked to this vendor (7.7, BR-20).
      asset: cmd.vendor
        ? {
            active: await approvedAsset(
              db,
              cmd.institutionId,
              cmd.payeeProfileId,
              cmd.vendor.assetRef,
            ),
          }
        : undefined,
      invoice,
      allowance: allowance ? await this.allowanceFacts(db, cmd, now) : undefined,
      event: cmd.event ? await this.eventFacts(db, cmd, now) : undefined,
      order: cmd.orderId ? await this.orderFacts(db, cmd, order) : undefined,
      feeRecord: cmd.feeRecordId ? await this.feeRecordFacts(db, cmd, feeRecord) : undefined,
      request:
        request === undefined
          ? undefined
          : request === null
            ? { status: 'CANCELLED', expiresAt: now, hasPayment: false }
            : {
                status: request.status,
                expiresAt: new Date(request.expires_at),
                hasPayment: request.payment_attempt_id !== null,
              },
      now,
      requestTtlSeconds: ttlSeconds,
    };
  }

  private async party(db: Db, profileId: string): Promise<PartyFacts | null> {
    const r = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .select([
        'm.id',
        'm.institution_id',
        'm.status',
        'm.txn_permission',
        'm.first_name',
        'm.last_name',
        'ut.category',
        'mer.display_name',
        'mer.sub_type',
      ])
      .where('m.id', '=', profileId)
      .executeTakeFirst();
    if (!r) return null;
    return {
      profileId: String(r.id),
      institutionId: String(r.institution_id),
      status: r.status,
      category: r.category,
      txnPermission: !!Number(r.txn_permission),
      name: r.display_name ?? titleCase([r.first_name, r.last_name].filter(Boolean).join(' ')),
      subType: r.sub_type ?? null,
    };
  }

  /** The profile's campus wallet (or a merchant's wallet). */
  private async mainWallet(db: Db, profileId: string): Promise<WalletFacts | null> {
    const w = await db
      .selectFrom('wallets as w')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .select(['w.id', 'w.status', 'b.available_paise'])
      .where('w.owner_profile_id', '=', profileId)
      .where('w.kind', 'in', ['CAMPUS', 'MERCHANT'])
      .executeTakeFirst();
    return w
      ? { id: String(w.id), status: w.status, availablePaise: Number(w.available_paise) }
      : null;
  }

  /** P2 (13.10): the event is Active and today (IST) is within its period; paid already or not. */
  private async eventFacts(db: Db, cmd: PayCommand, now: Date) {
    const e = cmd.event!;
    const today = istBusinessDate(now);
    const paid = await db
      .selectFrom('payment_attempts')
      .select('id')
      .where('institution_id', '=', cmd.institutionId)
      .where('event_ref', '=', e.publicId)
      .where('payer_profile_id', '=', cmd.payerProfileId)
      .where('status', '=', 'SUCCESS')
      .executeTakeFirst();
    return {
      active: e.active && e.startDate <= today && today <= e.endDate,
      alreadyPaid: !!paid,
    };
  }

  /** P3 (12.8): the order is open and the payment is for its total (unlocked at the guards). */
  private async orderFacts(
    db: Db,
    cmd: PayCommand,
    locked: { status: string; total_paise: string } | null | undefined,
  ) {
    const o =
      locked === undefined
        ? await db
            .selectFrom('pos_orders')
            .select(['status', 'total_paise'])
            .where('id', '=', cmd.orderId!)
            .where('institution_id', '=', cmd.institutionId)
            .executeTakeFirst()
        : locked;
    return { payable: !!o && o.status === 'CREATED' && Number(o.total_paise) === cmd.amountPaise };
  }

  /** P3 for a fee record: open, the payer's own, and the payment is its outstanding amount. */
  private async feeRecordFacts(db: Db, cmd: PayCommand, locked: FeeRecordRow | null | undefined) {
    const r =
      locked === undefined
        ? await db
            .selectFrom('fee_records')
            .select([
              'id',
              'student_profile_id',
              'status',
              'amount_paise',
              'late_fine_paise',
              'fine_applied',
              'paid_paise',
            ])
            .where('id', '=', cmd.feeRecordId!)
            .where('institution_id', '=', cmd.institutionId)
            .executeTakeFirst()
        : locked;
    return {
      payable:
        !!r &&
        ['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(r.status) &&
        String(r.student_profile_id) === cmd.payerProfileId &&
        outstandingOf(r) === cmd.amountPaise,
    };
  }

  /** The profile's allowance wallet (10.5). */
  private async allowanceWallet(db: Db, profileId: string): Promise<WalletFacts | null> {
    const w = await db
      .selectFrom('wallets as w')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .select(['w.id', 'w.status', 'b.available_paise'])
      .where('w.owner_profile_id', '=', profileId)
      .where('w.kind', '=', 'ALLOWANCE')
      .executeTakeFirst();
    return w
      ? { id: String(w.id), status: w.status, availablePaise: Number(w.available_paise) }
      : null;
  }

  /** What an allowance payment is checked against (10.7): the merchant, the grant, today's use. */
  private async allowanceFacts(db: Db, cmd: PayCommand, now: Date): Promise<AllowanceFacts> {
    const [merchant, grant, today] = await Promise.all([
      db
        .selectFrom('merchants')
        .select(['accepts_allowance', 'sub_type'])
        .where('profile_id', '=', cmd.payeeProfileId)
        .executeTakeFirst(),
      db
        .selectFrom('allowance_grants')
        .select(['daily_count_limit', 'daily_amount_limit_paise'])
        .where('profile_id', '=', cmd.payerProfileId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst(),
      this.allowanceToday(db, cmd.payerProfileId, now, false),
    ]);
    return {
      merchantAccepts:
        !!merchant && !!Number(merchant.accepts_allowance) && merchant.sub_type === 'REGULAR',
      dailyCount: grant?.daily_count_limit ?? null,
      dailyAmountPaise:
        grant?.daily_amount_limit_paise != null ? Number(grant.daily_amount_limit_paise) : null,
      ...today,
    };
  }

  /** The payer's successful allowance payments today (IST); `lock` reads the latest commit. */
  private async allowanceToday(db: Db, payerProfileId: string, now: Date, lock: boolean) {
    const ist = new Date(now.getTime() + 330 * 60_000);
    const start = new Date(
      Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000,
    );
    let q = db
      .selectFrom('payment_attempts')
      .select([
        sql<number>`COUNT(*)`.as('n'),
        sql<string>`COALESCE(SUM(amount_paise), 0)`.as('paise'),
      ])
      .where('payer_profile_id', '=', payerProfileId)
      .where('instrument', '=', 'ALLOWANCE')
      .where('status', '=', 'SUCCESS')
      .where('attempted_at', '>=', start);
    if (lock) q = q.forShare();
    const r = await q.executeTakeFirst();
    return { countToday: Number(r?.n ?? 0), spentTodayPaise: Number(r?.paise ?? 0) };
  }

  private async attemptByKey(db: Db, institutionId: string, key: string) {
    return db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private replay(
    a: NonNullable<Awaited<ReturnType<PaymentEngine['attemptByKey']>>>,
    stages: readonly PaymentStage[],
  ): PayResult {
    const view: AttemptView = {
      id: binToUuid(a.public_id),
      reference: a.reference,
      status: a.status,
      amountPaise: Number(a.amount_paise),
      channel: a.channel,
      payerProfileId: String(a.payer_profile_id),
      payeeProfileId: String(a.payee_profile_id),
      failedCheck: a.failed_check,
      failureCode: a.failure_code,
      attemptedAt: new Date(a.attempted_at),
      completedAt: a.completed_at ? new Date(a.completed_at) : null,
    };
    if (a.status === 'FAILURE' && a.failure_code && a.failed_check) {
      const params = parseParams(a.failure_params);
      throw new CustomAPIError(statusOf(a.failure_code), a.failure_code as MessageKey, {
        params,
        extensions: {
          check: a.failed_check,
          stage: stageFromCheck(a.failed_check),
          attempt: { id: view.id, reference: view.reference },
        },
      });
    }
    return { attempt: view, replayed: true, payerBalancePaise: null, stages };
  }
}

const parseParams = (v: unknown): Record<string, string | number> => {
  if (v === null || v === undefined) return {};
  try {
    const o = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
    return o && typeof o === 'object' ? (o as Record<string, string | number>) : {};
  } catch {
    return {};
  }
};

const statusOf = (code: string) => getMessage(code as MessageKey).http ?? 409;
const stageFromCheck = (check: string): PaymentStage =>
  STAGE_OF_CHECK[check as PaymentCheck] ?? 'identify';

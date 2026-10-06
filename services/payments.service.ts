/**
 * Paying a merchant from the app and collecting at the counter (SRS 9.2–9.4, 9.6, 9.11; PAY-001/002,
 * PAY-009…011; prototype m.scan, m.pay, m.mer.collect, m.mer.nfc).
 *
 * - The payer scans a RingPe code: a merchant's static QR (`ringpe://pay/s/…`) or a counter's
 *   dynamic request (`ringpe://pay/d/…`). `resolve` shows who is being paid and, for a request, the
 *   amount and its expiry; another institution's code is "not recognised" (RNG-GOV-006).
 * - `pay` hands the payment to the engine with the session's institution and active profile (never
 *   ids from the request) and the PIN; the engine applies the §9.11 order.
 * - A merchant creates a dynamic QR or NFC request when the channel is switched on for it; it is
 *   single-use and expires after `pay.request.ttlSeconds`. NFC taps (PAY-012) arrive with campus
 *   cards (Phase 4).
 */
import { emit, rooms } from '../utils/outbox';
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import {
  LIMITS,
  newQrToken,
  parseQrPayload,
  qrPayload,
  stagesFor,
  type PaymentStage,
} from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { formatInr } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { qrSvg } from '../utils/qr';
import type { Loggers } from '../controllers/logger';
import type { CardsService } from './cards.service';
import type { EventsService } from './events.service';
import type { MerchantsService } from './merchants.service';
import { forCounter, type PaymentEngine } from './payment-engine.service';
import { defaultValues, type SettingValues } from './settings.service';

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const iso = (d: Date | string) => new Date(d).toISOString();

export interface PayInput {
  /** A scanned code; or `eventId` for a paid event (13.10, channel EVENT). */
  readonly qrPayload?: string | undefined;
  readonly eventId?: string | undefined;
  /** Static QR only: the amount the payer typed (a dynamic request carries its own). */
  readonly amountPaise?: number | undefined;
  readonly vendor?: { readonly assetId: string; readonly invoiceNo: string } | undefined;
  readonly pin: string;
}

export class PaymentsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly engine: PaymentEngine;
      readonly merchants: MerchantsService;
      readonly cards: CardsService;
      readonly events?: EventsService;
      readonly loggers?: Loggers;
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

  /** The payer: the session's active profile in its institution, and the account (for the PIN). */
  private async payer(p: Principal) {
    if (!p.profileId || !isUuid(p.profileId) || !p.institutionId || !isUuid(p.institutionId)) {
      throw new NotFoundError();
    }
    const r = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select(['m.id', 'm.institution_id', 'a.id as account_id', 'a.public_id as account_public'])
      .where('m.public_id', '=', uuidToBin(p.profileId))
      .where('i.public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!r || !isUuid(p.subject) || binToUuid(r.account_public) !== p.subject.toLowerCase()) {
      throw new NotFoundError();
    }
    return {
      profileId: String(r.id),
      institutionId: String(r.institution_id),
      accountId: String(r.account_id),
    };
  }

  /** The code behind a scanned payload, within the payer's institution. */
  private async target(institutionId: string, payload: string) {
    const parsed = parseQrPayload(payload);
    if (!parsed) throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
    const db = this.deps.db;
    if (parsed.kind === 's') {
      const q = await db
        .selectFrom('merchant_qr_codes as q')
        .innerJoin('merchants as mer', 'mer.profile_id', 'q.merchant_profile_id')
        .select([
          'q.id',
          'q.kind',
          'q.status',
          'q.merchant_profile_id',
          'mer.display_name',
          'mer.unique_id',
          'mer.sub_type',
        ])
        .where('q.token', '=', parsed.token)
        .where('q.institution_id', '=', institutionId)
        .executeTakeFirst();
      if (!q) throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
      return { kind: 'static' as const, q };
    }
    const r = await db
      .selectFrom('payment_requests as r')
      .innerJoin('merchants as mer', 'mer.profile_id', 'r.merchant_profile_id')
      .select([
        'r.id',
        'r.public_id',
        'r.kind',
        'r.status',
        'r.amount_paise',
        'r.expires_at',
        'r.merchant_profile_id',
        'r.order_id',
        'r.terminal_id',
        'r.api_client_id',
        'mer.display_name',
        'mer.unique_id',
        'mer.sub_type',
      ])
      .where('r.token', '=', parsed.token)
      .where('r.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
    return { kind: 'request' as const, r };
  }

  private async requestRefusal(r: { status: string; expires_at: Date | string }) {
    if (r.status === 'SUCCESS') return new CustomAPIError(409, 'PAY.REQUEST_PAID');
    const ttl = await this.limit(LIMITS.paymentRequestTtlSeconds);
    if (r.status !== 'PENDING' || new Date(r.expires_at).getTime() <= this.now().getTime()) {
      return new CustomAPIError(409, 'PAY.REQUEST_EXPIRED', {
        params: { minutes: Math.max(1, Math.round(ttl / 60)) },
      });
    }
    return null;
  }

  // --- PAY-001 ------------------------------------------------------------------------------------
  async resolve(p: Principal, input: { qrPayload: string }) {
    const payer = await this.payer(p);
    const t = await this.target(payer.institutionId, input.qrPayload);
    if (t.kind === 'static') {
      if (t.q.status !== 'ACTIVE') throw new CustomAPIError(409, 'PAY.QR_INACTIVE');
      const vendor = t.q.sub_type === 'VENDOR';
      return {
        kind: t.q.kind,
        merchant: {
          name: t.q.display_name,
          code: t.q.unique_id.slice(-9),
          subType: t.q.sub_type,
        },
        request: null,
        instruments: t.q.kind === 'ALLOWANCE' ? ['ALLOWANCE'] : ['WALLET'],
        vendor: vendor ? { assetRequired: true, invoiceRequired: true } : null,
        // An allowance is bounded by its balance and daily limits, not the static-QR maximum.
        maxAmount:
          t.q.kind === 'ALLOWANCE' ? null : toMoneyDto(await this.limit(LIMITS.staticQrMaxPaise)),
        stages: stagesFor({ vendor }),
      };
    }
    const refusal = await this.requestRefusal(t.r);
    if (refusal) throw refusal;
    return {
      kind: t.r.kind === 'NFC' ? ('NFC' as const) : ('DYNAMIC' as const),
      merchant: {
        name: t.r.display_name,
        code: t.r.unique_id.slice(-9),
        subType: t.r.sub_type,
      },
      request: {
        id: binToUuid(t.r.public_id),
        amount: toMoneyDto(Number(t.r.amount_paise)),
        expiresAt: iso(t.r.expires_at),
      },
      instruments: ['WALLET'],
      vendor: null,
      maxAmount: null,
      stages: stagesFor({ request: t.r.kind }),
    };
  }

  // --- PAY-002 ------------------------------------------------------------------------------------
  async pay(p: Principal, input: PayInput, idempotencyKey: string) {
    const payer = await this.payer(p);
    if (input.eventId) return this.payEvent(p, payer, input, idempotencyKey);
    const t = await this.target(payer.institutionId, input.qrPayload ?? '');
    let payee: string;
    let amount: number;
    let channel: 'STATIC_QR' | 'DYNAMIC_QR' | 'POS_QR' | 'ALLOWANCE';
    let instrument: 'WALLET' | 'ALLOWANCE' = 'WALLET';
    let requestId: string | undefined;
    let orderId: string | undefined;
    let qrCodeId: string | undefined;
    let remarks: string;
    if (t.kind === 'static') {
      if (t.q.status !== 'ACTIVE') throw new CustomAPIError(409, 'PAY.QR_INACTIVE');
      // Coupon codes are redeemed through their own routine (Phase 4.4).
      if (t.q.kind === 'COUPON') throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
      if (!input.amountPaise) throw new CustomAPIError(422, 'PAY.AMOUNT_INVALID');
      payee = String(t.q.merchant_profile_id);
      amount = input.amountPaise;
      qrCodeId = String(t.q.id);
      if (t.q.kind === 'ALLOWANCE') {
        // The merchant's allowance QR (9.2): paid from the allowance wallet (10.7, channel 3).
        const [min, max] = [
          await this.limit(LIMITS.allowanceMinPaise),
          await this.limit(LIMITS.allowanceMaxPaise),
        ];
        if (amount < min || amount > max) throw new CustomAPIError(422, 'ALW.AMOUNT_RANGE');
        channel = 'ALLOWANCE';
        instrument = 'ALLOWANCE';
        remarks = 'Allowance payment';
      } else {
        channel = 'STATIC_QR';
        remarks = 'QR payment';
      }
    } else {
      if (t.r.kind !== 'DYNAMIC_QR') throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
      payee = String(t.r.merchant_profile_id);
      amount = Number(t.r.amount_paise);
      // A POS request (a canteen counter or a POS partner, 9.10) is the POS QR channel (5).
      const pos = t.r.terminal_id !== null || t.r.api_client_id !== null;
      channel = pos ? 'POS_QR' : 'DYNAMIC_QR';
      requestId = String(t.r.id);
      orderId = t.r.order_id ? String(t.r.order_id) : undefined;
      remarks = pos ? 'POS QR' : 'Counter QR';
    }
    const result = await this.deps.engine.pay({
      channel,
      instrument,
      institutionId: payer.institutionId,
      payerProfileId: payer.profileId,
      payeeProfileId: payee,
      amountPaise: amount,
      remarks,
      idempotencyKey,
      qrCodeId,
      requestId,
      orderId,
      vendor: input.vendor
        ? { assetRef: input.vendor.assetId, invoiceNo: input.vendor.invoiceNo.toUpperCase() }
        : undefined,
      auth: { kind: 'pin', accountId: payer.accountId, pin: input.pin },
      actorRef: isUuid(p.subject) ? uuidToBin(p.subject) : null,
    });
    return this.receipt(
      result.attempt.reference,
      result.payerBalancePaise,
      result.stages,
      result.replayed,
    );
  }

  /** An event's total to the fee account, once per payer (13.10; P2 in the engine). */
  private async payEvent(
    p: Principal,
    payer: Awaited<ReturnType<PaymentsService['payer']>>,
    input: PayInput,
    idempotencyKey: string,
  ) {
    if (!this.deps.events) throw new NotFoundError();
    const e = await this.deps.events.payable(payer.institutionId, payer.profileId, input.eventId!);
    const result = await this.deps.engine.pay({
      channel: 'EVENT',
      institutionId: payer.institutionId,
      payerProfileId: payer.profileId,
      payeeProfileId: e.payeeProfileId,
      amountPaise: e.totalPaise,
      remarks: `Event: ${e.title}`.slice(0, 140),
      idempotencyKey,
      event: { publicId: e.publicId, active: e.active, startDate: e.startDate, endDate: e.endDate },
      auth: { kind: 'pin', accountId: payer.accountId, pin: input.pin },
      actorRef: isUuid(p.subject) ? uuidToBin(p.subject) : null,
    });
    return this.receipt(
      result.attempt.reference,
      result.payerBalancePaise,
      result.stages,
      result.replayed,
    );
  }

  /** The receipt of a successful payment (the member's view of the attempt). */
  private async receipt(
    reference: string,
    balancePaise: number | null,
    stages: readonly PaymentStage[],
    replayed: boolean,
  ) {
    const a = await this.deps.db
      .selectFrom('payment_attempts as a')
      .innerJoin('merchants as mer', 'mer.profile_id', 'a.payee_profile_id')
      .select([
        'a.public_id',
        'a.reference',
        'a.status',
        'a.channel',
        'a.amount_paise',
        'a.completed_at',
        'a.attempted_at',
        'mer.display_name',
        'mer.unique_id',
      ])
      .where('a.reference', '=', reference)
      .executeTakeFirstOrThrow();
    return {
      receipt: {
        id: binToUuid(a.public_id),
        reference: a.reference,
        status: a.status,
        channel: a.channel,
        amount: toMoneyDto(Number(a.amount_paise)),
        merchant: { name: a.display_name, code: a.unique_id.slice(-9) },
        paidFrom: 'CAMPUS_WALLET' as const,
        paidAt: iso(a.completed_at ?? a.attempted_at),
        balanceAfter: balancePaise === null ? null : toMoneyDto(balancePaise),
      },
      stages,
      replayed,
    };
  }

  // --- PAY-009 ------------------------------------------------------------------------------------
  async createRequest(
    p: Principal,
    input: { kind: 'DYNAMIC_QR' | 'NFC'; amountPaise: number; instrument: 'WALLET' },
  ) {
    const { inst, m } = await this.deps.merchants.self(p);
    if (m.status !== 'ACTIVE') {
      throw new CustomAPIError(409, 'PAY.PAYEE_NOT_ACCEPTING', {
        params: { merchant: m.display_name },
      });
    }
    const enabled = input.kind === 'NFC' ? Number(m.nfc_enabled) : Number(m.dynamic_qr_enabled);
    if (!enabled) {
      throw new CustomAPIError(409, 'PAY.CHANNEL_DISABLED', {
        params: { channel: input.kind === 'NFC' ? 'NFC' : 'a dynamic QR' },
      });
    }
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new CustomAPIError(422, 'PAY.AMOUNT_INVALID');
    }
    const max = await this.limit(LIMITS.dynamicQrMaxPaise);
    if (input.amountPaise > max) {
      throw new CustomAPIError(422, 'PAY.LIMIT_EXCEEDED', {
        params: { max: formatInr(max).replace(/\.00$/, '') },
      });
    }
    const ttl = await this.limit(LIMITS.paymentRequestTtlSeconds);
    const now = this.now();
    const pub = newPublicIdPair();
    const token = newQrToken();
    const nonce = input.kind === 'NFC' ? randomBytes(16).toString('base64url') : null;
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    await this.deps.db
      .insertInto('payment_requests')
      .values({
        public_id: pub.bin,
        institution_id: inst.id,
        merchant_profile_id: m.id,
        kind: input.kind,
        instrument: input.instrument,
        amount_paise: input.amountPaise,
        token,
        nonce_hash: nonce ? createHash('sha256').update(nonce).digest() : null,
        status: 'PENDING',
        expires_at: expiresAt,
        created_by: isUuid(p.subject) ? uuidToBin(p.subject) : null,
        created_at: now,
      })
      .execute();
    const payload = input.kind === 'DYNAMIC_QR' ? qrPayload('d', token) : null;
    return {
      requestId: pub.id,
      kind: input.kind,
      amount: toMoneyDto(input.amountPaise),
      qrPayload: payload,
      svg: payload ? qrSvg(payload) : null,
      nonce,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: ttl,
    };
  }

  private async ownRequest(p: Principal, requestId: string) {
    const { inst, m } = await this.deps.merchants.self(p);
    if (!isUuid(requestId)) throw new NotFoundError();
    const r = await this.deps.db
      .selectFrom('payment_requests')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .where('merchant_profile_id', '=', m.id)
      .where('public_id', '=', uuidToBin(requestId))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  // --- PAY-010 ------------------------------------------------------------------------------------
  async request(p: Principal, requestId: string) {
    const r = await this.ownRequest(p, requestId);
    const expired =
      r.status === 'PENDING' && new Date(r.expires_at).getTime() <= this.now().getTime();
    let payer: string | null = null;
    let receipt: { reference: string } | null = null;
    if (r.payer_profile_id) {
      const who = await this.deps.db
        .selectFrom('member_profiles')
        .select(['first_name', 'last_name'])
        .where('id', '=', r.payer_profile_id)
        .executeTakeFirst();
      payer = who ? titleCase([who.first_name, who.last_name].filter(Boolean).join(' ')) : null;
    }
    if (r.payment_attempt_id) {
      const a = await this.deps.db
        .selectFrom('payment_attempts')
        .select('reference')
        .where('id', '=', r.payment_attempt_id)
        .executeTakeFirst();
      receipt = a ? { reference: a.reference } : null;
    }
    return {
      requestId: binToUuid(r.public_id),
      kind: r.kind,
      amount: toMoneyDto(Number(r.amount_paise)),
      // Expiry is derived from the expiry time, never stored (27.2).
      status: expired ? ('EXPIRED' as const) : r.status,
      failureCode: r.failure_code,
      expiresAt: iso(r.expires_at),
      payer,
      receipt,
    };
  }

  // --- PAY-012 ------------------------------------------------------------------------------------
  /**
   * A campus card tapped on the merchant's device for an NFC request (9.5, BR-15): the nonce must be the
   * request's (single use, unexpired), the card active in the institution; the holder pays through the
   * engine without a PIN (the card is the factor), within the daily cap. A reused nonce is a replay.
   */
  async nfcTap(
    p: Principal,
    requestId: string,
    input: { cardToken: string; nonce: string },
    idempotencyKey: string,
  ) {
    const { inst, m } = await this.deps.merchants.self(p);
    const r = await this.ownRequest(p, requestId);
    if (r.kind !== 'NFC' || !r.nonce_hash) throw new NotFoundError();
    const given = createHash('sha256').update(input.nonce).digest();
    if (!given.equals(r.nonce_hash)) throw new CustomAPIError(409, 'PAY.NONCE_REPLAY');
    if (r.status !== 'PENDING' || r.payment_attempt_id) {
      this.deps.loggers?.security.warn('pay.nonce_replay', {
        request: requestId,
        merchant: binToUuid(m.public_id),
      });
      throw new CustomAPIError(409, 'PAY.NONCE_REPLAY');
    }
    const card = await this.deps.cards.activeCard(inst.id, input.cardToken);
    await this.deps.cards.touch(String(card.id));
    const result = await this.deps.engine
      .pay({
        channel: 'NFC',
        institutionId: inst.id,
        payerProfileId: String(card.profile_id),
        payeeProfileId: String(m.id),
        amountPaise: Number(r.amount_paise),
        remarks: 'NFC tap',
        idempotencyKey,
        requestId: String(r.id),
        auth: { kind: 'card', accountId: card.account_id ? String(card.account_id) : null },
        actorRef: isUuid(p.subject) ? uuidToBin(p.subject) : null,
      })
      .catch((e: unknown) => {
        throw forCounter(e);
      });
    return this.receipt(result.attempt.reference, null, result.stages, result.replayed);
  }

  // --- PAY-011 ------------------------------------------------------------------------------------
  async cancelRequest(p: Principal, requestId: string) {
    const r = await this.ownRequest(p, requestId);
    const res = await this.deps.db
      .updateTable('payment_requests')
      .set({ status: 'CANCELLED', row_version: sql<number>`row_version + 1` })
      .where('id', '=', r.id)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'PAY.REQUEST_NOT_PENDING');
    await emit(this.deps.db, {
      institutionId: String(r.institution_id),
      type: 'payment.request.updated',
      rooms: [rooms.profile(String(r.merchant_profile_id))],
      data: { requestId: binToUuid(r.public_id), status: 'CANCELLED' },
    });
    return this.request(p, requestId);
  }
}

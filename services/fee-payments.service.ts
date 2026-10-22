/**
 * Collect Fee (client 2026-10-19; FEE-046…051): Accounts opens a student — their virtual account
 * number (VAN) and the year's instalments — picks an instalment and collects what is outstanding on
 * it:
 *
 * - in cash, at once: the record is paid and a receipt numbered `<prefix>/FR/<yyyy>/<n>`;
 * - by a QR code on the screen, or a payment link sent by SMS and e-mail to the student's registered
 *   mobile and e-mail (a parent's, for a child without their own): either opens the school's payment
 *   page, where the family pays through the school's gateway (gateway-payments.ts). The payment is
 *   confirmed by the page (its signature, then the gateway's own record of it) or by the gateway's
 *   webhook, whichever comes first, once.
 *
 * Neither passes through the student's wallet, so neither is settled to the fee account: the money
 * is the school's already (cash in hand, or the school's gateway). The collection is kept with the
 * record like a wallet one (fee_collections, mode CASH or ONLINE), so every figure — fee records, the
 * collection details, the family's dues — counts it. Late fines are collected as the wallet does:
 * the outstanding amount includes the fine once it applies.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS } from '../config/registers';
import type { MessageSender } from '../integrations/sms.provider';
import type { PaymentGateway } from '../integrations/payment-gateway.provider';
import type { Database, FeeRecordStatus } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import type { FlowTokens } from '../utils/flow-tokens';
import { formatDate, formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { qrSvg } from '../utils/qr';
import { recordAudit } from './audit.service';
import { chooseGateway, gatewayById, gatewayProblem } from './gateway-payments';
import { outstandingOf } from './payment-engine.service';
import type { PaymentGatewaysService } from './payment-gateways.service';
import { defaultValues, type SettingValues } from './settings.service';
import { vansOf } from './vans';

type Db = Kysely<Database> | Transaction<Database>;

const OPEN: readonly FeeRecordStatus[] = ['DUE', 'OVERDUE', 'PARTIALLY_PAID'];
const nameOf = (first: string | null, last: string | null) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const maskMobile = (m: string | null) => (m ? `••••••${m.slice(-4)}` : null);
const maskEmail = (e: string | null) => {
  if (!e) return null;
  const [user = '', domain = ''] = e.split('@');
  return `${user.slice(0, 1)}•••@${domain}`;
};
/** The receipt prefix: the short name, else the name's initials (as the admission numbers). */
const prefixOf = (i: { name: string; short_name: string | null }) => {
  const short = (i.short_name ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (short.length >= 2) return short.slice(0, 5);
  const words = i.name.split(/\s+/).filter(Boolean);
  const p = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'FEE').slice(0, 3);
  return p
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 5)
    .padEnd(2, 'X');
};

type RecordRow = {
  id: string;
  public_id: Buffer;
  institution_id: string;
  student_profile_id: string;
  label: string;
  due_date: Date | string;
  amount_paise: string;
  late_fine_paise: string;
  fine_applied: number;
  paid_paise: string;
  status: FeeRecordStatus;
  financed: number;
};

export class FeePaymentsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly flows: FlowTokens;
      /** RingPe's own gateway, or the test checkout. */
      readonly gateway: PaymentGateway;
      /** Each school's own gateways. */
      readonly gateways?: PaymentGatewaysService;
      readonly webUrl: string;
      readonly sms?: MessageSender;
      readonly email?: MessageSender;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private gatewayDeps() {
    return {
      gateway: this.deps.gateway,
      gateways: this.deps.gateways,
      platformFallback: () => this.limit(LIMITS.pgPlatformFallback),
    };
  }

  private async inst(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!i) throw new NotFoundError();
    return i;
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  /** A record of the institution, by its public id. */
  private async record(db: Db, institutionId: string, recordId: string, lock = false) {
    if (!isUuid(recordId)) throw new NotFoundError();
    let q = db
      .selectFrom('fee_records')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(recordId));
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r as unknown as RecordRow;
  }

  /** What can be collected on a record now: open, not financed, something outstanding. */
  private payable(r: RecordRow) {
    if (!OPEN.includes(r.status)) throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    if (Number(r.financed)) throw new CustomAPIError(409, 'FEE.FINANCED');
    const amount = outstandingOf(r);
    if (amount <= 0) throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    return amount;
  }

  /**
   * Where a payment link goes: the student's registered mobile and e-mail, else their primary
   * contact parent's (a child without a phone of their own).
   */
  private async contactsOf(studentRowId: string) {
    const db = this.deps.db;
    const st = await db
      .selectFrom('member_profiles')
      .select(['contact_mobile', 'contact_email'])
      .where('id', '=', studentRowId)
      .executeTakeFirst();
    const parent = await db
      .selectFrom('guardianships as g')
      .innerJoin('member_profiles as m', 'm.id', 'g.guardian_profile_id')
      .select(['m.contact_mobile', 'm.contact_email'])
      .where('g.ward_profile_id', '=', studentRowId)
      .orderBy('g.is_primary_contact', 'desc')
      .orderBy('g.id')
      .executeTakeFirst();
    return {
      mobile: st?.contact_mobile || parent?.contact_mobile || null,
      email: st?.contact_email || parent?.contact_email || null,
    };
  }

  /** The school's SMS and e-mail channels to families (as the admission notices). */
  private async channels(institutionId: string) {
    const [platform, school] = await Promise.all([
      this.deps.db.selectFrom('messaging_channels').select(['channel', 'enabled']).execute(),
      this.deps.db
        .selectFrom('notification_channel_settings')
        .select(['channel', 'enabled'])
        .where('institution_id', '=', institutionId)
        .execute(),
    ]);
    const on = (c: string) =>
      !!Number(platform.find((x) => x.channel === c)?.enabled ?? 0) &&
      !!Number(school.find((x) => x.channel === c)?.enabled ?? 0);
    return { sms: on('SMS'), email: on('EMAIL') };
  }

  /**
   * Collects a payment on a locked record: paid (or part paid, when a gateway payment fell short of
   * a fine applied meanwhile), the collection kept with its receipt number, any wallet attempt
   * still waiting closed, and the record's other links withdrawn.
   */
  private async settle(
    trx: Transaction<Database>,
    r: RecordRow,
    c: {
      mode: 'CASH' | 'ONLINE';
      source: 'CONSOLE' | 'MEMBER';
      amountPaise: number;
      paidBy?: string | null;
      gatewayPaymentId?: string | null;
      by: Buffer | null;
      requestRowId?: string;
    },
  ) {
    const now = this.now();
    const due = outstandingOf(r);
    const fine = Number(r.fine_applied) ? Number(r.late_fine_paise) : 0;
    const finePart = Math.min(fine, c.amountPaise);
    const paidInFull = c.amountPaise >= due;
    const inst = await trx
      .selectFrom('institutions')
      .select(['name', 'short_name'])
      .where('id', '=', r.institution_id)
      .executeTakeFirstOrThrow();
    const ins = await trx
      .insertInto('fee_collections')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: r.institution_id,
        record_id: r.id,
        payment_attempt_id: null,
        amount_paise: c.amountPaise - finePart,
        fine_paise: finePart,
        source: c.source,
        mode: c.mode,
        paid_by: c.paidBy?.trim().slice(0, 100) || null,
        gateway_payment_id: c.gatewayPaymentId ?? null,
        collected_by: c.by,
        collected_at: now,
      })
      .executeTakeFirstOrThrow();
    const id = String(ins.insertId);
    const receiptNo = `${prefixOf(inst)}/FR/${istBusinessDate(now).slice(0, 4)}/${id.padStart(6, '0')}`;
    await trx
      .updateTable('fee_collections')
      .set({ receipt_no: receiptNo })
      .where('id', '=', id)
      .execute();
    await trx
      .updateTable('fee_records')
      .set({
        paid_paise: sql<string>`paid_paise + ${c.amountPaise}`,
        status: paidInFull ? 'PAID' : 'PARTIALLY_PAID',
        ...(paidInFull ? { paid_at: now } : {}),
        paid_reference: receiptNo,
        updated_at: now,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', r.id)
      .execute();
    if (paidInFull) {
      // Collected another way: the auto-debit stops waiting for a top-up, other links are void.
      await trx
        .updateTable('fee_collection_attempts')
        .set({ status: 'CANCELLED', closed_at: now })
        .where('record_id', '=', r.id)
        .where('status', '=', 'PENDING')
        .execute();
      let others = trx
        .updateTable('fee_payment_requests')
        .set({ status: 'CANCELLED', updated_at: now })
        .where('record_id', '=', r.id)
        .where('status', '=', 'OPEN');
      if (c.requestRowId) others = others.where('id', '<>', c.requestRowId);
      await others.execute();
    }
    await recordAudit(trx, {
      institutionId: r.institution_id,
      action: c.mode === 'CASH' ? 'FEE_COLLECTED_CASH' : 'FEE_COLLECTED_ONLINE',
      entityType: 'fee_record',
      entityRef: binToUuid(r.public_id),
      after: { receiptNo, amount: formatInr(c.amountPaise), mode: c.mode },
    });
    return { collectionId: id, receiptNo };
  }

  // --- FEE-046 --------------------------------------------------------------------------------------
  /** A student's VAN, the year's instalments, and where a payment link would go. */
  async student(p: Principal, studentId: string, f: { yearId?: string | undefined }) {
    const i = await this.inst(p);
    const inst = String(i.id);
    const db = this.deps.db;
    let yq = db
      .selectFrom('academic_years')
      .select(['id', 'public_id', 'label'])
      .where('institution_id', '=', inst);
    if (f.yearId) {
      if (!isUuid(f.yearId)) throw new NotFoundError();
      yq = yq.where('public_id', '=', uuidToBin(f.yearId));
    } else yq = yq.where('is_current', '=', 1);
    const y = await yq.executeTakeFirst();
    if (!y) throw f.yearId ? new NotFoundError() : new CustomAPIError(409, 'ACA.NO_CURRENT_YEAR');
    if (!isUuid(studentId)) throw new NotFoundError();
    const st = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').on('e.year_id', '=', String(y.id)),
      )
      .leftJoin('sections as sec', 'sec.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'c.name as class_name',
        'sec.name as section_name',
      ])
      .where('m.institution_id', '=', inst)
      .where('m.public_id', '=', uuidToBin(studentId))
      // Students, and staff with transport dues (client 2026-10-21).
      .where((eb) =>
        eb.or([
          eb('ut.category', '=', 'STUDENT'),
          eb.exists(
            eb
              .selectFrom('fee_records as fr')
              .select('fr.id')
              .whereRef('fr.student_profile_id', '=', 'm.id')
              .where('fr.source', '=', 'TRANSPORT'),
          ),
        ]),
      )
      .executeTakeFirst();
    if (!st) throw new NotFoundError();
    const [wallet, records, contacts] = await Promise.all([
      db
        .selectFrom('wallets')
        .select('id')
        .where('owner_profile_id', '=', String(st.id))
        .where('kind', '=', 'CAMPUS')
        .executeTakeFirst(),
      db
        .selectFrom('fee_records')
        .selectAll()
        .where('institution_id', '=', inst)
        .where('student_profile_id', '=', String(st.id))
        .where('year_id', '=', String(y.id))
        .where('status', '<>', 'CANCELLED')
        .orderBy('due_date')
        .orderBy('instalment_seq')
        .execute(),
      this.contactsOf(String(st.id)),
    ]);
    // The VAN the bank pays into now: the class's corporate code, or the default (services/vans.ts).
    const van = wallet ? (await vansOf(db, [String(wallet.id)])).get(String(wallet.id)) : undefined;
    return {
      year: { id: binToUuid(y.public_id), label: y.label },
      student: {
        id: binToUuid(st.public_id),
        name: nameOf(st.first_name, st.last_name),
        admissionNo: st.admission_no,
        classSection: st.class_name ? `${st.class_name} ${st.section_name ?? ''}`.trim() : null,
      },
      van: van ? { number: van.van, active: true } : null,
      sendTo: { mobile: maskMobile(contacts.mobile), email: maskEmail(contacts.email) },
      instalments: records.map((r) => {
        const fine = Number(r.fine_applied) ? Number(r.late_fine_paise) : 0;
        const outstanding = Math.max(0, outstandingOf(r));
        return {
          recordId: binToUuid(r.public_id),
          label: r.label,
          dueDate: istBusinessDate(new Date(r.due_date)),
          amount: toMoneyDto(Number(r.amount_paise)),
          fine: toMoneyDto(fine),
          paid: toMoneyDto(Number(r.paid_paise)),
          outstanding: toMoneyDto(outstanding),
          status: r.status,
          financed: !!Number(r.financed),
          /** Open, not financed, something to collect. */
          collectable: OPEN.includes(r.status) && !Number(r.financed) && outstanding > 0,
        };
      }),
    };
  }

  // --- FEE-047 --------------------------------------------------------------------------------------
  /** The outstanding amount of an instalment, received in cash. */
  async cash(p: Principal, recordId: string, input: { paidBy?: string | null | undefined }) {
    const i = await this.inst(p);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.record(trx, String(i.id), recordId, true);
      const amount = this.payable(r);
      const s = await this.settle(trx, r, {
        mode: 'CASH',
        source: 'CONSOLE',
        amountPaise: amount,
        paidBy: input.paidBy ?? null,
        by: this.by(p),
      });
      return { ...s, amount };
    });
    return {
      receiptNo: out.receiptNo,
      amount: toMoneyDto(out.amount),
      mode: 'CASH' as const,
      recordId: recordId.toLowerCase(),
      status: 'PAID' as const,
    };
  }

  // --- FEE-048 --------------------------------------------------------------------------------------
  /**
   * A payment link or QR code for an instalment's outstanding amount. A link is sent by SMS and
   * e-mail through the school's channels to the student's registered contacts; a QR code is shown.
   */
  async request(p: Principal, recordId: string, input: { channel: 'LINK' | 'QR' }) {
    const i = await this.inst(p);
    const inst = String(i.id);
    const db = this.deps.db;
    const r = await this.record(db, inst, recordId);
    const amount = this.payable(r);
    const contacts =
      input.channel === 'LINK'
        ? await this.contactsOf(r.student_profile_id)
        : { mobile: null, email: null };
    if (input.channel === 'LINK' && !contacts.mobile && !contacts.email) {
      throw new CustomAPIError(409, 'FEE.NO_CONTACT');
    }
    const days = await this.limit(LIMITS.feePayLinkDays);
    const now = this.now();
    const pub = newPublicIdPair();
    const t = await this.deps.flows.issue(
      'fee-pay',
      { inst: binToUuid(i.public_id), req: pub.id },
      days * 86_400,
    );
    const link = `${this.deps.webUrl}/fees/pay/${pub.id}?token=${encodeURIComponent(t.token)}`;
    const channels = input.channel === 'LINK' ? await this.channels(inst) : null;
    const sms = !!(channels?.sms && contacts.mobile && this.deps.sms);
    const email = !!(channels?.email && contacts.email && this.deps.email);
    await db
      .insertInto('fee_payment_requests')
      .values({
        public_id: pub.bin,
        institution_id: inst,
        record_id: r.id,
        channel: input.channel,
        amount_paise: amount,
        sent_mobile: sms ? contacts.mobile : null,
        sent_email: email ? contacts.email : null,
        expires_at: t.expiresAt,
        created_by: this.by(p),
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (input.channel === 'LINK') {
      const student = await db
        .selectFrom('member_profiles')
        .select(['first_name', 'last_name'])
        .where('id', '=', r.student_profile_id)
        .executeTakeFirst();
      const child = nameOf(student?.first_name ?? null, student?.last_name ?? null) || 'your child';
      const text = `${i.name}: please pay ${r.label} for ${child}, ${formatInr(amount)}, here: ${link} (valid until ${formatDate(istBusinessDate(t.expiresAt))}).`;
      const log = {
        institutionId: inst,
        kind: 'TRANSACTIONAL' as const,
        subject: `Fee payment: ${r.label}`,
        refType: 'fee_record',
        refId: binToUuid(r.public_id),
      };
      const sends: Promise<void>[] = [];
      if (sms)
        sends.push(
          this.deps.sms!.send({ to: contacts.mobile!, purpose: 'fee.payLink', text, log }),
        );
      if (email) {
        sends.push(
          this.deps.email!.send({ to: contacts.email!, purpose: 'fee.payLink', text, log }),
        );
      }
      // Best effort: the communication log records a failed send; the link is shown either way.
      await Promise.allSettled(sends);
    }
    await recordAudit(db, {
      institutionId: inst,
      action: input.channel === 'LINK' ? 'FEE_PAY_LINK_SENT' : 'FEE_PAY_QR_SHOWN',
      entityType: 'fee_record',
      entityRef: binToUuid(r.public_id),
      after: { request: pub.id, amount: formatInr(amount), sms, email },
    });
    return {
      id: pub.id,
      channel: input.channel,
      link,
      amount: toMoneyDto(amount),
      expiresAt: t.expiresAt.toISOString(),
      ...(input.channel === 'QR' ? { qrSvg: qrSvg(link) } : {}),
      ...(input.channel === 'LINK'
        ? {
            sentTo: {
              mobile: sms ? maskMobile(contacts.mobile) : null,
              email: email ? maskEmail(contacts.email) : null,
            },
          }
        : {}),
    };
  }

  // --- public: the payment page ----------------------------------------------------------------------
  /** The request a link's token opens, with its record, school and student. */
  private async access(requestId: string, token: string | undefined) {
    if (!isUuid(requestId) || !token) throw new CustomAPIError(404, 'FEE.PAY_LINK_INVALID');
    const claims = await this.deps.flows.verify('fee-pay', token);
    if (!claims || String(claims['req'] ?? '') !== requestId.toLowerCase()) {
      throw new CustomAPIError(404, 'FEE.PAY_LINK_INVALID');
    }
    const req = await this.deps.db
      .selectFrom('fee_payment_requests as q')
      .innerJoin('institutions as i', 'i.id', 'q.institution_id')
      .select([
        'q.id',
        'q.public_id',
        'q.institution_id',
        'q.record_id',
        'q.status',
        'q.amount_paise',
        'q.gateway_id',
        'q.gateway_order_id',
        'q.gateway_payment_id',
        'q.collection_id',
        'i.public_id as inst_public_id',
        'i.name as inst_name',
      ])
      .where('q.public_id', '=', uuidToBin(requestId))
      .executeTakeFirst();
    if (!req || binToUuid(req.inst_public_id) !== String(claims['inst'] ?? '')) {
      throw new CustomAPIError(404, 'FEE.PAY_LINK_INVALID');
    }
    return req;
  }

  /** The receipt of a request's collection, when paid. */
  private async receiptOf(collectionId: string | null) {
    if (!collectionId) return null;
    const c = await this.deps.db
      .selectFrom('fee_collections')
      .select(['receipt_no', 'gateway_payment_id'])
      .where('id', '=', collectionId)
      .executeTakeFirst();
    return c ? { receiptNo: c.receipt_no, transactionId: c.gateway_payment_id } : null;
  }

  // --- FEE-049 --------------------------------------------------------------------------------------
  /** What the payment page shows: the school, the student, the instalment and the amount. */
  async summary(requestId: string, token: string | undefined) {
    const req = await this.access(requestId, token);
    const db = this.deps.db;
    const r = await db
      .selectFrom('fee_records as r')
      .innerJoin('member_profiles as m', 'm.id', 'r.student_profile_id')
      .select([
        'r.label',
        'r.due_date',
        'r.amount_paise',
        'r.late_fine_paise',
        'r.fine_applied',
        'r.paid_paise',
        'r.status',
        'r.financed',
        'm.first_name',
        'm.last_name',
      ])
      .where('r.id', '=', String(req.record_id))
      .executeTakeFirstOrThrow();
    const open = req.status === 'OPEN' && OPEN.includes(r.status) && !Number(r.financed);
    const outstanding = Math.max(0, outstandingOf(r));
    const receipt = await this.receiptOf(req.collection_id ? String(req.collection_id) : null);
    return {
      school: { id: binToUuid(req.inst_public_id), name: req.inst_name },
      student: { name: nameOf(r.first_name, r.last_name) },
      instalment: { label: r.label, dueDate: istBusinessDate(new Date(r.due_date)) },
      amount: toMoneyDto(open ? outstanding : Number(req.amount_paise)),
      /** PAID: this link paid it; CLOSED: paid another way, or withdrawn. */
      status: req.status === 'PAID' ? 'PAID' : open && outstanding > 0 ? 'OPEN' : 'CLOSED',
      receiptNo: receipt?.receiptNo ?? null,
      transactionId: receipt?.transactionId ?? null,
    };
  }

  // --- FEE-050 --------------------------------------------------------------------------------------
  /** An order with the school's gateway for what is outstanding now. */
  async order(requestId: string, token: string | undefined) {
    const req = await this.access(requestId, token);
    if (req.status !== 'OPEN') throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    const db = this.deps.db;
    const r = (await db
      .selectFrom('fee_records')
      .selectAll()
      .where('id', '=', String(req.record_id))
      .executeTakeFirstOrThrow()) as unknown as RecordRow;
    const amount = this.payable(r);
    const chosen = await chooseGateway(
      this.gatewayDeps(),
      String(req.institution_id),
      'FEE.GATEWAY_NOT_CONFIGURED',
    );
    let order: Awaited<ReturnType<PaymentGateway['createOrder']>>;
    try {
      order = await chosen.gateway.createOrder({
        amountPaise: amount,
        receipt: `FEE-${binToUuid(req.public_id).slice(-12)}`,
        notes: { feeRecord: binToUuid(r.public_id), instalment: r.label },
      });
    } catch {
      // The gateway didn't answer: the family can try again.
      throw new CustomAPIError(503, 'GEN.UNAVAILABLE');
    }
    if (!order) throw new CustomAPIError(503, 'FEE.GATEWAY_NOT_CONFIGURED');
    await db
      .updateTable('fee_payment_requests')
      .set({
        amount_paise: amount,
        gateway_id: chosen.gatewayId,
        gateway_order_id: order.orderId,
        updated_at: this.now(),
      })
      .where('id', '=', String(req.id))
      .where('status', '=', 'OPEN')
      .execute();
    return {
      amount: toMoneyDto(amount),
      gatewayOrder: {
        orderId: order.orderId,
        amount: toMoneyDto(order.amountPaise),
        mode: chosen.gateway.mode,
        ...(order.test ? { test: order.test } : {}),
        // Live: the page opens the gateway's checkout with this public key and the order.
        ...(order.checkout
          ? { checkout: { keyId: order.checkout.keyId, name: req.inst_name } }
          : {}),
      },
    };
  }

  /** The request paid: the record collected, once (the page and the webhook may both arrive). */
  private async paid(
    req: { id: string; record_id: string },
    amountPaise: number,
    gatewayPaymentId: string,
  ) {
    return this.deps.db.transaction().execute(async (trx) => {
      const cur = await trx
        .selectFrom('fee_payment_requests')
        .select(['status', 'collection_id', 'gateway_payment_id'])
        .where('id', '=', req.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (cur.status === 'PAID') {
        return cur.gateway_payment_id === gatewayPaymentId ? 'ALREADY_PAID' : 'PAID_OTHERWISE';
      }
      const r = (await trx
        .selectFrom('fee_records')
        .selectAll()
        .where('id', '=', req.record_id)
        .forUpdate()
        .executeTakeFirstOrThrow()) as unknown as RecordRow;
      const now = this.now();
      if (!OPEN.includes(r.status) || Number(r.financed) || outstandingOf(r) <= 0) {
        // Paid another way meanwhile (cash at the office): the gateway payment is kept on the
        // request for the office to refund; the record is not paid twice.
        await trx
          .updateTable('fee_payment_requests')
          .set({
            status: 'PAID',
            gateway_payment_id: gatewayPaymentId,
            paid_at: now,
            updated_at: now,
          })
          .where('id', '=', req.id)
          .execute();
        return 'PAID_OTHERWISE';
      }
      const s = await this.settle(trx, r, {
        mode: 'ONLINE',
        source: 'MEMBER',
        amountPaise: Math.min(amountPaise, outstandingOf(r)),
        gatewayPaymentId,
        by: null,
        requestRowId: req.id,
      });
      await trx
        .updateTable('fee_payment_requests')
        .set({
          status: 'PAID',
          gateway_payment_id: gatewayPaymentId,
          collection_id: s.collectionId,
          paid_at: now,
          updated_at: now,
        })
        .where('id', '=', req.id)
        .execute();
      return 'PAID';
    });
  }

  // --- FEE-051 --------------------------------------------------------------------------------------
  /** The gateway's answer from the checkout: its signature, then the payment as the gateway has it. */
  async verify(
    requestId: string,
    token: string | undefined,
    input: { gatewayPaymentId: string; signature: string },
  ) {
    const req = await this.access(requestId, token);
    if (req.status !== 'PAID') {
      const g = await gatewayById(
        this.gatewayDeps(),
        req.gateway_id ? String(req.gateway_id) : null,
      );
      const ok =
        !!req.gateway_order_id &&
        g.verify({
          orderId: req.gateway_order_id,
          paymentId: input.gatewayPaymentId,
          signature: input.signature,
        });
      if (!ok) throw new CustomAPIError(402, 'FEE.PAYMENT_NOT_VERIFIED');
      const wrong = await gatewayProblem(
        g,
        { orderId: req.gateway_order_id, amountPaise: Number(req.amount_paise) },
        input.gatewayPaymentId,
      );
      if (wrong) throw new CustomAPIError(402, 'FEE.PAYMENT_NOT_VERIFIED');
      await this.paid(
        { id: String(req.id), record_id: String(req.record_id) },
        Number(req.amount_paise),
        input.gatewayPaymentId,
      );
    } else if (req.gateway_payment_id !== input.gatewayPaymentId) {
      throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    }
    return this.summary(requestId, token);
  }

  /**
   * The gateway's webhook (SAS-033): a captured payment of an instalment's order. Null when the
   * order is not an instalment's (an admission fee's, say); else what was done.
   */
  async gatewayOrderPaid(e: {
    orderId: string;
    paymentId: string;
    amountPaise: number;
    captured: boolean;
    gatewayId: string | null;
  }): Promise<string | null> {
    const req = await this.deps.db
      .selectFrom('fee_payment_requests')
      .select(['id', 'record_id', 'status', 'amount_paise'])
      .where('gateway_order_id', '=', e.orderId)
      // Only payments taken with this gateway: one school's keys never settle another's.
      .where('gateway_id', e.gatewayId === null ? 'is' : '=', e.gatewayId)
      .executeTakeFirst();
    if (!req) return null;
    if (req.status === 'PAID') return 'ALREADY_PAID';
    if (e.amountPaise !== Number(req.amount_paise)) return 'AMOUNT_MISMATCH';
    if (!e.captured) return 'NOT_CAPTURED';
    return this.paid(
      { id: String(req.id), record_id: String(req.record_id) },
      e.amountPaise,
      e.paymentId,
    );
  }
}

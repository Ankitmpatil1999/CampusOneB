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
import type { Database, FeeRecordStatus } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import type { FlowTokens } from '../utils/flow-tokens';
import { formatDate, formatDateTime, formatInr, istBusinessDate } from '../utils/format';
import { PdfDocument, rupeesInWords } from '../utils/pdf';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { fromMoneyDto, toMoneyDto, type MoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { qrSvg } from '../utils/qr';
import { recordAudit } from './audit.service';
import { brandFields, schoolBrand, type LogoFiles } from './school-brand';
import { tellMembers } from './member-notices';
import { notificationsRepository } from '../repositories/notifications.repository';
import { familyAccountsByStudent } from './fee-notices.service';
import { chooseGateway, gatewayById, gatewayProblem } from './gateway-payments';
import { notify } from './notifications.service';
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
/** A receipts list with nothing in it (FEE-057: a filter that matches nothing). */
const emptyReceipts = () => {
  const none = { count: 0, amount: toMoneyDto(0) };
  return {
    items: [],
    totals: { count: 0, collected: toMoneyDto(0), cash: none, online: none, wallet: none },
    page: 1,
    pageSize: 15,
    total: 0,
  };
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
      /** CampusOne's own gateway, or the test checkout. */
      readonly gateway: PaymentGateway;
      /** Each school's own gateways. */
      readonly gateways?: PaymentGatewaysService;
      readonly webUrl: string;
      readonly sms?: MessageSender;
      readonly email?: MessageSender;
      /** The school's logo for its e-mails (client 2026-10-26). */
      readonly files?: LogoFiles;
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

  /**
   * Everyone a payment link goes to (client 2026-10-22): the student and every parent — their
   * mobiles and e-mails, the student's first — and their CampusOne accounts for the in-app notice.
   */
  private async familyOf(studentRowId: string) {
    const db = this.deps.db;
    const people = await db
      .selectFrom('member_profiles as m')
      .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
      .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select([
        'm.contact_mobile',
        'm.contact_email',
        'gm.contact_mobile as guardian_mobile',
        'gm.contact_email as guardian_email',
      ])
      .where('m.id', '=', studentRowId)
      .orderBy('g.is_primary_contact', 'desc')
      .orderBy('g.id')
      .execute();
    const distinct = (v: (string | null | undefined)[]) => [
      ...new Set(v.map((x) => x?.trim()).filter((x): x is string => !!x)),
    ];
    const accounts = (await familyAccountsByStudent(db, [studentRowId])).get(studentRowId) ?? [];
    return {
      mobiles: distinct(people.flatMap((x) => [x.contact_mobile, x.guardian_mobile])),
      emails: distinct(
        people.flatMap((x) => [x.contact_email?.toLowerCase(), x.guardian_email?.toLowerCase()]),
      ),
      accounts,
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
      /** When the money was received (cash: the day on the counterfoil); now by default. */
      paidAt?: Date;
      /** The counterfoil book's number (unique in the school); CampusOne numbers it otherwise. */
      receiptNo?: string | null;
    },
  ) {
    const now = this.now();
    const at = c.paidAt ?? now;
    const due = outstandingOf(r);
    const fine = Number(r.fine_applied) ? Number(r.late_fine_paise) : 0;
    const finePart = Math.min(fine, c.amountPaise);
    const paidInFull = c.amountPaise >= due;
    const inst = await trx
      .selectFrom('institutions')
      .select(['name', 'short_name'])
      .where('id', '=', r.institution_id)
      .executeTakeFirstOrThrow();
    const pub = newPublicIdPair();
    const ins = await trx
      .insertInto('fee_collections')
      .values({
        public_id: pub.bin,
        institution_id: r.institution_id,
        record_id: r.id,
        payment_attempt_id: null,
        amount_paise: c.amountPaise - finePart,
        fine_paise: finePart,
        source: c.source,
        mode: c.mode,
        receipt_no: c.receiptNo ?? null,
        paid_by: c.paidBy?.trim().slice(0, 100) || null,
        gateway_payment_id: c.gatewayPaymentId ?? null,
        collected_by: c.by,
        collected_at: at,
      })
      .executeTakeFirstOrThrow();
    const id = String(ins.insertId);
    const receiptNo =
      c.receiptNo ??
      `${prefixOf(inst)}/FR/${istBusinessDate(now).slice(0, 4)}/${id.padStart(6, '0')}`;
    if (!c.receiptNo) {
      await trx
        .updateTable('fee_collections')
        .set({ receipt_no: receiptNo })
        .where('id', '=', id)
        .execute();
    }
    await trx
      .updateTable('fee_records')
      .set({
        paid_paise: sql<string>`paid_paise + ${c.amountPaise}`,
        status: paidInFull ? 'PAID' : 'PARTIALLY_PAID',
        ...(paidInFull ? { paid_at: at } : {}),
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
    // The student and parents are told of every payment taken (client 2026-10-22).
    const left = Math.max(0, due - c.amountPaise);
    await tellMembers(
      trx,
      {
        institutionId: r.institution_id,
        profileRowIds: [String(r.student_profile_id)],
        titleKey: 'NTF.FEE_RECEIVED',
        params: { amount: formatInr(c.amountPaise), fee: r.label },
        body: `Receipt ${receiptNo}. ${left ? `Still due: ${formatInr(left)}.` : 'Paid in full.'}`,
        category: 'PAYMENT',
        link: '/fees',
      },
      now,
    );
    return { collectionId: id, collectionPublicId: pub.id, receiptNo };
  }

  /**
   * The query a receipt is read with — one, or the year's list (client 2026-10-22): the school, the
   * student with the admission number, class and year, the instalment, the fee and fine, how it was
   * paid and when.
   */
  private receiptQuery(db: Db) {
    return db
      .selectFrom('fee_collections as fc')
      .innerJoin('fee_records as r', 'r.id', 'fc.record_id')
      .innerJoin('member_profiles as m', 'm.id', 'r.student_profile_id')
      .innerJoin('institutions as i', 'i.id', 'fc.institution_id')
      .leftJoin('payment_attempts as pa', 'pa.id', 'fc.payment_attempt_id')
      .leftJoin('academic_years as y', 'y.id', 'r.year_id')
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').onRef('e.year_id', '=', 'r.year_id'),
      )
      .leftJoin('sections as sec', 'sec.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
      .select([
        'fc.id',
        'fc.public_id',
        'fc.receipt_no',
        'fc.collected_at',
        'fc.mode',
        'fc.paid_by',
        'fc.gateway_payment_id',
        'fc.amount_paise',
        'fc.fine_paise',
        'pa.reference',
        'i.name as school',
        'm.public_id as student_public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'y.label as year',
        'c.name as class_name',
        'sec.name as section_name',
        'r.public_id as record_public_id',
        'r.label',
        'r.due_date',
      ]);
  }

  /** A receipt as the API gives it; a wallet collection is numbered by its payment reference. */
  private toReceipt(
    x: Awaited<ReturnType<ReturnType<FeePaymentsService['receiptQuery']>['execute']>>[number],
  ) {
    const amount = Number(x.amount_paise);
    const fine = Number(x.fine_paise);
    return {
      collectionId: binToUuid(x.public_id),
      receiptNo: x.receipt_no ?? x.reference ?? '',
      paidAt: new Date(x.collected_at).toISOString(),
      mode: x.mode,
      paidBy: x.paid_by,
      transactionId: x.gateway_payment_id,
      school: { name: x.school },
      student: {
        name: nameOf(x.first_name, x.last_name),
        admissionNo: x.admission_no,
        classSection: x.class_name ? `${x.class_name} ${x.section_name ?? ''}`.trim() : null,
      },
      year: x.year,
      instalment: { label: x.label, dueDate: istBusinessDate(new Date(x.due_date)) },
      amount: toMoneyDto(amount),
      fine: toMoneyDto(fine),
      total: toMoneyDto(amount + fine),
    };
  }

  private async receiptOfCollection(db: Db, collectionRowId: string) {
    return this.toReceipt(
      await this.receiptQuery(db).where('fc.id', '=', collectionRowId).executeTakeFirstOrThrow(),
    );
  }

  // --- FEE-056 --------------------------------------------------------------------------------------
  /** A collection's receipt for the console's receipt view. */
  async collectionReceipt(p: Principal, collectionId: string) {
    const i = await this.inst(p);
    if (!isUuid(collectionId)) throw new NotFoundError();
    const x = await this.receiptQuery(this.deps.db)
      .where('fc.institution_id', '=', String(i.id))
      .where('fc.public_id', '=', uuidToBin(collectionId))
      .executeTakeFirst();
    if (!x) throw new NotFoundError();
    return this.toReceipt(x);
  }

  // --- FEE-057 --------------------------------------------------------------------------------------
  /**
   * The year's receipts, newest first (client 2026-10-22: a Receipts tab as the admission fees'),
   * narrowed by class, section, mode and a search on the student or the receipt number; the totals
   * cover every receipt the filters keep.
   */
  async receipts(
    p: Principal,
    f: {
      yearId?: string | undefined;
      classId?: string | undefined;
      sectionId?: string | undefined;
      q?: string | undefined;
      mode?: 'CASH' | 'ONLINE' | 'WALLET' | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
  ) {
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
    const year = { id: binToUuid(y.public_id), label: y.label };
    let q = this.receiptQuery(db)
      .where('fc.institution_id', '=', inst)
      .where('r.year_id', '=', String(y.id));
    if (f.classId) {
      if (!isUuid(f.classId)) return { year, ...emptyReceipts() };
      q = q.where('c.public_id', '=', uuidToBin(f.classId));
    }
    if (f.sectionId) {
      if (!isUuid(f.sectionId)) return { year, ...emptyReceipts() };
      q = q.where('sec.public_id', '=', uuidToBin(f.sectionId));
    }
    if (f.mode) q = q.where('fc.mode', '=', f.mode);
    const text = f.q?.trim();
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql<string>`CONCAT_WS(' ', m.first_name, m.last_name)`, 'like', like),
          eb('m.admission_no', 'like', like),
          eb('fc.receipt_no', 'like', like),
          eb('pa.reference', 'like', like),
        ]),
      );
    }
    const rows = await q.orderBy('fc.collected_at', 'desc').orderBy('fc.id', 'desc').execute();
    const paiseOf = (list: typeof rows) =>
      list.reduce((a, x) => a + Number(x.amount_paise) + Number(x.fine_paise), 0);
    const by = (mode: string) => {
      const list = rows.filter((x) => x.mode === mode);
      return { count: list.length, amount: toMoneyDto(paiseOf(list)) };
    };
    const pageSize = Math.min(100, Math.max(1, Math.floor(f.pageSize ?? 15)));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.floor(f.page ?? 1)));
    return {
      year,
      items: rows.slice((page - 1) * pageSize, page * pageSize).map((x) => {
        const r = this.toReceipt(x);
        return {
          collectionId: r.collectionId,
          receiptNo: r.receiptNo,
          paidAt: r.paidAt,
          mode: r.mode,
          paidBy: r.paidBy,
          transactionId: r.transactionId,
          amount: r.amount,
          fine: r.fine,
          total: r.total,
          student: { id: binToUuid(x.student_public_id), ...r.student },
          instalment: { recordId: binToUuid(x.record_public_id), label: r.instalment.label },
        };
      }),
      totals: {
        count: rows.length,
        collected: toMoneyDto(paiseOf(rows)),
        cash: by('CASH'),
        online: by('ONLINE'),
        wallet: by('WALLET'),
      },
      page,
      pageSize,
      total: rows.length,
    };
  }

  /** The receipt as a PDF, laid out as the admission fee's (admissions.service.ts). */
  private receiptPdf(x: Awaited<ReturnType<FeePaymentsService['receiptOfCollection']>>) {
    const total = Number(fromMoneyDto(x.total, { allowZero: true }));
    const doc = new PdfDocument(`Receipt ${x.receiptNo}`);
    const brand: [number, number, number] = [15, 110, 120];
    const muted: [number, number, number] = [90, 100, 110];
    doc.text(48, 64, x.school.name, { size: 18, bold: true, color: brand });
    doc.text(48, 84, 'Fee receipt', { size: 12, color: muted });
    doc.text(547, 64, x.receiptNo, { size: 12, bold: true, align: 'right' });
    doc.text(547, 84, formatDateTime(new Date(x.paidAt)), {
      size: 10,
      align: 'right',
      color: muted,
    });
    doc.line(48, 100, 547, 100, { color: [220, 226, 230] });
    doc.text(48, 140, formatInr(total).replace('₹', 'Rs. '), { size: 26, bold: true });
    doc.text(48, 160, rupeesInWords(total), { size: 9, color: muted });
    const rs = (m: MoneyDto) =>
      formatInr(Number(fromMoneyDto(m, { allowZero: true }))).replace('₹', 'Rs. ');
    const rows: [string, string][] = [
      ['Student', x.student.name || '—'],
      ['Admission number', x.student.admissionNo ?? '—'],
      ['Class', x.student.classSection ?? '—'],
      ['Academic year', x.year ?? '—'],
      ['Instalment', `${x.instalment.label} (due ${formatDate(x.instalment.dueDate)})`],
      ['Fee', rs(x.amount)],
      ...(Number(fromMoneyDto(x.fine, { allowZero: true })) > 0
        ? [['Late fine', rs(x.fine)] as [string, string]]
        : []),
      [
        'Paid',
        x.mode === 'CASH'
          ? `In cash${x.paidBy ? ` by ${x.paidBy}` : ''}`
          : x.mode === 'WALLET'
            ? 'From the campus wallet'
            : 'Online',
      ],
      ...(x.transactionId ? [['Transaction ID', x.transactionId] as [string, string]] : []),
    ];
    let y = 200;
    for (const [k, v] of rows) {
      doc.text(48, y, k, { size: 10, color: muted });
      doc.text(180, y, v, { size: 10 });
      y += 22;
    }
    doc.line(48, y + 4, 547, y + 4, { color: [220, 226, 230] });
    doc.text(48, y + 26, 'This receipt is generated by CampusOne and needs no signature.', {
      size: 8,
      color: [120, 130, 140],
    });
    return { fileName: `${x.receiptNo.replace(/\//g, '-')}.pdf`, pdf: doc.toBuffer() };
  }

  // --- FEE-054 --------------------------------------------------------------------------------------
  /** A collection's receipt (PDF) for the console. */
  async collectionReceiptPdf(p: Principal, collectionId: string) {
    const i = await this.inst(p);
    if (!isUuid(collectionId)) throw new NotFoundError();
    const c = await this.deps.db
      .selectFrom('fee_collections')
      .select('id')
      .where('institution_id', '=', String(i.id))
      .where('public_id', '=', uuidToBin(collectionId))
      .executeTakeFirst();
    if (!c) throw new NotFoundError();
    return this.receiptPdf(await this.receiptOfCollection(this.deps.db, String(c.id)));
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
    // What each instalment has had collected: a wallet's is numbered by its payment reference.
    const paidIn = records.length
      ? await db
          .selectFrom('fee_collections as fc')
          .leftJoin('payment_attempts as pa', 'pa.id', 'fc.payment_attempt_id')
          .select([
            'fc.record_id',
            'fc.public_id',
            'fc.receipt_no',
            'pa.reference',
            'fc.collected_at',
            'fc.mode',
            'fc.amount_paise',
            'fc.fine_paise',
          ])
          .where(
            'fc.record_id',
            'in',
            records.map((r) => r.id),
          )
          .orderBy('fc.collected_at')
          .orderBy('fc.id')
          .execute()
      : [];
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
          /** What was collected on it, oldest first: each opens its receipt (client 2026-10-22). */
          collections: paidIn
            .filter((c) => String(c.record_id) === String(r.id))
            .map((c) => ({
              collectionId: binToUuid(c.public_id),
              receiptNo: c.receipt_no ?? c.reference ?? '',
              paidAt: new Date(c.collected_at).toISOString(),
              mode: c.mode,
              total: toMoneyDto(Number(c.amount_paise) + Number(c.fine_paise)),
            })),
        };
      }),
    };
  }

  // --- FEE-047 --------------------------------------------------------------------------------------
  /**
   * The outstanding amount of an instalment, received in cash — recorded as the admission fee's cash
   * (ADM-022, client 2026-10-22): the day it was received (not in the future), who paid, and the
   * counterfoil book's receipt number (unique in the school), else CampusOne numbers it.
   */
  async cash(
    p: Principal,
    recordId: string,
    input: { receivedAt: string; receiptNo?: string | null | undefined; paidBy: string },
  ) {
    const i = await this.inst(p);
    if (input.receivedAt > istBusinessDate(this.now())) {
      throw new ValidationError([{ field: 'receivedAt', code: 'VALIDATION.DATE' }]);
    }
    let out;
    try {
      out = await this.deps.db.transaction().execute(async (trx) => {
        const r = await this.record(trx, String(i.id), recordId, true);
        const amount = this.payable(r);
        const s = await this.settle(trx, r, {
          mode: 'CASH',
          source: 'CONSOLE',
          amountPaise: amount,
          paidBy: input.paidBy,
          by: this.by(p),
          // Today's cash at the time it is recorded; an earlier day's at noon (as the admission fee).
          paidAt:
            input.receivedAt === istBusinessDate(this.now())
              ? this.now()
              : new Date(`${input.receivedAt}T12:00:00+05:30`),
          receiptNo: input.receiptNo?.trim() || null,
        });
        return { ...s, amount, receipt: await this.receiptOfCollection(trx, s.collectionId) };
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'FEE.RECEIPT_TAKEN', {
          params: { no: input.receiptNo?.trim() ?? '' },
        });
      }
      throw e;
    }
    return {
      receiptNo: out.receiptNo,
      amount: toMoneyDto(out.amount),
      mode: 'CASH' as const,
      recordId: recordId.toLowerCase(),
      status: 'PAID' as const,
      collectionId: out.collectionPublicId,
      receipt: out.receipt,
    };
  }

  // --- FEE-048 --------------------------------------------------------------------------------------
  /**
   * A payment link or QR code for an instalment's outstanding amount. A link goes to the student and
   * every parent (client 2026-10-22): by SMS and e-mail through the school's channels, and in the
   * app to those with a CampusOne account; a QR code is shown.
   */
  async request(p: Principal, recordId: string, input: { channel: 'LINK' | 'QR' }) {
    const i = await this.inst(p);
    const inst = String(i.id);
    const db = this.deps.db;
    const r = await this.record(db, inst, recordId);
    const amount = this.payable(r);
    const family = input.channel === 'LINK' ? await this.familyOf(r.student_profile_id) : null;
    if (family && !family.mobiles.length && !family.emails.length && !family.accounts.length) {
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
    const channels = family ? await this.channels(inst) : null;
    const sms = family && channels?.sms && this.deps.sms ? family.mobiles : [];
    const email = family && channels?.email && this.deps.email ? family.emails : [];
    await db
      .insertInto('fee_payment_requests')
      .values({
        public_id: pub.bin,
        institution_id: inst,
        record_id: r.id,
        channel: input.channel,
        amount_paise: amount,
        // The first of each (the communication log keeps every send).
        sent_mobile: sms[0] ?? null,
        sent_email: email[0] ?? null,
        expires_at: t.expiresAt,
        created_by: this.by(p),
        created_at: now,
        updated_at: now,
      })
      .execute();
    let inApp = 0;
    if (family) {
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
      // The school's name and logo, the fee, child and amount highlighted (client 2026-10-26).
      const mail = email.length
        ? {
            highlight: [r.label, child, formatInr(amount)],
            ...brandFields(await schoolBrand(db, this.deps.files, inst)),
          }
        : {};
      // Best effort: the communication log records a failed send; the link is shown either way.
      await Promise.allSettled([
        ...sms.map((to) => this.deps.sms!.send({ to, purpose: 'fee.payLink', text, log })),
        ...email.map((to) =>
          this.deps.email!.send({ to, purpose: 'fee.payLink', text, log, ...mail }),
        ),
      ]);
      if (family.accounts.length) {
        try {
          await notify(
            db,
            {
              institutionId: inst,
              accountIds: family.accounts,
              surface: 'MEMBER',
              category: 'PAYMENT',
              titleKey: 'NTF.FEE_PAY_LINK',
              params: { label: r.label, amount: formatInr(amount), name: child },
              body: text,
              link: '/fees',
              email: false,
            },
            now,
          );
          inApp = family.accounts.length;
        } catch {
          // As the SMS and the e-mail: the link is shown and can be shared by hand.
        }
      }
    }
    await recordAudit(db, {
      institutionId: inst,
      action: input.channel === 'LINK' ? 'FEE_PAY_LINK_SENT' : 'FEE_PAY_QR_SHOWN',
      entityType: 'fee_record',
      entityRef: binToUuid(r.public_id),
      after: {
        request: pub.id,
        amount: formatInr(amount),
        sms: sms.length,
        email: email.length,
        inApp,
      },
    });
    return {
      id: pub.id,
      channel: input.channel,
      link,
      amount: toMoneyDto(amount),
      expiresAt: t.expiresAt.toISOString(),
      ...(input.channel === 'QR' ? { qrSvg: qrSvg(link) } : {}),
      ...(family
        ? {
            sentTo: {
              mobiles: sms.map((m) => maskMobile(m)!),
              emails: email.map((e) => maskEmail(e)!),
              inApp,
            },
          }
        : {}),
    };
  }

  // --- FEE-058 --------------------------------------------------------------------------------------
  /**
   * "Pay online" in the app (client 2026-10-22): the family's own link to the school's payment page
   * (its gateway — UPI, cards, net banking) for what is outstanding on an instalment, opened in the
   * phone's browser; nothing is sent to anyone. Refused when the school takes no online payments
   * (FEE.GATEWAY_NOT_CONFIGURED). The caller checked the instalment is the family's (FEE-020).
   */
  async appLink(institutionId: string, recordId: string, by: Buffer) {
    const db = this.deps.db;
    const i = await db
      .selectFrom('institutions')
      .select(['public_id'])
      .where('id', '=', institutionId)
      .executeTakeFirstOrThrow();
    const r = await this.record(db, institutionId, recordId);
    const amount = this.payable(r);
    await chooseGateway(this.gatewayDeps(), institutionId, 'FEE.GATEWAY_NOT_CONFIGURED');
    const days = await this.limit(LIMITS.feePayLinkDays);
    const now = this.now();
    const pub = newPublicIdPair();
    const t = await this.deps.flows.issue(
      'fee-pay',
      { inst: binToUuid(i.public_id), req: pub.id },
      days * 86_400,
    );
    const link = `${this.deps.webUrl}/fees/pay/${pub.id}?token=${encodeURIComponent(t.token)}`;
    await db
      .insertInto('fee_payment_requests')
      .values({
        public_id: pub.bin,
        institution_id: institutionId,
        record_id: r.id,
        channel: 'APP',
        amount_paise: amount,
        sent_mobile: null,
        sent_email: null,
        expires_at: t.expiresAt,
        created_by: by,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await recordAudit(db, {
      institutionId,
      action: 'FEE_PAY_ONLINE_OPENED',
      entityType: 'fee_record',
      entityRef: binToUuid(r.public_id),
      after: { request: pub.id, amount: formatInr(amount) },
    });
    return {
      id: pub.id,
      link,
      amount: toMoneyDto(amount),
      expiresAt: t.expiresAt.toISOString(),
    };
  }

  // --- FEE-052 --------------------------------------------------------------------------------------
  /**
   * Pay now at the accounts desk (client 2026-10-22): an order with the school's gateway for what is
   * outstanding, for its checkout to open on the console — no link is created or sent. The order is
   * kept as a DESK request so the gateway's webhook settles it if the page closes first.
   */
  async deskOrder(p: Principal, recordId: string) {
    const i = await this.inst(p);
    const inst = String(i.id);
    const db = this.deps.db;
    const r = await this.record(db, inst, recordId);
    const amount = this.payable(r);
    const chosen = await chooseGateway(this.gatewayDeps(), inst, 'FEE.GATEWAY_NOT_CONFIGURED');
    const pub = newPublicIdPair();
    let order: Awaited<ReturnType<PaymentGateway['createOrder']>>;
    try {
      order = await chosen.gateway.createOrder({
        amountPaise: amount,
        receipt: `FEE-${pub.id.slice(-12)}`,
        notes: { feeRecord: binToUuid(r.public_id), instalment: r.label },
      });
    } catch {
      // The gateway didn't answer: the desk can try again.
      throw new CustomAPIError(503, 'GEN.UNAVAILABLE');
    }
    if (!order) throw new CustomAPIError(503, 'FEE.GATEWAY_NOT_CONFIGURED');
    const now = this.now();
    const days = await this.limit(LIMITS.feePayLinkDays);
    await db
      .insertInto('fee_payment_requests')
      .values({
        public_id: pub.bin,
        institution_id: inst,
        record_id: r.id,
        channel: 'DESK',
        amount_paise: amount,
        sent_mobile: null,
        sent_email: null,
        gateway_id: chosen.gatewayId,
        gateway_order_id: order.orderId,
        expires_at: new Date(now.getTime() + days * 86_400_000),
        created_by: this.by(p),
        created_at: now,
        updated_at: now,
      })
      .execute();
    return {
      requestId: pub.id,
      amount: toMoneyDto(amount),
      gatewayOrder: {
        orderId: order.orderId,
        amount: toMoneyDto(order.amountPaise),
        mode: chosen.gateway.mode,
        ...(order.test ? { test: order.test } : {}),
        ...(order.checkout ? { checkout: { keyId: order.checkout.keyId, name: i.name } } : {}),
      },
    };
  }

  // --- FEE-053 --------------------------------------------------------------------------------------
  /** The desk checkout's answer: verified as a link's (FEE-051), then the instalment's receipt. */
  async deskVerify(
    p: Principal,
    recordId: string,
    requestId: string,
    input: { gatewayPaymentId: string; signature: string },
  ) {
    const i = await this.inst(p);
    if (!isUuid(recordId) || !isUuid(requestId)) throw new NotFoundError();
    const db = this.deps.db;
    const req = await db
      .selectFrom('fee_payment_requests as q')
      .innerJoin('fee_records as r', 'r.id', 'q.record_id')
      .select([
        'q.id',
        'q.record_id',
        'q.status',
        'q.amount_paise',
        'q.gateway_id',
        'q.gateway_order_id',
        'q.gateway_payment_id',
        'q.collection_id',
        'r.public_id as record_public_id',
      ])
      .where('q.institution_id', '=', String(i.id))
      .where('q.public_id', '=', uuidToBin(requestId))
      .where('q.channel', '=', 'DESK')
      .executeTakeFirst();
    if (!req || binToUuid(req.record_public_id) !== recordId.toLowerCase()) {
      throw new NotFoundError();
    }
    let outcome = 'ALREADY_PAID';
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
      outcome = await this.paid(
        { id: String(req.id), record_id: String(req.record_id) },
        Number(req.amount_paise),
        input.gatewayPaymentId,
        { source: 'CONSOLE', by: this.by(p) },
      );
    } else if (req.gateway_payment_id !== input.gatewayPaymentId) {
      throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    }
    // Paid another way meanwhile (cash at the desk): the payment stays on the request for a refund.
    if (outcome === 'PAID_OTHERWISE') throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    const after = await db
      .selectFrom('fee_payment_requests')
      .select('collection_id')
      .where('id', '=', String(req.id))
      .executeTakeFirstOrThrow();
    const receipt = after.collection_id
      ? await this.receiptOfCollection(db, String(after.collection_id))
      : null;
    return {
      receiptNo: receipt?.receiptNo ?? null,
      transactionId: receipt?.transactionId ?? input.gatewayPaymentId,
      amount: toMoneyDto(Number(req.amount_paise)),
      mode: 'ONLINE' as const,
      recordId: recordId.toLowerCase(),
      status: 'PAID' as const,
      collectionId: receipt?.collectionId ?? null,
      receipt,
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

  // --- FEE-049 --------------------------------------------------------------------------------------
  /**
   * What the payment page shows: the school, the student with the admission number, class and year
   * (client 2026-10-22), the instalment and the amount; once this link paid it, the receipt.
   */
  async summary(requestId: string, token: string | undefined) {
    const req = await this.access(requestId, token);
    const db = this.deps.db;
    const r = await db
      .selectFrom('fee_records as r')
      .innerJoin('member_profiles as m', 'm.id', 'r.student_profile_id')
      .leftJoin('academic_years as y', 'y.id', 'r.year_id')
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').onRef('e.year_id', '=', 'r.year_id'),
      )
      .leftJoin('sections as sec', 'sec.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
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
        'm.admission_no',
        'y.label as year',
        'c.name as class_name',
        'sec.name as section_name',
      ])
      .where('r.id', '=', String(req.record_id))
      .executeTakeFirstOrThrow();
    const open = req.status === 'OPEN' && OPEN.includes(r.status) && !Number(r.financed);
    const outstanding = Math.max(0, outstandingOf(r));
    const receipt =
      req.status === 'PAID' && req.collection_id
        ? await this.receiptOfCollection(db, String(req.collection_id))
        : null;
    return {
      school: { id: binToUuid(req.inst_public_id), name: req.inst_name },
      student: {
        name: nameOf(r.first_name, r.last_name),
        admissionNo: r.admission_no,
        classSection: r.class_name ? `${r.class_name} ${r.section_name ?? ''}`.trim() : null,
      },
      year: r.year ? { label: r.year } : null,
      instalment: { label: r.label, dueDate: istBusinessDate(new Date(r.due_date)) },
      amount: toMoneyDto(open ? outstanding : Number(req.amount_paise)),
      /** PAID: this link paid it; CLOSED: paid another way, or withdrawn. */
      status: req.status === 'PAID' ? 'PAID' : open && outstanding > 0 ? 'OPEN' : 'CLOSED',
      receiptNo: receipt?.receiptNo ?? null,
      transactionId: receipt?.transactionId ?? null,
      receipt,
    };
  }

  // --- FEE-055 --------------------------------------------------------------------------------------
  /** The receipt (PDF) of an instalment this link paid, for the family to keep. */
  async publicReceiptPdf(requestId: string, token: string | undefined) {
    const req = await this.access(requestId, token);
    if (req.status !== 'PAID' || !req.collection_id) {
      throw new CustomAPIError(404, 'FEE.PAY_LINK_INVALID');
    }
    return this.receiptPdf(await this.receiptOfCollection(this.deps.db, String(req.collection_id)));
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

  /**
   * The request paid: the record collected, once (the page and the webhook may both arrive). A desk
   * payment is the accounts desk's collection; a link's, the family's.
   */
  private async paid(
    req: { id: string; record_id: string },
    amountPaise: number,
    gatewayPaymentId: string,
    who: { source: 'CONSOLE' | 'MEMBER'; by: Buffer | null } = { source: 'MEMBER', by: null },
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
        source: who.source,
        amountPaise: Math.min(amountPaise, outstandingOf(r)),
        gatewayPaymentId,
        by: who.by,
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
      // Accounts hear of it in the console bell and the staff app (client 2026-10-19).
      const student = await trx
        .selectFrom('member_profiles')
        .select(['first_name', 'last_name'])
        .where('id', '=', r.student_profile_id)
        .executeTakeFirst();
      await notify(trx, {
        institutionId: r.institution_id,
        accountIds: await notificationsRepository.holdersOf(trx, r.institution_id, 'fees.collect'),
        surface: 'CONSOLE',
        category: 'PAYMENT',
        titleKey: 'NTF.FEE_PAID_ONLINE',
        params: {
          label: r.label,
          name: nameOf(student?.first_name ?? null, student?.last_name ?? null) || 'a student',
        },
        body: `${formatInr(Math.min(amountPaise, outstandingOf(r) || amountPaise))} · receipt ${s.receiptNo}`,
        link: '/console/feecollection',
      });
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
      .select(['id', 'record_id', 'status', 'amount_paise', 'channel', 'created_by'])
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
      req.channel === 'DESK' ? { source: 'CONSOLE', by: req.created_by } : undefined,
    );
  }
}

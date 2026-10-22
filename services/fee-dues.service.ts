/**
 * Members' dues (SRS 13.4, 13.5, 13.6; FR-FEE-04/06/07; FEE-019…023; prototype m.fees, m.fee).
 *
 * - A student, or a parent for a child on the same account (CR-04, `for`), sees the year's fee: the
 *   heads, paid so far, the next due with its late fine, every instalment, consent and financing.
 * - Consent (13.5): when the institution asks for it, the member accepts the exact text shown, which
 *   is kept with the date (FR-FEE-06) and lasts `fee.consent.validityMonths`. Accepting it authorises
 *   collection from the campus wallet, so the next due is tried at once, as the auto-debit job would.
 * - Paying now (FEE-022) is a member debit: the PIN confirms it (G6) and the engine posts it (TUITION).
 * - The receipt (FEE-023) is a PDF for a paid record.
 */
import { sql, type Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { formatDate, formatDateTime, formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import { PdfDocument, rupeesInWords } from '../utils/pdf';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import type { FeeRecordsService } from './fee-records.service';
import { outstandingOf } from './payment-engine.service';
import { defaultValues, type SettingValues } from './settings.service';

/** The consent text's version (OI-FEE-11: the institution's active template, served here). */
export const CONSENT_TEMPLATE_VERSION = '2026.10';

const day = (d: Date | string) => istBusinessDate(new Date(d));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null, last: string | null) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

type Target = Awaited<ReturnType<FeeDuesService['target']>>;

export class FeeDuesService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly records: FeeRecordsService;
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

  /** The member (or a child on the account, `for`) with the account, class and institution. */
  private async target(p: Principal, forProfile?: string) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const wanted = forProfile ?? p.profileId;
    if (!wanted || !isUuid(wanted)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .leftJoin('academic_years as y', (j) =>
        j.onRef('y.institution_id', '=', 'm.institution_id').on('y.is_current', '=', 1),
      )
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').onRef('en.year_id', '=', 'y.id'),
      )
      .leftJoin('sections as s', 's.id', 'en.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'm.institution_id',
        'ut.category',
        'a.id as account_id',
        'a.first_name as account_first',
        'a.last_name as account_last',
        'i.name as institution_name',
        'y.id as year_id',
        'y.public_id as year_public_id',
        'y.label as year_label',
        'c.name as class_name',
        's.name as section_name',
        // A staff member with transport dues pays them here too (client 2026-10-21).
        (eb) =>
          eb
            .selectFrom('fee_records as fr')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('fr.student_profile_id', '=', 'm.id')
            .where('fr.source', '=', 'TRANSPORT')
            .where('fr.status', '<>', 'CANCELLED')
            .as('transport_dues'),
      ])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(wanted))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    return {
      rowId: String(m.id),
      id: binToUuid(m.public_id),
      name: nameOf(m.first_name, m.last_name),
      admissionNo: m.admission_no,
      student: m.category === 'STUDENT',
      /** Has fees: a student, or anyone with transport dues (staff, client 2026-10-21). */
      payer: m.category === 'STUDENT' || Number(m.transport_dues ?? 0) > 0,
      institutionId: String(m.institution_id),
      institutionName: m.institution_name,
      accountRowId: String(m.account_id),
      accountName: nameOf(m.account_first, m.account_last),
      self: !forProfile || forProfile.toLowerCase() === p.profileId?.toLowerCase(),
      year: m.year_id
        ? { rowId: String(m.year_id), id: binToUuid(m.year_public_id!), label: m.year_label! }
        : null,
      classSection: m.class_name ? `${m.class_name} ${m.section_name ?? ''}`.trim() : null,
    };
  }

  private async toggle(institutionId: string, key: 'feeConsent') {
    const t = await this.deps.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', institutionId)
      .where('feature_key', '=', key)
      .executeTakeFirst();
    return !!t && !!Number(t.enabled);
  }

  private async consentOf(t: Target) {
    const c = await this.deps.db
      .selectFrom('fee_consents')
      .select(['valid_until', 'agreed_at', 'text_version'])
      .where('institution_id', '=', t.institutionId)
      .where('student_profile_id', '=', t.rowId)
      .orderBy('valid_until', 'desc')
      .executeTakeFirst();
    const valid = !!c && new Date(c.valid_until).getTime() > this.now().getTime();
    return c ? { valid, validUntil: iso(c.valid_until), agreedAt: iso(c.agreed_at) } : null;
  }

  private async walletNo(profileRowId: string) {
    const w = await this.deps.db
      .selectFrom('wallets as w')
      .leftJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .select(['w.wallet_no', 'b.available_paise'])
      .where('w.owner_profile_id', '=', profileRowId)
      .where('w.kind', '=', 'CAMPUS')
      .executeTakeFirst();
    return { no: w?.wallet_no ?? null, balancePaise: Number(w?.available_paise ?? 0) };
  }

  /** The consent text the member reads and accepts (prototype fee.consent; FR-FEE-06). */
  private async consentText(t: Target) {
    const months = await this.limit(LIMITS.feeConsentValidityMonths);
    const w = await this.walletNo(t.rowId);
    const who = t.self
      ? `I, ${t.accountName}${t.admissionNo ? ` (admission no. ${t.admissionNo})` : ''}`
      : `I, ${t.accountName}, parent of ${t.name}${t.classSection ? ` (${t.classSection}` : ' ('}${t.admissionNo ? `${t.classSection ? ', ' : ''}admission no. ${t.admissionNo}` : ''})`;
    return {
      version: CONSENT_TEMPLATE_VERSION,
      months,
      text: `${who.replace(' ()', '')}, authorise ${t.institutionName} to collect the school fees of ${t.name} as they fall due from the campus wallet${w.no ? ` ${w.no}` : ''}. If the balance is not enough, the payment stays pending and is collected automatically when funds are available. This consent is valid for ${months} months and I can withdraw it by contacting the accounts office.`,
    };
  }

  private recordRows(institutionId: string, studentRowId: string) {
    return this.deps.db
      .selectFrom('fee_records as r')
      .innerJoin('academic_years as y', 'y.id', 'r.year_id')
      .leftJoin('fee_structure_versions as v', 'v.id', 'r.version_id')
      .leftJoin('fee_structures as s', 's.id', 'v.structure_id')
      .leftJoin('fee_collection_attempts as a', (j) =>
        j.onRef('a.record_id', '=', 'r.id').on('a.status', '=', 'PENDING'),
      )
      .leftJoin('fee_structure_instalments as fi', (j) =>
        j.onRef('fi.version_id', '=', 'r.version_id').onRef('fi.seq', '=', 'r.instalment_seq'),
      )
      .selectAll('r')
      .select([
        'fi.share_bp',
        'y.public_id as year_public_id',
        'y.label as year_label',
        's.name as structure_name',
        'a.public_id as attempt_public_id',
        'a.tries',
        'a.last_failure_code',
        'a.last_tried_at',
      ])
      .where('r.institution_id', '=', institutionId)
      .where('r.student_profile_id', '=', studentRowId);
  }

  private async receiptsOf(recordRowIds: readonly string[]) {
    if (!recordRowIds.length) return new Map<string, { reference: string; status: string }>();
    const rows = await this.deps.db
      .selectFrom('fee_collections as fc')
      // A cash or online collection has no engine attempt (0075): its receipt number instead.
      .leftJoin('payment_attempts as pa', 'pa.id', 'fc.payment_attempt_id')
      .select([
        'fc.record_id',
        'fc.status',
        'fc.settlement_ref',
        sql<string>`COALESCE(pa.reference, fc.receipt_no, '')`.as('reference'),
      ])
      .where('fc.record_id', 'in', recordRowIds)
      .orderBy('fc.id')
      .execute();
    return new Map(
      rows.map((r) => [
        String(r.record_id),
        { reference: r.reference, status: r.status, settlementRef: r.settlement_ref },
      ]),
    );
  }

  private view(
    r: Awaited<ReturnType<ReturnType<FeeDuesService['recordRows']>['execute']>>[number],
    receipt: { reference: string; status: string; settlementRef?: string | null } | undefined,
  ) {
    const fine = Number(r.fine_applied) ? Number(r.late_fine_paise) : 0;
    const outstanding = r.status === 'CANCELLED' ? 0 : Math.max(0, outstandingOf(r));
    return {
      id: binToUuid(r.public_id),
      label: r.label,
      seq: r.instalment_seq,
      share:
        r.share_bp === null || r.share_bp === undefined
          ? null
          : Number(r.share_bp) % 100 === 0
            ? String(Number(r.share_bp) / 100)
            : (Number(r.share_bp) / 100).toFixed(2),
      year: { id: binToUuid(r.year_public_id), label: r.year_label },
      structure: r.structure_name,
      dueDate: day(r.due_date),
      amount: toMoneyDto(Number(r.amount_paise)),
      lateFine: toMoneyDto(Number(r.late_fine_paise)),
      fine: toMoneyDto(fine),
      amountDue: toMoneyDto(outstanding),
      paid: toMoneyDto(Number(r.paid_paise)),
      status: r.status,
      financed: !!Number(r.financed),
      pending: r.attempt_public_id
        ? {
            tries: r.tries ?? 0,
            reasonCode: r.last_failure_code,
            lastTriedAt: iso(r.last_tried_at),
          }
        : null,
      paidAt: iso(r.paid_at),
      receipt: receipt?.reference ?? r.paid_reference ?? null,
      settlement: receipt ? (receipt.status === 'SETTLED' ? 'SETTLED' : 'COLLECTED') : null,
      settlementRef: receipt?.settlementRef ?? null,
    };
  }

  // --- FEE-019 ------------------------------------------------------------------------------------
  async dues(p: Principal, forProfile?: string, yearId?: string) {
    const t = await this.target(p, forProfile);
    // Fees belong to students: a parent's own profile has none (the app opens a child's).
    if (!t.payer) throw new CustomAPIError(422, 'FEE.NOT_A_STUDENT');
    let q = this.recordRows(t.institutionId, t.rowId).where('r.status', '<>', 'CANCELLED');
    if (yearId) {
      if (!isUuid(yearId)) throw new NotFoundError();
      q = q.where('y.public_id', '=', uuidToBin(yearId));
    } else if (t.year) {
      q = q.where('r.year_id', '=', t.year.rowId);
    }
    const rows = await q.orderBy('r.due_date').orderBy('r.instalment_seq').execute();
    const receipts = await this.receiptsOf(rows.map((r) => String(r.id)));
    const records = rows.map((r) => this.view(r, receipts.get(String(r.id))));
    const heads = rows.length
      ? await this.deps.db
          .selectFrom('fee_record_heads')
          .select(['name', sql<string>`SUM(amount_paise)`.as('total')])
          .where(
            'record_id',
            'in',
            rows.map((r) => String(r.id)),
          )
          .groupBy('name')
          .orderBy(sql`SUM(amount_paise)`, 'desc')
          .execute()
      : [];
    const annual = rows.reduce((a, r) => a + Number(r.amount_paise), 0);
    const paid = rows.reduce((a, r) => a + Number(r.paid_paise), 0);
    const outstanding = rows.reduce(
      (a, r) => a + (r.status === 'CANCELLED' ? 0 : Math.max(0, outstandingOf(r))),
      0,
    );
    const next =
      records.find((r) => ['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(r.status)) ?? null;
    const required = await this.toggle(t.institutionId, 'feeConsent');
    const consent = await this.consentOf(t);
    const financing = await this.deps.db
      .selectFrom('fee_financing_registrations')
      .select(['status', 'partner_name'])
      .where('institution_id', '=', t.institutionId)
      .where('student_profile_id', '=', t.rowId)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const wallet = await this.walletNo(t.rowId);
    return {
      student: {
        id: t.id,
        name: t.name,
        classSection: t.classSection,
        admissionNo: t.admissionNo,
      },
      year: rows[0]
        ? { id: binToUuid(rows[0].year_public_id), label: rows[0].year_label }
        : t.year
          ? { id: t.year.id, label: t.year.label }
          : null,
      structure: rows.find((r) => r.structure_name)?.structure_name ?? null,
      summary: {
        annual: toMoneyDto(annual),
        paid: toMoneyDto(paid),
        outstanding: toMoneyDto(outstanding),
        paidPercent: annual ? Math.min(100, Math.round((100 * paid) / annual)) : 0,
      },
      heads: heads.map((h) => ({ name: h.name, amount: toMoneyDto(Number(h.total)) })),
      next,
      records,
      consent: {
        required,
        valid: !!consent?.valid,
        validUntil: consent?.valid ? consent.validUntil : null,
        template: await this.consentText(t),
      },
      financing: financing
        ? { status: financing.status, partnerName: financing.partner_name }
        : { status: 'NOT_REGISTERED' as const, partnerName: null },
      wallet: { balance: toMoneyDto(wallet.balancePaise) },
    };
  }

  /** One of the target's records (another student's is a 404). */
  private async own(t: Target, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.recordRows(t.institutionId, t.rowId)
      .where('r.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  // --- FEE-020 ------------------------------------------------------------------------------------
  async detail(p: Principal, id: string, forProfile?: string) {
    const t = await this.target(p, forProfile);
    const r = await this.own(t, id);
    const receipts = await this.receiptsOf([String(r.id)]);
    const heads = await this.deps.db
      .selectFrom('fee_record_heads')
      .select(['name', 'amount_paise'])
      .where('record_id', '=', r.id)
      .execute();
    return {
      ...this.view(r, receipts.get(String(r.id))),
      student: { id: t.id, name: t.name, classSection: t.classSection },
      heads: heads.map((h) => ({ name: h.name, amount: toMoneyDto(Number(h.amount_paise)) })),
      collection: Number(r.financed) ? 'FINANCING' : 'WALLET',
    };
  }

  // --- FEE-021 ------------------------------------------------------------------------------------
  /**
   * Records the member's consent with the exact text, then tries the next due once (the consent is
   * the authority to collect, FR-FEE-04): collected, or kept pending for the auto-debit job.
   */
  async consent(
    p: Principal,
    input: { studentProfileId?: string | undefined; templateVersion: string },
    idempotencyKey: string,
  ) {
    const t = await this.target(p, input.studentProfileId);
    if (!t.payer) throw new CustomAPIError(422, 'FEE.NOT_A_STUDENT');
    if (input.templateVersion !== CONSENT_TEMPLATE_VERSION) {
      throw new CustomAPIError(409, 'FEE.CONSENT_TEMPLATE_STALE');
    }
    const tpl = await this.consentText(t);
    const at = this.now();
    const validUntil = new Date(at);
    validUntil.setMonth(validUntil.getMonth() + tpl.months);
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('fee_consents')
        .values({
          public_id: pub.bin,
          institution_id: t.institutionId,
          student_profile_id: t.rowId,
          account_id: t.accountRowId,
          text_version: tpl.version,
          accepted_text: tpl.text,
          agreed_at: at,
          valid_until: validUntil,
        })
        .execute();
      await recordAudit(trx, {
        institutionId: t.institutionId,
        action: 'FEE_CONSENT_ACCEPTED',
        entityType: 'fee_consent',
        entityRef: pub.id,
        after: { student: t.id, version: tpl.version, validUntil: iso(validUntil) },
      });
    });
    const next = await this.recordRows(t.institutionId, t.rowId)
      .where('r.status', 'in', ['DUE', 'OVERDUE', 'PARTIALLY_PAID'])
      .where('r.financed', '=', 0)
      .where('r.due_date', '<=', istBusinessDate(at))
      .orderBy('r.due_date')
      .executeTakeFirst();
    let collection: Awaited<ReturnType<FeeRecordsService['attempt']>> | null = null;
    if (next) {
      try {
        collection = await this.deps.records.attempt(
          t.institutionId,
          next,
          'MEMBER',
          `FEE-CONSENT:${pub.id}`,
          uuidToBin(p.subject),
        );
      } catch (e) {
        // Tuition collection off, or paid meanwhile: the consent stands; nothing to collect now.
        if (!(e instanceof CustomAPIError)) throw e;
      }
    }
    void idempotencyKey;
    return {
      consent: {
        id: pub.id,
        version: tpl.version,
        agreedAt: iso(at),
        validUntil: iso(validUntil),
      },
      collection: collection ? { recordId: binToUuid(next!.public_id), ...collection } : null,
    };
  }

  // --- FEE-022 ------------------------------------------------------------------------------------
  /** Pays a due instalment now from the student's campus wallet, confirmed with the PIN. */
  async pay(
    p: Principal,
    id: string,
    input: { pin: string },
    idempotencyKey: string,
    forProfile?: string,
  ) {
    const t = await this.target(p, forProfile);
    const r = await this.own(t, id);
    const out = await this.deps.records.attempt(
      t.institutionId,
      r,
      'MEMBER',
      idempotencyKey,
      uuidToBin(p.subject),
      { kind: 'pin', accountId: t.accountRowId, pin: input.pin },
    );
    return { ...out, record: await this.detail(p, id, forProfile) };
  }

  // --- FEE-023 ------------------------------------------------------------------------------------
  async receiptPdf(p: Principal, id: string, forProfile?: string) {
    const t = await this.target(p, forProfile);
    const r = await this.own(t, id);
    if (r.status !== 'PAID') throw new NotFoundError();
    const receipts = await this.receiptsOf([String(r.id)]);
    const v = this.view(r, receipts.get(String(r.id)));
    const paidPaise = Number(r.paid_paise);
    const doc = new PdfDocument(`Fee receipt ${v.receipt ?? v.id}`);
    const brand: [number, number, number] = [15, 110, 120];
    const muted: [number, number, number] = [90, 100, 110];
    doc.text(48, 64, t.institutionName, { size: 18, bold: true, color: brand });
    doc.text(48, 84, 'Fee receipt', { size: 12, color: muted });
    doc.text(547, 64, `${r.label} · ${r.year_label}`, { size: 12, bold: true, align: 'right' });
    doc.text(547, 84, r.paid_at ? formatDateTime(new Date(r.paid_at)) : '—', {
      size: 10,
      align: 'right',
      color: muted,
    });
    doc.line(48, 100, 547, 100, { color: [220, 226, 230] });
    doc.text(48, 140, formatInr(paidPaise).replace('₹', 'Rs. '), { size: 26, bold: true });
    doc.text(48, 160, rupeesInWords(paidPaise), { size: 9, color: muted });
    const rows: [string, string][] = [
      ['Receipt', v.receipt ?? '—'],
      ['Student', `${t.name}${t.admissionNo ? ` (${t.admissionNo})` : ''}`],
      ['Class', t.classSection ?? '—'],
      ['Instalment', `${r.label}, due ${formatDate(day(r.due_date))}`],
      ['Fee', formatInr(Number(r.amount_paise)).replace('₹', 'Rs. ')],
      [
        'Late fine',
        formatInr(Number(r.fine_applied) ? Number(r.late_fine_paise) : 0).replace('₹', 'Rs. '),
      ],
      ['Paid from', Number(r.financed) ? 'Financing partner' : 'Campus wallet'],
    ];
    let y = 200;
    for (const [k, val] of rows) {
      doc.text(48, y, k, { size: 10, color: muted });
      doc.text(180, y, val, { size: 10 });
      y += 22;
    }
    doc.line(48, y + 4, 547, y + 4, { color: [220, 226, 230] });
    doc.text(48, y + 26, 'This receipt is generated by RingPe and needs no signature.', {
      size: 8,
      color: [120, 130, 140],
    });
    return { fileName: `${v.receipt ?? `fee-${v.id}`}.pdf`, pdf: doc.toBuffer() };
  }
}

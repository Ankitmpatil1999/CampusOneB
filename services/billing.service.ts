/**
 * Billing (SRS 25; FR-SAS-07/08; SAS-030…032; prototype o.plans; Q14 · M14 defaults, client
 * 2026-10-03 "add by default"): invoices carry GST (setting `sas.invoice.gstBp`, 18 %), are due
 * `sas.invoice.dueDays` (15) after issue and have `sas.invoice.graceDays` (14) of grace. Grace and
 * Overdue follow the dates. A bank-transfer payment equal to the total marks the invoice paid and, when
 * nothing else is past due, restores a suspended institution (FR-SAS-08).
 */
import type { Kysely } from 'kysely';
import { INVOICE, LIMITS } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { MessageSender } from '../integrations/sms.provider';
import type { Database, InvoiceStatusCode, InvoiceTrigger } from '../models/campusone_models';
import { billingRepository as repo } from '../repositories/billing.repository';
import { institutionsRepository } from '../repositories/institutions.repository';
import { plansRepository, type PlanTerms } from '../repositories/plans.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { formatDate, formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { renderInvoicePdf } from './invoice-document';
import {
  ACCOUNT_NO_PATTERN,
  GSTIN_PATTERN,
  IFSC_PATTERN,
  SAC_PATTERN,
  stateOfCode,
} from '../utils/gst';
import { defaultValues, type SettingValues } from './settings.service';

/** A DATE column (UTC midnight with timezone Z, or a string) as "YYYY-MM-DD". */
export const dateOnly = (v: Date | string | null | undefined) =>
  v === null || v === undefined ? null : new Date(v).toISOString().slice(0, 10);

/** "YYYY-MM-DD" arithmetic on calendar dates. */
export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export const addMonths = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  const day = t.getUTCDate();
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + n);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
};

/** A cycle from `start`: the last day it covers and the renewal date. */
export const cycleOf = (start: string, cycle: 'MONTHLY' | 'ANNUAL') => {
  const renews = addMonths(start, cycle === 'MONTHLY' ? 1 : 12);
  return { to: addDays(renews, -1), renews };
};

const STATUS_LABEL = Object.fromEntries(INVOICE.values.map((v) => [v.code, v.label]));
const label = (from: string, to: string) => `${formatDate(from)} – ${formatDate(to)}`;

interface Institution {
  readonly id: string;
  readonly public_id: Buffer;
  readonly name: string;
}

export class BillingService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly loggers: Loggers;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly email?: MessageSender;
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }): Promise<number> {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  today() {
    return istBusinessDate(this.now());
  }

  /** Effective status: an unpaid invoice is in grace after its due date, overdue after the grace. */
  effective(status: InvoiceStatusCode, dueOn: string, graceUntilOn: string, today = this.today()) {
    if (status !== 'DUE' && status !== 'GRACE') return status;
    if (today > graceUntilOn) return 'OVERDUE';
    if (today > dueOn) return 'GRACE';
    return 'DUE';
  }

  /** Issues an invoice inside the caller's transaction; one per institution, trigger and period. */
  async issue(
    trx: Kysely<Database>,
    inst: Institution,
    v: {
      trigger: InvoiceTrigger;
      periodKey: string;
      periodLabel: string;
      from: string | null;
      to: string | null;
      lines: readonly { description: string; quantity: number; unitPricePaise: number }[];
    },
    by: Buffer | null,
  ) {
    const existing = await repo.exists(trx, inst.id, v.trigger, v.periodKey);
    if (existing) {
      throw new CustomAPIError(409, 'SAS.INVOICE_DUPLICATE', {
        params: { invoice: existing.invoice_no },
      });
    }
    const amount = v.lines.reduce((s, l) => s + l.quantity * l.unitPricePaise, 0);
    const bp = await this.limit(LIMITS.invoiceGstBp);
    const tax = Math.floor((amount * bp + 5000) / 10000);
    const issued = this.today();
    const due = addDays(issued, await this.limit(LIMITS.invoiceDueDays));
    const grace = addDays(due, await this.limit(LIMITS.invoiceGraceDays));
    const pub = newPublicIdPair();
    const r = await repo.insert(trx, {
      publicId: pub.bin,
      institutionId: inst.id,
      trigger: v.trigger,
      periodKey: v.periodKey,
      periodLabel: v.periodLabel,
      periodFrom: v.from,
      periodTo: v.to,
      amountPaise: amount,
      taxBp: bp,
      taxPaise: tax,
      totalPaise: amount + tax,
      issuedOn: issued,
      dueOn: due,
      graceUntilOn: grace,
      by,
      lines: v.lines,
    });
    await recordAudit(trx, {
      institutionId: inst.id,
      action: 'INVOICE_ISSUED',
      entityType: 'invoice',
      entityRef: pub.id,
      after: { invoiceNo: r.invoiceNo, trigger: v.trigger, totalPaise: amount + tax },
    });
    return { id: pub.id, invoiceNo: r.invoiceNo, totalPaise: amount + tax, dueOn: due };
  }

  /** The first cycle, billed when an institution is activated or its trial converts. */
  async firstCycle(trx: Kysely<Database>, inst: Institution, terms: PlanTerms, by: Buffer | null) {
    const from = this.today();
    const { to } = cycleOf(from, terms.cycle);
    return this.issue(
      trx,
      inst,
      {
        trigger: 'PLAN_ACTIVATION',
        periodKey: from,
        periodLabel: label(from, to),
        from,
        to,
        lines: [
          {
            description: `${terms.name} · first ${terms.cycle === 'MONTHLY' ? 'monthly' : 'annual'} cycle`,
            quantity: 1,
            unitPricePaise: terms.price_paise,
          },
        ],
      },
      by,
    );
  }

  /**
   * The terms the next period takes: a change scheduled for renewal, otherwise the plan's current
   * version (a started period keeps its version only until renewal).
   */
  async nextTerms(
    trx: Kysely<Database>,
    sub: { plan_id: number; plan_version_id: number; scheduled_plan_version_id: number | null },
  ) {
    if (sub.scheduled_plan_version_id) {
      const scheduled = await plansRepository.atVersion(trx, sub.scheduled_plan_version_id);
      if (scheduled) return scheduled;
    }
    const current = (await plansRepository.plans(trx)).find((x) => x.id === sub.plan_id);
    return current ?? (await plansRepository.atVersion(trx, sub.plan_version_id));
  }

  /** The renewal invoice for the period starting on the renewal date. */
  async renewalInvoice(
    trx: Kysely<Database>,
    inst: Institution,
    sub: {
      plan_id: number;
      plan_version_id: number;
      scheduled_plan_version_id: number | null;
      renews_on: Date | string | null;
    },
    by: Buffer | null,
  ) {
    const terms = await this.nextTerms(trx, sub);
    if (!terms) throw new CustomAPIError(409, 'SAS.NO_PLAN');
    const from = sub.renews_on ? dateOnly(sub.renews_on)! : this.today();
    const { to } = cycleOf(from, terms.cycle);
    return this.issue(
      trx,
      inst,
      {
        trigger: 'RENEWAL',
        periodKey: from,
        periodLabel: label(from, to),
        from,
        to,
        lines: [
          {
            description: `${terms.name} · ${terms.cycle === 'MONTHLY' ? 'monthly' : 'annual'} · renewal`,
            quantity: 1,
            unitPricePaise: terms.price_paise,
          },
        ],
      },
      by,
    );
  }

  // --- SAS-040 / SAS-041: CampusOne's invoice and bank details -----------------------------------------
  async profile() {
    const p = await repo.profile(this.deps.db);
    if (!p) throw new NotFoundError();
    return {
      legalName: p.legal_name,
      gstin: p.gstin,
      address: p.address,
      stateCode: p.state_code,
      stateName: stateOfCode(p.state_code)?.name ?? null,
      sacCode: p.sac_code,
      payee: {
        name: p.payee_name,
        bank: p.payee_bank,
        accountNo: p.payee_account_no,
        ifsc: p.payee_ifsc,
      },
      example: Boolean(Number(p.is_example)),
      updatedAt: p.updated_at ? new Date(p.updated_at).toISOString() : null,
      etag: p.row_version,
    };
  }

  async updateProfile(
    p: Principal,
    expected: number,
    input: {
      legalName: string;
      gstin: string;
      address: string;
      sacCode: string;
      payee: { name: string; bank: string; accountNo: string; ifsc: string };
    },
  ) {
    const gstin = input.gstin.trim().toUpperCase();
    const ifsc = input.payee.ifsc.trim().toUpperCase();
    const errors: {
      field: string;
      code: 'SAS.GSTIN_FORMAT' | 'SAS.SAC_FORMAT' | 'IDN.IFSC_INVALID' | 'VALIDATION.FORMAT';
    }[] = [];
    if (!GSTIN_PATTERN.test(gstin) || !stateOfCode(gstin.slice(0, 2))) {
      errors.push({ field: 'gstin', code: 'SAS.GSTIN_FORMAT' });
    }
    if (!SAC_PATTERN.test(input.sacCode.trim()))
      errors.push({ field: 'sacCode', code: 'SAS.SAC_FORMAT' });
    if (!IFSC_PATTERN.test(ifsc)) errors.push({ field: 'payee.ifsc', code: 'IDN.IFSC_INVALID' });
    if (!ACCOUNT_NO_PATTERN.test(input.payee.accountNo.trim())) {
      errors.push({ field: 'payee.accountNo', code: 'VALIDATION.FORMAT' });
    }
    if (errors.length) throw new ValidationError(errors);
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    await this.deps.db.transaction().execute(async (trx) => {
      const ok = await repo.updateProfile(trx, expected, {
        legal_name: input.legalName.trim(),
        gstin,
        address: input.address.trim(),
        state_code: gstin.slice(0, 2),
        sac_code: input.sacCode.trim(),
        payee_name: input.payee.name.trim(),
        payee_bank: input.payee.bank.trim(),
        payee_account_no: input.payee.accountNo.trim(),
        payee_ifsc: ifsc,
        by,
      });
      if (!ok) throw new PreconditionFailedError();
      await recordAudit(trx, {
        action: 'BILLING_PROFILE_CHANGED',
        entityType: 'platform_billing_profile',
        after: { legalName: input.legalName.trim(), gstin, ifsc },
      });
    });
    return this.profile();
  }

  // --- SAS-042 / SAS-043: the GST invoice as a PDF ---------------------------------------------------
  /** The invoice document; `institutionId` limits it to one institution (console). */
  async document(invoicePublicId: string, institutionId?: string) {
    if (!isUuid(invoicePublicId)) throw new NotFoundError();
    const [inv, prof] = await Promise.all([
      repo.forDocument(this.deps.db, uuidToBin(invoicePublicId)),
      repo.profile(this.deps.db),
    ]);
    if (!inv || !prof) throw new NotFoundError();
    if (institutionId !== undefined && String(inv.institution_id) !== String(institutionId)) {
      throw new NotFoundError();
    }
    const [lines, payments] = await Promise.all([
      repo.lines(this.deps.db, [String(inv.id)]),
      repo.payments(this.deps.db, [String(inv.id)]),
    ]);
    const status = this.effective(inv.status, dateOnly(inv.due_on)!, dateOnly(inv.grace_until_on)!);
    const pay = payments[0];
    const pdf = renderInvoicePdf({
      profile: {
        legalName: prof.legal_name,
        gstin: prof.gstin,
        address: prof.address,
        stateCode: prof.state_code,
        sacCode: prof.sac_code,
        payeeName: prof.payee_name,
        payeeBank: prof.payee_bank,
        payeeAccountNo: prof.payee_account_no,
        payeeIfsc: prof.payee_ifsc,
        example: Boolean(Number(prof.is_example)),
      },
      institution: {
        name: inv.institution_name,
        identifier: inv.institution_identifier,
        address: inv.institution_address,
        city: inv.institution_city,
        pin: inv.institution_pin,
      },
      invoice: {
        invoiceNo: inv.invoice_no,
        issuedOn: dateOnly(inv.issued_on)!,
        dueOn: dateOnly(inv.due_on)!,
        period: inv.period_label,
        status: STATUS_LABEL[status] ?? status,
        amountPaise: Number(inv.amount_paise),
        taxBp: inv.tax_bp,
        taxPaise: Number(inv.tax_paise),
        totalPaise: Number(inv.total_paise),
        paid: pay ? { on: dateOnly(pay.paid_on)!, reference: pay.utr } : null,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPricePaise: Number(l.unit_price_paise),
          amountPaise: Number(l.amount_paise),
        })),
      },
    });
    return { fileName: `${inv.invoice_no}.pdf`, pdf };
  }

  // --- SAS-030 ------------------------------------------------------------------------------------
  async list(f: { institutionId?: string | undefined } = {}) {
    let instId: string | undefined;
    if (f.institutionId) {
      if (!isUuid(f.institutionId)) throw new NotFoundError();
      const inst = await institutionsRepository.byPublicId(
        this.deps.db,
        uuidToBin(f.institutionId),
      );
      if (!inst) throw new NotFoundError();
      instId = inst.id;
    }
    const rows = await repo.list(this.deps.db, { institutionId: instId });
    const ids = rows.map((r) => String(r.id));
    const [lines, payments] = await Promise.all([
      repo.lines(this.deps.db, ids),
      repo.payments(this.deps.db, ids),
    ]);
    const today = this.today();
    return {
      items: rows.map((r) => {
        const pay = payments.find((p) => String(p.invoice_id) === String(r.id));
        return {
          id: binToUuid(r.public_id),
          invoiceNo: r.invoice_no,
          institution: { id: binToUuid(r.institution_public_id), name: r.institution_name },
          trigger: r.trigger_kind,
          period: r.period_label,
          amount: toMoneyDto(Number(r.amount_paise)),
          taxPercent: (r.tax_bp / 100).toFixed(2),
          tax: toMoneyDto(Number(r.tax_paise)),
          total: toMoneyDto(Number(r.total_paise)),
          issuedOn: dateOnly(r.issued_on)!,
          dueOn: dateOnly(r.due_on)!,
          graceUntilOn: dateOnly(r.grace_until_on)!,
          status: this.effective(r.status, dateOnly(r.due_on)!, dateOnly(r.grace_until_on)!, today),
          paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
          transfer:
            r.transfer_utr && !pay
              ? {
                  utr: r.transfer_utr,
                  paidOn: dateOnly(r.transfer_paid_on)!,
                  reportedAt: new Date(r.transfer_reported_at!).toISOString(),
                }
              : null,
          payment: pay
            ? {
                method: pay.method,
                reference: pay.utr,
                paidOn: dateOnly(pay.paid_on)!,
              }
            : null,
          lines: lines
            .filter((l) => String(l.invoice_id) === String(r.id))
            .map((l) => ({
              description: l.description,
              quantity: l.quantity,
              amount: toMoneyDto(Number(l.amount_paise)),
            })),
          version: r.row_version,
        };
      }),
    };
  }

  // --- SAS-031 ------------------------------------------------------------------------------------
  async generate(
    p: Principal,
    input: {
      institutionId: string;
      trigger: 'RENEWAL' | 'PLAN_ACTIVATION' | 'USAGE_OVERAGE';
      smsOver?: number | undefined;
      whatsappOver?: number | undefined;
    },
  ) {
    if (!isUuid(input.institutionId)) throw new NotFoundError();
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await institutionsRepository.byPublicId(
        trx,
        uuidToBin(input.institutionId),
        true,
      );
      if (!inst) throw new NotFoundError();
      if (inst.status !== 'ACTIVE' && inst.status !== 'SUSPENDED') {
        throw new CustomAPIError(409, 'INS.TRANSITION_INVALID', {
          params: { status: inst.status === 'CANCELLED' ? 'Cancelled' : 'Pending activation' },
        });
      }
      const sub = await institutionsRepository.subscription(trx, inst.id);
      if (!sub) throw new CustomAPIError(409, 'SAS.NO_PLAN');
      const terms = await plansRepository.atVersion(trx, sub.plan_version_id);
      if (!terms) throw new CustomAPIError(409, 'SAS.NO_PLAN');
      const today = this.today();
      if (input.trigger === 'USAGE_OVERAGE') {
        const sms = Math.max(0, Math.floor(input.smsOver ?? 0));
        const wa = Math.max(0, Math.floor(input.whatsappOver ?? 0));
        const smsPaise = await this.limit(LIMITS.overageSmsPaise);
        const waPaise = await this.limit(LIMITS.overageWhatsappPaise);
        const lines = [
          sms
            ? {
                description: `${sms.toLocaleString('en-IN')} SMS above allowance × ${formatInr(smsPaise)}`,
                quantity: sms,
                unitPricePaise: smsPaise,
              }
            : null,
          wa
            ? {
                description: `${wa.toLocaleString('en-IN')} WhatsApp above allowance × ${formatInr(waPaise)}`,
                quantity: wa,
                unitPricePaise: waPaise,
              }
            : null,
        ].filter((x): x is NonNullable<typeof x> => x !== null);
        if (!lines.length || lines.every((l) => l.quantity * l.unitPricePaise === 0)) {
          throw new ValidationError([{ field: 'smsOver', code: 'SAS.NOTHING_TO_BILL' }]);
        }
        const month = today.slice(0, 7);
        const monthLabel = formatDate(`${month}-01`).slice(3);
        return this.issue(
          trx,
          inst,
          {
            trigger: 'USAGE_OVERAGE',
            periodKey: month,
            periodLabel: monthLabel,
            from: null,
            to: null,
            lines,
          },
          by,
        );
      }
      if (input.trigger === 'RENEWAL') return this.renewalInvoice(trx, inst, sub, by);
      const from = today;
      const { to } = cycleOf(from, terms.cycle);
      return this.issue(
        trx,
        inst,
        {
          trigger: input.trigger,
          periodKey: from,
          periodLabel: label(from, to),
          from,
          to,
          lines: [
            {
              description: `${terms.name} · ${terms.cycle === 'MONTHLY' ? 'monthly' : 'annual'} · plan activation`,
              quantity: 1,
              unitPricePaise: terms.price_paise,
            },
          ],
        },
        by,
      );
    });
    await this.notifyIssued(input.institutionId, out.invoiceNo, out.totalPaise, out.dueOn);
    return (await this.list({ institutionId: input.institutionId })).items.find(
      (x) => x.id === out.id,
    )!;
  }

  /** E-mails the institution's primary contact that an invoice was issued. */
  async notifyIssued(
    institutionPublicId: string,
    invoiceNo: string,
    totalPaise: number,
    dueOn: string,
  ) {
    if (!this.deps.email) return;
    const inst = await institutionsRepository.byPublicId(
      this.deps.db,
      uuidToBin(institutionPublicId),
    );
    if (!inst) return;
    const contacts = await institutionsRepository.contacts(this.deps.db, inst.id);
    const primary = contacts.find((c) => c.kind === 'PRIMARY');
    if (!primary?.email) return;
    await this.deps.email
      .send({
        to: primary.email,
        purpose: 'billing.invoice_issued',
        text: `CampusOne invoice ${invoiceNo} for ${inst.name}: ${formatInr(totalPaise)} (GST included), due on ${formatDate(dueOn)}.`,
      })
      .catch((e: unknown) =>
        this.deps.loggers.app.warn('billing.invoice_email_failed', { error: String(e) }),
      );
  }

  // --- SAS-032 ------------------------------------------------------------------------------------
  async recordPayment(
    p: Principal,
    invoicePublicId: string,
    input: { utr: string; amountPaise: number; paidOn: string },
  ) {
    if (!isUuid(invoicePublicId)) throw new NotFoundError();
    const utr = input.utr.trim().toUpperCase();
    if (!/^[A-Z0-9]{10,22}$/.test(utr)) {
      throw new ValidationError([{ field: 'utr', code: 'SAS.UTR_FORMAT' }]);
    }
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    const today = this.today();
    const result = await this.deps.db.transaction().execute(async (trx) => {
      const inv = await repo.byPublicId(trx, uuidToBin(invoicePublicId), true);
      if (!inv) throw new NotFoundError();
      const status = this.effective(
        inv.status,
        dateOnly(inv.due_on)!,
        dateOnly(inv.grace_until_on)!,
        today,
      );
      if (status === 'PAID' || status === 'VOID' || status === 'DRAFT') {
        throw new CustomAPIError(409, 'SAS.INVOICE_NOT_PAYABLE', {
          params: { status: STATUS_LABEL[status] ?? status },
        });
      }
      if (input.paidOn > today) {
        throw new ValidationError([{ field: 'paidOn', code: 'SAS.PAID_ON_FUTURE' }]);
      }
      if (input.paidOn < dateOnly(inv.issued_on)!) {
        throw new ValidationError([{ field: 'paidOn', code: 'SAS.PAID_ON_BEFORE_ISSUE' }]);
      }
      if (input.amountPaise !== Number(inv.total_paise)) {
        throw new ValidationError([
          {
            field: 'amount',
            code: 'SAS.AMOUNT_MISMATCH',
            params: { total: formatInr(Number(inv.total_paise)) },
          },
        ]);
      }
      if (await repo.utrTaken(trx, utr)) throw new CustomAPIError(409, 'SAS.UTR_TAKEN');
      const at = this.now();
      if (!(await repo.markPaid(trx, String(inv.id), at))) {
        throw new CustomAPIError(409, 'SAS.INVOICE_NOT_PAYABLE', {
          params: { status: STATUS_LABEL[inv.status] ?? inv.status },
        });
      }
      await repo.addPayment(trx, {
        publicId: newPublicIdPair().bin,
        institutionId: String(inv.institution_id),
        invoiceId: String(inv.id),
        utr,
        amountPaise: input.amountPaise,
        paidOn: input.paidOn,
        by,
      });
      await recordAudit(trx, {
        institutionId: String(inv.institution_id),
        action: 'INVOICE_PAID',
        entityType: 'invoice',
        entityRef: invoicePublicId,
        after: { invoiceNo: inv.invoice_no, utr, amountPaise: input.amountPaise },
      });
      // Payment restores a suspended institution when nothing else is past due (FR-SAS-08).
      const inst = await institutionsRepository.byId(trx, String(inv.institution_id), true);
      let restored = false;
      const others = inst ? await repo.pastDue(trx, inst.id, today, String(inv.id)) : [];
      if (inst?.status === 'ACTIVE' && others.length === 0) {
        await institutionsRepository.setSubscriptionStatus(trx, inst.id, ['GRACE'], 'ACTIVE');
      }
      if (inst?.status === 'SUSPENDED') {
        if (
          others.length === 0 &&
          (await institutionsRepository.changeStatus(trx, inst.id, 'SUSPENDED', 'ACTIVE', by, at))
        ) {
          await institutionsRepository.setSubscriptionStatus(
            trx,
            inst.id,
            ['SUSPENDED', 'GRACE'],
            'ACTIVE',
          );
          await institutionsRepository.addEvent(trx, {
            institutionId: inst.id,
            action: 'REACTIVATED',
            from: 'SUSPENDED',
            to: 'ACTIVE',
            reason: `Invoice ${inv.invoice_no} paid — payment restores the institution (FR-SAS-08)`,
            actor: by,
            at,
          });
          restored = true;
        }
      }
      return { institutionId: inst ? binToUuid(inst.public_id) : null, restored };
    });
    const list = result.institutionId
      ? await this.list({ institutionId: result.institutionId })
      : { items: [] };
    return {
      invoice: list.items.find((x) => x.id === invoicePublicId)!,
      institutionRestored: result.restored,
    };
  }
}

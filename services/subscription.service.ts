/**
 * Subscriptions after go-live (SRS 25; FR-SAS-05…08, FR-SAS-11; SAS-026, SAS-034…039; prototype
 * c.subscription and o.institutions "Change plan"; client 2026-10-03 "add by default, give a
 * provision to change").
 *
 * - A plan change in a trial applies at once. In a paid period an upgrade applies now with a
 *   prorated invoice for the days left to renewal, or at renewal; a move to a lower-priced plan waits
 *   for renewal. Features outside the new plan are switched off when it applies.
 * - The Institution Administrator sees the plan, usage and invoices (c.subscription), asks CampusOne
 *   for another plan and reports a bank transfer; a platform administrator applies or declines the
 *   request and confirms the transfer (SAS-032).
 * - The billing run (job `subscription-billing`, daily): renewals roll over (applying a change
 *   scheduled for renewal and the plan's current terms), renewal invoices are issued
 *   `sas.renewal.billDaysBefore` days ahead, and unpaid invoices move to Grace and then Overdue with
 *   a reminder each. Suspension stays an operator's decision (prototype: suspended by an operator,
 *   "Invoice unpaid after the grace period").
 */
import type { Kysely } from 'kysely';
import {
  FEATURES,
  INSTITUTION,
  LIMITS,
  MODULES,
  PLAN_CHANGE_REQUEST,
  type ModuleKey,
} from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { MessageSender } from '../integrations/sms.provider';
import type { Database } from '../models/campusone_models';
import { billingRepository } from '../repositories/billing.repository';
import { institutionsRepository as instRepo } from '../repositories/institutions.repository';
import { plansRepository, type PlanTerms } from '../repositories/plans.repository';
import { subscriptionsRepository as repo } from '../repositories/subscriptions.repository';
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
import { addDays, cycleOf, dateOnly, type BillingService } from './billing.service';
import { planDto } from './plans.service';
import { defaultValues, type SettingValues } from './settings.service';

const STATUS_LABEL = Object.fromEntries(INSTITUTION.values.map((v) => [v.code, v.label]));
const REQUEST_LABEL = Object.fromEntries(
  PLAN_CHANGE_REQUEST.values.map((v) => [v.code, v.label.toLowerCase()]),
);

/** The yearly price, to compare a monthly plan with an annual one. */
const annual = (t: PlanTerms) => (t.cycle === 'MONTHLY' ? t.price_paise * 12 : t.price_paise);

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const bool = (v: unknown) => v === true || v === 1 || v === '1';

const personName = (first: string | null, last: string | null) =>
  [first, last].filter(Boolean).join(' ') || null;

/** One institution's line in a job run log (RC-26). */
export interface JobItem {
  readonly institutionId: string | null;
  readonly status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  readonly processed: number;
  readonly failed: number;
  readonly note: string | null;
  readonly errorCode?: string | null;
}

/**
 * Switches off the features a plan doesn't include (prototype ob.inst.plan.save) and records each
 * change; returns the labels switched off.
 */
export async function switchOffOutside(
  trx: Kysely<Database>,
  institutionId: string,
  terms: PlanTerms,
  at: Date,
): Promise<string[]> {
  const current = await instRepo.features(trx, institutionId);
  const off: string[] = [];
  for (const f of FEATURES) {
    const on = bool(current.find((c) => c.feature_key === f.key)?.enabled);
    if (on && f.module && !terms.modules.includes(f.module)) {
      await instRepo.setFeature(trx, institutionId, f.key, false);
      await instRepo.logFeature(trx, {
        institutionId,
        key: f.key,
        from: true,
        to: false,
        reason: `Not included in ${terms.name}`,
        actor: null,
        at,
      });
      off.push(f.label);
    }
  }
  return off;
}

export class SubscriptionService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly loggers: Loggers;
      readonly billing: BillingService;
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

  private actor(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async reasonOf(text: string) {
    const reason = text.trim();
    const min = await this.limit(LIMITS.lifecycleReasonMinLength);
    if (reason.length < min) {
      throw new ValidationError([
        { field: 'reason', code: 'INS.REASON_TOO_SHORT', params: { min } },
      ]);
    }
    return reason;
  }

  /** The caller's own institution (console sessions; the tenant comes from the token). */
  private async own(p: Principal, db: Kysely<Database> = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await instRepo.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  private async institution(publicId: string, db: Kysely<Database>, lock = false) {
    if (!isUuid(publicId)) throw new NotFoundError();
    const row = await instRepo.byPublicId(db, uuidToBin(publicId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  /** A running subscription: the institution is Active and its period has started. */
  private async running(trx: Kysely<Database>, inst: { id: string; status: string }) {
    const sub = await instRepo.subscription(trx, inst.id, true);
    if (
      inst.status !== 'ACTIVE' ||
      !sub?.status ||
      !['TRIAL', 'ACTIVE', 'GRACE'].includes(sub.status)
    ) {
      throw new CustomAPIError(409, 'INS.TRANSITION_INVALID', {
        params: { status: STATUS_LABEL[inst.status] ?? inst.status },
      });
    }
    return sub;
  }

  private async planByPublicId(trx: Kysely<Database>, planId: string) {
    const plans = await plansRepository.plans(trx);
    const to = plans.find((x) => isUuid(planId) && binToUuid(x.public_id) === planId.toLowerCase());
    if (!to) throw new ValidationError([{ field: 'planId', code: 'VALIDATION.FORMAT' }]);
    return to;
  }

  /** E-mails the primary and secondary contacts (FR-SAS-11); failures are logged, never thrown. */
  private async tell(institutionId: string, purpose: string, text: string, primaryOnly = false) {
    if (!this.deps.email) return;
    const contacts = await instRepo.contacts(this.deps.db, institutionId);
    for (const c of contacts) {
      if (!c.email || (primaryOnly && c.kind !== 'PRIMARY')) continue;
      await this.deps.email
        .send({ to: c.email, purpose, text })
        .catch((e: unknown) =>
          this.deps.loggers.app.warn('subscription.email_failed', { purpose, error: String(e) }),
        );
    }
  }

  // --- SAS-034 ------------------------------------------------------------------------------------
  /** A platform administrator changes the plan of a running subscription. */
  async changePlan(
    p: Principal,
    institutionPublicId: string,
    input: { planId: string; timing: 'NOW' | 'RENEWAL'; reason: string },
  ) {
    const reason = await this.reasonOf(input.reason);
    const by = this.actor(p);
    const at = this.now();
    const today = istBusinessDate(at);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.institution(institutionPublicId, trx, true);
      const sub = await this.running(trx, inst);
      const to = await this.planByPublicId(trx, input.planId);
      if (to.id === sub.plan_id) throw new CustomAPIError(409, 'SAS.PLAN_SAME');
      const from = (await plansRepository.atVersion(trx, sub.plan_version_id))!;
      const renews = dateOnly(sub.renews_on);
      let mode: 'NOW' | 'RENEWAL';
      if (sub.status === 'TRIAL' || !renews) mode = 'NOW';
      else if (annual(to) > annual(from)) mode = input.timing;
      else if (input.timing === 'NOW') {
        throw new ValidationError([
          {
            field: 'timing',
            code: 'SAS.DOWNGRADE_AT_RENEWAL',
            params: { date: formatDate(renews) },
          },
        ]);
      } else mode = 'RENEWAL';

      let invoice: Awaited<ReturnType<BillingService['issue']>> | null = null;
      let off: string[] = [];
      if (mode === 'NOW') {
        if (
          !(await repo.switchNow(trx, inst.id, sub.row_version, {
            planId: to.id,
            versionId: to.version_id,
          }))
        ) {
          throw new PreconditionFailedError();
        }
        off = await switchOffOutside(trx, inst.id, to, at);
        // The rest of the cycle is billed at the difference, prorated by day (prototype).
        if (sub.status !== 'TRIAL' && renews) {
          const left = Math.max(0, daysBetween(today, renews));
          const amount = Math.round(((annual(to) - annual(from)) * left) / 365);
          if (amount > 0) {
            const last = addDays(renews, -1);
            invoice = await this.deps.billing.issue(
              trx,
              inst,
              {
                trigger: 'PLAN_CHANGE',
                periodKey: `${today}/${to.code}`,
                periodLabel: `${formatDate(today)} – ${formatDate(last)}`,
                from: today,
                to: last,
                lines: [
                  {
                    description: `${to.name} − ${from.name}, ${left} days prorated`,
                    quantity: 1,
                    unitPricePaise: amount,
                  },
                ],
              },
              by,
            );
          }
        }
        await instRepo.addEvent(trx, {
          institutionId: inst.id,
          action: 'PLAN_CHANGE',
          from: from.name,
          to: to.name,
          reason,
          actor: by,
          at,
        });
      } else {
        await repo.schedule(trx, inst.id, sub.row_version, { versionId: to.version_id, by, at });
        await instRepo.addEvent(trx, {
          institutionId: inst.id,
          action: 'PLAN_CHANGE_SCHEDULED',
          from: from.name,
          to: to.name,
          reason: `${reason} (from ${formatDate(renews!)})`,
          actor: by,
          at,
        });
      }
      await repo.applyPending(trx, inst.id, to.id, {
        by,
        at,
        resolution: mode === 'NOW' ? 'Changed now' : `Changes at renewal on ${formatDate(renews!)}`,
      });
      await recordAudit(trx, {
        institutionId: inst.id,
        action: mode === 'NOW' ? 'PLAN_CHANGED' : 'PLAN_CHANGE_SCHEDULED',
        entityType: 'subscription',
        entityRef: institutionPublicId,
        before: { plan: from.code, version: from.version },
        after: { plan: to.code, version: to.version, effective: mode },
        reason,
      });
      return { inst, mode, renews, invoice, off, from, to };
    });

    const when =
      out.mode === 'NOW' ? 'from today' : `from the renewal on ${formatDate(out.renews!)}`;
    await this.tell(
      out.inst.id,
      'subscription.plan_changed',
      `CampusOne: ${out.inst.name} moves from ${out.from.name} to ${out.to.name} ${when}. Reason: ${reason}`,
    );
    if (out.invoice) {
      await this.deps.billing.notifyIssued(
        institutionPublicId,
        out.invoice.invoiceNo,
        out.invoice.totalPaise,
        out.invoice.dueOn,
      );
    }
    return {
      plan: out.to.name,
      effective: out.mode,
      effectiveOn: out.mode === 'NOW' ? today : out.renews!,
      switchedOff: out.off,
      invoice: out.invoice
        ? {
            id: out.invoice.id,
            invoiceNo: out.invoice.invoiceNo,
            total: toMoneyDto(out.invoice.totalPaise),
            dueOn: out.invoice.dueOn,
          }
        : null,
    };
  }

  // --- SAS-035 ------------------------------------------------------------------------------------
  /** Cancels a change scheduled for renewal. */
  async cancelScheduled(p: Principal, institutionPublicId: string, input: { reason: string }) {
    const reason = await this.reasonOf(input.reason);
    const by = this.actor(p);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.institution(institutionPublicId, trx, true);
      const sub = await instRepo.subscription(trx, inst.id, true);
      if (!sub?.scheduled_plan_version_id) throw new NotFoundError();
      const [current, scheduled] = await Promise.all([
        plansRepository.atVersion(trx, sub.plan_version_id),
        plansRepository.atVersion(trx, sub.scheduled_plan_version_id),
      ]);
      await repo.schedule(trx, inst.id, sub.row_version, { versionId: null, by: null, at: null });
      await instRepo.addEvent(trx, {
        institutionId: inst.id,
        action: 'PLAN_CHANGE_CANCELLED',
        from: scheduled?.name ?? null,
        to: current?.name ?? null,
        reason,
        actor: by,
        at,
      });
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'PLAN_CHANGE_CANCELLED',
        entityType: 'subscription',
        entityRef: institutionPublicId,
        before: { scheduled: scheduled?.code ?? null },
        reason,
      });
    });
    return { cancelled: true };
  }

  // --- SAS-036 ------------------------------------------------------------------------------------
  /** A platform administrator declines an institution's plan change request. */
  async declineRequest(p: Principal, requestPublicId: string, input: { reason: string }) {
    const reason = await this.reasonOf(input.reason);
    if (!isUuid(requestPublicId)) throw new NotFoundError();
    const by = this.actor(p);
    const at = this.now();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const r = await repo.requestByPublicId(trx, uuidToBin(requestPublicId), true);
      if (!r) throw new NotFoundError();
      if (!(await repo.resolveRequest(trx, r.id, 'DECLINED', { by, at, resolution: reason }))) {
        throw new CustomAPIError(409, 'SAS.REQUEST_CLOSED', {
          params: { status: REQUEST_LABEL[r.status] ?? r.status },
        });
      }
      await recordAudit(trx, {
        institutionId: String(r.institution_id),
        action: 'PLAN_CHANGE_REQUEST_DECLINED',
        entityType: 'plan_change_request',
        entityRef: requestPublicId,
        reason,
      });
      const plan = (await plansRepository.plans(trx)).find((x) => x.id === r.plan_id);
      return { institutionId: String(r.institution_id), plan: plan?.name ?? '' };
    });
    await this.tell(
      out.institutionId,
      'subscription.request_declined',
      `CampusOne declined your request to move to ${out.plan}. Reason: ${reason}`,
      true,
    );
    return { status: 'DECLINED' as const };
  }

  // --- SAS-026 ------------------------------------------------------------------------------------
  /** The console's Plan & billing page: plan, period, usage, invoices and requests. */
  async consoleSummary(p: Principal) {
    const db = this.deps.db;
    const inst = await this.own(p);
    const sub = await instRepo.subscription(db, inst.id);
    const plans = await plansRepository.plans(db);
    const current = sub ? plans.find((x) => x.id === sub.plan_id) : undefined;
    const terms = sub?.status
      ? ((await plansRepository.atVersion(db, sub.plan_version_id)) ?? current)
      : current;
    const scheduled = sub?.scheduled_plan_version_id
      ? await plansRepository.atVersion(db, sub.scheduled_plan_version_id)
      : undefined;
    const [members, storageBytes, since, requests, invoices, values, profile] = await Promise.all([
      instRepo.memberCount(db, inst.id),
      repo.storageBytes(db, inst.id),
      repo.since(db, inst.id),
      repo.requests(db, inst.id),
      this.deps.billing.list({ institutionId: binToUuid(inst.public_id) }),
      this.deps.settings ? this.deps.settings.values() : Promise.resolve(defaultValues()),
      this.deps.billing.profile(),
    ]);
    const v = (l: { key: string; value: number }) => values[l.key] ?? l.value;
    return {
      institution: { name: inst.name, status: inst.status },
      subscription: sub
        ? {
            status: sub.status,
            since: since ? since.toISOString() : null,
            periodStart: dateOnly(sub.current_period_start_on),
            periodEnd: dateOnly(sub.current_period_end_on),
            renewsOn: dateOnly(sub.renews_on),
            trialEndsOn: dateOnly(sub.trial_ends_on),
          }
        : null,
      plan: terms ? planDto(terms) : null,
      modules: MODULES.map((m: ModuleKey) => ({
        module: m,
        included: terms ? terms.modules.includes(m) : false,
      })),
      scheduledChange:
        scheduled && sub?.renews_on ? { plan: scheduled.name, on: dateOnly(sub.renews_on)! } : null,
      usage: {
        members,
        // SMS and WhatsApp are counted from the communication log (Phase 8).
        sms: null,
        whatsapp: null,
        storageBytes,
      },
      billing: {
        renewalBillDaysBefore: v(LIMITS.renewalBillDaysBefore),
        dueDays: v(LIMITS.invoiceDueDays),
        graceDays: v(LIMITS.invoiceGraceDays),
        gstPercent: (v(LIMITS.invoiceGstBp) / 100).toFixed(2),
        smsOverage: toMoneyDto(v(LIMITS.overageSmsPaise)),
        whatsappOverage: toMoneyDto(v(LIMITS.overageWhatsappPaise)),
      },
      payee: { ...profile.payee, example: profile.example },
      plans: plans.map((x) => planDto(x)),
      invoices: invoices.items,
      requests: requests.map((r) => ({
        id: binToUuid(r.public_id),
        plan: { id: binToUuid(r.plan_public_id), name: r.plan_name },
        timing: r.timing,
        note: r.note,
        status: r.status,
        requestedAt: new Date(r.requested_at).toISOString(),
        requestedBy: personName(r.first_name, r.last_name) ?? r.email ?? null,
        resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
        resolution: r.resolution,
      })),
    };
  }

  /** The plan change requests of an institution (back office detail). */
  async requestsOf(institutionId: string) {
    const rows = await repo.requests(this.deps.db, institutionId, 10);
    return rows.map((r) => ({
      id: binToUuid(r.public_id),
      plan: { id: binToUuid(r.plan_public_id), name: r.plan_name },
      timing: r.timing,
      note: r.note,
      status: r.status,
      requestedAt: new Date(r.requested_at).toISOString(),
      requestedBy: personName(r.first_name, r.last_name) ?? r.email ?? null,
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
      resolution: r.resolution,
    }));
  }

  // --- SAS-042 ------------------------------------------------------------------------------------
  /** The institution's own invoice as a PDF. */
  async document(p: Principal, invoicePublicId: string) {
    const inst = await this.own(p);
    return this.deps.billing.document(invoicePublicId, inst.id);
  }

  // --- SAS-037 ------------------------------------------------------------------------------------
  /** The Institution Administrator asks CampusOne for another plan. */
  async requestChange(
    p: Principal,
    input: { planId: string; timing: 'NOW' | 'RENEWAL'; note?: string | null | undefined },
  ) {
    const by = this.actor(p);
    if (!by) throw new NotFoundError();
    const at = this.now();
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const sub = await this.running(trx, inst);
      const to = await this.planByPublicId(trx, input.planId);
      if (to.id === sub.plan_id) throw new CustomAPIError(409, 'SAS.PLAN_SAME');
      if (await repo.pendingRequest(trx, inst.id)) {
        throw new CustomAPIError(409, 'SAS.REQUEST_PENDING');
      }
      await repo.insertRequest(trx, {
        publicId: pub.bin,
        institutionId: inst.id,
        planId: to.id,
        timing: input.timing,
        note: input.note?.trim() || null,
        by,
        at,
      });
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'PLAN_CHANGE_REQUESTED',
        entityType: 'plan_change_request',
        entityRef: pub.id,
        after: { plan: to.code, timing: input.timing },
      });
    });
    return { id: pub.id, status: 'PENDING' as const };
  }

  // --- SAS-038 ------------------------------------------------------------------------------------
  async withdrawRequest(p: Principal, requestPublicId: string) {
    if (!isUuid(requestPublicId)) throw new NotFoundError();
    const by = this.actor(p);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx);
      const r = await repo.requestByPublicId(trx, uuidToBin(requestPublicId), true);
      // Another institution's request is not found (tenant isolation).
      if (!r || String(r.institution_id) !== String(inst.id)) throw new NotFoundError();
      if (!(await repo.resolveRequest(trx, r.id, 'WITHDRAWN', { by, at, resolution: null }))) {
        throw new CustomAPIError(409, 'SAS.REQUEST_CLOSED', {
          params: { status: REQUEST_LABEL[r.status] ?? r.status },
        });
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'PLAN_CHANGE_REQUEST_WITHDRAWN',
        entityType: 'plan_change_request',
        entityRef: requestPublicId,
      });
    });
  }

  // --- SAS-039 ------------------------------------------------------------------------------------
  /** The institution reports a bank transfer; a platform administrator confirms it (SAS-032). */
  async reportTransfer(
    p: Principal,
    invoicePublicId: string,
    input: { utr: string; paidOn: string },
  ) {
    if (!isUuid(invoicePublicId)) throw new NotFoundError();
    const utr = input.utr.trim().toUpperCase();
    if (!/^[A-Z0-9]{10,22}$/.test(utr)) {
      throw new ValidationError([{ field: 'utr', code: 'SAS.UTR_FORMAT' }]);
    }
    const by = this.actor(p);
    const at = this.now();
    const today = istBusinessDate(at);
    const inst = await this.deps.db.transaction().execute(async (trx) => {
      const own = await this.own(p, trx);
      const inv = await billingRepository.byPublicId(trx, uuidToBin(invoicePublicId), true);
      if (!inv || String(inv.institution_id) !== String(own.id)) throw new NotFoundError();
      const status = this.deps.billing.effective(
        inv.status,
        dateOnly(inv.due_on)!,
        dateOnly(inv.grace_until_on)!,
        today,
      );
      if (status === 'PAID' || status === 'VOID' || status === 'DRAFT') {
        throw new CustomAPIError(409, 'SAS.INVOICE_NOT_PAYABLE', {
          params: { status: status === 'PAID' ? 'Paid' : status === 'VOID' ? 'Void' : 'Draft' },
        });
      }
      if (input.paidOn > today) {
        throw new ValidationError([{ field: 'paidOn', code: 'SAS.PAID_ON_FUTURE' }]);
      }
      if (input.paidOn < dateOnly(inv.issued_on)!) {
        throw new ValidationError([{ field: 'paidOn', code: 'SAS.PAID_ON_BEFORE_ISSUE' }]);
      }
      if (await billingRepository.utrTaken(trx, utr)) {
        throw new CustomAPIError(409, 'SAS.UTR_TAKEN');
      }
      await billingRepository.reportTransfer(trx, String(inv.id), {
        utr,
        paidOn: input.paidOn,
        by,
        at,
      });
      await recordAudit(trx, {
        institutionId: own.id,
        action: 'INVOICE_TRANSFER_REPORTED',
        entityType: 'invoice',
        entityRef: invoicePublicId,
        after: { invoiceNo: inv.invoice_no, utr, paidOn: input.paidOn },
      });
      return own;
    });
    const list = await this.deps.billing.list({ institutionId: binToUuid(inst.public_id) });
    return list.items.find((x) => x.id === invoicePublicId)!;
  }

  // --- job subscription-billing -------------------------------------------------------------------
  /** The daily billing run for the business date `periodKey` (YYYY-MM-DD, IST). */
  async billingRun(ctx: { periodKey: string; item(i: JobItem): void }) {
    const today = ctx.periodKey;
    const db = this.deps.db;
    const billing = this.deps.billing;
    const ahead = await this.limit(LIMITS.renewalBillDaysBefore);
    const at = this.now();

    // 1. Renewals roll over; renewal invoices go out ahead of the date.
    for (const s of await repo.running(db)) {
      try {
        const done = await db.transaction().execute(async (trx) => {
          const notes: string[] = [];
          const issued: { invoiceNo: string; totalPaise: number; dueOn: string }[] = [];
          const inst = { id: s.institution_id, public_id: s.public_id, name: s.name };
          let sub = await instRepo.subscription(trx, s.institution_id, true);
          for (let guard = 0; guard < 36; guard++) {
            const renews = dateOnly(sub?.renews_on);
            if (!sub || !renews || renews > today) break;
            if (sub.status !== 'ACTIVE' && sub.status !== 'GRACE') break;
            const terms = await billing.nextTerms(trx, sub);
            if (!terms) break;
            // The period's invoice is normally issued ahead; a missed one is issued now.
            if (!(await billingRepository.exists(trx, s.institution_id, 'RENEWAL', renews))) {
              issued.push(await billing.renewalInvoice(trx, inst, sub, null));
            }
            const before = await plansRepository.atVersion(trx, sub.plan_version_id);
            const cycle = cycleOf(renews, terms.cycle);
            await repo.rollOver(trx, s.institution_id, renews, {
              planId: terms.id,
              versionId: terms.version_id,
              start: renews,
              end: cycle.to,
              renews: cycle.renews,
            });
            if (terms.version_id !== sub.plan_version_id) {
              const off = await switchOffOutside(trx, s.institution_id, terms, at);
              await instRepo.addEvent(trx, {
                institutionId: s.institution_id,
                action: 'PLAN_CHANGE',
                from: before?.name ?? null,
                to: terms.name,
                reason: `Applied at renewal on ${formatDate(renews)}${off.length ? ` · switched off: ${off.join(', ')}` : ''}`,
                actor: null,
                at,
              });
            }
            notes.push(`renewed ${formatDate(renews)} on ${terms.name}`);
            sub = await instRepo.subscription(trx, s.institution_id, true);
          }
          const next = dateOnly(sub?.renews_on);
          if (
            sub &&
            next &&
            (sub.status === 'ACTIVE' || sub.status === 'GRACE') &&
            addDays(next, -ahead) <= today &&
            !(await billingRepository.exists(trx, s.institution_id, 'RENEWAL', next))
          ) {
            issued.push(await billing.renewalInvoice(trx, inst, sub, null));
          }
          for (const i of issued) notes.push(`invoice ${i.invoiceNo}`);
          return { notes, issued };
        });
        for (const i of done.issued) {
          await billing.notifyIssued(binToUuid(s.public_id), i.invoiceNo, i.totalPaise, i.dueOn);
        }
        ctx.item({
          institutionId: s.institution_id,
          status: done.notes.length ? 'SUCCESS' : 'SKIPPED',
          processed: done.notes.length,
          failed: 0,
          note: done.notes.length ? done.notes.join('; ').slice(0, 500) : 'nothing due',
        });
      } catch (e) {
        this.deps.loggers.job.error('subscription-billing renewal failed', {
          institution: s.institution_id,
          error: String(e),
        });
        ctx.item({
          institutionId: s.institution_id,
          status: 'FAILED',
          processed: 0,
          failed: 1,
          note: 'renewal failed',
          errorCode: e instanceof CustomAPIError ? e.code : 'ERROR',
        });
      }
    }

    // 2. Unpaid invoices: Grace after the due date, Overdue after the grace, one reminder each.
    for (const inv of await billingRepository.forReminders(db, today)) {
      try {
        const due = dateOnly(inv.due_on)!;
        const grace = dateOnly(inv.grace_until_on)!;
        const sent = await db.transaction().execute(async (trx) => {
          const out: ('GRACE' | 'OVERDUE')[] = [];
          let stage = inv.reminder_stage;
          let status = inv.status;
          if (stage === 0 && today > due) {
            if (
              await billingRepository.advanceReminder(
                trx,
                inv.id,
                { stage: 0, status },
                { stage: 1, status: 'GRACE' },
              )
            ) {
              stage = 1;
              status = 'GRACE';
              await instRepo.setSubscriptionStatus(trx, inv.institution_id, ['ACTIVE'], 'GRACE');
              await instRepo.addEvent(trx, {
                institutionId: inv.institution_id,
                action: 'GRACE_STARTED',
                from: null,
                to: null,
                reason: `Invoice ${inv.invoice_no} overdue — ${daysBetween(due, grace)}-day grace period`,
                actor: null,
                at,
              });
              if (today <= grace) out.push('GRACE');
            }
          }
          if (stage === 1 && today > grace) {
            if (
              await billingRepository.advanceReminder(
                trx,
                inv.id,
                { stage: 1, status },
                { stage: 2, status: 'OVERDUE' },
              )
            ) {
              await instRepo.addEvent(trx, {
                institutionId: inv.institution_id,
                action: 'GRACE_ENDED',
                from: null,
                to: null,
                reason: `Invoice ${inv.invoice_no} unpaid after the grace period`,
                actor: null,
                at,
              });
              out.push('OVERDUE');
            }
          }
          return out;
        });
        const total = formatInr(Number(inv.total_paise));
        for (const k of sent) {
          await this.tell(
            inv.institution_id,
            k === 'GRACE' ? 'billing.grace_reminder' : 'billing.overdue_notice',
            k === 'GRACE'
              ? `Reminder: CampusOne invoice ${inv.invoice_no} for ${inv.institution_name} (${total}) is overdue. Please pay by ${formatDate(grace)}; after the grace period ${inv.institution_name} may be suspended until it is paid.`
              : `CampusOne invoice ${inv.invoice_no} for ${inv.institution_name} (${total}) is unpaid after the grace period. CampusOne may suspend ${inv.institution_name}: members can't sign in, pay or be paid until it is paid.`,
            true,
          );
        }
        ctx.item({
          institutionId: inv.institution_id,
          status: sent.length ? 'SUCCESS' : 'SKIPPED',
          processed: sent.length,
          failed: 0,
          note: sent.length
            ? `${inv.invoice_no}: ${sent.map((k) => (k === 'GRACE' ? 'grace reminder' : 'overdue notice')).join(', ')}`
            : null,
        });
      } catch (e) {
        this.deps.loggers.job.error('subscription-billing reminder failed', {
          invoice: inv.invoice_no,
          error: String(e),
        });
        ctx.item({
          institutionId: inv.institution_id,
          status: 'FAILED',
          processed: 0,
          failed: 1,
          note: `${inv.invoice_no}: reminder failed`,
          errorCode: e instanceof CustomAPIError ? e.code : 'ERROR',
        });
      }
    }
  }
}

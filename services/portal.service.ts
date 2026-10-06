/**
 * The customer portal (SRS 4.10, FR-SAS-04…11, FR-INS-01…03; SAS-001…021; prototype s.*): an
 * institution signs itself up, finishes its onboarding checklist, goes live on a trial or with the
 * first invoice, changes plan, pays (bank transfer until the gateway, Q17), reads its notices and
 * asks RingPe to change its name or address.
 *
 * - Sign-up uses the administrator's own RingPe account (the one they use in the app), verified by
 *   a code to its mobile; an account that already belongs to an institution is refused (BR-01).
 *   The page is public, so a refusal never names the other institution.
 * - The portal reuses the operator's and the console's rules: registration (INS-001), checklist
 *   steps, lifecycle (INS-005), plan changes (SAS-034/035), invoices and transfer reports.
 * - The fee-account step records the account the institution names (masked); the merchant that
 *   receives fees is created with the fees module (Phase 4/5).
 */
import type { Kysely } from 'kysely';
import { CHECKLIST, FEATURES, LIMITS, type ChecklistKey } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository as repo } from '../repositories/institutions.repository';
import { raiseApproval } from './approvals.service';
import type { AcademicsService } from './academics.service';
import { recordAudit } from './audit.service';
import type { BillingService } from './billing.service';
import type { InstitutionSetupService } from './institution-setup.service';
import type { InstitutionsService } from './institutions.service';
import type { OtpService } from './otp.service';
import { planDto, type PlansService } from './plans.service';
import type { ClientContext, SessionService } from './session.service';
import { defaultValues, type SettingValues } from './settings.service';
import type { SubscriptionService } from './subscription.service';
import { plansRepository } from '../repositories/plans.repository';
import {
  ConflictError,
  CustomAPIError,
  NotFoundError,
  ValidationError,
} from '../utils/CustomAPIError';
import type { FlowTokens } from '../utils/flow-tokens';
import { IFSC_PATTERN } from '../utils/gst';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

export const TERMS_VERSION = '2026-10';

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const personName = (first: string | null, last: string | null) =>
  titleCase([first, last].filter(Boolean).join(' '));
const maskMobile = (m: string) => `${'•'.repeat(6)}${m.slice(-4)}`;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface PortalSignupInput {
  readonly signupToken: string;
  readonly institution: {
    readonly name: string;
    readonly address: string;
    readonly city: string;
    readonly pinCode: string;
    readonly board: string;
    readonly students: number;
  };
  readonly primaryContact: { name: string; email: string; mobile: string };
  readonly secondaryContact?: { name: string; email: string; mobile: string } | null | undefined;
  readonly planId: string;
  readonly start: 'TRIAL' | 'PAY';
  readonly accept: { subscription: boolean; dataProcessing: boolean; authorised: boolean };
}

export type PortalStepInput =
  | { readonly key: 'toggles'; readonly features: Readonly<Record<string, boolean>> }
  | {
      readonly key: 'usertypes';
      readonly userTypes: readonly {
        name: string;
        category: 'STUDENT' | 'PARENT' | 'TEACHER' | 'STAFF' | 'MANAGEMENT' | 'CREW' | 'OTHER';
        departments: readonly string[];
      }[];
    }
  | {
      readonly key: 'year';
      readonly label?: string;
      readonly startsOn?: string;
      readonly endsOn?: string;
    }
  | {
      readonly key: 'feeacct';
      readonly name: string;
      readonly bank: string;
      readonly ifsc: string;
      readonly accountNo: string;
    }
  | { readonly key: 'branding'; readonly logoFileId?: string | undefined }
  | { readonly key: 'firstusers' };

export class PortalService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly loggers: Loggers;
      readonly otp: OtpService;
      readonly flows: FlowTokens;
      readonly sessions: SessionService;
      readonly institutions: InstitutionsService;
      readonly setup: InstitutionSetupService;
      readonly academics: AcademicsService;
      readonly subscriptions: SubscriptionService;
      readonly billing: BillingService;
      readonly plans: PlansService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private async inst(p: Principal, db: Kysely<Database> = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await repo.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  // --- SAS-001 ------------------------------------------------------------------------------------
  /** The plans one can sign up for: terms in force, without the operator's figures. */
  async plans() {
    const plans = await plansRepository.plans(this.deps.db);
    return {
      items: plans.map((p) => {
        const dto: Partial<ReturnType<typeof planDto>> = { ...planDto(p) };
        delete dto.etag;
        delete dto.version;
        return dto;
      }),
      graceDays: await this.limit(LIMITS.invoiceGraceDays),
      dueDays: await this.limit(LIMITS.invoiceDueDays),
    };
  }

  // --- SAS-002 / SAS-003 --------------------------------------------------------------------------
  private async signupAccount(mobile: string) {
    const account = await this.deps.db
      .selectFrom('platform_accounts')
      .select(['id', 'public_id', 'first_name', 'last_name', 'email', 'mobile', 'status'])
      .where('mobile', '=', mobile)
      .executeTakeFirst();
    if (!account || account.status !== 'ACTIVE') {
      throw new CustomAPIError(404, 'SAS.SIGNUP_NO_ACCOUNT');
    }
    const busy =
      (await repo.hasInstitutionProfile(this.deps.db, String(account.id))) ||
      (await repo.isOperator(this.deps.db, String(account.id)));
    if (busy) throw new CustomAPIError(409, 'SAS.SIGNUP_ACCOUNT_IN_USE');
    return account;
  }

  /** The administrator's RingPe account: a code goes to its mobile. */
  async signupOtp(input: { mobile: string }) {
    const account = await this.signupAccount(input.mobile);
    const challenge = await this.deps.otp.issue({
      purpose: 'PORTAL_SIGNUP',
      channel: 'SMS',
      destination: account.mobile,
      accountId: String(account.id),
      reuseLive: true,
    });
    return challenge;
  }

  async signupVerify(input: { challengeId: string; otp: string }) {
    const v = await this.deps.otp.verify(input.challengeId, input.otp, 'PORTAL_SIGNUP');
    if (!v.accountId) throw new CustomAPIError(401, 'SAS.SIGNUP_EXPIRED');
    const account = await this.deps.db
      .selectFrom('platform_accounts')
      .select(['id', 'public_id', 'first_name', 'last_name', 'email', 'mobile'])
      .where('id', '=', v.accountId)
      .executeTakeFirstOrThrow();
    // The account may have joined an institution in the meantime.
    await this.signupAccount(account.mobile);
    const { token, expiresAt } = await this.deps.flows.issue(
      'portal-signup',
      { acc: binToUuid(account.public_id) },
      30 * 60,
    );
    return {
      signupToken: token,
      expiresAt: expiresAt.toISOString(),
      account: {
        name: personName(account.first_name, account.last_name),
        email: account.email,
        mobile: maskMobile(account.mobile),
      },
    };
  }

  // --- SAS-004 ------------------------------------------------------------------------------------
  /** Registers the institution with the verified account as its first administrator and signs in. */
  async signup(input: PortalSignupInput, client: ClientContext = {}) {
    const claims = await this.deps.flows.verify('portal-signup', input.signupToken);
    const acc = claims?.['acc'];
    if (typeof acc !== 'string' || !isUuid(acc)) {
      throw new CustomAPIError(401, 'SAS.SIGNUP_EXPIRED');
    }
    if (!input.accept.subscription || !input.accept.dataProcessing || !input.accept.authorised) {
      throw new ValidationError([{ field: 'accept', code: 'SAS.TERMS_REQUIRED' }]);
    }
    const account = await this.deps.db
      .selectFrom('platform_accounts')
      .select(['id', 'public_id', 'email', 'mobile', 'first_name', 'last_name'])
      .where('public_id', '=', uuidToBin(acc))
      .executeTakeFirst();
    if (!account?.email) throw new CustomAPIError(401, 'SAS.SIGNUP_EXPIRED');
    await this.signupAccount(account.mobile);
    const actor: Principal = {
      subject: acc,
      surface: 'portal',
      sessionId: 'portal-signup',
      subTasks: [],
    };
    const i = input.institution;
    const out = await this.deps.institutions.register(actor, {
      name: i.name,
      address: i.address,
      city: i.city,
      board: i.board,
      primaryContact: input.primaryContact,
      ...(input.secondaryContact ? { secondaryContact: input.secondaryContact } : {}),
      adminEmail: account.email,
      planId: input.planId,
    });
    const at = this.now();
    const row = (await repo.byPublicId(this.deps.db, uuidToBin(out.id)))!;
    await this.deps.db
      .updateTable('institutions')
      .set({
        pin_code: i.pinCode,
        signup_source: 'PORTAL',
        start_preference: input.start,
        students_estimate: i.students,
        terms_version: TERMS_VERSION,
        terms_accepted_at: at,
      })
      .where('id', '=', row.id)
      .execute();
    await recordAudit(this.deps.db, {
      institutionId: row.id,
      action: 'PORTAL_SIGNUP',
      entityType: 'institution',
      entityRef: out.id,
      after: { start: input.start, terms: TERMS_VERSION, students: i.students },
      actor: { type: 'portal', ref: acc },
    });
    const admin = await repo.administrator(this.deps.db, row.id);
    const profile = await this.deps.db
      .selectFrom('member_profiles')
      .select(['id', 'public_id'])
      .where('institution_id', '=', row.id)
      .where('account_id', '=', String(account.id))
      .executeTakeFirstOrThrow();
    const tokens = await this.deps.sessions.start(
      {
        accountId: String(account.id),
        accountPublicId: acc,
        surface: 'portal',
        institution: { id: row.id, publicId: out.id },
        profile: { id: String(profile.id), publicId: binToUuid(profile.public_id) },
      },
      client,
    );
    return {
      institutionId: out.id,
      identifier: out.identifier,
      name: admin ? personName(admin.first_name, admin.last_name) : row.name,
      tokens,
    };
  }

  // --- SAS-008 ------------------------------------------------------------------------------------
  /** The checklist with who does each step and a one-line summary of what was done. */
  async onboarding(p: Principal) {
    const row = await this.inst(p);
    const [done, features, members, year, settings] = await Promise.all([
      repo.stepsDone(this.deps.db, row.id),
      repo.features(this.deps.db, row.id),
      repo.memberCount(this.deps.db, row.id),
      this.deps.db
        .selectFrom('academic_years')
        .select(['label', 'starts_on', 'ends_on'])
        .where('institution_id', '=', row.id)
        .where('is_current', '=', 1)
        .executeTakeFirst(),
      repo.settings(this.deps.db, row.id),
    ]);
    const types = await this.deps.db
      .selectFrom('user_types as t')
      .leftJoin('departments as d', 'd.user_type_id', 't.id')
      .select(['t.id', 'd.id as dep'])
      .where('t.institution_id', '=', row.id)
      .execute();
    const on = features.filter((f) => Number(f.enabled) === 1).length;
    const summary: Partial<Record<ChecklistKey, string>> = {
      details: `${row.city}${row.board ? ` · ${row.board}` : ''}`,
      bank: row.corporate_code
        ? `Corporate code ${row.corporate_code}${row.pool_account_ref ? ` · ${row.pool_account_ref}` : ''}`
        : 'Being set up by RingPe',
      toggles: `${on} of ${FEATURES.length} features on`,
      usertypes: `${new Set(types.map((t) => t.id)).size} user types · ${types.filter((t) => t.dep !== null).length} departments`,
      year: year ? `${year.label}` : '',
      branding: settings?.logo_public_id ? 'Logo uploaded' : '',
      firstusers: `${members} members`,
    };
    const steps = CHECKLIST.map((c) => {
      const d = done.find((x) => x.step_key === c.key);
      return {
        key: c.key,
        label: c.label,
        required: c.required,
        byRingPe: c.key === 'bank' || c.key === 'details',
        done: Boolean(d),
        doneAt: iso(d?.done_at),
        summary: d?.note ?? summary[c.key] ?? '',
      };
    });
    const missing = steps.filter((s) => s.required && !s.done);
    // The features step shows the plan's features with their switches (as the console does).
    const view = await this.deps.institutions.consoleView(p);
    return {
      status: row.status,
      startPreference: row.start_preference,
      steps,
      done: steps.filter((s) => s.done).length,
      total: steps.length,
      canGoLive: row.status === 'PENDING_ACTIVATION' && missing.length === 0,
      missing: missing.map((s) => s.label),
      plan: view.plan,
      features: view.features,
      version: view.version,
    };
  }

  // --- SAS-009 ------------------------------------------------------------------------------------
  /** Completes one of the institution's checklist steps with what the step needs. */
  async completeStep(p: Principal, input: PortalStepInput) {
    const row = await this.inst(p);
    const instId = binToUuid(row.public_id);
    let note: string | undefined;
    switch (input.key) {
      case 'toggles': {
        await this.deps.institutions.updateConsole(p, row.row_version, {
          features: input.features,
        });
        const on = (await repo.features(this.deps.db, row.id)).filter(
          (f) => Number(f.enabled) === 1,
        ).length;
        note = `${on} of ${FEATURES.length} features on`;
        break;
      }
      case 'usertypes': {
        const existing = await this.deps.setup.userTypes(p);
        for (const t of input.userTypes) {
          if (existing.items.some((x) => x.name.toLowerCase() === t.name.trim().toLowerCase())) {
            continue;
          }
          await this.deps.setup.createUserType(p, {
            name: t.name,
            category: t.category,
            departments: t.departments,
          });
        }
        const now = await this.deps.setup.userTypes(p);
        const deps = now.items.reduce((n, x) => n + x.departments.length, 0);
        note = `${now.items.length} user types · ${deps} departments`;
        break;
      }
      case 'year': {
        const years = await this.deps.academics.years(p);
        let current = years.items.find((y) => y.current);
        if (input.label && input.startsOn && input.endsOn && input.label !== current?.label) {
          const made = await this.deps.academics.createYear(p, {
            label: input.label,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
          });
          if (!made.current) {
            await this.deps.academics.yearAction(p, made.id, {
              action: 'MAKE_CURRENT',
              reason: 'Declared from the customer portal',
            });
          }
          current = (await this.deps.academics.years(p)).items.find((y) => y.current);
        }
        if (!current) throw new CustomAPIError(409, 'ACA.NO_CURRENT_YEAR');
        note = `${current.label} · ${current.startsOn} – ${current.endsOn}`;
        break;
      }
      case 'feeacct': {
        const ifsc = input.ifsc.trim().toUpperCase();
        const acct = input.accountNo.replace(/\s+/g, '');
        const errors = [];
        if (!IFSC_PATTERN.test(ifsc))
          errors.push({ field: 'ifsc', code: 'IDN.IFSC_INVALID' as const });
        if (!/^\d{9,18}$/.test(acct)) {
          errors.push({ field: 'accountNo', code: 'VALIDATION.FORMAT' as const });
        }
        if (!input.name.trim())
          errors.push({ field: 'name', code: 'VALIDATION.REQUIRED' as const });
        if (errors.length) throw new ValidationError(errors);
        // Only the masked number is kept until the fee merchant exists (fees module).
        note = `${input.name.trim()} · ${input.bank.trim()} ••${acct.slice(-4)} · ${ifsc}`;
        break;
      }
      case 'branding': {
        if (input.logoFileId) {
          await this.deps.institutions.setLogo(p, { fileId: input.logoFileId });
        }
        note = input.logoFileId ? 'Logo uploaded' : 'No logo';
        break;
      }
      case 'firstusers': {
        const members = await repo.memberCount(this.deps.db, row.id);
        note = `${members} members`;
        break;
      }
    }
    await this.deps.institutions.markStep(p, instId, input.key, { note });
    return this.onboarding(p);
  }

  // --- SAS-010 ------------------------------------------------------------------------------------
  /** Go live: a trial, or straight to Active with the first invoice (due in the set days). */
  async goLive(p: Principal, input: { mode: 'TRIAL' | 'PAY' }) {
    const row = await this.inst(p);
    const out = await this.deps.institutions.lifecycle(p, binToUuid(row.public_id), {
      action: input.mode === 'TRIAL' ? 'START_TRIAL' : 'ACTIVATE',
      reason:
        input.mode === 'TRIAL'
          ? 'Gone live from the customer portal with a free trial'
          : 'Gone live from the customer portal; the first invoice is issued',
    });
    return { status: out.status, invoice: out.invoice };
  }

  // --- SAS-007 ------------------------------------------------------------------------------------
  /** Overview: status, plan and period, usage, open invoices, checklist progress, recent notices. */
  async account(p: Principal) {
    const row = await this.inst(p);
    const [billing, onboarding, notices] = await Promise.all([
      this.deps.subscriptions.consoleSummary(p),
      this.onboarding(p),
      this.notices(p),
    ]);
    return {
      institution: {
        id: binToUuid(row.public_id),
        identifier: row.identifier,
        name: row.name,
        city: row.city,
        status: row.status,
        signupSource: row.signup_source,
        startPreference: row.start_preference,
        since: iso(row.created_at),
      },
      billing,
      onboarding: {
        done: onboarding.done,
        total: onboarding.total,
        canGoLive: onboarding.canGoLive,
        missing: onboarding.missing,
      },
      notices: notices.items.slice(0, 5),
    };
  }

  // --- SAS-011 / SAS-012 / SAS-013 ----------------------------------------------------------------
  async subscription(p: Principal) {
    return this.deps.subscriptions.consoleSummary(p);
  }

  /** Before go-live the plan is simply replaced; afterwards the operator's rules apply (SAS-034). */
  async changePlan(p: Principal, input: { planId: string; timing: 'NOW' | 'RENEWAL' }) {
    const row = await this.inst(p);
    const id = binToUuid(row.public_id);
    if (row.status === 'PENDING_ACTIVATION') {
      await this.deps.institutions.edit(p, id, row.row_version, {
        planId: input.planId,
        reason: 'Plan chosen in the customer portal',
      });
    } else {
      await this.deps.subscriptions.changePlan(p, id, {
        planId: input.planId,
        timing: input.timing,
        reason: 'Changed by the institution in the customer portal',
      });
    }
    return this.subscription(p);
  }

  async cancelScheduled(p: Principal) {
    const row = await this.inst(p);
    await this.deps.subscriptions.cancelScheduled(p, binToUuid(row.public_id), {
      reason: 'Undone by the institution in the customer portal',
    });
  }

  // --- SAS-014 / SAS-015 / SAS-016 / SAS-017 ------------------------------------------------------
  async invoices(p: Principal) {
    const row = await this.inst(p);
    return this.deps.billing.list({ institutionId: binToUuid(row.public_id) });
  }

  async invoice(p: Principal, invoiceId: string) {
    const all = await this.invoices(p);
    const inv = all.items.find((x) => x.id === invoiceId.toLowerCase());
    if (!inv) throw new NotFoundError();
    return inv;
  }

  async invoicePdf(p: Principal, invoiceId: string) {
    const row = await this.inst(p);
    if (!isUuid(invoiceId)) throw new NotFoundError();
    return this.deps.billing.document(invoiceId, row.id);
  }

  /** Bank transfer reported (RingPe confirms it); online payment arrives with the gateway (Q17). */
  async pay(
    p: Principal,
    invoiceId: string,
    input: {
      method: 'BANK_TRANSFER' | 'GATEWAY';
      utr?: string | undefined;
      paidOn?: string | undefined;
    },
  ) {
    if (input.method === 'GATEWAY') throw new CustomAPIError(409, 'SAS.GATEWAY_UNAVAILABLE');
    if (!input.utr || !input.paidOn) {
      throw new ValidationError([
        ...(!input.utr ? [{ field: 'utr', code: 'VALIDATION.REQUIRED' as const }] : []),
        ...(!input.paidOn ? [{ field: 'paidOn', code: 'VALIDATION.REQUIRED' as const }] : []),
      ]);
    }
    await this.deps.subscriptions.reportTransfer(p, invoiceId, {
      utr: input.utr,
      paidOn: input.paidOn,
    });
    return this.invoice(p, invoiceId);
  }

  // --- SAS-019 ------------------------------------------------------------------------------------
  /** Lifecycle history: what happened, who did it and why (FR-SAS-11). */
  async notices(p: Principal) {
    const row = await this.inst(p);
    const rows = await repo.history(this.deps.db, row.id);
    return {
      items: rows.map((h) => ({
        action: h.action,
        from: h.from_status,
        to: h.to_status,
        reason: h.reason,
        at: iso(h.occurred_at)!,
        by: personName(h.first_name, h.last_name) || 'RingPe',
      })),
    };
  }

  // --- SAS-020 / SAS-047 / SAS-021 ----------------------------------------------------------------
  async details(p: Principal) {
    const view = await this.deps.institutions.consoleView(p);
    const row = await this.inst(p);
    const [fee, requests] = await Promise.all([
      this.deps.db
        .selectFrom('onboarding_checklist_steps')
        .select('note')
        .where('institution_id', '=', row.id)
        .where('step_key', '=', 'feeacct')
        .executeTakeFirst(),
      this.deps.db
        .selectFrom('approval_requests')
        .select([
          'public_id',
          'request_seq',
          'summary',
          'status',
          'remarks',
          'created_at',
          'decided_at',
        ])
        .where('module', '=', 'INSTITUTION_DETAILS')
        .where('subject_type', '=', 'institution')
        .where('subject_ref', '=', row.public_id)
        .orderBy('id', 'desc')
        .execute(),
    ]);
    return {
      id: view.id,
      identifier: view.identifier,
      name: view.name,
      address: view.address,
      city: view.city,
      pinCode: view.pinCode,
      board: view.board,
      status: view.status,
      registeredAt: iso(row.created_at),
      signupSource: row.signup_source,
      contacts: view.contacts,
      administrator: view.administrator,
      bank: {
        corporateCode: row.corporate_code,
        poolAccount: row.pool_account_ref,
        feeAccount: fee?.note ?? null,
      },
      changeRequests: requests.map((r) => ({
        id: binToUuid(r.public_id),
        no: `APR-${String(r.request_seq).padStart(4, '0')}`,
        summary: r.summary,
        status: r.status,
        remarks: r.remarks,
        at: iso(r.created_at)!,
        decidedAt: iso(r.decided_at),
      })),
      version: view.version,
    };
  }

  /** Contacts the institution keeps itself (prototype s.details). */
  async saveContacts(
    p: Principal,
    expected: number,
    input: {
      primaryContact: { name: string; email: string; mobile: string };
      secondaryContact?: { name: string; email: string; mobile: string } | null | undefined;
    },
  ) {
    await this.deps.institutions.updateConsole(p, expected, {
      primaryContact: input.primaryContact,
      secondaryContact: input.secondaryContact ?? null,
    });
    return this.details(p);
  }

  /** Name, address or board: RingPe checks name and address stay unique, then changes them. */
  async requestDetailsChange(
    p: Principal,
    input: { field: 'NAME' | 'ADDRESS' | 'BOARD'; value: string; reason: string },
  ) {
    const value = input.value.trim();
    const reason = input.reason.trim();
    const errors = [];
    if (value.length < (input.field === 'BOARD' ? 2 : 3) || value.length > 200) {
      errors.push({ field: 'value', code: 'VALIDATION.FORMAT' as const });
    }
    if (reason.length < 5 || reason.length > 200) {
      errors.push({ field: 'reason', code: 'VALIDATION.FORMAT' as const });
    }
    if (errors.length) throw new ValidationError(errors);
    if (!isUuid(p.subject)) throw new NotFoundError();
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const row = await this.inst(p, trx, true);
      const pending = await trx
        .selectFrom('approval_requests')
        .select('id')
        .where('module', '=', 'INSTITUTION_DETAILS')
        .where('subject_ref', '=', row.public_id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (pending) throw new ConflictError('SAS.DETAILS_CHANGE_PENDING');
      const label = { NAME: 'Name', ADDRESS: 'Address', BOARD: 'Board' }[input.field];
      const current = { NAME: row.name, ADDRESS: row.address_line1, BOARD: row.board ?? '—' }[
        input.field
      ];
      const raised = await raiseApproval(trx, {
        institutionId: null,
        module: 'INSTITUTION_DETAILS',
        summary: `${label} of ${row.name} (${row.identifier}): ${current} → ${value}`,
        payload: { institution: binToUuid(row.public_id), field: input.field, value, reason },
        makerType: 'staff',
        makerRef: uuidToBin(p.subject),
        subjectType: 'institution',
        subjectRef: row.public_id,
        at,
      });
      await repo.addEvent(trx, {
        institutionId: row.id,
        action: 'DETAILS_CHANGE_REQUESTED',
        from: null,
        to: null,
        reason: `${label} → ${value} (${raised.no}): ${reason}`,
        actor: uuidToBin(p.subject),
        at,
      });
      return { approvalId: raised.id, no: raised.no };
    });
  }
}

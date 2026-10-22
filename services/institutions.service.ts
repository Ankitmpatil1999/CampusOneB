/**
 * Institutions (SRS 7.2–7.5; FR-INS-01…06, FR-SAS-05/10/11; INS-001…013, INS-035, INS-036,
 * SAS-027; prototype o.institutions, o.features, c.institution).
 *
 * - Registration is one transaction (RNG-ONB-039, OI-ONB-07): the record with its identifier
 *   (RNG-ONB-035), settings, contacts, the "Staff" user type with "Administration", the
 *   administrator's profile and role, feature toggles all off (RNG-ONB-036), notification channels,
 *   the plan and the first checklist steps. The welcome e-mail follows the commit. The
 *   administrator's campus and allowance wallets arrive with the wallet module (Phase 3).
 * - Lifecycle actions are the RC-08 transitions, each a guarded update with a reason, recorded in
 *   the append-only history and e-mailed to the contacts (FR-SAS-11). Suspension and cancellation
 *   end the institution's open sessions. Trials and invoices come with plans and billing (2.7).
 * - Features: a feature outside the plan stays locked (FR-SAS-05); switching one off also switches
 *   off what needs it; every change is recorded with who, when and why (FR-INS-04).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  CHANNELS,
  CHECKLIST,
  FEATURES,
  INSTITUTION,
  LIFECYCLE,
  LIMITS,
  checkTransition,
  featureByKey,
  renderMessage,
  type ChannelKey,
  type ChecklistKey,
  type LifecycleAction,
  type MessageKey,
} from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { MessageSender } from '../integrations/sms.provider';
import type { Database, InstitutionStatusCode } from '../models/ringpe_models';
import { institutionsRepository as repo } from '../repositories/institutions.repository';
import { plansRepository, type PlanTerms } from '../repositories/plans.repository';
import { academicsRepository } from '../repositories/academics.repository';
import { schoolYearOf } from './academics.service';
import {
  ConflictError,
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import type { FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { hashSecret } from '../utils/password';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import type { FileService } from './file.service';
import { logoFileOf, logoUrlOf } from './institution-logo';
import { planDto } from './plans.service';
import { addDays, cycleOf, dateOnly, type BillingService } from './billing.service';
import { istBusinessDate } from '../utils/format';
import { toMoneyDto } from '../utils/money';
import type { SessionService } from './session.service';
import { switchOffOutside, type SubscriptionService } from './subscription.service';
import { defaultValues, type SettingValues } from './settings.service';

export interface InstitutionsDeps {
  readonly db: Kysely<Database>;
  readonly cipher: FieldCipher;
  readonly sessions: SessionService;
  readonly loggers: Loggers;
  readonly settings?: { values(): Promise<SettingValues> };
  readonly email?: MessageSender;
  /** Address of the web application (console sign-in link in the welcome e-mail). */
  readonly webUrl?: string;
  readonly files?: FileService;
  /** Raises the first-cycle invoice on activation (2.7). */
  readonly billing?: BillingService;
  /** Plan change requests in the detail (2.7). */
  readonly subscriptions?: SubscriptionService;
  readonly now?: () => Date;
}

export interface ContactInput {
  readonly name: string;
  readonly email: string;
  readonly mobile: string;
}

export interface RegisterInput {
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly board?: string | undefined;
  readonly primaryContact: ContactInput;
  readonly secondaryContact?: ContactInput | undefined;
  readonly adminEmail: string;
  /** For an e-mail without an account (client 2026-10-07); else the primary contact's. */
  readonly adminName?: string | undefined;
  readonly adminMobile?: string | undefined;
  readonly planId?: string | undefined;
}

export interface DetailsInput {
  readonly name?: string | undefined;
  readonly address?: string | undefined;
  readonly city?: string | undefined;
  readonly pinCode?: string | undefined;
  readonly board?: string | null | undefined;
  readonly shortName?: string | undefined;
  readonly officePhone?: string | null | undefined;
  readonly officeEmail?: string | undefined;
  readonly primaryContact?: ContactInput | undefined;
  readonly secondaryContact?: ContactInput | null | undefined;
}

export interface ConsoleDetailsInput extends DetailsInput {
  readonly consentValidityMonths?: number | undefined;
  readonly channels?: Readonly<Partial<Record<ChannelKey, boolean>>> | undefined;
  readonly features?: Readonly<Partial<Record<string, boolean>>> | undefined;
}

type Row = NonNullable<Awaited<ReturnType<typeof repo.byId>>>;

/** A logo larger than this isn't served (an upload takes up to 2 MB). */
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const STATUS_LABEL = Object.fromEntries(INSTITUTION.values.map((v) => [v.code, v.label]));

/** Normalised name/address for the uniqueness key (case, spacing and punctuation ignored). */
export const normKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const nameAddressKey = (name: string, address: string) =>
  createHash('sha256')
    .update(`${normKey(name)}|${normKey(address)}`)
    .digest('hex');

const first3 = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 3);

/** RNG-ONB-035 / 27.4 §7: RPE + 3 of the name + 3 of the address + id (5) + MMYY (IST). */
export function institutionIdentifier(name: string, address: string, id: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    month: '2-digit',
    year: '2-digit',
  }).formatToParts(at);
  const mm = parts.find((p) => p.type === 'month')?.value ?? '01';
  const yy = parts.find((p) => p.type === 'year')?.value ?? '00';
  return `RPE${first3(name)}${first3(address)}${id.padStart(5, '0')}${mm}${yy}`;
}

/** Short name for cards and receipts: initials of the words (prototype), 2–6 capitals. */
export function shortNameOf(name: string) {
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .slice(0, 5);
  return initials.length >= 2 ? initials : first3(name).padEnd(2, 'X');
}

const personName = (first: string | null, last: string | null) =>
  [first, last].filter(Boolean).join(' ') || null;

const bool = (v: unknown) => v === true || v === 1 || v === '1';

const iso = (d: Date | string | null | undefined) =>
  d === null || d === undefined ? null : new Date(d).toISOString();

export class InstitutionsService {
  private readonly now: () => Date;

  constructor(private readonly deps: InstitutionsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }): Promise<number> {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private actor(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async find(publicId: string, lock = false, db: Kysely<Database> = this.deps.db) {
    if (!isUuid(publicId)) throw new NotFoundError();
    const r = await repo.byPublicId(db, uuidToBin(publicId), lock);
    if (!r) throw new NotFoundError();
    return r;
  }

  /** The console session's institution (never from the request). */
  private async own(p: Principal) {
    if (!p.institutionId) throw new NotFoundError();
    return this.find(p.institutionId);
  }

  private encryptMobile(inst: Buffer, kind: 'PRIMARY' | 'SECONDARY', mobile: string) {
    return this.deps.cipher.encrypt(
      'institution_contact',
      mobile,
      `institution_contacts.mobile:${binToUuid(inst)}:${kind}`,
    );
  }

  private async contactsOf(row: Row) {
    const rows = await repo.contacts(this.deps.db, row.id);
    const out = (kind: 'PRIMARY' | 'SECONDARY') => {
      const c = rows.find((r) => r.kind === kind);
      if (!c) return null;
      let mobile: string | null = null;
      if (c.mobile_enc) {
        try {
          mobile = this.deps.cipher.decrypt(
            'institution_contact',
            c.mobile_enc,
            `institution_contacts.mobile:${binToUuid(row.public_id)}:${kind}`,
          );
        } catch {
          mobile = null;
        }
      }
      return { name: c.name, email: c.email, mobile };
    };
    return { primary: out('PRIMARY'), secondary: out('SECONDARY') };
  }

  private async planOf(institutionId: string) {
    const sub = await repo.subscription(this.deps.db, institutionId);
    if (!sub) return { plan: null, subscription: null };
    const current = (await plansRepository.plans(this.deps.db)).find((p) => p.id === sub.plan_id);
    // A started period keeps its version until renewal; before that the plan's current terms apply.
    const plan =
      sub.status && current?.version_id !== sub.plan_version_id
        ? ((await plansRepository.atVersion(this.deps.db, sub.plan_version_id)) ?? current ?? null)
        : (current ?? null);
    return { plan, subscription: sub };
  }

  private planDto(p: PlanTerms) {
    return planDto(p);
  }

  private async checklistOf(institutionId: string) {
    const done = await repo.stepsDone(this.deps.db, institutionId);
    return CHECKLIST.map((c) => {
      const d = done.find((x) => x.step_key === c.key);
      return {
        key: c.key,
        label: c.label,
        owner: c.owner,
        required: c.required,
        ref: c.ref,
        done: Boolean(d),
        doneAt: iso(d?.done_at),
        note: d?.note ?? null,
      };
    });
  }

  private async completeStep(
    trx: Kysely<Database>,
    row: Row,
    key: ChecklistKey,
    by: Buffer | null,
    note: string | null,
    at: Date,
  ) {
    const changed = await repo.completeStep(trx, row.id, key, by, note);
    if (changed) {
      await repo.addEvent(trx, {
        institutionId: row.id,
        action: 'STEP_COMPLETED',
        from: null,
        // The step key is kept in to_status so the history can name the step.
        to: key,
        reason: note ?? '',
        actor: by,
        at,
      });
    }
    return changed;
  }

  private frozen(row: Row) {
    if (row.status === 'CANCELLED') {
      throw new CustomAPIError(409, 'INS.FROZEN', { params: { institution: row.name } });
    }
  }

  // --- INS-001 ------------------------------------------------------------------------------------
  async list() {
    const rows = await repo.list(this.deps.db);
    return {
      items: rows.map((r) => {
        const done = new Set(
          String(r.steps_done ?? '')
            .split(',')
            .filter(Boolean),
        );
        return {
          id: binToUuid(r.public_id),
          identifier: r.identifier,
          name: r.name,
          shortName: r.short_name,
          city: r.city,
          status: r.status,
          statusSince: iso(r.status === 'SUSPENDED' ? r.suspended_at : r.cancelled_at),
          plan: r.plan_public_id
            ? {
                id: binToUuid(r.plan_public_id),
                code: r.plan_code ?? '',
                name: r.plan_name ?? '',
                cycle: r.plan_cycle ?? 'ANNUAL',
              }
            : null,
          subscriptionStatus: r.subscription_status ?? null,
          trialEndsOn: dateOnly(r.trial_ends_on),
          members: Number(r.members ?? 0),
          checklist: {
            done: CHECKLIST.filter((c) => done.has(c.key)).length,
            total: CHECKLIST.length,
          },
          registeredAt: iso(r.created_at)!,
        };
      }),
    };
  }

  // --- INS-003 ------------------------------------------------------------------------------------
  async detail(publicId: string) {
    const row = await this.find(publicId);
    const [contacts, { plan, subscription }, checklist, history, admin, members, requests] =
      await Promise.all([
        this.contactsOf(row),
        this.planOf(row.id),
        this.checklistOf(row.id),
        repo.history(this.deps.db, row.id),
        repo.administrator(this.deps.db, row.id),
        repo.memberCount(this.deps.db, row.id),
        this.deps.subscriptions ? this.deps.subscriptions.requestsOf(row.id) : Promise.resolve([]),
      ]);
    const scheduled = subscription?.scheduled_plan_version_id
      ? await plansRepository.atVersion(this.deps.db, subscription.scheduled_plan_version_id)
      : undefined;
    const missing = checklist.filter((c) => c.required && !c.done).map((c) => c.label);
    // A trial converts with Activate (prototype LIFE: Trial → Activate · Suspend · Cancel).
    const onTrial = row.status === 'ACTIVE' && subscription?.status === 'TRIAL';
    const actions = (Object.keys(LIFECYCLE) as LifecycleAction[])
      .filter((a) => LIFECYCLE[a].from.includes(row.status) || (a === 'ACTIVATE' && onTrial))
      .map((a) => ({
        action: a,
        label: LIFECYCLE[a].label,
        blocked:
          (a === 'ACTIVATE' || a === 'START_TRIAL') && row.status === 'PENDING_ACTIVATION'
            ? missing.length > 0
            : false,
      }));
    return {
      id: binToUuid(row.public_id),
      identifier: row.identifier,
      name: row.name,
      shortName: row.short_name,
      city: row.city,
      address: row.address_line1,
      pinCode: row.pin_code,
      board: row.board,
      status: row.status,
      suspendedAt: iso(row.suspended_at),
      cancelledAt: iso(row.cancelled_at),
      registeredAt: iso(row.created_at)!,
      corporateCode: row.corporate_code,
      poolAccountRef: row.pool_account_ref,
      plan: plan ? this.planDto(plan) : null,
      subscription: subscription
        ? {
            status: subscription.status,
            trialEndsOn: dateOnly(subscription.trial_ends_on),
            renewsOn: dateOnly(subscription.renews_on),
            scheduledChange:
              scheduled && subscription.renews_on
                ? { plan: scheduled.name, on: dateOnly(subscription.renews_on)! }
                : null,
          }
        : null,
      planRequests: requests,
      contacts,
      administrator: admin
        ? {
            name: personName(admin.first_name, admin.last_name),
            email: admin.email,
            pending: admin.pending,
          }
        : null,
      members,
      checklist,
      missing,
      actions,
      history: history.map((h) => ({
        action: h.action,
        step:
          h.action === 'STEP_COMPLETED'
            ? (CHECKLIST.find((c) => c.key === h.to_status)?.label ?? h.to_status)
            : null,
        from: h.action === 'STEP_COMPLETED' ? null : h.from_status,
        to: h.action === 'STEP_COMPLETED' ? null : h.to_status,
        reason: h.reason || null,
        at: iso(h.occurred_at)!,
        by: personName(h.first_name, h.last_name) ?? 'System',
      })),
      version: row.row_version,
    };
  }

  // --- INS-002 ------------------------------------------------------------------------------------
  /**
   * The new administrator's account details: the name and mobile given, or the primary contact's
   * when it is the same e-mail. A mobile that already has an account is refused — that account's
   * e-mail is used instead (BR-01).
   */
  private async newAdministrator(input: RegisterInput, adminEmail: string) {
    const primary = input.primaryContact.email.trim().toLowerCase() === adminEmail;
    const name = input.adminName?.trim() || (primary ? input.primaryContact.name.trim() : '');
    const mobile = input.adminMobile?.trim() || (primary ? input.primaryContact.mobile.trim() : '');
    const errors: { field: string; code: MessageKey }[] = [];
    if (!name) errors.push({ field: 'adminName', code: 'VALIDATION.REQUIRED' });
    if (!mobile) errors.push({ field: 'adminMobile', code: 'VALIDATION.REQUIRED' });
    if (errors.length) throw new ValidationError(errors);
    const taken = await this.deps.db
      .selectFrom('platform_accounts')
      .select('id')
      .where('mobile', '=', mobile)
      .executeTakeFirst();
    if (taken) {
      throw new CustomAPIError(409, 'INS.ADMIN_MOBILE_TAKEN', {
        errors: [{ field: 'adminMobile', code: 'INS.ADMIN_MOBILE_TAKEN' }],
      });
    }
    const space = name.indexOf(' ');
    return {
      name,
      mobile,
      first: (space > 0 ? name.slice(0, space) : name).slice(0, 60).toUpperCase(),
      last:
        space > 0
          ? name
              .slice(space + 1)
              .trim()
              .slice(0, 60)
              .toUpperCase()
          : null,
    };
  }

  async register(p: Principal, input: RegisterInput) {
    const name = input.name.trim();
    const address = input.address.trim();
    const errors = [];
    if (name.length < 3 || name.length > (await this.limit(LIMITS.institutionNameMaxLength))) {
      errors.push({ field: 'name', code: 'VALIDATION.FORMAT' });
    }
    if (address.length > (await this.limit(LIMITS.institutionAddressMaxLength))) {
      errors.push({ field: 'address', code: 'VALIDATION.FORMAT' });
    }
    if (errors.length) throw new ValidationError(errors);

    const key = nameAddressKey(name, address);
    if (await repo.nameAddressTaken(this.deps.db, key)) {
      throw new CustomAPIError(409, 'INS.NAME_ADDRESS_TAKEN');
    }
    const adminEmail = input.adminEmail.trim().toLowerCase();
    const admin = await this.deps.db
      .selectFrom('platform_accounts')
      .select(['id', 'public_id', 'first_name', 'last_name', 'status'])
      .where('email', '=', adminEmail)
      .executeTakeFirst();
    // An e-mail without a RingPe account no longer stops registration (client 2026-10-06): the
    // administrator profile waits for it and is linked once that person creates their account on
    // the customer site and confirms the e-mail (claimPendingAdministrator).
    if (admin && admin.status !== 'ACTIVE') {
      // Only a closed or blocked account; an unknown e-mail is never refused (client 2026-10-06/07).
      throw new CustomAPIError(409, 'INS.ADMIN_ACCOUNT_INACTIVE');
    }
    if (admin && (await repo.hasInstitutionProfile(this.deps.db, String(admin.id)))) {
      throw new CustomAPIError(409, 'INS.ADMIN_IN_INSTITUTION');
    }
    if (admin && (await repo.isOperator(this.deps.db, String(admin.id)))) {
      throw new CustomAPIError(409, 'INS.ADMIN_IS_OPERATOR');
    }
    if (!admin && (await repo.pendingAdministrator(this.deps.db, adminEmail))) {
      // One institution per person (BR-01): an e-mail already waiting for another institution.
      throw new CustomAPIError(409, 'INS.ADMIN_IN_INSTITUTION');
    }
    // E-mail is not integrated yet (client 2026-10-07): the account is made now with a temporary
    // password shown once to the operator, changed at first sign-in (OI-IDN-20). With the setting
    // off, the profile waits for the account to be made on the customer site (client 2026-10-06).
    const newAdmin =
      !admin && (await this.limit(LIMITS.institutionAdminPasswordShown)) === 1
        ? await this.newAdministrator(input, adminEmail)
        : null;
    const temporaryPassword = newAdmin
      ? `${randomBytes(9).toString('base64url').slice(0, 10)}@1`
      : null;
    const temporaryHash = temporaryPassword ? await hashSecret(temporaryPassword) : null;
    const plan = input.planId
      ? (await plansRepository.plans(this.deps.db)).find(
          (x) => isUuid(input.planId!) && binToUuid(x.public_id) === input.planId!.toLowerCase(),
        )
      : undefined;
    if (input.planId && !plan) {
      throw new ValidationError([{ field: 'planId', code: 'VALIDATION.FORMAT' }]);
    }

    const by = this.actor(p);
    const at = this.now();
    const inst = newPublicIdPair();
    const consent = await this.limit(LIMITS.feeConsentValidityMonths);
    // The waiting administrator is named after the primary contact when it is the same e-mail.
    const contactName =
      input.primaryContact.email.trim().toLowerCase() === adminEmail
        ? input.primaryContact.name.trim()
        : null;
    const space = contactName?.indexOf(' ') ?? -1;
    const waiting = {
      first: (contactName && space > 0
        ? contactName.slice(0, space)
        : (contactName ?? adminEmail.split('@')[0] ?? adminEmail)
      ).slice(0, 60),
      last: contactName && space > 0 ? contactName.slice(space + 1).slice(0, 60) : null,
    };
    const adminName = admin
      ? (personName(admin.first_name, admin.last_name) ?? adminEmail)
      : newAdmin
        ? newAdmin.name
        : (contactName ?? adminEmail);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const id = await repo.insert(trx, {
        publicId: inst.bin,
        identifier: `TMP${inst.id.replace(/-/g, '').slice(0, 21).toUpperCase()}`,
        name,
        shortName: shortNameOf(name),
        board: input.board ?? null,
        address,
        city: input.city.trim(),
        nameAddressKey: key,
        createdBy: by,
      });
      const identifier = institutionIdentifier(name, address, id, at);
      await repo.setIdentifier(trx, id, identifier);
      await repo.insertSettings(trx, id, consent);
      // Every institution starts with the current school year (RC-22; CR-13).
      const year = schoolYearOf(istBusinessDate(at));
      await academicsRepository.insertYear(trx, {
        publicId: newPublicIdPair().bin,
        institutionId: id,
        label: year.label,
        startsOn: year.startsOn,
        endsOn: year.endsOn,
        current: true,
      });
      for (const [kind, c] of [
        ['PRIMARY', input.primaryContact],
        ['SECONDARY', input.secondaryContact],
      ] as const) {
        if (!c) continue;
        await repo.putContact(trx, {
          institutionId: id,
          kind,
          name: c.name.trim(),
          email: c.email.trim().toLowerCase(),
          mobileEnc: this.encryptMobile(inst.bin, kind, c.mobile),
          mobileLast4: c.mobile.slice(-4),
        });
      }
      // The default user type and department (RNG-ONB-024/036).
      const ut = newPublicIdPair();
      const userType = await trx
        .insertInto('user_types')
        .values({
          public_id: ut.bin,
          institution_id: id,
          name: 'Staff',
          category: 'STAFF',
          created_by: by,
        })
        .executeTakeFirstOrThrow();
      const dep = await trx
        .insertInto('departments')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: id,
          user_type_id: String(userType.insertId),
          name: 'Administration',
        })
        .executeTakeFirstOrThrow();
      // The students' user type and its department (client 2026-10-21): students are onboarded,
      // admitted and uploaded under it from the first day.
      const student = await trx
        .insertInto('user_types')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: id,
          name: 'Student',
          category: 'STUDENT',
          created_by: by,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('departments')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: id,
          user_type_id: String(student.insertId),
          name: 'Academics',
        })
        .execute();
      let accountId = admin ? String(admin.id) : null;
      if (newAdmin && temporaryHash) {
        const acc = newPublicIdPair();
        const made = await trx
          .insertInto('platform_accounts')
          .values({
            public_id: acc.bin,
            mobile: newAdmin.mobile,
            email: adminEmail,
            first_name: newAdmin.first,
            last_name: newAdmin.last,
            created_by: by,
            updated_by: by,
          })
          .executeTakeFirstOrThrow();
        accountId = String(made.insertId);
        await trx
          .insertInto('account_credentials')
          .values({ account_id: accountId, kind: 'PASSWORD', hash: temporaryHash, must_change: 1 })
          .execute();
        await recordAudit(trx, {
          institutionId: id,
          action: 'ACCOUNT_CREATED',
          entityType: 'platform_account',
          entityRef: acc.id,
          after: { email: adminEmail, via: 'institution registration', password: 'temporary' },
        });
      }
      const profile = await trx
        .insertInto('member_profiles')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: id,
          account_id: accountId,
          contact_email: accountId ? null : adminEmail,
          user_type_id: String(userType.insertId),
          department_id: String(dep.insertId),
          first_name: admin
            ? (admin.first_name ?? adminEmail)
            : (newAdmin?.first ?? waiting.first.toUpperCase()),
          last_name: admin
            ? admin.last_name
            : newAdmin
              ? newAdmin.last
              : (waiting.last?.toUpperCase() ?? null),
          employee_no: null,
          admission_no: null,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('profile_roles')
        .values({
          institution_id: id,
          profile_id: String(profile.insertId),
          role_id: await repo.roleId(trx, 'INSTITUTION_ADMIN'),
        })
        .execute();
      // Feature-permission record with every toggle off (RNG-ONB-036); channels per OI-ONB-09.
      for (const f of FEATURES) await repo.setFeature(trx, id, f.key, false);
      for (const c of CHANNELS) await repo.setChannel(trx, id, c.key, c.defaultOn);
      if (plan) await repo.setPlan(trx, id, plan.id, plan.version_id);

      await repo.addEvent(trx, {
        institutionId: id,
        action: 'REGISTERED',
        from: null,
        to: 'PENDING_ACTIVATION',
        reason: `Defaults created: Staff user type + Administration department; administrator profile for ${adminName}; feature record; administrator role; welcome e-mail`,
        actor: by,
        at,
      });
      const row = (await repo.byId(trx, id))!;
      await this.completeStep(trx, row, 'details', null, null, at);
      await this.completeStep(
        trx,
        row,
        'usertypes',
        null,
        'Staff user type with Administration',
        at,
      );
      if (plan) await this.completeStep(trx, row, 'plan', null, plan.name, at);
      await recordAudit(trx, {
        institutionId: id,
        action: 'INSTITUTION_REGISTERED',
        entityType: 'institution',
        entityRef: inst.id,
        after: { identifier, name, plan: plan?.code ?? null },
      });
      return {
        id: inst.id,
        identifier,
        version: row.row_version,
        administrator: {
          email: adminEmail,
          pending: !accountId,
          accountCreated: Boolean(newAdmin),
          // Shown once: never stored, left out of an idempotent replay (the controller).
          ...(temporaryPassword ? { temporaryPassword } : {}),
        },
      };
    });

    if (this.deps.email) {
      const web = this.deps.webUrl ?? 'https://localhost:4200';
      const link = `${web}/console/signin`;
      // Without an account yet: create it on the customer site with this e-mail first.
      const next = admin
        ? `Sign in to the console: ${link}`
        : newAdmin
          ? `Your RingPe account has been created for this e-mail address. Sign in to the customer site with it and the temporary password RingPe gave you: ${web}/portal/signin — you'll choose your own password at first sign-in. Once it is live, sign in to the console: ${link}`
          : `Create your RingPe account on the customer site with this e-mail address: ${web}/portal/signup\nYou become the administrator of ${name} once the e-mail is confirmed. Then sign in to the customer site while it is being set up: ${web}/portal/signin\nOnce it is live, sign in to the console: ${link}`;
      await this.deps.email
        .send({
          to: adminEmail,
          purpose: 'institution.registered',
          text: `${renderMessage('INS.REGISTERED_EMAIL_SUBJECT', { name })}\n\n${name}\n${address}\nOrganization ID: ${out.identifier}\n${next}`,
        })
        .catch((e: unknown) =>
          this.deps.loggers.app.warn('institution.welcome_email_failed', { error: String(e) }),
        );
    }
    return out;
  }

  // --- INS-004 / INS-011: details ---------------------------------------------------------------------
  private async applyDetails(
    trx: Kysely<Database>,
    row: Row,
    expected: number,
    input: DetailsInput,
    by: Buffer | null,
  ) {
    const name = input.name?.trim() ?? row.name;
    const address = input.address?.trim() ?? row.address_line1;
    const key = nameAddressKey(name, address);
    const errors = [];
    if (name.length < 3 || name.length > (await this.limit(LIMITS.institutionNameMaxLength))) {
      errors.push({ field: 'name', code: 'VALIDATION.FORMAT' });
    }
    if (address.length > (await this.limit(LIMITS.institutionAddressMaxLength))) {
      errors.push({ field: 'address', code: 'VALIDATION.FORMAT' });
    }
    if (errors.length) throw new ValidationError(errors);
    if (
      (input.name !== undefined || input.address !== undefined) &&
      (await repo.nameAddressTaken(trx, key, row.id))
    ) {
      throw new CustomAPIError(409, 'INS.NAME_ADDRESS_TAKEN');
    }
    const ok = await repo.update(
      trx,
      row.id,
      expected,
      {
        name,
        address_line1: address,
        name_address_key: key,
        ...(input.city !== undefined ? { city: input.city.trim() } : {}),
        ...(input.pinCode !== undefined ? { pin_code: input.pinCode } : {}),
        ...(input.board !== undefined ? { board: input.board } : {}),
        ...(input.shortName !== undefined ? { short_name: input.shortName } : {}),
        ...(input.officePhone !== undefined ? { office_phone: input.officePhone || null } : {}),
        ...(input.officeEmail !== undefined
          ? { office_email: input.officeEmail.trim().toLowerCase() }
          : {}),
      },
      by,
    );
    if (!ok) throw new PreconditionFailedError();
    const changed: string[] = [];
    for (const [kind, c] of [
      ['PRIMARY', input.primaryContact],
      ['SECONDARY', input.secondaryContact],
    ] as const) {
      if (c === undefined) continue;
      changed.push(`${kind.toLowerCase()} contact`);
      if (c === null) {
        await repo.removeContact(trx, row.id, kind);
        continue;
      }
      await repo.putContact(trx, {
        institutionId: row.id,
        kind,
        name: c.name.trim(),
        email: c.email.trim().toLowerCase(),
        mobileEnc: this.encryptMobile(row.public_id, kind, c.mobile),
        mobileLast4: c.mobile.slice(-4),
      });
    }
    return changed;
  }

  async edit(
    p: Principal,
    publicId: string,
    expected: number,
    input: DetailsInput & { planId?: string | undefined; reason?: string | undefined },
  ) {
    const at = this.now();
    const by = this.actor(p);
    const version = await this.deps.db.transaction().execute(async (trx) => {
      const row = await this.find(publicId, true, trx);
      this.frozen(row);
      if (row.row_version !== expected) throw new PreconditionFailedError();
      await this.applyDetails(trx, row, expected, input, by);
      if (input.planId !== undefined) {
        await this.choosePlan(trx, row, input.planId, by, at, input.reason);
      }
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'INSTITUTION_EDITED',
        entityType: 'institution',
        entityRef: publicId,
        after: { fields: Object.keys(input) },
      });
      return (await repo.byId(trx, row.id))!.row_version;
    });
    return { id: publicId, version };
  }

  /**
   * Chooses the plan while no subscription period has started (pending activation). A change once
   * the period has started goes through SAS-034 (SubscriptionService.changePlan).
   */
  private async choosePlan(
    trx: Kysely<Database>,
    row: Row,
    planId: string,
    by: Buffer | null,
    at: Date,
    reason?: string,
  ) {
    const plans = await plansRepository.plans(trx);
    const to = plans.find((x) => isUuid(planId) && binToUuid(x.public_id) === planId.toLowerCase());
    if (!to) throw new ValidationError([{ field: 'planId', code: 'VALIDATION.FORMAT' }]);
    const sub = await repo.subscription(trx, row.id);
    if (sub?.status) {
      throw new CustomAPIError(409, 'INS.TRANSITION_INVALID', {
        params: { status: STATUS_LABEL[row.status] ?? row.status },
      });
    }
    if (sub?.plan_id === to.id) return;
    const from = plans.find((x) => x.id === sub?.plan_id);
    await repo.setPlan(trx, row.id, to.id, to.version_id);
    // Features the new plan doesn't include are switched off (prototype ob.inst.plan.save).
    await switchOffOutside(trx, row.id, to, at);
    await repo.addEvent(trx, {
      institutionId: row.id,
      action: 'PLAN_CHANGE',
      from: from?.name ?? null,
      to: to.name,
      reason: reason || (from ? 'Plan changed before activation' : 'Plan chosen'),
      actor: by,
      at,
    });
    await this.completeStep(trx, row, 'plan', by, to.name, at);
  }

  // --- INS-005 ------------------------------------------------------------------------------------
  async lifecycle(
    p: Principal,
    publicId: string,
    input: { action: LifecycleAction; reason: string },
  ) {
    const reason = input.reason.trim();
    const min = await this.limit(LIMITS.lifecycleReasonMinLength);
    if (reason.length < min) {
      throw new ValidationError([
        { field: 'reason', code: 'INS.REASON_TOO_SHORT', params: { min } },
      ]);
    }
    const t = LIFECYCLE[input.action];
    const at = this.now();
    const by = this.actor(p);
    const result = await this.deps.db.transaction().execute(async (trx) => {
      const row = await this.find(publicId, true, trx);
      const from = row.status as InstitutionStatusCode;
      const sub = await repo.subscription(trx, row.id);
      // A trial converts with Activate: the institution stays Active, the subscription changes.
      const converting =
        input.action === 'ACTIVATE' && from === 'ACTIVE' && sub?.status === 'TRIAL';
      if (!converting && (!t.from.includes(from) || !checkTransition(INSTITUTION, from, t.to).ok)) {
        throw new CustomAPIError(409, 'INS.TRANSITION_INVALID', {
          params: { status: STATUS_LABEL[from] ?? from },
        });
      }
      const starting = input.action === 'START_TRIAL' || input.action === 'ACTIVATE';
      if (starting && !converting) {
        const done = new Set((await repo.stepsDone(trx, row.id)).map((s) => s.step_key));
        const missing = CHECKLIST.filter((c) => c.required && !done.has(c.key));
        if (missing.length) {
          throw new CustomAPIError(409, 'INS.CHECKLIST_INCOMPLETE', {
            params: { steps: missing.map((m) => m.label).join('; ') },
          });
        }
      }
      if (starting && !sub) throw new CustomAPIError(409, 'SAS.NO_PLAN');
      if (!converting && !(await repo.changeStatus(trx, row.id, from, t.to, by, at))) {
        throw new ConflictError('INS.TRANSITION_INVALID', {
          params: { status: STATUS_LABEL[from] ?? from },
        });
      }
      // The subscription follows (RC-09); a started period takes the plan's current terms.
      let invoice: Awaited<ReturnType<BillingService['firstCycle']>> | null = null;
      const today = istBusinessDate(at);
      const terms = sub
        ? (await plansRepository.plans(trx)).find((x) => x.id === sub.plan_id)
        : undefined;
      if (input.action === 'START_TRIAL' && sub && terms) {
        await repo.setSubscriptionStatus(trx, row.id, [null], 'TRIAL', {
          plan_version_id: terms.version_id,
          trial_ends_on: addDays(today, terms.trial_days),
          current_period_start_on: today,
        });
      } else if (input.action === 'ACTIVATE' && sub && terms) {
        const cycle = cycleOf(today, terms.cycle);
        await repo.setSubscriptionStatus(trx, row.id, [null, 'TRIAL'], 'ACTIVE', {
          plan_version_id: terms.version_id,
          trial_ends_on: null,
          current_period_start_on: today,
          current_period_end_on: cycle.to,
          renews_on: cycle.renews,
        });
        if (this.deps.billing) invoice = await this.deps.billing.firstCycle(trx, row, terms, by);
      } else if (input.action === 'SUSPEND') {
        await repo.setSubscriptionStatus(trx, row.id, ['TRIAL', 'ACTIVE', 'GRACE'], 'SUSPENDED');
      } else if (input.action === 'REACTIVATE') {
        await repo.setSubscriptionStatus(trx, row.id, ['SUSPENDED'], 'ACTIVE');
      } else if (input.action === 'CANCEL') {
        await repo.setSubscriptionStatus(
          trx,
          row.id,
          ['TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED'],
          'CANCELLED',
        );
        // A cancellation the institution asked for in the portal is now confirmed (RC-27).
        await trx
          .updateTable('cancellation_requests')
          .set({ status: 'CONFIRMED', resolved_by: by, resolved_at: at, resolution: reason })
          .where('institution_id', '=', row.id)
          .where('status', '=', 'PENDING')
          .execute();
      }
      await repo.addEvent(trx, {
        institutionId: row.id,
        action: t.event,
        from: converting ? 'TRIAL' : from,
        to: converting ? 'ACTIVE' : t.to,
        reason,
        actor: by,
        at,
      });
      await recordAudit(trx, {
        institutionId: row.id,
        action: `INSTITUTION_${t.event}`,
        entityType: 'institution',
        entityRef: publicId,
        before: { status: from },
        after: { status: t.to },
        reason,
      });
      return { row, from, invoice };
    });

    if (input.action === 'SUSPEND' || input.action === 'CANCEL') {
      await this.deps.sessions.endAllForInstitution(
        result.row.id,
        input.action === 'SUSPEND' ? 'INSTITUTION_SUSPENDED' : 'INSTITUTION_CANCELLED',
      );
    }
    const notified = await this.notifyContacts(result.row, t.to, reason);
    const inv = result.invoice;
    if (inv && this.deps.billing) {
      await this.deps.billing.notifyIssued(publicId, inv.invoiceNo, inv.totalPaise, inv.dueOn);
    }
    const fresh = (await repo.byId(this.deps.db, result.row.id))!;
    return {
      status: t.to,
      version: fresh.row_version,
      notified,
      invoice: inv
        ? {
            id: inv.id,
            invoiceNo: inv.invoiceNo,
            total: toMoneyDto(inv.totalPaise),
            dueOn: inv.dueOn,
          }
        : null,
    };
  }

  /** FR-SAS-11: the primary and secondary contacts are e-mailed every lifecycle change. */
  private async notifyContacts(row: Row, to: InstitutionStatusCode, reason: string) {
    if (!this.deps.email) return [];
    const { primary, secondary } = await this.contactsOf(row);
    const sent: string[] = [];
    for (const c of [primary, secondary]) {
      if (!c?.email) continue;
      try {
        await this.deps.email.send({
          to: c.email,
          purpose: 'institution.lifecycle',
          text: `${row.name} (${row.identifier}) is now ${STATUS_LABEL[to] ?? to} on RingPe.\nReason: ${reason}`,
        });
        sent.push(c.name);
      } catch (e) {
        this.deps.loggers.app.warn('institution.lifecycle_email_failed', { error: String(e) });
      }
    }
    return sent;
  }

  // --- INS-006 ------------------------------------------------------------------------------------
  async bankArrangement(
    p: Principal,
    publicId: string,
    expected: number,
    input: { corporateCode: string; poolAccountRef: string; shadowAccountRef?: string | null },
  ) {
    const code = input.corporateCode.trim().toUpperCase();
    const len = await this.limit(LIMITS.corporateCodeLength);
    if (!new RegExp(`^[A-Z0-9]{${len}}$`).test(code)) {
      throw new ValidationError([{ field: 'corporateCode', code: 'INS.CORPORATE_CODE_FORMAT' }]);
    }
    const at = this.now();
    const by = this.actor(p);
    const version = await this.deps.db.transaction().execute(async (trx) => {
      const row = await this.find(publicId, true, trx);
      this.frozen(row);
      if (row.row_version !== expected) throw new PreconditionFailedError();
      if (await repo.corporateCodeTaken(trx, code, row.id)) {
        throw new CustomAPIError(409, 'INS.CORPORATE_CODE_TAKEN');
      }
      const ok = await repo.update(
        trx,
        row.id,
        expected,
        {
          corporate_code: code,
          pool_account_ref: input.poolAccountRef,
          ...(input.shadowAccountRef !== undefined
            ? { shadow_account_ref: input.shadowAccountRef }
            : {}),
        },
        by,
      );
      if (!ok) throw new PreconditionFailedError();
      await this.completeStep(trx, row, 'bank', by, `Corporate code ${code}`, at);
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'CORPORATE_CODE_SET',
        entityType: 'institution',
        entityRef: publicId,
        after: { corporateCode: code },
      });
      return (await repo.byId(trx, row.id))!.row_version;
    });
    return { corporateCode: code, version };
  }

  // --- INS-036: the operator marks an onboarding step done (prototype ob.inst.check) -------------------
  async markStep(
    p: Principal,
    publicId: string,
    step: string,
    input: { note?: string | undefined },
  ) {
    const def = CHECKLIST.find((c) => c.key === step);
    if (!def || def.key === 'bank' || def.key === 'plan') throw new NotFoundError();
    const at = this.now();
    const by = this.actor(p);
    return this.deps.db.transaction().execute(async (trx) => {
      const row = await this.find(publicId, true, trx);
      this.frozen(row);
      const note =
        input.note?.trim() ||
        (def.owner === 'Institution' ? 'Confirmed with the institution' : null);
      await this.completeStep(trx, row, def.key, by, note, at);
      await repo.touch(trx, row.id, by);
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'ONBOARDING_STEP_COMPLETED',
        entityType: 'institution',
        entityRef: publicId,
        after: { step: def.key },
      });
      const done = (await repo.stepsDone(trx, row.id)).length;
      return { step: def.key, done, total: CHECKLIST.length };
    });
  }

  // --- INS-007 / INS-008 / INS-009 ---------------------------------------------------------------
  private async featureView(row: Row) {
    const [{ plan }, toggles, channels] = await Promise.all([
      this.planOf(row.id),
      repo.features(this.deps.db, row.id),
      repo.channels(this.deps.db, row.id),
    ]);
    const on = (k: string) => bool(toggles.find((t) => t.feature_key === k)?.enabled);
    return {
      institution: {
        id: binToUuid(row.public_id),
        name: row.name,
        shortName: row.short_name,
        status: row.status,
      },
      plan: plan ? { id: binToUuid(plan.public_id), name: plan.name, code: plan.code } : null,
      features: FEATURES.map((f) => {
        const notInPlan = Boolean(f.module) && !(plan?.modules.includes(f.module!) ?? false);
        const needs = f.needs && !on(f.needs) ? featureByKey(f.needs)! : null;
        return {
          key: f.key,
          label: f.label,
          sub: f.sub,
          consoleLabel: f.consoleLabel,
          consoleSub: f.consoleSub,
          icon: f.icon,
          module: f.module,
          group: f.group,
          cr: f.cr ?? null,
          enabled: on(f.key) && !notInPlan,
          lock: notInPlan
            ? { kind: 'PLAN' as const, text: `Not in ${plan?.name ?? 'the plan'}` }
            : needs
              ? { kind: 'NEEDS' as const, text: `Needs ${needs.label.toLowerCase()}` }
              : null,
        };
      }),
      channels: CHANNELS.map((c) => {
        const allowance = c.allowance ? (plan?.allowances[c.allowance] ?? 0) : null;
        const notInPlan = c.allowance !== null && !allowance;
        const enabled =
          c.key === 'IN_APP' || bool(channels.find((x) => x.channel === c.key)?.enabled);
        return {
          key: c.key,
          label: c.label,
          consoleSub: c.consoleSub,
          icon: c.icon,
          allowance,
          enabled: enabled && !notInPlan,
          lock: c.locked
            ? { kind: 'ALWAYS_ON' as const, text: "In-app notifications can't be switched off." }
            : notInPlan
              ? { kind: 'PLAN' as const, text: `Not in ${plan?.name ?? 'the plan'}` }
              : null,
        };
      }),
      version: row.row_version,
    };
  }

  async features(publicId: string) {
    return this.featureView(await this.find(publicId));
  }

  /** One set of feature and channel changes (plan locks, dependencies, change record). */
  private async applyFeatureChanges(
    trx: Kysely<Database>,
    row: Row,
    changes: readonly { key: string; enabled: boolean }[],
    by: Buffer | null,
    reason: string | null,
    at: Date,
  ) {
    const { plan } = await this.planOf(row.id);
    const toggles = await repo.features(trx, row.id);
    const channels = await repo.channels(trx, row.id);
    const state = new Map<string, boolean>(
      FEATURES.map((f) => [f.key, bool(toggles.find((t) => t.feature_key === f.key)?.enabled)]),
    );
    for (const ch of changes) {
      if (ch.key.startsWith('channel.')) {
        const key = ch.key.slice(8) as ChannelKey;
        const c = CHANNELS.find((x) => x.key === key);
        if (!c) throw new ValidationError([{ field: 'changes', code: 'VALIDATION.FORMAT' }]);
        if (c.locked) throw new CustomAPIError(409, 'INS.CHANNEL_LOCKED');
        if (ch.enabled && c.allowance && !(plan?.allowances[c.allowance] ?? 0)) {
          throw new CustomAPIError(409, 'INS.NOT_ENTITLED_BY_PLAN', {
            params: { feature: c.label, plan: plan?.name ?? '—' },
          });
        }
        const was = bool(channels.find((x) => x.channel === key)?.enabled);
        if (was === ch.enabled) continue;
        await repo.setChannel(trx, row.id, key, ch.enabled);
        await repo.logFeature(trx, {
          institutionId: row.id,
          key: ch.key,
          from: was,
          to: ch.enabled,
          reason,
          actor: by,
          at,
        });
        continue;
      }
      const f = featureByKey(ch.key);
      if (!f) throw new ValidationError([{ field: 'changes', code: 'VALIDATION.FORMAT' }]);
      if (ch.enabled && f.module && !(plan?.modules.includes(f.module) ?? false)) {
        throw new CustomAPIError(409, 'INS.NOT_ENTITLED_BY_PLAN', {
          params: { feature: f.label, plan: plan?.name ?? '—' },
        });
      }
      if (ch.enabled && f.needs && !state.get(f.needs)) {
        throw new CustomAPIError(409, 'INS.FEATURE_NEEDS', {
          params: { feature: featureByKey(f.needs)!.label },
        });
      }
      if (state.get(f.key) === ch.enabled) continue;
      state.set(f.key, ch.enabled);
      await repo.setFeature(trx, row.id, f.key, ch.enabled);
      await repo.logFeature(trx, {
        institutionId: row.id,
        key: f.key,
        from: !ch.enabled,
        to: ch.enabled,
        reason,
        actor: by,
        at,
      });
      if (!ch.enabled) {
        for (const dep of FEATURES.filter((x) => x.needs === f.key && state.get(x.key))) {
          state.set(dep.key, false);
          await repo.setFeature(trx, row.id, dep.key, false);
          await repo.logFeature(trx, {
            institutionId: row.id,
            key: dep.key,
            from: true,
            to: false,
            reason: `Depends on ${f.label}`,
            actor: by,
            at,
          });
        }
      }
    }
  }

  async changeFeatures(
    p: Principal,
    publicId: string,
    expected: number,
    input: { changes: readonly { key: string; enabled: boolean }[]; reason?: string | undefined },
  ) {
    const at = this.now();
    const by = this.actor(p);
    const reason = input.reason?.trim() || null;
    await this.deps.db.transaction().execute(async (trx) => {
      const row = await this.find(publicId, true, trx);
      this.frozen(row);
      if (row.row_version !== expected) throw new PreconditionFailedError();
      await this.applyFeatureChanges(trx, row, input.changes, by, reason, at);
      await this.completeStep(trx, row, 'toggles', by, null, at);
      await repo.touch(trx, row.id, by);
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'FEATURE_PERMISSION_CHANGED',
        entityType: 'institution',
        entityRef: publicId,
        after: { changes: input.changes },
        ...(reason ? { reason } : {}),
      });
    });
    return this.features(publicId);
  }

  async featureLog(institutionPublicId?: string) {
    let id: string | undefined;
    if (institutionPublicId) id = (await this.find(institutionPublicId)).id;
    const rows = await repo.featureLog(this.deps.db, id, 200);
    return {
      items: rows.map((r) => {
        const channel = r.feature_key.startsWith('channel.')
          ? CHANNELS.find((c) => `channel.${c.key}` === r.feature_key)
          : undefined;
        return {
          id: String(r.id),
          institutionId: binToUuid(r.institution_public_id),
          institution: r.short_name,
          key: r.feature_key,
          label: channel
            ? `${channel.label} notifications`
            : (featureByKey(r.feature_key)?.label ?? r.feature_key),
          from: bool(r.from_value),
          to: bool(r.to_value),
          reason: r.reason,
          by: personName(r.first_name, r.last_name) ?? 'System',
          at: iso(r.changed_at)!,
        };
      }),
    };
  }

  // --- INS-010 / INS-011 / INS-012 / INS-013: the console's own institution -------------------------
  async consoleView(p: Principal) {
    const row = await this.own(p);
    const [contacts, settings, view, admin] = await Promise.all([
      this.contactsOf(row),
      repo.settings(this.deps.db, row.id),
      this.featureView(row),
      repo.administrator(this.deps.db, row.id),
    ]);
    const fee = row.fee_merchant_profile_id
      ? await this.deps.db
          .selectFrom('member_profiles')
          .select(['public_id', 'first_name', 'last_name'])
          .where('id', '=', row.fee_merchant_profile_id)
          .where('institution_id', '=', row.id)
          .executeTakeFirst()
      : undefined;
    return {
      id: binToUuid(row.public_id),
      identifier: row.identifier,
      name: row.name,
      shortName: row.short_name,
      address: row.address_line1,
      city: row.city,
      pinCode: row.pin_code,
      board: row.board,
      officePhone: row.office_phone,
      officeEmail: row.office_email,
      status: row.status,
      contacts,
      administrator: admin
        ? {
            name: personName(admin.first_name, admin.last_name),
            email: admin.email,
            pending: admin.pending,
          }
        : null,
      corporateCode: row.corporate_code,
      consentValidityMonths: settings?.consent_validity_months ?? 3,
      logo:
        settings?.logo_public_id && settings.logo_scan === 'CLEAN'
          ? {
              fileId: binToUuid(settings.logo_public_id),
              name: settings.logo_name ?? '',
              sizeBytes: Number(settings.logo_size ?? 0),
            }
          : null,
      feeAccount: fee
        ? { id: binToUuid(fee.public_id), name: personName(fee.first_name, fee.last_name) ?? '' }
        : null,
      plan: view.plan,
      features: view.features,
      channels: view.channels,
      version: row.row_version,
    };
  }

  async updateConsole(p: Principal, expected: number, input: ConsoleDetailsInput) {
    const at = this.now();
    const by = this.actor(p);
    const row0 = await this.own(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const row = (await repo.byId(trx, row0.id, true))!;
      this.frozen(row);
      if (row.row_version !== expected) throw new PreconditionFailedError();
      const changed = await this.applyDetails(trx, row, expected, input, by);
      if (input.consentValidityMonths !== undefined) {
        await repo.updateSettings(trx, row.id, {
          consent_validity_months: input.consentValidityMonths,
        });
      }
      // Features (client 2026-10-03: the Institution Administrator switches them) and channels.
      const changes = [
        ...Object.entries(input.features ?? {})
          .filter((e): e is [string, boolean] => typeof e[1] === 'boolean')
          .map(([key, enabled]) => ({ key, enabled })),
        ...Object.entries(input.channels ?? {})
          .filter(
            (e): e is [string, boolean] =>
              typeof e[1] === 'boolean' && !(e[0] === 'IN_APP' && e[1]),
          )
          .map(([key, enabled]) => ({ key: `channel.${key}`, enabled })),
      ];
      if (changes.length) {
        await this.applyFeatureChanges(trx, row, changes, by, 'Changed by the institution', at);
      }
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'INSTITUTION_SETTINGS_SAVED',
        entityType: 'institution',
        entityRef: binToUuid(row.public_id),
        after: { fields: Object.keys(input), contacts: changed },
      });
    });
    return this.consoleView(p);
  }

  async setLogo(p: Principal, input: { fileId: string }) {
    const row = await this.own(p);
    this.frozen(row);
    if (!isUuid(input.fileId)) throw new NotFoundError();
    const f = await this.deps.db
      .selectFrom('files')
      .select(['id', 'institution_id', 'purpose', 'scan_status'])
      .where('public_id', '=', uuidToBin(input.fileId))
      .executeTakeFirst();
    if (!f || String(f.institution_id) !== row.id || f.scan_status !== 'CLEAN') {
      throw new NotFoundError();
    }
    if (f.purpose !== 'logo') throw new CustomAPIError(415, 'FILE.TYPE_NOT_ALLOWED');
    const by = this.actor(p);
    await this.deps.db.transaction().execute(async (trx) => {
      await repo.updateSettings(trx, row.id, { logo_file_id: String(f.id) });
      await this.completeStep(trx, row, 'branding', by, 'Logo uploaded', this.now());
      await repo.touch(trx, row.id, by);
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'INSTITUTION_LOGO_REPLACED',
        entityType: 'institution',
        entityRef: binToUuid(row.public_id),
        after: { fileId: input.fileId },
      });
    });
    return this.consoleView(p);
  }

  /** FR-INS-06: the merchant profile that receives tuition and other institutional fees. */
  async setFeeAccount(p: Principal, expected: number, input: { merchantId: string }) {
    const row0 = await this.own(p);
    if (!isUuid(input.merchantId)) throw new NotFoundError();
    const by = this.actor(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const row = (await repo.byId(trx, row0.id, true))!;
      this.frozen(row);
      if (row.row_version !== expected) throw new PreconditionFailedError();
      const m = await trx
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as t', 't.id', 'm.user_type_id')
        .select(['m.id', 't.category', 'm.status'])
        .where('m.public_id', '=', uuidToBin(input.merchantId))
        .where('m.institution_id', '=', row.id)
        .executeTakeFirst();
      if (!m) throw new NotFoundError();
      if (m.category !== 'MERCHANT' || m.status !== 'ACTIVE') {
        throw new CustomAPIError(409, 'INS.FEE_ACCOUNT_NOT_MERCHANT');
      }
      if (
        !(await repo.update(trx, row.id, expected, { fee_merchant_profile_id: String(m.id) }, by))
      ) {
        throw new PreconditionFailedError();
      }
      await this.completeStep(trx, row, 'feeacct', by, null, this.now());
      await recordAudit(trx, {
        institutionId: row.id,
        action: 'FEE_ACCOUNT_DESIGNATED',
        entityType: 'institution',
        entityRef: binToUuid(row.public_id),
        after: { merchantId: input.merchantId },
      });
    });
    return this.consoleView(p);
  }

  // --- INS-035 ------------------------------------------------------------------------------------
  /**
   * Public branding for sign-in and admission pages (RNG-GOV-007): minimum data, by the public
   * identifier; institutions that are not live answer 404.
   */
  async branding(slug: string) {
    const identifier = slug.trim().toUpperCase();
    if (!/^RPE[A-Z0-9]{6,21}$/.test(identifier)) throw new NotFoundError();
    const row = await repo.byIdentifier(this.deps.db, identifier);
    if (!row || (row.status !== 'ACTIVE' && row.status !== 'PENDING_ACTIVATION')) {
      throw new NotFoundError();
    }
    const settings = await repo.settings(this.deps.db, row.id);
    return {
      name: row.name,
      shortName: row.short_name,
      city: row.city,
      // The stable address (INS-043), not a signed link that expires (client 2026-10-15).
      logoUrl: await logoUrlOf(this.deps.db, String(row.id)),
      colors: { brand: settings?.brand_color ?? null },
    };
  }

  /**
   * INS-043: the institution's logo itself, public like its branding (sign-in, the admission pages,
   * the console's menu, the apps). Only a picture scanned clean; anything else answers 404.
   */
  async logo(institutionId: string) {
    if (!isUuid(institutionId) || !this.deps.files) throw new NotFoundError();
    const f = await logoFileOf(this.deps.db, { publicId: institutionId });
    const file = f ? await this.deps.files.contents(f.fileId, LOGO_MAX_BYTES) : null;
    if (!file || !/^image\/(png|jpeg)$/.test(file.mimeType)) throw new NotFoundError();
    return file;
  }
}

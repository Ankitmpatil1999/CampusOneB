/**
 * Staff sign-in for the institution console, the operator back office and the customer portal (SRS
 * 6.4, 6.38.4 CR-05; IDN-031…037, SAS-005/006; prototype c.signin / o.signin / s.signin):
 *
 * 1. Work e-mail + password. Every refusal — unknown e-mail, wrong password, an account that may not
 *    enter this console — returns the one 6.4 message, and no code is issued (RNG-IDN-376).
 *    Wrong passwords lock the account for a while (staff lock-out, a setting).
 * 2. A 4-digit code by SMS to the account mobile, with the e-mail as fallback (OI-IDN-38). No
 *    session, token or task list exists before the code is verified (RNG-IDN-375).
 * 3. Wrong codes end the attempt after the limit; abandoned attempts lock the account until an
 *    administrator releases it (RNG-IDN-380, Q13). Verification opens the session exactly as 6.4
 *    does: other sessions of the account end, the task list rides in the token (RNG-IDN-381).
 */
import type { Kysely } from 'kysely';
import { LIMITS, type MessageKey } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/ringpe_models';
import { accessRepository } from '../repositories/access.repository';
import { accountRepository } from '../repositories/account.repository';
import { institutionsRepository } from '../repositories/institutions.repository';
import { otpRepository } from '../repositories/otp.repository';
import type { MessageSender } from '../integrations/sms.provider';
import { BadRequestError, CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import type { FlowTokens } from '../utils/flow-tokens';
import { recordAudit } from './audit.service';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { hashSecret, needsRehash, verifyAgainstDummy, verifySecret } from '../utils/password';
import type { Principal } from '../utils/principal';
import { PATTERNS, isValidPassword } from '../utils/validators';
import type { IssuedChallenge, OtpService } from './otp.service';
import type { ClientContext, SessionService, SessionTokens } from './session.service';
import { defaultValues, type SettingValues } from './settings.service';
import { logoFileOf, logoPath } from './institution-logo';

export type StaffSurface = 'console' | 'ops' | 'portal';

const PURPOSE = { console: 'CONSOLE_2FA', ops: 'OPS_2FA', portal: 'PORTAL_2FA' } as const;

export interface StaffChallenge extends IssuedChallenge {
  readonly channel: 'SMS' | 'EMAIL';
  /** The masked e-mail the code can be sent to instead, when the account has one. */
  readonly emailFallback: string | null;
}

export type StaffSignedIn =
  | { readonly tokens: SessionTokens; readonly name: string }
  /** A temporary password (onboarded staff, OI-IDN-20): choose one before the first session. */
  | { readonly passwordChange: { readonly resetToken: string }; readonly name: string };

export interface StaffAuthDeps {
  readonly db: Kysely<Database>;
  readonly otp: OtpService;
  readonly sessions: SessionService;
  readonly loggers: Loggers;
  readonly settings?: { values(): Promise<SettingValues> };
  readonly now?: () => Date;
  /** Password reset by e-mail (IDN-034, IDN-082/083). */
  readonly flows?: FlowTokens;
  readonly email?: MessageSender;
  /** Address of the web application, for the link in the e-mail. */
  readonly webUrl?: string;
}

const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, '$1•••$2');
const fullName = (a: { first_name: string; last_name: string | null }) =>
  [a.first_name, a.last_name].filter(Boolean).join(' ');

export class StaffAuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: StaffAuthDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }): Promise<number> {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  /** The single 6.4 refusal (MSG-IDN-96). */
  private refused(): CustomAPIError {
    return new CustomAPIError(401, 'IDN.CONSOLE_SIGNIN_REFUSED');
  }

  private locked(): CustomAPIError {
    return new CustomAPIError(423, 'IDN.CONSOLE_LOCKED');
  }

  private temporarilyLocked(until: Date | string, now: Date): CustomAPIError {
    const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - now.getTime()) / 60_000));
    return new CustomAPIError(429, 'IDN.SIGNIN_LOCKED', {
      params: { minutes },
      headers: { 'Retry-After': String(minutes * 60) },
    });
  }

  /** May this account enter this surface now? (6.4 checks after the password.) */
  private async eligible(surface: StaffSurface, accountId: string) {
    if (surface === 'console') {
      const ctx = await accessRepository.consoleContext(this.deps.db, accountId);
      return ctx ? ({ surface, ctx } as const) : undefined;
    }
    if (surface === 'portal') {
      const ctx = await accessRepository.portalContext(this.deps.db, accountId);
      return ctx ? ({ surface, ctx } as const) : undefined;
    }
    if (await accessRepository.hasInstitutionProfile(this.deps.db, accountId)) return undefined;
    const op = await accessRepository.operatorContext(this.deps.db, accountId);
    return op ? ({ surface, op } as const) : undefined;
  }

  /** IDN-031 / IDN-035: e-mail and password; a code goes to the account mobile. */
  async signIn(
    surface: StaffSurface,
    input: { email: string; password: string },
  ): Promise<StaffChallenge> {
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    const password = String(input.password ?? '');
    const maxLength = await this.limit(LIMITS.passwordMaxLength);
    if (!PATTERNS.email.test(email) || !password || password.length > maxLength) {
      throw this.refused();
    }
    const now = this.now();
    const account = await accessRepository.findAccountByEmail(this.deps.db, email);
    if (!account) {
      await verifyAgainstDummy(password);
      this.deps.loggers.security.warn('auth.staff_signin_refused', { surface, reason: 'unknown' });
      throw this.refused();
    }
    if (account.signin_lock === 'LOCKED') throw this.locked();
    if (account.locked_until && new Date(account.locked_until) > now) {
      throw this.temporarilyLocked(account.locked_until, now);
    }
    const credential = await accountRepository.credential(this.deps.db, account.id, 'PASSWORD');
    const ok = credential ? await verifySecret(credential.hash, password) : false;
    if (!ok) {
      const max = await this.limit(LIMITS.staffSignInLockAfterFailures);
      const minutes = await this.limit(LIMITS.staffSignInLockMinutes);
      const lockUntil =
        account.failed_signins + 1 >= max ? new Date(now.getTime() + minutes * 60_000) : null;
      await accountRepository.signinFailure(this.deps.db, account.id, lockUntil);
      this.deps.loggers.security.warn('auth.staff_signin_refused', {
        surface,
        reason: 'password',
        locked: lockUntil !== null,
      });
      if (lockUntil) throw this.temporarilyLocked(lockUntil, now);
      throw this.refused();
    }
    if (credential && needsRehash(credential.hash)) {
      await accountRepository.replaceCredential(this.deps.db, {
        id: credential.id,
        hash: await hashSecret(password),
        previousHash: credential.hash,
        expectedVersion: credential.row_version,
      });
    }
    await accountRepository.resetFailures(this.deps.db, account.id);
    // An institution the back office registered for this (verified) e-mail before the account
    // existed: the account becomes its administrator now (client 2026-10-06).
    if (
      surface !== 'ops' &&
      account.status === 'ACTIVE' &&
      account.email &&
      account.email_verified_at
    ) {
      const joined = await institutionsRepository.claimPendingAdministrator(this.deps.db, {
        id: String(account.id),
        email: account.email,
        firstName: account.first_name,
        lastName: account.last_name,
      });
      if (joined) {
        await recordAudit(this.deps.db, {
          institutionId: String(joined.institution_id),
          action: 'ADMINISTRATOR_LINKED',
          entityType: 'institution',
          entityRef: binToUuid(joined.public_id),
          after: { email: account.email, via: 'console sign-in' },
        });
      }
    }
    if (account.status !== 'ACTIVE' || !(await this.eligible(surface, account.id))) {
      this.deps.loggers.security.warn('auth.staff_signin_refused', {
        surface,
        reason: 'no_access',
      });
      throw this.refused();
    }
    const challenge = await this.deps.otp.issue({
      purpose: PURPOSE[surface],
      channel: 'SMS',
      destination: account.mobile,
      accountId: account.id,
      reuseLive: true,
    });
    return {
      ...challenge,
      channel: 'SMS',
      emailFallback: account.email ? maskEmail(account.email) : null,
    };
  }

  /**
   * IDN-032 / IDN-037: one resend after the countdown; or, once, the code by e-mail instead of SMS
   * (the SMS code stops working).
   */
  async resend(
    surface: StaffSurface,
    input: { challengeId: string; channel?: 'SMS' | 'EMAIL' },
  ): Promise<StaffChallenge> {
    if (!isUuid(input.challengeId)) throw new BadRequestError('AUTH.OTP_INVALID');
    const c = await otpRepository.findByPublicId(this.deps.db, uuidToBin(input.challengeId));
    if (!c || c.purpose !== PURPOSE[surface] || !c.account_id) {
      throw new BadRequestError('AUTH.OTP_INVALID');
    }
    const account = await accountRepository.findById(this.deps.db, c.account_id);
    if (!account) throw new BadRequestError('AUTH.OTP_INVALID');
    const fallback = account.email ? maskEmail(account.email) : null;
    if (input.channel === 'EMAIL' && c.channel !== 'EMAIL') {
      if (!account.email) throw new BadRequestError('AUTH.OTP_INVALID');
      if (c.consumed_at || c.abandoned_at) throw new BadRequestError('AUTH.OTP_INVALID');
      await otpRepository.close(this.deps.db, c.id, this.now());
      const issued = await this.deps.otp.issue({
        purpose: PURPOSE[surface],
        channel: 'EMAIL',
        destination: account.email,
        accountId: account.id,
        reuseLive: true,
      });
      return { ...issued, channel: 'EMAIL', emailFallback: fallback };
    }
    const issued = await this.deps.otp.resend(input.challengeId);
    return { ...issued, channel: c.channel, emailFallback: fallback };
  }

  /** IDN-033 / IDN-036: the code opens the session. */
  async verify(
    surface: StaffSurface,
    input: { challengeId: string; otp: string },
    client: ClientContext = {},
    /** The staff app's console session (IDN-088), beside the web's. */
    opts: { staffApp?: boolean } = {},
  ): Promise<StaffSignedIn> {
    let accountId: string | null;
    try {
      accountId = (await this.deps.otp.verify(input.challengeId, input.otp, PURPOSE[surface]))
        .accountId;
    } catch (e) {
      throw await this.wrongCode(surface, input.challengeId, e);
    }
    const account = accountId
      ? await accountRepository.findById(this.deps.db, accountId)
      : undefined;
    if (!account || account.status !== 'ACTIVE') throw this.refused();
    if (account.signin_lock === 'LOCKED') throw this.locked();
    const access = await this.eligible(surface, account.id);
    if (!access) throw this.refused();
    await accessRepository.resetAbandoned(this.deps.db, account.id);
    const credential = await accountRepository.credential(this.deps.db, account.id, 'PASSWORD');
    if (credential && Boolean(Number(credential.must_change)) && this.deps.flows) {
      // OI-IDN-20: a generated password is changed at first sign-in; no session until then.
      const minutes = await this.limit(LIMITS.staffResetLinkMinutes);
      const { token } = await this.deps.flows.issue(
        'staff-password-reset',
        { acc: binToUuid(account.public_id), rv: credential.row_version, srf: surface },
        minutes * 60,
      );
      this.deps.loggers.security.info('auth.staff_password_change_required', { surface });
      return { passwordChange: { resetToken: token }, name: fullName(account) };
    }
    await accountRepository.signinSuccess(this.deps.db, account.id, this.now());
    const tokens = await this.deps.sessions.start(
      {
        accountId: account.id,
        accountPublicId: binToUuid(account.public_id),
        surface,
        ...(opts.staffApp && surface === 'console' ? { staffApp: true } : {}),
        ...(access.surface === 'console' || access.surface === 'portal'
          ? {
              institution: {
                id: access.ctx.institution_id,
                publicId: binToUuid(access.ctx.institution_public_id),
              },
              profile: {
                id: access.ctx.profile_id,
                publicId: binToUuid(access.ctx.profile_public_id),
              },
            }
          : {}),
      },
      client,
    );
    this.deps.loggers.security.info('auth.staff_signed_in', {
      surface,
      ...(opts.staffApp ? { client: 'staff-app' } : {}),
    });
    return { tokens, name: fullName(account) };
  }

  /**
   * IDN-092 (client 2026-10-27: "after click on this i should login again with the phone number and
   * Password and OTP this is not required"): the member app's "Open the staff app" opens the staff
   * app's console session for the account signed in on this phone, without a second sign-in. The
   * member session already proved the password and, for this phone, the code (it is bound to the
   * device, FR-IDN-09); the console's own checks still apply — an active, unlocked account with a
   * console role at its school. A temporary password still to be changed, or anything else refused,
   * answers the one 6.4 refusal, and the app falls back to the staff sign-in (IDN-031).
   *
   * Client 2026-10-27 ("one login, one unified experience" for staff; a choice of mode for a parent
   * who is also staff): the member session goes on beside the staff app's, so one sign-in gives
   * both. Each still reaches only its own surface's routes, checked as before; signing out ends
   * both (the app signs each out).
   */
  async staffAppFromMember(p: Principal, client: ClientContext = {}): Promise<StaffSignedIn> {
    if (p.surface !== 'member' || !isUuid(p.subject) || !isUuid(p.sessionId)) throw this.refused();
    const now = this.now();
    const member = await this.deps.db
      .selectFrom('sessions as s')
      .innerJoin('platform_accounts as a', 'a.id', 's.account_id')
      .select(['s.device_id', 'a.id as account_id', 'a.public_id'])
      .where('s.public_id', '=', uuidToBin(p.sessionId))
      .where('s.surface', '=', 'MEMBER')
      .where('s.ended_at', 'is', null)
      .where('s.absolute_expires_at', '>', now)
      .executeTakeFirst();
    if (
      !member ||
      member.device_id === null ||
      binToUuid(member.public_id).toLowerCase() !== p.subject.toLowerCase()
    ) {
      throw this.refused();
    }
    const account = await accountRepository.findById(this.deps.db, String(member.account_id));
    if (!account || account.status !== 'ACTIVE') throw this.refused();
    if (account.signin_lock === 'LOCKED') throw this.locked();
    const access = await this.eligible('console', account.id);
    if (!access || access.surface !== 'console') {
      this.deps.loggers.security.warn('auth.staff_app_from_member_refused', {
        reason: 'no_access',
      });
      throw this.refused();
    }
    const credential = await accountRepository.credential(this.deps.db, account.id, 'PASSWORD');
    if (credential && Boolean(Number(credential.must_change))) {
      // OI-IDN-20: the temporary password is changed through the staff sign-in first.
      throw this.refused();
    }
    const tokens = await this.deps.sessions.start(
      {
        accountId: account.id,
        accountPublicId: binToUuid(account.public_id),
        surface: 'console',
        staffApp: true,
        institution: {
          id: access.ctx.institution_id,
          publicId: binToUuid(access.ctx.institution_public_id),
        },
        profile: {
          id: access.ctx.profile_id,
          publicId: binToUuid(access.ctx.profile_public_id),
        },
      },
      client,
    );
    this.deps.loggers.security.info('auth.staff_signed_in', {
      surface: 'console',
      client: 'staff-app',
      via: 'member-app',
    });
    return { tokens, name: fullName(account) };
  }

  /** IDN-089: the staff app renews its console session with the refresh token in the body. */
  refreshStaffApp(refreshToken: string, client: ClientContext = {}) {
    return this.deps.sessions.refresh(refreshToken, client, 'console', true);
  }

  /** A failed code: tries left, or the attempt ends (and may lock the account). */
  private async wrongCode(surface: StaffSurface, challengeId: string, e: unknown) {
    if (!(e instanceof CustomAPIError) || !isUuid(challengeId)) return e;
    const c = await otpRepository.findByPublicId(this.deps.db, uuidToBin(challengeId));
    if (!c || c.purpose !== PURPOSE[surface] || !c.account_id) return e;
    const code: MessageKey = e.code;
    if (code === 'AUTH.OTP_INVALID') {
      const triesLeft = Math.max(0, c.max_attempts - c.attempts);
      return new BadRequestError('AUTH.OTP_INVALID', { params: { triesLeft } });
    }
    if (code === 'AUTH.OTP_ATTEMPTS_EXCEEDED') {
      const lockAfter = await this.limit(LIMITS.consoleLockAfterAbandonedAttempts);
      const locked = await accessRepository.abandonedAttempt(this.deps.db, c.account_id, lockAfter);
      this.deps.loggers.security.warn('auth.staff_attempt_abandoned', { surface, locked });
      if (locked) return this.locked();
      return new BadRequestError('IDN.SIGNIN_ATTEMPT_ENDED', {
        params: { count: c.max_attempts },
      });
    }
    return e;
  }

  /**
   * IDN-034 / IDN-082: "Forgot password?" — a link to choose a new password goes to the account's
   * e-mail when the account may enter this surface. The answer never differs (enumeration-safe).
   * The link works once (it carries the password's version) within the setting's minutes.
   */
  async forgotPassword(surface: StaffSurface, input: { email: string }): Promise<void> {
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    if (!PATTERNS.email.test(email)) return;
    const account = await accessRepository.findAccountByEmail(this.deps.db, email);
    if (!account || !account.email || account.status !== 'ACTIVE') return;
    if (!(await this.eligible(surface, account.id))) return;
    if (!this.deps.flows || !this.deps.email) return;
    const credential = await accountRepository.credential(this.deps.db, account.id, 'PASSWORD');
    const minutes = await this.limit(LIMITS.staffResetLinkMinutes);
    const { token } = await this.deps.flows.issue(
      'staff-password-reset',
      { acc: binToUuid(account.public_id), rv: credential?.row_version ?? 0, srf: surface },
      minutes * 60,
    );
    const area = surface === 'ops' ? 'backoffice' : surface;
    const link = `${this.deps.webUrl ?? 'https://localhost:4200'}/${area}/reset-password#token=${token}`;
    const where =
      surface === 'ops'
        ? 'back office'
        : surface === 'portal'
          ? 'customer portal'
          : 'institution console';
    await this.deps.email.send({
      to: account.email,
      purpose: `password_reset.${surface}`,
      text: `Choose a new password for the RingPe ${where}: ${link} — the link works once, within ${minutes} minutes. If you didn't ask for it, ignore this e-mail; your password stays the same.`,
    });
    this.deps.loggers.security.info('auth.staff_reset_link_sent', { surface });
  }

  /** IDN-083: the new password; every session of the account ends. */
  async resetPassword(input: {
    resetToken: string;
    newPassword: string;
  }): Promise<{ surface: StaffSurface }> {
    const claims = this.deps.flows
      ? await this.deps.flows.verify('staff-password-reset', String(input.resetToken ?? ''))
      : undefined;
    const acc = claims?.['acc'];
    const rv = claims?.['rv'];
    const srf = claims?.['srf'];
    if (
      typeof acc !== 'string' ||
      typeof rv !== 'number' ||
      (srf !== 'console' && srf !== 'ops' && srf !== 'portal')
    ) {
      throw new CustomAPIError(401, 'IDN.RESET_LINK_INVALID');
    }
    const policy = {
      minLength: await this.limit(LIMITS.passwordMinLength),
      maxLength: await this.limit(LIMITS.passwordMaxLength),
    };
    if (!isValidPassword(String(input.newPassword ?? ''), policy)) {
      throw new ValidationError([{ field: 'newPassword', code: 'IDN.PASSWORD_FORMAT' }]);
    }
    const account = await accountRepository.findByPublicId(this.deps.db, uuidToBin(acc));
    if (!account) throw new CustomAPIError(401, 'IDN.RESET_LINK_INVALID');
    const hash = await hashSecret(input.newPassword);
    await this.deps.db.transaction().execute(async (trx) => {
      const current = await accountRepository.lockCredential(trx, account.id, 'PASSWORD');
      if ((current?.row_version ?? 0) !== rv)
        throw new CustomAPIError(401, 'IDN.RESET_LINK_INVALID');
      if (current) {
        await accountRepository.replaceCredential(trx, {
          id: current.id,
          hash,
          previousHash: current.hash,
          expectedVersion: current.row_version,
        });
      } else {
        await accountRepository.insertCredential(trx, {
          accountId: account.id,
          kind: 'PASSWORD',
          hash,
        });
      }
      await accountRepository.resetFailures(trx, account.id);
      await recordAudit(trx, {
        action: 'PASSWORD_RESET',
        entityType: 'platform_account',
        entityRef: acc,
        after: { surface: srf },
        actor: { type: srf === 'ops' ? 'operator' : srf, ref: acc },
      });
    });
    await this.deps.sessions.endAllForAccount(account.id, 'PASSWORD_RESET');
    this.deps.loggers.security.info('auth.staff_password_reset', { surface: srf });
    return { surface: srf };
  }

  /** IDN-079: who is signed in to the console — name, institution, roles, grants. */
  async consoleSession(p: Principal) {
    if (!p.profileId) throw this.refused();
    const prof = await accessRepository.institutionOfProfile(this.deps.db, uuidToBin(p.profileId));
    if (!prof) throw this.refused();
    const account = await accountRepository.findByPublicId(this.deps.db, uuidToBin(p.subject));
    const roles = await accessRepository.profileRoles(this.deps.db, prof.profile_id);
    const institutionId = binToUuid(prof.institution_public_id);
    const logo = await logoFileOf(this.deps.db, { publicId: institutionId });
    return {
      name: account ? fullName(account) : fullName(prof),
      email: account?.email ?? null,
      institution: {
        id: institutionId,
        name: prof.institution_name,
        shortName: prof.short_name,
        city: prof.city,
        // The school's logo for the console's menu (client 2026-10-15).
        logoUrl: logo ? logoPath(logo.institutionId, logo.fileId) : null,
      },
      roles: roles.map((r) => ({ code: r.code, name: r.name, readOnly: r.read_only === 1 })),
      subTasks: [...p.subTasks],
      preferredLang: account?.preferred_lang ?? 'en',
    };
  }

  /** SAS-044: who is signed in to the customer portal — name and the institution. */
  async portalSession(p: Principal) {
    const account = await accountRepository.findByPublicId(this.deps.db, uuidToBin(p.subject));
    if (!account) throw this.refused();
    const ctx = await accessRepository.portalContext(this.deps.db, account.id);
    if (!ctx || !p.institutionId || binToUuid(ctx.institution_public_id) !== p.institutionId) {
      throw this.refused();
    }
    return {
      name: fullName(account),
      email: account.email,
      mobile: account.mobile,
      institution: {
        id: binToUuid(ctx.institution_public_id),
        name: ctx.institution_name,
        shortName: ctx.short_name,
        city: ctx.city,
        identifier: ctx.identifier,
        status: ctx.institution_status,
      },
      preferredLang: account.preferred_lang,
    };
  }

  /** IDN-080: who is signed in to the back office — name, operator role, grants. */
  async opsSession(p: Principal) {
    const account = await accountRepository.findByPublicId(this.deps.db, uuidToBin(p.subject));
    if (!account) throw this.refused();
    const op = await accessRepository.operatorContext(this.deps.db, account.id);
    if (!op) throw this.refused();
    return {
      name: fullName(account),
      email: account.email,
      role: { code: op.role_code, name: op.role_name },
      subTasks: [...p.subTasks],
      preferredLang: account.preferred_lang,
    };
  }

  /** The grants that go into a staff session's access token (SessionService GrantsProvider). */
  async grants(s: {
    accountId: string;
    surface: string;
    profileId: string | null;
  }): Promise<readonly string[]> {
    if (s.surface === 'console' && s.profileId) {
      return accessRepository.profileGrants(this.deps.db, s.profileId);
    }
    if (s.surface === 'ops') return accessRepository.operatorGrants(this.deps.db, s.accountId);
    return [];
  }
}

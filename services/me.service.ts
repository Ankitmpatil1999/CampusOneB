/**
 * The signed-in person's own account (IDN-013, IDN-024, IDN-029, IDN-030; SRS 6.9, 6.15, 6.16,
 * 6.17). The response lists the institution profiles on the account (a parent and the children
 * registered under the number, CR-04); an account without one works as a personal account. The menu
 * and features join with the member app's money screens (Phase 3).
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { accessRepository } from '../repositories/access.repository';
import { accountRepository, referenceRepository } from '../repositories/account.repository';
import { kindOf } from '../repositories/members.repository';
import { recordAudit } from './audit.service';
import type { IssuedChallenge, OtpService } from './otp.service';
import type { SessionService } from './session.service';
import { defaultValues, type SettingValues } from './settings.service';
import { institutionItems, logoFileOf, logoPath } from './institution-logo';
import { AuthenticationError, CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import { maskIdNumber, maskPan } from '../utils/fieldEncryption';
import { binToUuid, uuidToBin } from '../utils/idGenerator';
import { hashSecret, verifySecret } from '../utils/password';
import type { Principal } from '../utils/principal';
import type { FlowTokens } from '../utils/flow-tokens';
import { PATTERNS, isValidPassword } from '../utils/validators';

export interface MeServiceDeps {
  readonly db: Kysely<Database>;
  readonly sessions: SessionService;
  readonly otp?: OtpService;
  readonly flows?: FlowTokens;
  readonly settings?: { values(): Promise<SettingValues> };
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * What opens a module of the staff app (client 2026-10-19: Accounts, Co-ordinator, Counsellor): the
 * sub-tasks behind its tabs and links — fees, admissions and their fees, the admission QR, teacher
 * leave, attendance, announcements and the calendar.
 */
const OFFICE_GRANTS = [
  'fees.view',
  'admfees.view',
  'admissions.view',
  'admqr.view',
  'leave.decide',
  'attendance.view',
  'comms.view',
  'academics.view',
];
/** A person's own console roles, not office work (they have their own homes in the app). */
const OWN_ROLES = ['TEACHER', 'PRINCIPAL', 'MERCHANT', 'VENDOR_MERCHANT'];

export class MeService {
  constructor(private readonly deps: MeServiceDeps) {}

  private async account(p: Principal) {
    const a = await accountRepository.findByPublicId(this.deps.db, uuidToBin(p.subject));
    if (!a || a.status !== 'ACTIVE') throw new AuthenticationError();
    return a;
  }

  /** IDN-013: account, institution profiles, active profile, menu and features. */
  async me(p: Principal) {
    const a = await this.account(p);
    const profiles = await this.profiles(a.id);
    return {
      account: {
        accountId: binToUuid(a.public_id),
        mobile: a.mobile,
        email: a.email,
        emailVerified: a.email_verified_at !== null,
        firstName: a.first_name,
        middleName: a.middle_name,
        lastName: a.last_name,
        gender: a.gender,
        dob: a.dob ? new Date(a.dob).toISOString().slice(0, 10) : null,
        pan: maskPan(a.pan_last4),
        idDocument: a.id_doc_type
          ? { type: a.id_doc_type, number: maskIdNumber(a.id_doc_type, a.id_doc_last4) }
          : null,
        kycLevel: a.kyc_level,
        preferredLang: a.preferred_lang,
        lastSignInAt: iso(a.last_signin_at),
      },
      profiles,
      activeProfileId: p.profileId ?? profiles[0]?.id ?? null,
      menu: [] as unknown[],
      features: {} as Record<string, boolean>,
    };
  }

  /**
   * IDN-014: the profile the app works for (a parent switches to a child, CR-04). It must be on
   * this account; the session keeps it, and the next token refresh carries it.
   */
  async setActiveProfile(p: Principal, input: { profileId: string }) {
    const a = await this.account(p);
    const profiles = await this.profiles(a.id);
    const chosen = profiles.find((x) => x.id === input.profileId.toLowerCase());
    if (!chosen) throw new CustomAPIError(404, 'IDN.PROFILE_NOT_LINKED');
    const row = await this.deps.db
      .selectFrom('member_profiles')
      .select(['id', 'institution_id'])
      .where('public_id', '=', uuidToBin(chosen.id))
      .executeTakeFirstOrThrow();
    await this.deps.db
      .updateTable('sessions')
      .set({ profile_id: String(row.id), institution_id: String(row.institution_id) })
      .where('public_id', '=', uuidToBin(p.sessionId))
      .where('account_id', '=', a.id)
      .execute();
    await recordAudit(this.deps.db, {
      action: 'ACTIVE_PROFILE_CHANGED',
      entityType: 'platform_account',
      entityRef: binToUuid(a.public_id),
      after: { profile: chosen.id },
      actor: { type: 'member', ref: p.subject },
    });
    return { activeProfileId: chosen.id };
  }

  /**
   * IDN-093 (client 2026-10-27: a person may belong to several institutions): the institutions of
   * the account's profiles, in the order of IDN-013's profiles, and the session's.
   */
  async institutions(p: Principal) {
    const a = await this.account(p);
    const rows = await accessRepository.memberProfiles(this.deps.db, a.id);
    return {
      current: p.institutionId ?? null,
      institutions: await institutionItems(this.deps.db, rows),
    };
  }

  /**
   * IDN-094: the app opens another of the account's institutions — the session works for the
   * account's best profile there (the account holder's own first, else a child under the account
   * or a student's own login, as IDN-013 orders them). The next token refresh carries it.
   */
  async setInstitution(p: Principal, input: { institutionId: string }) {
    const a = await this.account(p);
    const wanted = input.institutionId.toLowerCase();
    const chosen = (await accessRepository.memberProfiles(this.deps.db, a.id)).find(
      (r) => binToUuid(r.institution_public_id) === wanted,
    );
    if (!chosen) throw new CustomAPIError(404, 'IDN.INSTITUTION_NOT_LINKED');
    await this.deps.db
      .updateTable('sessions')
      .set({ profile_id: String(chosen.id), institution_id: String(chosen.institution_id) })
      .where('public_id', '=', uuidToBin(p.sessionId))
      .where('account_id', '=', a.id)
      .execute();
    const activeProfileId = binToUuid(chosen.public_id);
    await recordAudit(this.deps.db, {
      institutionId: String(chosen.institution_id),
      action: 'ACTIVE_INSTITUTION_CHANGED',
      entityType: 'platform_account',
      entityRef: binToUuid(a.public_id),
      before: { institution: p.institutionId ?? null },
      after: { institution: wanted, profile: activeProfileId },
      actor: { type: 'member', ref: p.subject },
    });
    return { activeProfileId, institutionId: wanted };
  }

  /** Institution profiles on this account (a parent and the children under the number, CR-04). */
  private async profiles(accountId: string) {
    const rows = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('academic_years as y', (j) =>
        j.onRef('y.institution_id', '=', 'm.institution_id').on('y.is_current', '=', 1),
      )
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').onRef('e.year_id', '=', 'y.id'),
      )
      .leftJoin('sections as s', 's.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.member_seq',
        'm.first_name',
        'm.last_name',
        'm.status',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'i.short_name',
        'ut.name as user_type',
        'ut.category',
        'c.name as class_name',
        's.name as section_name',
      ])
      .where((eb) =>
        // The account's profiles, or a student's own login (client 2026-10-23).
        eb.or([eb('m.account_id', '=', accountId), eb('m.own_account_id', '=', accountId)]),
      )
      // The account holder's own profile first: a child under the account (a ward of another
      // profile on it, CR-04) never comes before its parent.
      .orderBy(
        sql`EXISTS (SELECT 1 FROM guardianships gw JOIN member_profiles gp ON gp.id = gw.guardian_profile_id
                    WHERE gw.ward_profile_id = m.id AND gp.account_id = m.account_id)`,
      )
      .orderBy('m.id')
      .execute();
    // Each school's logo, once per school (client 2026-10-15).
    const logos = new Map<string, string | null>();
    for (const id of new Set(rows.map((r) => binToUuid(r.institution_public_id)))) {
      const f = await logoFileOf(this.deps.db, { publicId: id });
      logos.set(id, f ? logoPath(f.institutionId, f.fileId) : null);
    }
    // The office work a profile's console roles open in the staff app (client 2026-10-23): the app
    // offers it from the member's home, so Accounts, the Co-ordinator and the Counsellor find it.
    const office = new Map<string, string[]>();
    for (const r of rows) {
      if (r.category === 'STUDENT' || r.category === 'PARENT') continue;
      const grants = await accessRepository.profileGrants(this.deps.db, String(r.id));
      if (!grants.some((g) => OFFICE_GRANTS.includes(g))) continue;
      const roles = await accessRepository.profileRoles(this.deps.db, String(r.id));
      office.set(
        String(r.id),
        roles.filter((x) => !OWN_ROLES.includes(x.code ?? '')).map((x) => x.name),
      );
    }
    return rows.map((r) => ({
      id: binToUuid(r.public_id),
      memberNo: `${r.short_name}-${String(r.member_seq).padStart(5, '0')}`,
      name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      institution: {
        id: binToUuid(r.institution_public_id),
        name: r.institution_name,
        shortName: r.short_name,
        logoUrl: logos.get(binToUuid(r.institution_public_id)) ?? null,
      },
      userType: r.user_type,
      kind: kindOf(r.category),
      category: r.category,
      grade: r.class_name ? `${r.class_name} ${r.section_name ?? ''}`.trim() : null,
      status: r.status,
      office: office.has(String(r.id)) ? { roles: office.get(String(r.id))! } : null,
    }));
  }

  /** IDN-024: current password required; the new one must differ; other sessions end. */
  async changePassword(p: Principal, input: { currentPassword: string; newPassword: string }) {
    const a = await this.account(p);
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    const policy = {
      minLength: v[LIMITS.passwordMinLength.key] ?? LIMITS.passwordMinLength.value,
      maxLength: v[LIMITS.passwordMaxLength.key] ?? LIMITS.passwordMaxLength.value,
    };
    const current = await accountRepository.credential(this.deps.db, a.id, 'PASSWORD');
    if (!current || !(await verifySecret(current.hash, input.currentPassword))) {
      throw new ValidationError([{ field: 'currentPassword', code: 'IDN.PASSWORD_MISMATCH' }]);
    }
    if (input.newPassword === input.currentPassword) {
      throw new ValidationError([{ field: 'newPassword', code: 'IDN.PASSWORD_SAME' }]);
    }
    if (!isValidPassword(input.newPassword, policy)) {
      throw new ValidationError([{ field: 'newPassword', code: 'IDN.PASSWORD_FORMAT' }]);
    }
    const hash = await hashSecret(input.newPassword);
    await this.deps.db.transaction().execute(async (trx) => {
      const locked = await accountRepository.lockCredential(trx, a.id, 'PASSWORD');
      if (!locked)
        throw new ValidationError([{ field: 'currentPassword', code: 'IDN.PASSWORD_MISMATCH' }]);
      await accountRepository.replaceCredential(trx, {
        id: locked.id,
        hash,
        previousHash: locked.hash,
        expectedVersion: locked.row_version,
      });
      await recordAudit(trx, {
        action: 'PASSWORD_CHANGED',
        entityType: 'platform_account',
        entityRef: binToUuid(a.public_id),
      });
    });
    await this.deps.sessions.endAllForAccount(a.id, 'PASSWORD_CHANGED', undefined, p.sessionId);
  }

  /**
   * IDN-018: a new e-mail takes effect only once the code sent to it is confirmed (6.9, OI-IDN-10;
   * prototype m.security). Returns the code challenge and a signed change token for IDN-019.
   */
  async startEmailChange(
    p: Principal,
    input: { email: string },
  ): Promise<{ challenge: IssuedChallenge; changeToken: string }> {
    const a = await this.account(p);
    const email = input.email.trim().toLowerCase();
    if (email.length > 254 || !PATTERNS.email.test(email)) {
      throw new ValidationError([{ field: 'email', code: 'VALIDATION.EMAIL' }]);
    }
    if (email === a.email) {
      throw new ValidationError([{ field: 'email', code: 'IDN.EMAIL_UNCHANGED' }]);
    }
    if (await accountRepository.emailInUse(this.deps.db, email)) {
      throw new ValidationError([{ field: 'email', code: 'IDN.EMAIL_TAKEN' }]);
    }
    if (!this.deps.otp || !this.deps.flows) throw new Error('e-mail change is not configured');
    const challenge = await this.deps.otp.issue({
      purpose: 'EMAIL_CHANGE',
      channel: 'EMAIL',
      destination: email,
      accountId: a.id,
      reuseLive: true,
    });
    const { token } = await this.deps.flows.issue(
      'email-change',
      { acc: binToUuid(a.public_id), em: email, cid: challenge.challengeId },
      Math.max(60, Math.ceil((challenge.expiresAt.getTime() - Date.now()) / 1000)),
    );
    return { challenge, changeToken: token };
  }

  /** IDN-019: the code from the new address confirms the change (unique again at that moment). */
  async confirmEmailChange(
    p: Principal,
    input: { changeToken: string; challengeId: string; otp: string },
  ): Promise<{ email: string }> {
    const a = await this.account(p);
    if (!this.deps.otp || !this.deps.flows) throw new Error('e-mail change is not configured');
    const claims = await this.deps.flows.verify('email-change', input.changeToken);
    const email = claims?.['em'];
    if (
      !claims ||
      typeof email !== 'string' ||
      claims['acc'] !== binToUuid(a.public_id) ||
      claims['cid'] !== input.challengeId
    ) {
      throw new CustomAPIError(401, 'IDN.SIGNUP_SESSION_ENDED');
    }
    const verified = await this.deps.otp.verify(input.challengeId, input.otp, 'EMAIL_CHANGE');
    if (!verified.destinationHash.equals(this.deps.otp.destinationHash('EMAIL', email))) {
      throw new CustomAPIError(401, 'IDN.SIGNUP_SESSION_ENDED');
    }
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        if (await accountRepository.emailInUse(trx, email)) {
          throw new ValidationError([{ field: 'email', code: 'IDN.EMAIL_TAKEN' }]);
        }
        await accountRepository.setVerifiedEmail(trx, a.id, email);
        await recordAudit(trx, {
          action: 'EMAIL_CHANGED',
          entityType: 'platform_account',
          entityRef: binToUuid(a.public_id),
          before: { email: a.email },
          after: { email },
          actor: { type: 'member', ref: binToUuid(a.public_id) },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ValidationError([{ field: 'email', code: 'IDN.EMAIL_TAKEN' }]);
      }
      throw e;
    }
    return { email };
  }

  /** IDN-029: the one bound device (6.15). */
  async devices(p: Principal) {
    const a = await this.account(p);
    const d = await accountRepository.activeDevice(this.deps.db, a.id);
    return {
      device: d
        ? {
            deviceId: binToUuid(d.public_id),
            model: d.model,
            os: d.os,
            appVersion: d.app_version,
            boundAt: iso(d.bound_at),
          }
        : null,
    };
  }

  /** IDN-030: re-selecting the current language is a no-op (OI-IDN-18). */
  async setLanguage(p: Principal, lang: string) {
    const a = await this.account(p);
    if (!(await referenceRepository.languageEnabled(this.deps.db, lang))) {
      throw new CustomAPIError(422, 'IDN.LANGUAGE_INVALID', { params: { code: lang } });
    }
    if (a.preferred_lang !== lang)
      await accountRepository.setPreferredLang(this.deps.db, a.id, lang);
    return { preferredLang: lang };
  }
}

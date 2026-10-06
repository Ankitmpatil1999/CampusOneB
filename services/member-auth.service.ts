/**
 * Member sign-up, sign-in, device binding and password recovery (SRS 6.2, 6.3, 6.8, 6.15;
 * FR-IDN-01/02/06/08/09; BR-01, BR-05; OI-IDN-02/09; Q13, Q16(a) personal wallet in scope).
 *
 * Messages are the 27.5 texts (Q22). Limits come from the settings in force (changeable).
 * Not yet here, by phase:
 * - the personal wallet created with the account (RNG-IDN-018) arrives with the wallet module
 *   (Phase 3), which also opens wallets for accounts created before it;
 * - the default member role arrives with roles (2.3);
 * - linking to institution profiles that carry the mobile (OI-IDN-03) arrives with members (2.5).
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { GENDERS, LIMITS } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/ringpe_models';
import { accountRepository, referenceRepository } from '../repositories/account.repository';
import { membersRepository } from '../repositories/members.repository';
import { otpRepository } from '../repositories/otp.repository';
import { recordAudit } from './audit.service';
import type { IssuedChallenge, OtpService } from './otp.service';
import type { ClientContext, SessionService, SessionTokens } from './session.service';
import { defaultValues, type SettingValues } from './settings.service';
import {
  AuthorizationError,
  ConflictError,
  CustomAPIError,
  ValidationError,
} from '../utils/CustomAPIError';
import { lastFour, normaliseForIndex, type FieldCipher } from '../utils/fieldEncryption';
import type { FlowTokens } from '../utils/flow-tokens';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { ipToBin } from '../utils/ip';
import { hashSecret, needsRehash, normaliseAnswer, verifySecret } from '../utils/password';
import { PATTERNS, isRealDate, isValidPassword } from '../utils/validators';
import { retryOnLock } from '../utils/retry';
import type { FieldError } from '../utils/validators';

export interface DeviceInfo {
  readonly installId: string;
  readonly model?: string;
  readonly os?: string;
  readonly appVersion?: string;
}

export interface SignupInput {
  readonly signupToken: string;
  /** Sign-up after a sign-in provider (CR-03): PAN and password become optional. */
  readonly socialTicket?: string;
  readonly mobile: string;
  readonly consentVersion: string;
  readonly termsVersion: string;
  readonly termsAccepted: boolean;
  readonly pan?: string;
  readonly firstName: string;
  readonly middleName?: string;
  readonly lastName?: string;
  readonly gender: string;
  readonly dob: string;
  readonly idDocType: string;
  readonly idDocNumber: string;
  readonly email: string;
  readonly password?: string;
  readonly securityQuestion: string;
  readonly securityAnswer: string;
  readonly device: DeviceInfo;
}

export interface AccountSummary {
  readonly accountId: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly preferredLang: string;
}

export type SignInResult =
  | { readonly kind: 'session'; readonly tokens: SessionTokens; readonly account: AccountSummary }
  | { readonly kind: 'device'; readonly challenge: IssuedChallenge };

export interface MemberAuthDeps {
  readonly db: Kysely<Database>;
  readonly cipher: FieldCipher;
  readonly otp: OtpService;
  readonly sessions: SessionService;
  readonly flows: FlowTokens;
  readonly loggers: Loggers;
  readonly settings?: { values(): Promise<SettingValues> };
  readonly now?: () => Date;
}

const NAME = /^[a-zA-Z]+$/;
const ANSWER = /^[a-z]+$/;

const yearsBetween = (dob: string, on: Date) => {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  let age = on.getUTCFullYear() - y;
  const before = on.getUTCMonth() + 1 < m || (on.getUTCMonth() + 1 === m && on.getUTCDate() < d);
  if (before) age -= 1;
  return age;
};

export class MemberAuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: MemberAuthDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async values(): Promise<SettingValues> {
    return this.deps.settings ? this.deps.settings.values() : defaultValues();
  }

  private async limit(l: { key: string; value: number }): Promise<number> {
    return (await this.values())[l.key] ?? l.value;
  }

  private async passwordPolicy() {
    return {
      minLength: await this.limit(LIMITS.passwordMinLength),
      maxLength: await this.limit(LIMITS.passwordMaxLength),
    };
  }

  /**
   * The profile a new member session works for: the first linked one, as IDN-013 shows it. The token
   * then carries it, so paying works right after sign-in; IDN-014 switches it (CR-04).
   */
  private async defaultProfile(accountId: string) {
    const r = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .select([
        'm.id',
        'm.public_id',
        'i.id as institution_id',
        'i.public_id as institution_public',
      ])
      .where('m.account_id', '=', accountId)
      // The account holder's own profile first: a child under the account (a ward of another
      // profile on it, CR-04) never comes before its parent.
      .orderBy(
        sql`EXISTS (SELECT 1 FROM guardianships gw JOIN member_profiles gp ON gp.id = gw.guardian_profile_id
                    WHERE gw.ward_profile_id = m.id AND gp.account_id = m.account_id)`,
      )
      .orderBy('m.id')
      .limit(1)
      .executeTakeFirst();
    return r
      ? {
          profile: { id: String(r.id), publicId: binToUuid(r.public_id) },
          institution: { id: String(r.institution_id), publicId: binToUuid(r.institution_public) },
        }
      : {};
  }

  private installHash(installId: string): Buffer {
    return this.deps.cipher.blindIndex('device_install', installId);
  }

  /** Everything the sign-up wizard shows (IDN-077): consent, terms, questions, documents, genders. */
  async signupReference() {
    const [consent, terms, questions, docs] = await Promise.all([
      referenceRepository.activeConsent(this.deps.db, 'CONSENT'),
      referenceRepository.activeConsent(this.deps.db, 'TERMS'),
      referenceRepository.securityQuestions(this.deps.db),
      referenceRepository.idDocumentTypes(this.deps.db),
    ]);
    const doc = (c: typeof consent) =>
      c
        ? { version: c.version, title: c.title_en, text: c.body_en, draft: Boolean(c.is_draft) }
        : null;
    const policy = await this.passwordPolicy();
    return {
      consent: doc(consent),
      terms: doc(terms),
      securityQuestions: questions.map((q) => ({
        code: q.code,
        labelKey: q.label_key,
        text: q.text_en,
      })),
      idDocumentTypes: docs.map((d) => ({ code: d.code, labelKey: d.label_key })),
      genders: GENDERS.map((g) => ({ code: g.code, labelKey: g.labelKey, text: g.en })),
      password: policy,
      minAgeYears: await this.limit(LIMITS.signupMinAgeYears),
    };
  }

  /** Step 1 (IDN-001): consent + mobile → code by SMS; a live code is returned as is (RNG-IDN-010). */
  async startSignup(input: { mobile: string; consentVersion: string }): Promise<IssuedChallenge> {
    if (!PATTERNS.mobile.test(input.mobile)) {
      throw new ValidationError([{ field: 'mobile', code: 'VALIDATION.MOBILE' }]);
    }
    if (!(await referenceRepository.consentExists(this.deps.db, 'CONSENT', input.consentVersion))) {
      throw new CustomAPIError(422, 'IDN.CONSENT_UNKNOWN');
    }
    if (await accountRepository.findByMobile(this.deps.db, input.mobile)) {
      throw new ConflictError('IDN.ACCOUNT_EXISTS');
    }
    return this.deps.otp.issue({
      purpose: 'SIGNUP',
      channel: 'SMS',
      destination: input.mobile,
      reuseLive: true,
    });
  }

  /** Step 2 (IDN-002): code → a sign-up token valid for the registration session (3 h, setting). */
  async verifySignupCode(input: { challengeId: string; otp: string }) {
    const verified = await this.deps.otp.verify(input.challengeId, input.otp, 'SIGNUP');
    const ttl = (await this.limit(LIMITS.signupSessionMinutes)) * 60;
    const { token, expiresAt } = await this.deps.flows.issue(
      'signup',
      { dh: verified.destinationHash.toString('base64url'), cid: input.challengeId },
      ttl,
    );
    return { signupToken: token, expiresAt };
  }

  /** Steps 3–5 (IDN-003): validates everything, creates the account and signs in on this device. */
  async completeSignup(input: SignupInput, client: ClientContext = {}) {
    const claims = await this.deps.flows.verify('signup', input.signupToken);
    const mobileHash = this.deps.otp.destinationHash('SMS', input.mobile);
    if (!claims || claims['dh'] !== mobileHash.toString('base64url')) {
      throw new CustomAPIError(401, 'IDN.SIGNUP_SESSION_ENDED');
    }
    if (!input.termsAccepted) throw new CustomAPIError(422, 'IDN.TERMS_REQUIRED');
    const social = input.socialTicket
      ? await this.deps.flows.verify('social-signup', input.socialTicket)
      : undefined;
    if (input.socialTicket && (!social || typeof social['sh'] !== 'string')) {
      throw new CustomAPIError(401, 'IDN.SOCIAL_STATE_INVALID');
    }
    for (const [kind, version] of [
      ['CONSENT', input.consentVersion],
      ['TERMS', input.termsVersion],
    ] as const) {
      if (!(await referenceRepository.consentExists(this.deps.db, kind, version))) {
        throw new CustomAPIError(422, 'IDN.CONSENT_UNKNOWN');
      }
    }

    const errors: FieldError[] = [];
    const now = this.now();
    // PAN opens the personal wallet; a provider sign-up may skip it (prototype m.signup, CR-03).
    const pan = (input.pan ?? '').trim().toUpperCase() || null;
    if (pan === null && !social) errors.push({ field: 'pan', code: 'VALIDATION.REQUIRED' });
    else if (pan !== null && !PATTERNS.pan.test(pan)) {
      errors.push({ field: 'pan', code: 'IDN.PAN_INVALID' });
    }
    const names = {
      firstName: input.firstName.trim(),
      middleName: input.middleName?.trim() || null,
      lastName: input.lastName?.trim() || null,
    };
    for (const [field, v] of Object.entries(names)) {
      if (field === 'firstName' && !v) errors.push({ field, code: 'VALIDATION.REQUIRED' });
      else if (v && (!NAME.test(v) || v.length > 60)) {
        errors.push({ field, code: 'IDN.NAME_LETTERS_ONLY' });
      }
    }
    if (!GENDERS.some((g) => g.code === input.gender)) {
      errors.push({ field: 'gender', code: 'VALIDATION.FORMAT' });
    }
    if (!isRealDate(input.dob)) {
      errors.push({ field: 'dob', code: 'VALIDATION.DATE' });
    } else if (yearsBetween(input.dob, now) < (await this.limit(LIMITS.signupMinAgeYears))) {
      errors.push({ field: 'dob', code: 'IDN.AGE_UNDER_18' });
    }
    const docTypes = await referenceRepository.idDocumentTypes(this.deps.db);
    const docType = docTypes.find((d) => d.code === input.idDocType);
    const docNumber = normaliseForIndex(input.idDocNumber);
    if (!docType) {
      errors.push({
        field: 'idDocType',
        code: 'IDN.ID_DOC_TYPE_INVALID',
        params: { types: docTypes.map((d) => d.code).join(', ') },
      });
    } else if (!new RegExp(docType.number_regex).test(docNumber)) {
      errors.push({ field: 'idDocNumber', code: 'IDN.ID_DOC_NUMBER_INVALID' });
    }
    const email = input.email.trim().toLowerCase();
    if (email.length > 254 || !PATTERNS.email.test(email)) {
      errors.push({ field: 'email', code: 'VALIDATION.EMAIL' });
    }
    // The provider's e-mail is used as is (read-only in the app).
    if (social && social['em'] !== email) throw new CustomAPIError(401, 'IDN.SIGNUP_SESSION_ENDED');
    const policy = await this.passwordPolicy();
    const password = input.password ?? '';
    if ((password !== '' || !social) && !isValidPassword(password, policy)) {
      errors.push({
        field: 'password',
        code: 'VALIDATION.PASSWORD',
        params: { min: policy.minLength, max: policy.maxLength },
      });
    }
    const questions = await referenceRepository.securityQuestions(this.deps.db);
    if (!questions.some((q) => q.code === input.securityQuestion)) {
      errors.push({ field: 'securityQuestion', code: 'IDN.SECURITY_QUESTION_INVALID' });
    }
    const answer = normaliseAnswer(input.securityAnswer);
    if (!ANSWER.test(answer)) {
      errors.push({ field: 'securityAnswer', code: 'IDN.SECURITY_ANSWER_FORMAT' });
    }
    if (!input.device?.installId) {
      errors.push({ field: 'device.installId', code: 'VALIDATION.REQUIRED' });
    }
    if (errors.length === 0) {
      if (await accountRepository.emailInUse(this.deps.db, email)) {
        errors.push({ field: 'email', code: 'IDN.EMAIL_TAKEN' });
      }
      if (
        pan !== null &&
        (await accountRepository.panInUse(this.deps.db, this.deps.cipher.blindIndex('pan', pan)))
      ) {
        errors.push({ field: 'pan', code: 'IDN.PAN_TAKEN' });
      }
    }
    if (errors.length > 0) throw new ValidationError(errors);

    const account = newPublicIdPair();
    const device = newPublicIdPair();
    const [passwordHash, answerHash] = await Promise.all([
      password ? hashSecret(password) : Promise.resolve(null),
      hashSecret(answer),
    ]);
    const c = this.deps.cipher;
    const lang = 'en';
    let created: { accountId: string; deviceId: string };
    try {
      // Re-run on a deadlock: the mobile lookup locks an index gap that a parallel sign-up for
      // another number can share before both insert (retryOnLock). Everything here is in the database.
      created = await retryOnLock(() =>
        this.deps.db.transaction().execute(async (trx) => {
          if (await accountRepository.lockByMobile(trx, input.mobile)) {
            throw new ConflictError('IDN.ACCOUNT_EXISTS');
          }
          const accountId = await accountRepository.insert(trx, {
            publicId: account.bin,
            mobile: input.mobile,
            email,
            firstName: names.firstName.toUpperCase(),
            middleName: names.middleName?.toUpperCase() ?? null,
            lastName: names.lastName?.toUpperCase() ?? null,
            gender: input.gender as 'MALE' | 'FEMALE',
            dob: input.dob,
            panEnc: pan ? c.encrypt('pan', pan, `platform_accounts.pan:${account.id}`) : null,
            panBidx: pan ? c.blindIndex('pan', pan) : null,
            panLast4: pan ? lastFour(pan) : null,
            idDocType: input.idDocType,
            idDocEnc: c.encrypt('id_doc', docNumber, `platform_accounts.id_doc:${account.id}`),
            idDocBidx: c.blindIndex('id_doc', docNumber),
            idDocLast4: lastFour(docNumber),
            preferredLang: lang,
          });
          // Profiles the institution created for this mobile link now (BR-01, 6.18).
          await membersRepository.linkByMobile(trx, accountId, input.mobile);
          if (passwordHash) {
            await accountRepository.insertCredential(trx, {
              accountId,
              kind: 'PASSWORD',
              hash: passwordHash,
            });
          }
          if (social) {
            await accountRepository.linkSocial(trx, {
              accountId,
              provider: String(social['p']),
              subjectHash: Buffer.from(String(social['sh']), 'base64url'),
              email,
            });
          }
          await accountRepository.insertCredential(trx, {
            accountId,
            kind: 'SECURITY_ANSWER',
            hash: answerHash,
            questionCode: input.securityQuestion,
          });
          const deviceId = await accountRepository.bindDevice(trx, {
            accountId,
            publicId: device.bin,
            installIdHash: this.installHash(input.device.installId),
            model: input.device.model ?? null,
            os: input.device.os ?? null,
            appVersion: input.device.appVersion ?? null,
            at: now,
            fresh: true,
          });
          for (const [kind, version] of [
            ['CONSENT', input.consentVersion],
            ['TERMS', input.termsVersion],
          ] as const) {
            await accountRepository.insertConsent(trx, {
              accountId,
              kind,
              version,
              ip: ipToBin(client.ip),
              deviceId,
            });
          }
          await accountRepository.signinSuccess(trx, accountId, now);
          await recordAudit(trx, {
            action: 'ACCOUNT_CREATED',
            entityType: 'platform_account',
            entityRef: account.id,
            after: {
              mobile: input.mobile,
              email,
              panLast4: pan ? lastFour(pan) : null,
              idDocType: input.idDocType,
              ...(social ? { signedUpWith: String(social['p']) } : {}),
            },
            actor: { type: 'member', ref: account.id },
          });
          return { accountId, deviceId };
        }),
      );
    } catch (e) {
      // A duplicate key from a parallel sign-up of the same mobile, e-mail or PAN.
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY')
        throw new ConflictError('IDN.ACCOUNT_EXISTS');
      throw e;
    }
    const tokens = await this.deps.sessions.start(
      {
        accountId: created.accountId,
        accountPublicId: account.id,
        surface: 'member',
        deviceId: created.deviceId,
        ...(await this.defaultProfile(created.accountId)),
      },
      client,
    );
    return {
      tokens,
      account: {
        accountId: account.id,
        firstName: names.firstName.toUpperCase(),
        lastName: names.lastName?.toUpperCase() ?? null,
        preferredLang: lang,
      },
    };
  }

  /** IDN-006: mobile + password; a new device gets a code first (FR-IDN-09). */
  async signIn(
    input: { mobile: string; password: string; device: DeviceInfo },
    client: ClientContext = {},
  ): Promise<SignInResult> {
    const policy = await this.passwordPolicy();
    if (!PATTERNS.mobile.test(input.mobile) || !isValidPassword(input.password, policy)) {
      throw new CustomAPIError(400, 'IDN.CREDENTIALS_FORMAT');
    }
    if (!input.device?.installId) {
      throw new ValidationError([{ field: 'device.installId', code: 'VALIDATION.REQUIRED' }]);
    }
    const now = this.now();
    const account = await accountRepository.findByMobile(this.deps.db, input.mobile);
    if (!account) throw new CustomAPIError(401, 'IDN.MOBILE_NOT_REGISTERED');
    await this.refuseIfLocked(account.locked_until, now);
    if (account.status !== 'ACTIVE') throw new AuthorizationError('IDN.ACCOUNT_DEACTIVATED');
    const credential = await accountRepository.credential(this.deps.db, account.id, 'PASSWORD');
    const ok = credential ? await verifySecret(credential.hash, input.password) : false;
    if (!ok) {
      const max = await this.limit(LIMITS.memberSignInLockAfterFailures);
      const minutes = await this.limit(LIMITS.memberSignInLockMinutes);
      const lock = account.failed_signins + 1 >= max;
      await accountRepository.signinFailure(
        this.deps.db,
        account.id,
        lock ? new Date(now.getTime() + minutes * 60_000) : null,
      );
      this.deps.loggers.security.warn('auth.signin_failed', { surface: 'member', locked: lock });
      if (lock) throw this.lockedError(minutes);
      throw new CustomAPIError(401, 'IDN.CREDENTIALS_INVALID');
    }
    if (credential && needsRehash(credential.hash)) {
      const fresh = await hashSecret(input.password);
      await accountRepository.replaceCredential(this.deps.db, {
        id: credential.id,
        hash: fresh,
        previousHash: credential.hash,
        expectedVersion: credential.row_version,
      });
    }
    return this.signInOnDevice(account, input.device, client);
  }

  /**
   * The account is proven (password, or a linked sign-in provider): the bound phone gets a session;
   * a new phone first gets a code to the account mobile (FR-IDN-09).
   */
  async signInOnDevice(
    account: {
      id: string;
      public_id: Buffer;
      mobile: string;
      status: string;
      locked_until: Date | string | null;
      first_name: string;
      last_name: string | null;
      preferred_lang: string;
    },
    deviceInfo: DeviceInfo,
    client: ClientContext = {},
  ): Promise<SignInResult> {
    const now = this.now();
    await this.refuseIfLocked(account.locked_until, now);
    if (account.status !== 'ACTIVE') throw new AuthorizationError('IDN.ACCOUNT_DEACTIVATED');
    if (!deviceInfo?.installId) {
      throw new ValidationError([{ field: 'device.installId', code: 'VALIDATION.REQUIRED' }]);
    }
    const install = this.installHash(deviceInfo.installId);
    const device = await accountRepository.activeDevice(this.deps.db, account.id);
    if (!device || !device.install_id_hash.equals(install)) {
      await accountRepository.resetFailures(this.deps.db, account.id);
      const challenge = await this.deps.otp.issue({
        purpose: 'DEVICE',
        channel: 'SMS',
        destination: account.mobile,
        accountId: account.id,
        contextHash: install,
        reuseLive: true,
      });
      return { kind: 'device', challenge };
    }
    await accountRepository.signinSuccess(this.deps.db, account.id, now);
    const tokens = await this.deps.sessions.start(
      {
        accountId: account.id,
        accountPublicId: binToUuid(account.public_id),
        surface: 'member',
        deviceId: String(device.id),
        ...(await this.defaultProfile(account.id)),
      },
      client,
    );
    return { kind: 'session', tokens, account: this.summary(account) };
  }

  /** IDN-007: the code sent to the account mobile binds this device; the session starts. */
  async verifyDevice(
    input: { deviceChallengeId: string; otp: string; device: DeviceInfo },
    client: ClientContext = {},
  ) {
    if (!input.device?.installId) {
      throw new ValidationError([{ field: 'device.installId', code: 'VALIDATION.REQUIRED' }]);
    }
    const install = this.installHash(input.device.installId);
    const verified = await this.deps.otp.verify(input.deviceChallengeId, input.otp, 'DEVICE', {
      contextHash: install,
    });
    const account = verified.accountId
      ? await accountRepository.findById(this.deps.db, verified.accountId)
      : undefined;
    if (!account) throw new CustomAPIError(401, 'IDN.MOBILE_NOT_REGISTERED');
    if (account.status !== 'ACTIVE') throw new AuthorizationError('IDN.ACCOUNT_DEACTIVATED');
    const now = this.now();
    const device = newPublicIdPair();
    const deviceId = await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const id = await accountRepository.bindDevice(trx, {
          accountId: account.id,
          publicId: device.bin,
          installIdHash: install,
          model: input.device.model ?? null,
          os: input.device.os ?? null,
          appVersion: input.device.appVersion ?? null,
          at: now,
        });
        await accountRepository.signinSuccess(trx, account.id, now);
        await recordAudit(trx, {
          action: 'DEVICE_BOUND',
          entityType: 'device',
          entityRef: device.id,
          after: { model: input.device.model, os: input.device.os },
          actor: { type: 'member', ref: binToUuid(account.public_id) },
        });
        return id;
      }),
    );
    const tokens = await this.deps.sessions.start(
      {
        accountId: account.id,
        accountPublicId: binToUuid(account.public_id),
        surface: 'member',
        deviceId,
        ...(await this.defaultProfile(account.id)),
      },
      client,
    );
    return { tokens, account: this.summary(account) };
  }

  /** IDN-010: registered mobile → the stored question and a code (both needed, OI-IDN-09). */
  async startRecovery(input: { mobile: string }) {
    if (!PATTERNS.mobile.test(input.mobile)) {
      throw new ValidationError([{ field: 'mobile', code: 'VALIDATION.MOBILE' }]);
    }
    const account = await accountRepository.findByMobile(this.deps.db, input.mobile);
    if (!account) throw new CustomAPIError(404, 'IDN.USER_NOT_REGISTERED');
    const answer = await accountRepository.credential(this.deps.db, account.id, 'SECURITY_ANSWER');
    const questions = await referenceRepository.securityQuestions(this.deps.db);
    const question = questions.find((q) => q.code === answer?.question_code);
    const challenge = await this.deps.otp.issue({
      purpose: 'RECOVERY',
      channel: 'SMS',
      destination: input.mobile,
      accountId: account.id,
      reuseLive: true,
    });
    return {
      recoveryId: challenge.challengeId,
      question: question
        ? { code: question.code, labelKey: question.label_key, text: question.text_en }
        : null,
      challenge,
    };
  }

  /** IDN-011: security answer and code → a single-use reset token. */
  async verifyRecovery(input: { recoveryId: string; securityAnswer: string; otp: string }) {
    if (!isUuid(input.recoveryId)) throw new CustomAPIError(401, 'IDN.RECOVERY_SESSION_ENDED');
    const now = this.now();
    const challenge = await otpRepository.findByPublicId(this.deps.db, uuidToBin(input.recoveryId));
    if (
      !challenge ||
      challenge.purpose !== 'RECOVERY' ||
      !challenge.account_id ||
      new Date(challenge.expires_at) <= now
    ) {
      throw new CustomAPIError(401, 'IDN.RECOVERY_SESSION_ENDED');
    }
    const accountId = challenge.account_id;
    const answer = normaliseAnswer(input.securityAnswer);
    const stored = await accountRepository.credential(this.deps.db, accountId, 'SECURITY_ANSWER');
    if (stored) {
      await this.refuseIfLocked(stored.locked_until, now);
      if (!ANSWER.test(answer)) {
        throw new ValidationError([
          { field: 'securityAnswer', code: 'IDN.SECURITY_ANSWER_FORMAT' },
        ]);
      }
      if (!(await verifySecret(stored.hash, answer))) {
        const max = await this.limit(LIMITS.memberSignInLockAfterFailures);
        const minutes = await this.limit(LIMITS.memberSignInLockMinutes);
        const lock = stored.failed_attempts + 1 >= max;
        await accountRepository.credentialFailure(
          this.deps.db,
          stored.id,
          lock ? new Date(now.getTime() + minutes * 60_000) : null,
        );
        if (lock) throw this.lockedError(minutes);
        throw new ValidationError([{ field: 'securityAnswer', code: 'IDN.SECURITY_ANSWER_WRONG' }]);
      }
    }
    await this.deps.otp.verify(input.recoveryId, input.otp, 'RECOVERY');
    const account = await accountRepository.findById(this.deps.db, accountId);
    const password = await accountRepository.credential(this.deps.db, accountId, 'PASSWORD');
    if (!account) throw new CustomAPIError(401, 'IDN.RECOVERY_SESSION_ENDED');
    const ttl = (await this.limit(LIMITS.passwordResetMinutes)) * 60;
    const { token, expiresAt } = await this.deps.flows.issue(
      'password-reset',
      { acc: binToUuid(account.public_id), rv: password?.row_version ?? 0 },
      ttl,
    );
    return { resetToken: token, expiresAt };
  }

  /** IDN-012: new password; the token works once; every session ends (OI-IDN-09). */
  async resetPassword(input: { resetToken: string; newPassword: string }) {
    const claims = await this.deps.flows.verify('password-reset', input.resetToken);
    if (!claims || typeof claims['acc'] !== 'string' || typeof claims['rv'] !== 'number') {
      throw new CustomAPIError(401, 'IDN.RECOVERY_SESSION_ENDED');
    }
    if (!isValidPassword(input.newPassword, await this.passwordPolicy())) {
      throw new ValidationError([{ field: 'newPassword', code: 'IDN.PASSWORD_FORMAT' }]);
    }
    const account = await accountRepository.findByPublicId(this.deps.db, uuidToBin(claims['acc']));
    if (!account) throw new CustomAPIError(401, 'IDN.RECOVERY_SESSION_ENDED');
    const hash = await hashSecret(input.newPassword);
    await this.deps.db.transaction().execute(async (trx) => {
      const current = await accountRepository.lockCredential(trx, account.id, 'PASSWORD');
      if ((current?.row_version ?? 0) !== claims['rv']) {
        throw new CustomAPIError(401, 'IDN.RECOVERY_SESSION_ENDED');
      }
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
        entityRef: binToUuid(account.public_id),
        actor: { type: 'member', ref: binToUuid(account.public_id) },
      });
    });
    await this.deps.sessions.endAllForAccount(account.id, 'PASSWORD_RESET');
  }

  private summary(a: {
    public_id: Buffer;
    first_name: string;
    last_name: string | null;
    preferred_lang: string;
  }): AccountSummary {
    return {
      accountId: binToUuid(a.public_id),
      firstName: a.first_name,
      lastName: a.last_name,
      preferredLang: a.preferred_lang,
    };
  }

  private lockedError(minutes: number) {
    return new CustomAPIError(429, 'IDN.SIGNIN_LOCKED', {
      params: { minutes },
      headers: { 'Retry-After': String(minutes * 60) },
    });
  }

  private async refuseIfLocked(until: Date | string | null, now: Date) {
    if (until && new Date(until) > now) {
      const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - now.getTime()) / 60_000));
      throw this.lockedError(minutes);
    }
  }
}

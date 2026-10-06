/**
 * One-time codes (SRS 6.2, 6.4, 6.8; 27.4 §6; golden rule "OTPs stored hashed"):
 * - 4 digits, valid 5 minutes, one resend after 60 seconds, no new code while one is live;
 * - stored as an HMAC bound to the challenge id, compared in constant time;
 * - three wrong codes abandon the challenge (RC-03 Abandoned; the sign-in services count
 *   abandoned staff challenges towards the account lock, RNG-IDN-380).
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database, OtpPurpose } from '../models/ringpe_models';
import type { MessageSender } from '../integrations/sms.provider';
import { otpRepository } from '../repositories/otp.repository';
import { BadRequestError, ConflictError } from '../utils/CustomAPIError';
import type { FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { retryOnLock } from '../utils/retry';
import { defaultValues, type SettingValues } from './settings.service';

export type OtpChannel = 'SMS' | 'EMAIL';

export interface OtpIssueInput {
  readonly purpose: OtpPurpose;
  readonly channel: OtpChannel;
  /** 10-digit mobile for SMS, e-mail address for EMAIL. */
  readonly destination: string;
  readonly accountId?: string;
  /** The institution the code is for, if any (the communication log, CR-16; OI-COM-48). */
  readonly institutionId?: string;
  /** Binds the code to what it confirms (e.g. the device being bound); verify must match. */
  readonly contextHash?: Buffer;
  /**
   * SRS 6.2 (RNG-IDN-010): when a live code exists, return it ("OTP Already Sent", the flow
   * continues) instead of refusing.
   */
  readonly reuseLive?: boolean;
}

export interface IssuedChallenge {
  readonly challengeId: string;
  readonly expiresAt: Date;
  readonly resendAfterSeconds: number;
  /** Destination for display, masked (`••••••3210`). */
  readonly sentTo: string;
  /**
   * Test mode only (OTP_TEST_SHOW_CODE, refused in production): the code itself, so testers can
   * sign in before an SMS provider is connected (client, Q17).
   */
  readonly testCode?: string;
  /** True when an existing live code was returned instead of a new one (no new SMS). */
  readonly alreadySent?: boolean;
}

export interface VerifiedChallenge {
  readonly accountId: string | null;
  readonly destinationHash: Buffer;
  readonly purpose: OtpPurpose;
}

export interface OtpServiceDeps {
  readonly db: Kysely<Database>;
  readonly cipher: FieldCipher;
  readonly sms: MessageSender;
  readonly email: MessageSender;
  readonly now?: () => Date;
  /** Platform settings in force (code lifetime, resend timer, attempts — Q13, changeable). */
  readonly settings?: { values(): Promise<SettingValues> };
  /** Return the code in the response (test environments only). */
  readonly showCodeInTestMode?: boolean;
}

interface OtpRules {
  readonly digits: number;
  readonly ttlMs: number;
  readonly resendAfterMs: number;
  readonly maxResends: number;
  readonly maxAttempts: number;
}

const rulesFrom = (v: SettingValues): OtpRules => {
  const n = (l: { key: string; value: number }) => v[l.key] ?? l.value;
  return {
    digits: n(LIMITS.otpDigits),
    ttlMs: n(LIMITS.otpTtlSeconds) * 1000,
    resendAfterMs: n(LIMITS.otpResendAfterSeconds) * 1000,
    maxResends: n(LIMITS.otpMaxResends),
    maxAttempts: n(LIMITS.consoleOtpWrongCodesPerAttempt),
  };
};

/** A code in the 27.4 format: no leading zero (e.g. 1000–9999 for four digits). */
const newCode = (digits: number) => String(randomInt(10 ** (digits - 1), 10 ** digits));

const normaliseDestination = (channel: OtpChannel, d: string) =>
  channel === 'EMAIL' ? d.trim().toLowerCase() : d.trim();

const mask = (channel: OtpChannel, d: string) =>
  channel === 'SMS' ? `••••••${d.slice(-4)}` : d.replace(/^(.)[^@]*(@.*)$/, '$1•••$2');

/** The legacy countdown format of MSG-IDN-14 ("Resend code in m:ss"). */
export const asMinutesSeconds = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const secondsUntil = (t: Date, now: Date) =>
  Math.max(0, Math.ceil((new Date(t).getTime() - now.getTime()) / 1000));

/** SMS text of 6.2.4, kept as the legacy wording (Q22) with the validity in force. */
const smsText = (code: string, ttlMs: number) =>
  `Your Verification code is ${code}, valid for ${Math.round(ttlMs / 60000)} minutes. Please do not share with anyone.`;

export class OtpService {
  private readonly now: () => Date;

  constructor(private readonly deps: OtpServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  destinationHash(channel: OtpChannel, destination: string): Buffer {
    return this.deps.cipher.blindIndex(
      'otp_destination',
      normaliseDestination(channel, destination),
    );
  }

  private codeHash(challengeId: string, code: string): Buffer {
    return createHmac('sha256', this.deps.cipher.secret('otp'))
      .update(`${challengeId}:${code}`)
      .digest();
  }

  private async rules(): Promise<OtpRules> {
    return rulesFrom(this.deps.settings ? await this.deps.settings.values() : defaultValues());
  }

  private testCode(code: string): { testCode?: string } {
    return this.deps.showCodeInTestMode ? { testCode: code } : {};
  }

  private async deliver(input: OtpIssueInput, code: string, ttlMs: number): Promise<void> {
    const sender = input.channel === 'SMS' ? this.deps.sms : this.deps.email;
    await sender.send({
      to: normaliseDestination(input.channel, input.destination),
      purpose: `otp.${input.purpose.toLowerCase()}`,
      text: smsText(code, ttlMs),
      log: {
        kind: 'OTP',
        institutionId: input.institutionId ?? null,
        recipientAccountId: input.accountId ?? null,
        refType: `otp.${input.purpose.toLowerCase()}`,
      },
    });
  }

  /** Sends a new code, unless one is still live (then the caller must resend or wait). */
  async issue(input: OtpIssueInput): Promise<IssuedChallenge> {
    const now = this.now();
    const rules = await this.rules();
    const destinationHash = this.destinationHash(input.channel, input.destination);
    const code = newCode(rules.digits);
    const challenge = newPublicIdPair();
    // Re-run on a deadlock: the live-code lookup takes a gap lock that a parallel sign-up for
    // another number may share before both insert (retryOnLock).
    const issued = await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const live = await otpRepository.findLive(trx, destinationHash, input.purpose, now);
        if (live) {
          if (input.reuseLive) {
            return {
              kind: 'reused' as const,
              challengeId: binToUuid(live.public_id),
              expiresAt: new Date(live.expires_at),
              resendAfterSeconds: secondsUntil(live.resend_after_at, now),
            };
          }
          const until = live.resends < live.max_resends ? live.resend_after_at : live.expires_at;
          return { kind: 'conflict' as const, seconds: secondsUntil(until, now) };
        }
        const resendAfterAt = new Date(now.getTime() + rules.resendAfterMs);
        const expiresAt = new Date(now.getTime() + rules.ttlMs);
        await otpRepository.insert(trx, {
          publicId: challenge.bin,
          accountId: input.accountId ?? null,
          purpose: input.purpose,
          channel: input.channel,
          destinationHash,
          contextHash: input.contextHash ?? null,
          codeHash: this.codeHash(challenge.id, code),
          maxAttempts: rules.maxAttempts,
          maxResends: rules.maxResends,
          resendAfterAt,
          expiresAt,
        });
        return { kind: 'created' as const, expiresAt };
      }),
    );
    if (issued.kind === 'reused') {
      return {
        challengeId: issued.challengeId,
        expiresAt: issued.expiresAt,
        resendAfterSeconds: issued.resendAfterSeconds,
        sentTo: mask(input.channel, input.destination),
        alreadySent: true,
      };
    }
    if (issued.kind === 'conflict') {
      throw new ConflictError('AUTH.OTP_ALREADY_SENT', {
        headers: { 'Retry-After': String(issued.seconds) },
      });
    }
    await this.deliver(input, code, rules.ttlMs);
    return {
      challengeId: challenge.id,
      expiresAt: issued.expiresAt,
      resendAfterSeconds: rules.resendAfterMs / 1000,
      sentTo: mask(input.channel, input.destination),
      ...this.testCode(code),
    };
  }

  /**
   * One resend per challenge, after the countdown (27.4 §6). For account-bound codes the
   * destination comes from the account; otherwise (sign-up) the caller repeats it.
   */
  async resend(challengeId: string, destination?: string): Promise<IssuedChallenge> {
    if (!isUuid(challengeId)) throw new BadRequestError('AUTH.OTP_INVALID');
    const now = this.now();
    const rules = await this.rules();
    const code = newCode(rules.digits);
    const result = await this.deps.db.transaction().execute(async (trx) => {
      const c = await otpRepository.lockByPublicId(trx, uuidToBin(challengeId));
      if (!c) return { error: new BadRequestError('AUTH.OTP_INVALID') };
      const to =
        destination ??
        (c.account_id
          ? await otpRepository.destinationOfAccount(trx, c.account_id, c.channel)
          : undefined);
      if (!to || !this.destinationHash(c.channel, to).equals(c.destination_hash)) {
        return { error: new BadRequestError('AUTH.OTP_INVALID') };
      }
      if (c.consumed_at) return { error: new ConflictError('AUTH.OTP_ALREADY_USED') };
      if (c.abandoned_at) return { error: new BadRequestError('AUTH.OTP_ATTEMPTS_EXCEEDED') };
      if (new Date(c.expires_at) <= now) return { error: new BadRequestError('AUTH.OTP_EXPIRED') };
      if (c.resends >= c.max_resends) return { error: new ConflictError('AUTH.OTP_RESEND_LIMIT') };
      if (new Date(c.resend_after_at) > now) {
        return {
          error: new ConflictError('AUTH.OTP_RESEND_TOO_SOON', {
            params: { time: asMinutesSeconds(secondsUntil(c.resend_after_at, now)) },
            headers: { 'Retry-After': String(secondsUntil(c.resend_after_at, now)) },
          }),
        };
      }
      const expiresAt = new Date(now.getTime() + rules.ttlMs);
      await otpRepository.replaceCode(trx, c.id, {
        codeHash: this.codeHash(challengeId, code),
        resendAfterAt: new Date(now.getTime() + rules.resendAfterMs),
        expiresAt,
      });
      return { channel: c.channel, purpose: c.purpose, expiresAt, to };
    });
    if ('error' in result) throw result.error;
    await this.deliver(
      { purpose: result.purpose, channel: result.channel, destination: result.to },
      code,
      rules.ttlMs,
    );
    return {
      challengeId,
      expiresAt: result.expiresAt,
      resendAfterSeconds: rules.resendAfterMs / 1000,
      sentTo: mask(result.channel, result.to),
      ...this.testCode(code),
    };
  }

  /**
   * Checks a code. A wrong code counts against the challenge even though the request fails; the
   * last allowed wrong code abandons it.
   */
  async verify(
    challengeId: string,
    code: string,
    purpose: OtpPurpose,
    opts: { contextHash?: Buffer } = {},
  ): Promise<VerifiedChallenge> {
    if (!isUuid(challengeId) || !/^\d+$/.test(code)) throw new BadRequestError('AUTH.OTP_INVALID');
    const now = this.now();
    const result = await this.deps.db.transaction().execute(async (trx) => {
      const c = await otpRepository.lockByPublicId(trx, uuidToBin(challengeId));
      if (!c || c.purpose !== purpose) return { error: new BadRequestError('AUTH.OTP_INVALID') };
      if (c.context_hash && !(opts.contextHash && opts.contextHash.equals(c.context_hash))) {
        return { error: new BadRequestError('AUTH.OTP_INVALID') };
      }
      if (c.consumed_at) return { error: new ConflictError('AUTH.OTP_ALREADY_USED') };
      if (c.abandoned_at) return { error: new BadRequestError('AUTH.OTP_ATTEMPTS_EXCEEDED') };
      if (new Date(c.expires_at) <= now) return { error: new BadRequestError('AUTH.OTP_EXPIRED') };
      const expected = this.codeHash(binToUuid(c.public_id), code);
      if (!timingSafeEqual(expected, c.code_hash)) {
        const abandon = c.attempts + 1 >= c.max_attempts;
        await otpRepository.recordWrongCode(trx, c.id, abandon, now);
        return {
          error: abandon
            ? new BadRequestError('AUTH.OTP_ATTEMPTS_EXCEEDED')
            : new BadRequestError('AUTH.OTP_INVALID'),
        };
      }
      if (!(await otpRepository.markConsumed(trx, c.id, now))) {
        return { error: new ConflictError('AUTH.OTP_ALREADY_USED') };
      }
      return {
        verified: {
          accountId: c.account_id,
          destinationHash: c.destination_hash,
          purpose: c.purpose,
        },
      };
    });
    if ('error' in result) throw result.error;
    return result.verified;
  }
}

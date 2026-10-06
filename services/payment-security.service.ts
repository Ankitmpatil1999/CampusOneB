/**
 * Transaction PIN, daily spending cap and transaction permission (SRS 6.12, 6.13, 6.29; BR-06,
 * BR-13; IDN-025…028, IDN-056; prototype m.tpin, m.cap and the console member drawer).
 *
 * - The PIN is 4 digits, hashed (Argon2id), never logged or echoed; an easy combination (all one
 *   digit, a straight run) is refused; the new PIN differs from the current and the previous one.
 * - Wrong PINs lock it for a while (settings `idn.tpin.maxWrong`, `idn.tpin.lockMinutes`); a reset
 *   needs the security answer and a code sent to the account mobile.
 * - The cap limits what the member's own wallets pay out in a day (amount and count); the payment
 *   engine checks it with the PIN before it writes anything.
 * - The transaction permission belongs to an institution profile; the console grants or revokes it
 *   with a reason, and the engine refuses a payer without it (V5).
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { referenceRepository } from '../repositories/account.repository';
import { PATTERNS } from '../utils/validators';
import { recordAudit } from './audit.service';
import type { OtpService } from './otp.service';
import { defaultValues, type SettingValues } from './settings.service';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import { hashSecret, normaliseAnswer, verifySecret } from '../utils/password';
import type { Principal } from '../utils/principal';

type Db = Kysely<Database> | Transaction<Database>;

const PIN = PATTERNS.tpin;

/** All one digit, or a straight run up or down (1234, 9876 …). */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const step = d[1]! - d[0]!;
  return Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1]! === step);
}

export class PaymentSecurityService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly otp: OtpService;
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

  private async account(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const a = await this.deps.db
      .selectFrom('platform_accounts')
      .select(['id', 'public_id', 'mobile'])
      .where('public_id', '=', uuidToBin(p.subject))
      .executeTakeFirst();
    if (!a) throw new NotFoundError();
    return { id: String(a.id), publicId: binToUuid(a.public_id), mobile: a.mobile };
  }

  private pinOf(db: Db, accountId: string, lock = false) {
    let q = db
      .selectFrom('account_credentials')
      .select(['id', 'hash', 'previous_hash', 'failed_attempts', 'locked_until', 'row_version'])
      .where('account_id', '=', accountId)
      .where('kind', '=', 'TPIN');
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private checkFormat(pin: string, field: string) {
    if (!PIN.test(pin)) throw new ValidationError([{ field, code: 'IDN.TPIN_FORMAT' }]);
    if (isWeakPin(pin)) throw new ValidationError([{ field, code: 'IDN.TPIN_WEAK' }]);
  }

  // --- status (shown on Profile) ------------------------------------------------------------------
  async status(p: Principal) {
    const a = await this.account(p);
    const pin = await this.pinOf(this.deps.db, a.id);
    const cap = await this.deps.db
      .selectFrom('spending_caps')
      .selectAll()
      .where('account_id', '=', a.id)
      .executeTakeFirst();
    const locked = pin?.locked_until && new Date(pin.locked_until) > this.now();
    return {
      tpin: {
        set: Boolean(pin),
        lockedUntil: locked ? new Date(pin!.locked_until!).toISOString() : null,
      },
      cap: {
        enabled: Boolean(Number(cap?.enabled ?? 0)),
        amount: cap?.daily_amount_paise ? toMoneyDto(Number(cap.daily_amount_paise)) : null,
        count: cap?.daily_count ?? null,
        version: cap?.row_version ?? 0,
      },
    };
  }

  // --- IDN-025 ------------------------------------------------------------------------------------
  async setPin(p: Principal, input: { pin: string }) {
    const a = await this.account(p);
    this.checkFormat(input.pin, 'pin');
    if (await this.pinOf(this.deps.db, a.id)) throw new CustomAPIError(409, 'IDN.TPIN_ALREADY_SET');
    try {
      await this.deps.db
        .insertInto('account_credentials')
        .values({ account_id: a.id, kind: 'TPIN', hash: await hashSecret(input.pin) })
        .execute();
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new CustomAPIError(409, 'IDN.TPIN_ALREADY_SET');
      }
      throw e;
    }
    await recordAudit(this.deps.db, {
      action: 'TPIN_SET',
      entityType: 'platform_account',
      entityRef: a.publicId,
      actor: { type: 'member', ref: p.subject },
    });
  }

  /**
   * Checks the PIN (the engine and PIN changes): a wrong PIN counts, the limit locks it. Runs in its
   * own short transaction so a failed payment still records the attempt.
   */
  async verifyPin(accountId: string, pin: string) {
    if (!PIN.test(pin)) throw new ValidationError([{ field: 'pin', code: 'IDN.TPIN_FORMAT' }]);
    const now = this.now();
    const max = await this.limit(LIMITS.tpinMaxWrong);
    const minutes = await this.limit(LIMITS.tpinLockMinutes);
    const outcome = await this.deps.db.transaction().execute(async (trx) => {
      const c = await this.pinOf(trx, accountId, true);
      if (!c) return { kind: 'unset' as const };
      if (c.locked_until && new Date(c.locked_until) > now) {
        const left = Math.ceil((new Date(c.locked_until).getTime() - now.getTime()) / 60_000);
        return { kind: 'locked' as const, minutes: left };
      }
      if (await verifySecret(c.hash, pin)) {
        if (c.failed_attempts) {
          await trx
            .updateTable('account_credentials')
            .set({ failed_attempts: 0, locked_until: null })
            .where('id', '=', c.id)
            .execute();
        }
        return { kind: 'ok' as const };
      }
      const failures = c.failed_attempts + 1;
      const lock = failures >= max;
      await trx
        .updateTable('account_credentials')
        .set({
          failed_attempts: lock ? 0 : failures,
          locked_until: lock ? new Date(now.getTime() + minutes * 60_000) : null,
        })
        .where('id', '=', c.id)
        .execute();
      return lock
        ? { kind: 'locked' as const, minutes }
        : { kind: 'wrong' as const, left: max - failures };
    });
    if (outcome.kind === 'unset') throw new CustomAPIError(409, 'IDN.TPIN_NOT_SET');
    if (outcome.kind === 'locked') {
      throw new CustomAPIError(423, 'IDN.TPIN_LOCKED', { params: { minutes: outcome.minutes } });
    }
    if (outcome.kind === 'wrong') {
      throw new ValidationError([
        { field: 'pin', code: 'IDN.TPIN_WRONG', params: { left: outcome.left } },
      ]);
    }
  }

  // --- IDN-026 ------------------------------------------------------------------------------------
  async changePin(p: Principal, input: { currentPin: string; newPin: string }) {
    const a = await this.account(p);
    this.checkFormat(input.newPin, 'newPin');
    await this.verifyPin(a.id, input.currentPin);
    await this.replacePin(a.id, input.newPin, p.subject, 'TPIN_CHANGED');
  }

  private async replacePin(accountId: string, pin: string, actor: string, action: string) {
    const hash = await hashSecret(pin);
    await this.deps.db.transaction().execute(async (trx) => {
      const c = await this.pinOf(trx, accountId, true);
      if (!c) throw new CustomAPIError(409, 'IDN.TPIN_NOT_SET');
      const reused =
        (await verifySecret(c.hash, pin)) ||
        (c.previous_hash !== null && (await verifySecret(c.previous_hash, pin)));
      if (reused) throw new ValidationError([{ field: 'newPin', code: 'IDN.TPIN_REUSED' }]);
      await trx
        .updateTable('account_credentials')
        .set({
          hash,
          previous_hash: c.hash,
          failed_attempts: 0,
          locked_until: null,
          set_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', c.id)
        .execute();
      const acc = await trx
        .selectFrom('platform_accounts')
        .select('public_id')
        .where('id', '=', accountId)
        .executeTakeFirstOrThrow();
      await recordAudit(trx, {
        action,
        entityType: 'platform_account',
        entityRef: binToUuid(acc.public_id),
        actor: { type: 'member', ref: actor },
      });
    });
  }

  // --- IDN-027 ------------------------------------------------------------------------------------
  /** Forgot PIN, step 1: a code to the account mobile. */
  async resetStart(p: Principal) {
    const a = await this.account(p);
    if (!(await this.pinOf(this.deps.db, a.id))) throw new CustomAPIError(409, 'IDN.TPIN_NOT_SET');
    // The stored security question is asked with the code, as in password recovery (IDN-010).
    const answer = await this.deps.db
      .selectFrom('account_credentials')
      .select('question_code')
      .where('account_id', '=', a.id)
      .where('kind', '=', 'SECURITY_ANSWER')
      .executeTakeFirst();
    const question = (await referenceRepository.securityQuestions(this.deps.db)).find(
      (q) => q.code === answer?.question_code,
    );
    const challenge = await this.deps.otp.issue({
      purpose: 'TPIN_RESET',
      channel: 'SMS',
      destination: a.mobile,
      accountId: a.id,
      reuseLive: true,
    });
    return {
      ...challenge,
      question: question
        ? { code: question.code, labelKey: question.label_key, text: question.text_en }
        : null,
    };
  }

  /** Forgot PIN, step 2: the security answer and the code, then the new PIN. */
  async reset(
    p: Principal,
    input: { securityAnswer: string; challengeId: string; otp: string; newPin: string },
  ) {
    const a = await this.account(p);
    this.checkFormat(input.newPin, 'newPin');
    const answer = await this.deps.db
      .selectFrom('account_credentials')
      .select('hash')
      .where('account_id', '=', a.id)
      .where('kind', '=', 'SECURITY_ANSWER')
      .executeTakeFirst();
    if (!answer || !(await verifySecret(answer.hash, normaliseAnswer(input.securityAnswer)))) {
      throw new ValidationError([{ field: 'securityAnswer', code: 'IDN.SECURITY_ANSWER_WRONG' }]);
    }
    // Refuse an old PIN before the code is used up, so the member can try another PIN.
    const current = await this.pinOf(this.deps.db, a.id);
    if (
      current &&
      ((await verifySecret(current.hash, input.newPin)) ||
        (current.previous_hash !== null &&
          (await verifySecret(current.previous_hash, input.newPin))))
    ) {
      throw new ValidationError([{ field: 'newPin', code: 'IDN.TPIN_REUSED' }]);
    }
    const v = await this.deps.otp.verify(input.challengeId, input.otp, 'TPIN_RESET');
    if (v.accountId !== a.id) throw new NotFoundError();
    await this.replacePin(a.id, input.newPin, p.subject, 'TPIN_RESET');
  }

  // --- IDN-028 ------------------------------------------------------------------------------------
  async setCap(
    p: Principal,
    expected: number,
    input: { enabled: boolean; amountPaise?: number | undefined; count?: number | undefined },
  ) {
    const a = await this.account(p);
    if (input.enabled) {
      const min = await this.limit(LIMITS.spendingCapMinPaise);
      const max = await this.limit(LIMITS.spendingCapMaxPaise);
      const maxCount = await this.limit(LIMITS.spendingCapMaxCount);
      const errors = [];
      if (!input.amountPaise || input.amountPaise < min || input.amountPaise > max) {
        errors.push({
          field: 'amount',
          code: 'VALIDATION.RANGE' as const,
          params: {
            min: formatInr(min).replace(/\.00$/, ''),
            max: formatInr(max).replace(/\.00$/, ''),
          },
        });
      }
      if (!input.count || input.count < 1 || input.count > maxCount) {
        errors.push({
          field: 'count',
          code: 'VALIDATION.RANGE' as const,
          params: { min: 1, max: maxCount },
        });
      }
      if (errors.length) throw new ValidationError(errors);
    }
    await this.deps.db.transaction().execute(async (trx) => {
      const cur = await trx
        .selectFrom('spending_caps')
        .select('row_version')
        .where('account_id', '=', a.id)
        .forUpdate()
        .executeTakeFirst();
      if ((cur?.row_version ?? 0) !== expected) throw new PreconditionFailedError();
      const values = {
        enabled: input.enabled ? 1 : 0,
        daily_amount_paise: input.enabled ? input.amountPaise! : null,
        daily_count: input.enabled ? input.count! : null,
      };
      if (cur) {
        await trx
          .updateTable('spending_caps')
          .set({ ...values, row_version: sql<number>`row_version + 1`, updated_at: this.now() })
          .where('account_id', '=', a.id)
          .execute();
      } else {
        await trx
          .insertInto('spending_caps')
          .values({ account_id: a.id, ...values })
          .execute();
      }
      await recordAudit(trx, {
        action: 'SPENDING_CAP_SET',
        entityType: 'platform_account',
        entityRef: a.publicId,
        after: {
          enabled: input.enabled,
          amountPaise: values.daily_amount_paise,
          count: values.daily_count,
        },
        actor: { type: 'member', ref: p.subject },
      });
    });
    return (await this.status(p)).cap;
  }

  /**
   * The engine's cap check (6.13): today's payments out of the wallets of the account's profiles,
   * plus this one, stay within the cap.
   */
  async checkCap(db: Db, accountId: string, amountPaise: number) {
    const cap = await db
      .selectFrom('spending_caps')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (!cap || !Number(cap.enabled)) return;
    const today = istBusinessDate(this.now());
    const spent = await db
      .selectFrom('ledger_entries as e')
      .innerJoin('wallets as w', 'w.id', 'e.wallet_id')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select([
        sql<string>`COALESCE(SUM(e.amount_paise), 0)`.as('amount'),
        sql<number>`COUNT(*)`.as('n'),
      ])
      .where('m.account_id', '=', accountId)
      .where('e.direction', '=', 'D')
      .where('e.posted_on', '=', today)
      .executeTakeFirst();
    const total = Number(spent?.amount ?? 0) + amountPaise;
    const count = Number(spent?.n ?? 0) + 1;
    if (total > Number(cap.daily_amount_paise) || count > Number(cap.daily_count)) {
      throw new CustomAPIError(409, 'IDN.CAP_EXCEEDED', {
        params: {
          amount: formatInr(Number(cap.daily_amount_paise)),
          count: Number(cap.daily_count),
        },
      });
    }
  }

  // --- IDN-056 ------------------------------------------------------------------------------------
  /** The console grants or revokes a member's transaction permission (BR-13), with a reason. */
  async setPermission(
    p: Principal,
    memberId: string,
    expected: number,
    input: { enabled: boolean; reason: string },
  ) {
    if (!p.institutionId || !isUuid(p.institutionId) || !isUuid(memberId))
      throw new NotFoundError();
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 300) {
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.FORMAT' }]);
    }
    const inst = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!inst) throw new NotFoundError();
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const m = await trx
        .selectFrom('member_profiles')
        .select(['id', 'txn_permission', 'row_version'])
        .where('institution_id', '=', inst.id)
        .where('public_id', '=', uuidToBin(memberId))
        .forUpdate()
        .executeTakeFirst();
      if (!m) throw new NotFoundError();
      if (m.row_version !== expected) throw new PreconditionFailedError();
      await trx
        .updateTable('member_profiles')
        .set({
          txn_permission: input.enabled ? 1 : 0,
          txn_permission_reason: reason,
          txn_permission_changed_at: at,
          row_version: sql<number>`row_version + 1`,
          updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        })
        .where('id', '=', m.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: input.enabled ? 'TXN_PERMISSION_GRANTED' : 'TXN_PERMISSION_REVOKED',
        entityType: 'member',
        entityRef: memberId,
        before: { txnPermission: Boolean(Number(m.txn_permission)) },
        after: { txnPermission: input.enabled },
        reason,
      });
      return {
        enabled: input.enabled,
        reason,
        changedAt: at.toISOString(),
        version: m.row_version + 1,
      };
    });
  }
}

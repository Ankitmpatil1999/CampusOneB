import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StaffAuthService } from '../services/staff-auth.service';
import { accessRepository } from '../repositories/access.repository';
import { accountRepository } from '../repositories/account.repository';
import { institutionsRepository } from '../repositories/institutions.repository';
import { hashSecret } from '../utils/password';
import { capturingLoggers } from './helpers';

describe('StaffAuthService.signInAuto', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('increments failed_signins only once per wrong-password attempt and locks for 1 minute at limit 5', async () => {
    const hash = await hashSecret('Hello@123');
    let failedSignins = 0;
    let lockedUntil: Date | null = null;
    let currentTime = new Date('2026-11-10T05:00:00.000Z');

    vi.spyOn(accessRepository, 'findAccountByEmail').mockImplementation(async () => ({
      id: '27',
      public_id: Buffer.alloc(16, 1),
      email: 'geeta@gmail.com',
      email_verified_at: null,
      mobile: '8180093401',
      first_name: 'GEETA',
      last_name: 'PATIL',
      status: 'ACTIVE',
      signin_lock: 'UNLOCKED',
      failed_signins: failedSignins,
      locked_until: lockedUntil,
      abandoned_code_attempts: 0,
      preferred_lang: 'en',
    }));

    vi.spyOn(accountRepository, 'credential').mockResolvedValue({
      id: '21',
      hash,
      question_code: null,
      failed_attempts: 0,
      locked_until: null,
      must_change: 0,
      row_version: 1,
    });

    const failureSpy = vi
      .spyOn(accountRepository, 'signinFailure')
      .mockImplementation(async (_db, _id, until) => {
        if (until) {
          failedSignins = 0;
          lockedUntil = until;
        } else {
          failedSignins += 1;
        }
      });

    vi.spyOn(accountRepository, 'resetFailures').mockImplementation(async () => {
      failedSignins = 0;
      lockedUntil = null;
    });

    vi.spyOn(institutionsRepository, 'claimPendingAdministrator').mockResolvedValue([]);
    vi.spyOn(accessRepository, 'consoleContexts').mockResolvedValue([
      {
        profile_id: '4',
        profile_public_id: Buffer.alloc(16, 2),
        first_name: 'GEETA',
        last_name: 'PATIL',
        institution_id: '4',
        institution_public_id: Buffer.alloc(16, 3),
        institution_name: 'Sun Rice Convent',
        short_name: 'SRC',
        city: 'Nagpur',
      },
    ]);

    const otp = {
      issue: vi.fn(async () => ({
        challengeId: '0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a',
        expiresAt: new Date(currentTime.getTime() + 300_000),
        resendAfterSeconds: 60,
        sentTo: '••••••3401',
        testCode: '4821',
      })),
    };

    const service = new StaffAuthService({
      db: {} as never,
      otp: otp as never,
      sessions: {} as never,
      loggers: capturingLoggers().loggers,
      settings: {
        values: async () => ({
          'idn.password.maxLength': 64,
          'idn.staffSignIn.lockAfterFailures': 5,
          'idn.staffSignIn.lockMinutes': 1,
        }),
      },
      now: () => currentTime,
    });

    // First 4 wrong attempts: 401 each, failure counter increments strictly +1 per attempt
    for (let i = 1; i <= 4; i++) {
      await expect(
        service.signInAuto({ email: 'geeta@gmail.com', password: 'WrongPassword@1' }),
      ).rejects.toMatchObject({ statusCode: 401, code: 'IDN.CONSOLE_SIGNIN_REFUSED' });
      expect(failedSignins).toBe(i);
    }
    expect(failureSpy).toHaveBeenCalledTimes(4);

    // 5th wrong attempt triggers 1-minute temporary lock (429 IDN.SIGNIN_LOCKED, minutes: 1)
    await expect(
      service.signInAuto({ email: 'geeta@gmail.com', password: 'WrongPassword@1' }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'IDN.SIGNIN_LOCKED',
      params: { minutes: 1 },
    });
    expect(failureSpy).toHaveBeenCalledTimes(5);
    expect(lockedUntil?.toISOString()).toBe('2026-11-10T05:01:00.000Z');

    // After 61 seconds the 1-minute lock expires and the right password signs in to console
    currentTime = new Date('2026-11-10T05:01:01.000Z');
    const challenge = await service.signInAuto({ email: 'geeta@gmail.com', password: 'Hello@123' });
    expect(challenge.surface).toBe('console');
    expect(challenge.challengeId).toBe('0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a');
  });

  it('routes operators with a valid password to ops surface without failing on console', async () => {
    const hash = await hashSecret('Ankit@1999');
    vi.spyOn(accessRepository, 'findAccountByEmail').mockResolvedValue({
      id: '9',
      public_id: Buffer.alloc(16, 4),
      email: 'aryapatil963@gmail.com',
      email_verified_at: new Date(),
      mobile: '9999999999',
      first_name: 'ANKIT',
      last_name: 'PATIL',
      status: 'ACTIVE',
      signin_lock: 'UNLOCKED',
      failed_signins: 0,
      locked_until: null,
      abandoned_code_attempts: 0,
      preferred_lang: 'en',
    });
    vi.spyOn(accountRepository, 'credential').mockResolvedValue({
      id: '9',
      hash,
      question_code: null,
      failed_attempts: 0,
      locked_until: null,
      must_change: 0,
      row_version: 1,
    });
    vi.spyOn(accountRepository, 'resetFailures').mockResolvedValue(undefined);
    vi.spyOn(institutionsRepository, 'claimPendingAdministrator').mockResolvedValue([]);
    vi.spyOn(accessRepository, 'consoleContexts').mockResolvedValue([]);
    vi.spyOn(accessRepository, 'hasInstitutionProfile').mockResolvedValue(false);
    vi.spyOn(accessRepository, 'operatorContext').mockResolvedValue({
      role_code: 'PLATFORM_ADMIN',
      role_name: 'Platform Administrator',
    } as never);

    const otp = {
      issue: vi.fn(async () => ({
        challengeId: '0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7b',
        expiresAt: new Date(Date.now() + 300_000),
        resendAfterSeconds: 60,
        sentTo: '••••••9999',
      })),
    };

    const service = new StaffAuthService({
      db: {} as never,
      otp: otp as never,
      sessions: {} as never,
      loggers: capturingLoggers().loggers,
    });

    const out = await service.signInAuto({ email: 'aryapatil963@gmail.com', password: 'Ankit@1999' });
    expect(out.surface).toBe('ops');
    expect(otp.issue).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'OPS_2FA' }));
  });
});


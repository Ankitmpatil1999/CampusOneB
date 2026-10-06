/**
 * Platform settings on a real MySQL (client 2026-10-02: every accepted default must stay
 * changeable): ranges, consistency, optimistic locking, history, audit, the public limits document
 * and services that read the values in force.
 */
import request from 'supertest';
import { SettingsService } from '../../services/settings.service';
import { SessionService } from '../../services/session.service';
import { OtpService } from '../../services/otp.service';
import { capturingLoggers, testSecurity } from '../helpers';
import { adminUrl, createTestDatabase, insertAccount, type TestDatabase } from './db';
import { buildHttpApp } from './http-app';

const OPERATOR = '0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a';
const KEY = 'auth.session.consoleHours';

describe.skipIf(!adminUrl)('platform settings on real MySQL', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('lists every limit with its default, range and version', async () => {
    const s = new SettingsService(t.db, { cacheMs: 0 });
    const items = await s.list();
    const pw = items.find((i) => i.key === 'idn.password.maxLength');
    expect(pw).toMatchObject({
      value: 64,
      defaultValue: 64,
      srsValue: '15',
      overridden: false,
      version: 0,
    });
    expect(items.find((i) => i.key === KEY)?.adjustable).toEqual({ min: 1, max: 72 });
  });

  it('changes a value within its range, records history and audit, and resets it', async () => {
    const s = new SettingsService(t.db, { cacheMs: 0 });
    const changed = await s.change(KEY, 12, 'shorter staff sessions for the pilot', OPERATOR, 0);
    expect(changed).toMatchObject({ value: 12, overridden: true, version: 1, updatedBy: OPERATOR });
    expect((await s.values())[KEY]).toBe(12);
    await expect(s.change(KEY, 10, 'stale read', OPERATOR, 0)).rejects.toMatchObject({
      statusCode: 412,
    });
    const reset = await s.change(KEY, null, 'back to the SRS value', OPERATOR, 1);
    expect(reset).toMatchObject({ value: 24, overridden: false, version: 0 });
    const history = await s.history(KEY);
    expect(history.map((h) => [h.from, h.to])).toEqual([
      [12, null],
      [null, 12],
    ]);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'PLATFORM_SETTING_CHANGE')
      .execute();
    expect(audit.length).toBe(2);
  });

  it('refuses values out of range, inconsistent pairs and fixed limits', async () => {
    const s = new SettingsService(t.db, { cacheMs: 0 });
    await expect(s.change(KEY, 0, 'x'.repeat(5), OPERATOR, 0)).rejects.toMatchObject({
      code: 'VALIDATION.FAILED',
      errors: [{ field: 'value', code: 'VALIDATION.RANGE', params: { min: 1, max: 72 } }],
    });
    await expect(
      s.change('idn.password.minLength', 64, 'longer', OPERATOR, 0),
    ).resolves.toBeDefined();
    await expect(
      s.change('idn.password.maxLength', 32, 'shorter', OPERATOR, 0),
    ).rejects.toMatchObject({
      code: 'SETTINGS.INCONSISTENT',
      params: { other: 'idn.password.minLength' },
    });
    await expect(s.change('file.maxBytes', 1, 'no', OPERATOR, 0)).rejects.toMatchObject({
      code: 'SETTINGS.NOT_ADJUSTABLE',
    });
    await expect(s.change('no.such.key', 1, 'no', OPERATOR, 0)).rejects.toMatchObject({
      statusCode: 404,
    });
    await s.change('idn.password.minLength', null, 'reset', OPERATOR, 1);
  });

  it('applies the values in force: session lifetime and one-time-code rules', async () => {
    const s = new SettingsService(t.db, { cacheMs: 0 });
    const security = await testSecurity();
    const { loggers } = capturingLoggers();
    const sessions = new SessionService({
      db: t.db,
      signer: security.signer,
      revocations: security.revocations,
      loggers,
      settings: s,
    });
    await s.change('auth.session.memberMobileDays', 30, 'pilot', OPERATOR, 0);
    await s.change('auth.access.ttlMinutes', 10, 'pilot', OPERATOR, 0);
    const acct = await insertAccount(t.db);
    const before = Date.now();
    const tokens = await sessions.start({
      accountId: acct.id,
      accountPublicId: acct.publicId,
      surface: 'member',
    });
    const days = (tokens.refreshTokenExpiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    const accessMinutes = (tokens.accessTokenExpiresAt.getTime() - before) / 60_000;
    expect(accessMinutes).toBeGreaterThan(9.9);
    expect(accessMinutes).toBeLessThan(10.1);

    await s.change('idn.otp.resendAfterSeconds', 120, 'pilot', OPERATOR, 0);
    const sms = { channel: 'sms' as const, send: async () => undefined };
    const otp = new OtpService({
      db: t.db,
      cipher: security.cipher,
      sms,
      email: { ...sms, channel: 'email' as const },
      settings: s,
      showCodeInTestMode: true,
    });
    const issued = await otp.issue({
      purpose: 'SIGNUP',
      channel: 'SMS',
      destination: '9876512345',
    });
    expect(issued.resendAfterSeconds).toBe(120);
    expect(issued.testCode).toMatch(/^[1-9]\d{3}$/);
    await expect(otp.verify(issued.challengeId, issued.testCode!, 'SIGNUP')).resolves.toBeDefined();
  });

  it('serves the values in force in the public limits document (PLT-008) and the operator API', async () => {
    const settings = new SettingsService(t.db, { cacheMs: 0 });
    const { app, security } = await buildHttpApp(t, { overrides: { settings } });
    const sign = (surface: 'ops' | 'console', st: string[]) =>
      security.signer.sign({ subject: OPERATOR, surface, sessionId: `s-${surface}`, subTasks: st });

    const ops = (await sign('ops', ['settings.view', 'settings.edit'])).token;
    const list = await request(app)
      .get('/api/v1/ops/settings')
      .set('Authorization', `Bearer ${ops}`);
    expect(list.status).toBe(200);
    const current = list.body.items.find(
      (i: { key: string }) => i.key === 'idn.memberSignIn.lockMinutes',
    );

    const noMatch = await request(app)
      .put('/api/v1/ops/settings/idn.memberSignIn.lockMinutes')
      .set('Authorization', `Bearer ${ops}`)
      .send({ value: 30, reason: 'longer lock-out' });
    expect(noMatch.status).toBe(428);

    const put = await request(app)
      .put('/api/v1/ops/settings/idn.memberSignIn.lockMinutes')
      .set('Authorization', `Bearer ${ops}`)
      .set('If-Match', `"v${current.version}"`)
      .send({ value: 30, reason: 'longer lock-out' });
    expect(put.status).toBe(200);
    expect(put.headers['etag']).toBe(`"v${current.version + 1}"`);

    const limits = await request(app).get('/api/v1/config/limits');
    expect(limits.body.limits['idn.memberSignIn.lockMinutes']).toEqual({ value: 30, unit: 'min' });

    const history = await request(app)
      .get('/api/v1/ops/settings/idn.memberSignIn.lockMinutes/history')
      .set('Authorization', `Bearer ${ops}`);
    expect(history.body.items[0]).toMatchObject({
      to: 30,
      reason: 'longer lock-out',
      changedBy: OPERATOR,
    });

    // A console session holding a sub-task of the same name is refused: back office only.
    const consoleToken = (await sign('console', ['settings.view'])).token;
    const refused = await request(app)
      .get('/api/v1/ops/settings')
      .set('Authorization', `Bearer ${consoleToken}`);
    expect(refused.status).toBe(403);
    // An operator without the sub-task is refused too.
    const viewer = (await sign('ops', ['home.view'])).token;
    expect(
      (await request(app).get('/api/v1/ops/settings').set('Authorization', `Bearer ${viewer}`))
        .status,
    ).toBe(403);
  });
});

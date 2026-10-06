/**
 * The operator's platform tools on a real MySQL (Phase 8.1; SRS 6.30, 6.31, 18.5; IDN-070…076,
 * INT-009/010; OI-INT-08):
 * - languages: added switched off, the default stays on, one default at a time;
 * - translations: what a language lacks, placeholders kept, an edit marked reviewed;
 * - the log analyser: written in batches off the request path, filtered, never bodies or values;
 * - messaging channels: a channel without an integrated provider can't be switched on; in-app stays on.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { capturingLoggers } from '../helpers';
import { RequestLogStore } from '../../utils/request-log';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { adminUrl } from './db';
import { schoolFixture, type Auth } from './school';

describe.skipIf(!adminUrl)('platform tools on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let analyst: Auth;
  const post = (path: string, auth: Auth, body: object) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth = f.ops) => request(f.app).get(`/api/v1${path}`).set(auth);

  beforeAll(async () => {
    f = await schoolFixture('Tools School');
    const acct = await f.account('LATHA');
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'LOG_ANALYST')
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: acct.id, role_id: String(role.id) })
      .execute();
    analyst = await f.signedIn('ops', acct.email);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('adds languages switched off and keeps one default that stays on', async () => {
    const list = await get('/ops/languages');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items[0]).toMatchObject({ code: 'en', isDefault: true, enabled: true });
    expect(
      list.body.items.find((l: { code: string }) => l.code === 'kn').translations.machine,
    ).toBeGreaterThan(0);
    const added = await post('/ops/languages', f.ops, {
      code: 'SA',
      name: 'Sanskrit',
      native: 'संस्कृतम्',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      code: 'sa',
      enabled: false,
      isDefault: false,
      translations: { reviewed: 0, machine: 0 },
    });
    expect(
      (await post('/ops/languages', f.ops, { code: 'sa', name: 'Sanskrit', native: 'x' })).body
        .code,
    ).toBe('I18N.LANGUAGE_EXISTS');
    expect(
      (await post('/ops/languages', f.ops, { code: 'sanskrit!', name: 'S', native: '' })).body
        .errors[0].code,
    ).toBe('I18N.LANGUAGE_CODE');
    const version = async (code: string) =>
      ((await get('/ops/languages')).body.items as { code: string; version: number }[]).find(
        (l) => l.code === code,
      )!.version;
    const patch = async (code: string, body: object, v?: number) =>
      request(f.app)
        .patch(`/api/v1/ops/languages/${code}`)
        .set(f.ops)
        .set('If-Match', `"v${v ?? (await version(code))}"`)
        .send(body);
    // Optimistic locking: the version read is required and must still be current.
    expect(
      (await request(f.app).patch('/api/v1/ops/languages/sa').set(f.ops).send({ enabled: true }))
        .status,
    ).toBe(428);
    const stale = await version('sa');
    expect((await patch('sa', { enabled: true }, stale + 1)).status).toBe(412);
    expect((await patch('sa', { isDefault: true })).body.code).toBe('I18N.DEFAULT_ENABLED');
    expect((await patch('en', { enabled: false })).body.code).toBe('I18N.DEFAULT_ENABLED');
    expect((await patch('sa', { enabled: true })).body).toMatchObject({ enabled: true });
    expect((await patch('sa', { isDefault: true })).body).toMatchObject({ isDefault: true });
    expect(
      (await get('/ops/languages')).body.items.filter((l: { isDefault: boolean }) => l.isDefault),
    ).toHaveLength(1);
    expect((await patch('en', { isDefault: true })).body).toMatchObject({ isDefault: true });
    expect((await request(f.app).get('/api/v1/ops/languages').set(analyst)).status).toBe(403);
  });

  it('lists what a language lacks and keeps placeholders in an edit', async () => {
    const missing = await get('/ops/translations?missingIn=sa&screen=ACA&q=ACA.YEAR_CLOSED');
    expect(missing.status, JSON.stringify(missing.body)).toBe(200);
    const item = missing.body.items.find((i: { key: string }) => i.key === 'ACA.YEAR_CLOSED');
    expect(item).toMatchObject({
      screen: 'ACA',
      placeholders: ['label'],
      texts: expect.objectContaining({ sa: null }),
    });
    const kn = item.texts.kn?.version ?? null;
    const put = (key: string, texts: object, versions: object = { sa: null, kn, en: null }) =>
      request(f.app).put(`/api/v1/ops/translations/${key}`).set(f.ops).send({ texts, versions });
    expect((await put('ACA.YEAR_CLOSED', { sa: 'वर्षः समाप्तः' })).body.errors[0]).toMatchObject({
      code: 'I18N.PLACEHOLDERS',
      params: { lang: 'sa', names: '{label}' },
    });
    expect((await put('ACA.YEAR_CLOSED', { en: 'x {label}' })).body.errors[0].code).toBe(
      'I18N.LANGUAGE_NOT_FOUND',
    );
    const ok = await put('ACA.YEAR_CLOSED', {
      sa: '{label} वर्षः समाप्तः',
      kn: '{label} ಮುಚ್ಚಲಾಗಿದೆ.',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.texts.sa).toMatchObject({ source: 'HUMAN', text: '{label} वर्षः समाप्तः' });
    expect(ok.body.texts.kn).toMatchObject({ source: 'HUMAN' });
    // A second editor still holding the old versions is refused (optimistic locking).
    expect((await put('ACA.YEAR_CLOSED', { sa: '{label} वर्षः' })).status).toBe(412);
    expect((await put('ACA.YEAR_CLOSED', { sa: '{label} वर्षः' }, {})).status).toBe(428);
    const again = await put(
      'ACA.YEAR_CLOSED',
      { sa: '{label} वर्षः समाप्तम्' },
      { sa: ok.body.texts.sa.version },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.texts.sa.version).toBe(ok.body.texts.sa.version + 1);
    const after = await get('/ops/translations?missingIn=sa&screen=ACA&q=ACA.YEAR_CLOSED');
    expect(after.body.items.some((i: { key: string }) => i.key === 'ACA.YEAR_CLOSED')).toBe(false);
    expect((await put('NO.SUCH_KEY', { sa: 'x' })).body.code).toBe('I18N.KEY_NOT_FOUND');
  });

  it('writes the request log in batches and filters it, never with values', async () => {
    const { loggers } = capturingLoggers();
    const store = new RequestLogStore({ db: f.t.db, loggers, intervalMs: 10 });
    const at = new Date();
    const correlation = randomUUID();
    const base = {
      at,
      correlationId: correlation,
      method: 'GET',
      route: '/api/v1/console/members',
      path: '/api/v1/console/members',
      status: 200,
      latencyMs: 12.4,
      surface: 'console',
      actor: uuidToBin(randomUUID()),
      institution: null,
      ip: '192.168.10.23',
      userAgent: 'Mozilla/5.0',
      queryKeys: ['q', 'cursor'],
      problemCode: null,
    };
    store.push(base);
    store.push({
      ...base,
      correlationId: randomUUID(),
      method: 'POST',
      route: '/api/v1/console/members/:id/status-changes',
      status: 409,
      problemCode: 'MEM.STATUS',
    });
    store.push({
      ...base,
      correlationId: randomUUID(),
      route: '/api/v1/ops/jobs',
      status: 503,
      problemCode: 'GEN.UNAVAILABLE',
    });
    await store.close();
    const all = await get('/ops/logs', analyst);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.items).toHaveLength(3);
    expect((await get('/ops/logs?status=5xx', analyst)).body.items).toEqual([
      expect.objectContaining({ status: 503, problemCode: 'GEN.UNAVAILABLE' }),
    ]);
    expect((await get('/ops/logs?endpoint=status-changes', analyst)).body.items).toHaveLength(1);
    const one = (await get(`/ops/logs?correlationId=${correlation}`, analyst)).body.items[0];
    const detail = await get(`/ops/logs/${one.id}`, analyst);
    expect(detail.body).toMatchObject({
      queryKeys: ['q', 'cursor'],
      clientAddress: '192.168.10.x',
      latencyMs: 12,
    });
    expect(JSON.stringify(detail.body)).not.toContain('192.168.10.23');
    expect(
      (await get('/ops/logs?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z', analyst)).body
        .errors[0].code,
    ).toBe('LOG.RANGE');
    expect((await get('/ops/logs/999999999', analyst)).body.code).toBe('LOG.NOT_FOUND');
    expect((await get('/ops/logs')).status).toBe(403);
  });

  it('switches channels: no provider, no switch; in-app stays on', async () => {
    const ch = await get('/ops/messaging-providers');
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    expect(ch.body.items.map((c: { channel: string }) => c.channel)).toEqual([
      'IN_APP',
      'SMS',
      'EMAIL',
      'WHATSAPP',
      'PUSH',
    ]);
    const sms = ch.body.items.find((c: { channel: string }) => c.channel === 'SMS');
    expect(sms).toMatchObject({ integrated: true, enabled: true });
    const put = (channel: string, body: object, ver: number) =>
      request(f.app)
        .put(`/api/v1/ops/messaging-providers/${channel}`)
        .set(f.ops)
        .set('If-Match', `"v${ver}"`)
        .send(body);
    expect((await put('whatsapp', { enabled: true }, 1)).body).toMatchObject({
      code: 'INT.PROVIDER_NOT_INTEGRATED',
      status: 409,
    });
    expect((await put('IN_APP', { enabled: false }, 1)).body.code).toBe('INT.IN_APP_REQUIRED');
    const off = await put('SMS', { enabled: false, templateSet: 'school-v2' }, sms.version);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, templateSet: 'school-v2' });
    expect((await put('SMS', { enabled: true }, sms.version)).status).toBe(412);
    expect((await put('FAX', { enabled: true }, 1)).body.code).toBe('INT.CHANNEL_NOT_FOUND');
  });
});

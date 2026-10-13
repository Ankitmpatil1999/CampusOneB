/**
 * Phase 2.1 building blocks on a real MySQL: sessions and refresh rotation, one-time codes,
 * Idempotency-Key, the audit writer, uploads and the public endpoints (PLT-006/009/010/011,
 * IDN-008/009). Runs only when TEST_DB_MIGRATOR_URL is set.
 */
import express from 'express';
import request from 'supertest';
import { sql } from 'kysely';
import { SessionService } from '../../services/session.service';
import { OtpService } from '../../services/otp.service';
import { recordAudit } from '../../services/audit.service';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { errorHandler } from '../../middlewares/error-handler.middleware';
import { runWithContext } from '../../utils/request-context';
import { binToUuid, newCorrelationId } from '../../utils/idGenerator';
import { cookieNames, csrfTokenFor } from '../../utils/cookies';
import { capturingLoggers, testSecurity } from '../helpers';
import {
  adminUrl,
  createTestDatabase,
  insertAccount,
  insertInstitution,
  type TestDatabase,
} from './db';
import { buildHttpApp, captureSender, codeOf } from './http-app';

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe.skipIf(!adminUrl)('Phase 2.1 building blocks on real MySQL', () => {
  let t: TestDatabase;
  let clock = Date.now();
  const now = () => new Date(clock);

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function services() {
    const security = await testSecurity();
    const { loggers, lines } = capturingLoggers();
    const sessions = new SessionService({
      db: t.db,
      signer: security.signer,
      revocations: security.revocations,
      loggers,
      now,
    });
    return { security, loggers, lines, sessions };
  }

  describe('sessions (ADR-0011, BR-05)', () => {
    it('opens a session whose access token verifies, then ends it when the account signs in again', async () => {
      const { security, sessions } = await services();
      const acct = await insertAccount(t.db);
      const first = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const p = await security.verifier.verify(first.accessToken);
      expect(p).toMatchObject({
        subject: acct.publicId,
        surface: 'member',
        sessionId: first.sessionId,
      });
      expect(first.refreshTokenExpiresAt.getTime() - clock).toBeGreaterThan(364 * 86_400_000);

      const second = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      expect(await security.revocations.isRevoked(first.sessionId)).toBe(true);
      expect(await security.revocations.isRevoked(second.sessionId)).toBe(false);
      // Said so, not a bare "no active session" (client 2026-10-13).
      await expect(sessions.refresh(first.refreshToken)).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH.SIGNED_IN_ELSEWHERE',
      });
      const ended = await t.db
        .selectFrom('sessions')
        .select(['end_reason'])
        .where('account_id', '=', acct.id)
        .where('ended_at', 'is not', null)
        .execute();
      expect(ended.map((e) => e.end_reason)).toEqual(['OTHER_DEVICE_LOGIN']);
    });

    it('keeps one session per surface: a console sign-in leaves the member session alone', async () => {
      const { sessions, security } = await services();
      const acct = await insertAccount(t.db);
      const inst = await insertInstitution(t.db);
      const member = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const console1 = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'console',
        institution: inst,
      });
      expect(await security.revocations.isRevoked(member.sessionId)).toBe(false);
      const p = await security.verifier.verify(console1.accessToken);
      expect(p.institutionId).toBe(inst.publicId);
      // Staff sessions have a 15-minute idle limit on the refresh token.
      expect(console1.refreshTokenExpiresAt.getTime() - clock).toBeLessThanOrEqual(15 * 60_000);
    });

    it('rotates the refresh token on every use', async () => {
      const { sessions, security } = await services();
      const acct = await insertAccount(t.db);
      const s = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const r1 = await sessions.refresh(s.refreshToken);
      expect(r1.refreshToken).not.toBe(s.refreshToken);
      expect(r1.sessionId).toBe(s.sessionId);
      await expect(security.verifier.verify(r1.accessToken)).resolves.toMatchObject({
        sessionId: s.sessionId,
      });
      const r2 = await sessions.refresh(r1.refreshToken);
      expect(r2.refreshToken).not.toBe(r1.refreshToken);
    });

    it('treats reuse of a rotated refresh token as theft: family revoked, session ended, security event', async () => {
      const { sessions, security, lines } = await services();
      const acct = await insertAccount(t.db);
      const s = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const r1 = await sessions.refresh(s.refreshToken);
      clock += 30_000; // outside the parallel-request grace
      await expect(sessions.refresh(s.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
      await expect(sessions.refresh(r1.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
      expect(await security.revocations.isRevoked(s.sessionId)).toBe(true);
      await vi.waitFor(() =>
        expect(lines.some((l) => l['message'] === 'auth.refresh_reuse')).toBe(true),
      );
      const row = await t.db
        .selectFrom('sessions')
        .select('end_reason')
        .where('account_id', '=', acct.id)
        .executeTakeFirstOrThrow();
      expect(row.end_reason).toBe('REFRESH_REUSE');
    });

    it('refuses a second parallel refresh with the same token without ending the session', async () => {
      const { sessions } = await services();
      const acct = await insertAccount(t.db);
      const s = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const r1 = await sessions.refresh(s.refreshToken);
      // Superseded, not ended: the caller keeps the winner's tokens.
      await expect(sessions.refresh(s.refreshToken)).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH.REFRESH_SUPERSEDED',
      });
      await expect(sessions.refresh(r1.refreshToken)).resolves.toMatchObject({
        sessionId: s.sessionId,
      });
    });

    it('ends a staff session after 15 idle minutes, and refuses a token bound to another surface', async () => {
      const { sessions } = await services();
      const acct = await insertAccount(t.db);
      const s = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'portal',
      });
      await expect(sessions.refresh(s.refreshToken, {}, 'console')).rejects.toMatchObject({
        statusCode: 401,
      });
      clock += 16 * 60_000;
      await expect(sessions.refresh(s.refreshToken, {}, 'portal')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('signs out one session, or every session of an account', async () => {
      const { sessions, security } = await services();
      const acct = await insertAccount(t.db);
      const m = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const c = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'portal',
      });
      await sessions.end(m.sessionId, 'SIGN_OUT');
      expect(await security.revocations.isRevoked(m.sessionId)).toBe(true);
      await sessions.end(m.sessionId, 'SIGN_OUT'); // already ended: no-op
      expect(await sessions.endAllForAccount(acct.id, 'PASSWORD_CHANGED')).toBe(1);
      expect(await security.revocations.isRevoked(c.sessionId)).toBe(true);
    });
  });

  describe('one-time codes (6.2, 27.4 §6)', () => {
    async function otp() {
      const security = await testSecurity();
      const sms = captureSender('sms');
      const email = captureSender('email');
      return { svc: new OtpService({ db: t.db, cipher: security.cipher, sms, email, now }), sms };
    }

    it('sends a 4-digit code, refuses a second code while one is live, and verifies once', async () => {
      const { svc, sms } = await otp();
      const issued = await svc.issue({
        purpose: 'SIGNUP',
        channel: 'SMS',
        destination: '9876543210',
      });
      expect(issued.sentTo).toBe('••••••3210');
      const code = codeOf(sms.sent[0]);
      expect(code).toMatch(/^\d{4}$/);
      await expect(
        svc.issue({ purpose: 'SIGNUP', channel: 'SMS', destination: '9876543210' }),
      ).rejects.toMatchObject({ code: 'AUTH.OTP_ALREADY_SENT', headers: { 'Retry-After': '60' } });
      await expect(svc.verify(issued.challengeId, code, 'SIGNUP')).resolves.toMatchObject({
        purpose: 'SIGNUP',
      });
      await expect(svc.verify(issued.challengeId, code, 'SIGNUP')).rejects.toMatchObject({
        code: 'AUTH.OTP_ALREADY_USED',
      });
      const stored = await t.db
        .selectFrom('otp_challenges')
        .select('code_hash')
        .executeTakeFirstOrThrow();
      expect(stored.code_hash.includes(Buffer.from(code))).toBe(false);
    });

    it('abandons the challenge after three wrong codes', async () => {
      const { svc, sms } = await otp();
      const issued = await svc.issue({
        purpose: 'DEVICE',
        channel: 'SMS',
        destination: '9876500001',
      });
      const right = codeOf(sms.sent[0]);
      const wrong = right === '0000' ? '1111' : '0000';
      await expect(svc.verify(issued.challengeId, wrong, 'DEVICE')).rejects.toMatchObject({
        code: 'AUTH.OTP_INVALID',
      });
      await expect(svc.verify(issued.challengeId, wrong, 'DEVICE')).rejects.toMatchObject({
        code: 'AUTH.OTP_INVALID',
      });
      await expect(svc.verify(issued.challengeId, wrong, 'DEVICE')).rejects.toMatchObject({
        code: 'AUTH.OTP_ATTEMPTS_EXCEEDED',
      });
      await expect(svc.verify(issued.challengeId, right, 'DEVICE')).rejects.toMatchObject({
        code: 'AUTH.OTP_ATTEMPTS_EXCEEDED',
      });
    });

    it('allows one resend after 60 seconds; the old code stops working', async () => {
      const { svc, sms } = await otp();
      const issued = await svc.issue({
        purpose: 'RECOVERY',
        channel: 'SMS',
        destination: '9876500002',
      });
      await expect(svc.resend(issued.challengeId, '9876500002')).rejects.toMatchObject({
        code: 'AUTH.OTP_RESEND_TOO_SOON',
      });
      clock += 61_000;
      await svc.resend(issued.challengeId, '9876500002');
      const [first, second] = [codeOf(sms.sent[0]), codeOf(sms.sent[1])];
      if (first !== second) {
        await expect(svc.verify(issued.challengeId, first, 'RECOVERY')).rejects.toMatchObject({
          code: 'AUTH.OTP_INVALID',
        });
      }
      clock += 61_000;
      await expect(svc.resend(issued.challengeId, '9876500002')).rejects.toMatchObject({
        code: 'AUTH.OTP_RESEND_LIMIT',
      });
      await expect(svc.verify(issued.challengeId, second, 'RECOVERY')).resolves.toBeDefined();
    });

    it('refuses an expired code and a code for another purpose', async () => {
      const { svc, sms } = await otp();
      const a = await svc.issue({
        purpose: 'CONSOLE_2FA',
        channel: 'EMAIL',
        destination: 'Head@School.in',
      });
      await expect(
        svc.verify(a.challengeId, codeOf(sms.sent[0]) || '1234', 'OPS_2FA'),
      ).rejects.toMatchObject({
        code: 'AUTH.OTP_INVALID',
      });
      clock += 5 * 60_000 + 1;
      await expect(svc.verify(a.challengeId, '1234', 'CONSOLE_2FA')).rejects.toMatchObject({
        code: 'AUTH.OTP_EXPIRED',
      });
      // E-mail destinations are matched case-insensitively.
      expect(
        svc
          .destinationHash('EMAIL', 'head@school.in')
          .equals(svc.destinationHash('EMAIL', ' HEAD@SCHOOL.IN')),
      ).toBe(true);
    });
  });

  describe('Idempotency-Key (brief §7.4)', () => {
    function app() {
      let runs = 0;
      const { loggers } = capturingLoggers();
      const a = express();
      a.use(express.json());
      a.post('/things', idempotency({ db: t.db, mode: 'required' }), (req, res) => {
        runs += 1;
        res.status(201).json({ run: runs, name: (req.body as { name?: string }).name });
      });
      a.post('/boom', idempotency({ db: t.db, mode: 'required' }), (_req, res) => {
        runs += 1;
        res.status(500).json({ failed: true });
      });
      a.use(errorHandler(loggers));
      return { a, runs: () => runs };
    }

    it('runs once and replays the stored response for the same key and body', async () => {
      const { a, runs } = app();
      const first = await request(a)
        .post('/things')
        .set('Idempotency-Key', 'key-00000001')
        .send({ name: 'x' });
      expect(first.status).toBe(201);
      await vi.waitFor(async () => {
        const r = await t.db
          .selectFrom('idempotency_records')
          .select('status')
          .where('idempotency_key', '=', 'key-00000001')
          .executeTakeFirst();
        expect(r?.status).toBe('COMPLETED');
      });
      const replay = await request(a)
        .post('/things')
        .set('Idempotency-Key', 'key-00000001')
        .send({ name: 'x' });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(runs()).toBe(1);
    });

    it('refuses a reused key with a different body, and a request without a key', async () => {
      const { a } = app();
      await request(a).post('/things').set('Idempotency-Key', 'key-00000002').send({ name: 'x' });
      const other = await request(a)
        .post('/things')
        .set('Idempotency-Key', 'key-00000002')
        .send({ name: 'y' });
      expect(other.status).toBe(422);
      expect(other.body.code).toBe('GEN.IDEMPOTENCY_KEY_REUSED');
      const missing = await request(a).post('/things').send({ name: 'x' });
      expect(missing.status).toBe(428);
      expect(missing.body.code).toBe('GEN.IDEMPOTENCY_KEY_REQUIRED');
    });

    it('does not store server errors, so the client can retry with the same key', async () => {
      const { a, runs } = app();
      await request(a).post('/boom').set('Idempotency-Key', 'key-00000003').send({});
      await vi.waitFor(async () => {
        const r = await t.db
          .selectFrom('idempotency_records')
          .select('id')
          .where('idempotency_key', '=', 'key-00000003')
          .executeTakeFirst();
        expect(r).toBeUndefined();
      });
      await request(a).post('/boom').set('Idempotency-Key', 'key-00000003').send({});
      expect(runs()).toBe(2);
    });
  });

  describe('audit writer', () => {
    it('writes a masked, append-only record with the request correlation id and actor', async () => {
      const inst = await insertInstitution(t.db);
      const correlationId = newCorrelationId();
      const actor = '0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a';
      await runWithContext(
        { correlationId, actorId: actor, actorType: 'console', ip: '10.0.0.7' },
        () =>
          recordAudit(t.db, {
            institutionId: inst.id,
            action: 'MEMBER_CONTACT_CHANGE',
            entityType: 'member_profile',
            before: { pan: 'ABCDE1234F', city: 'Mysuru' },
            after: { city: 'Bengaluru' },
            reason: 'moved',
          }),
      );
      const row = await t.db
        .selectFrom('audit_log')
        .selectAll()
        .where('institution_id', '=', inst.id)
        .executeTakeFirstOrThrow();
      expect(row.actor_type).toBe('console');
      expect(binToUuid(row.actor_ref!)).toBe(actor);
      expect(binToUuid(row.correlation_id)).toBe(correlationId);
      expect(JSON.stringify(row.before_state)).not.toContain('ABCDE1234F');
      expect(JSON.stringify(row.after_state)).toContain('Bengaluru');
      await expect(
        sql`UPDATE audit_log SET reason = 'x' WHERE institution_id = ${inst.id}`.execute(t.db),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('HTTP: keys, bundles, uploads, refresh and sign-out', () => {
    async function http() {
      const h = await buildHttpApp(t);
      return {
        app: h.app,
        security: h.security,
        sessions: h.services.sessions,
        storage: h.storage,
      };
    }

    it('publishes the public signing keys only (PLT-006)', async () => {
      const { app } = await http();
      const res = await request(app).get('/.well-known/jwks.json');
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBeGreaterThan(0);
      for (const k of res.body.keys) expect(k.d).toBeUndefined();
    });

    it('serves language bundles with an ETag and 404 for a language that is not enabled (PLT-009)', async () => {
      const { app } = await http();
      const en = await request(app).get('/api/v1/i18n/en');
      expect(en.status).toBe(200);
      expect(en.body.messages['GEN.INTERNAL']).toBe('Something went wrong. Please try again.');
      expect(en.body.complete).toBe(true);
      const again = await request(app)
        .get('/api/v1/i18n/en')
        .set('If-None-Match', String(en.headers['etag']));
      expect(again.status).toBe(304);
      const kn = await request(app).get('/api/v1/i18n/kn');
      // Machine-draft translations (client 2026-10-02) over English, key by key.
      expect(kn.body).toMatchObject({ lang: 'kn', fallback: 'en', machineDraft: true });
      expect(kn.body.messages['ui.welcome.signIn']).toBeTruthy();
      expect(kn.body.messages['ui.welcome.signIn']).not.toBe('Sign in');
      expect((await request(app).get('/api/v1/i18n/fr')).status).toBe(404);
      // PLT-015: the picker order the client asked for (Kannada next to English).
      const langs = await request(app).get('/api/v1/languages');
      expect(langs.body.items.map((l: { code: string }) => l.code)).toEqual([
        'en',
        'kn',
        'hi',
        'te',
        'ta',
        'ml',
        'mr',
      ]);
      expect(langs.body.items[1]).toEqual({
        code: 'kn',
        name: 'Kannada',
        nativeName: 'ಕನ್ನಡ',
        isDefault: false,
      });
    });

    it('uploads within the rules and hands out a signed link to the same institution only (PLT-010/011)', async () => {
      const { app, sessions } = await http();
      const inst = await insertInstitution(t.db);
      const other = await insertInstitution(t.db);
      const acct = await insertAccount(t.db);
      const s = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'console',
        institution: inst,
      });
      const auth = { Authorization: `Bearer ${s.accessToken}` };

      const up = await request(app)
        .post('/api/v1/files')
        .set(auth)
        .field('purpose', 'logo')
        .attach('file', PNG, 'logo.png');
      expect(up.status).toBe(201);
      expect(up.body).toMatchObject({
        purpose: 'logo',
        mimeType: 'image/png',
        scanStatus: 'CLEAN',
      });

      const wrongType = await request(app)
        .post('/api/v1/files')
        .set(auth)
        .field('purpose', 'logo')
        .attach('file', PDF, 'logo.png');
      expect(wrongType.status).toBe(415);
      expect(wrongType.body.detail).toBe('Invalid file format');

      const big = await request(app)
        .post('/api/v1/files')
        .set(auth)
        .field('purpose', 'document')
        .attach('file', Buffer.concat([PDF, Buffer.alloc(2_200_000)]), 'big.pdf');
      expect(big.status).toBe(413);
      expect(big.body.detail).toBe('The file must be under 2 MB.');

      const link = await request(app).get(`/api/v1/files/${up.body.fileId}/url`).set(auth);
      expect(link.status).toBe(200);
      const content = await request(app).get(link.body.url);
      expect(content.status).toBe(200);
      expect(content.headers['content-type']).toBe('image/png');
      expect(Buffer.from(content.body as Buffer).equals(PNG)).toBe(true);

      const tampered = await request(app).get(link.body.url.replace(/sig=./, 'sig=x'));
      expect(tampered.status).toBe(404);

      const outsider = await sessions.start({
        accountId: (await insertAccount(t.db)).id,
        accountPublicId: (await insertAccount(t.db)).publicId,
        surface: 'console',
        institution: other,
      });
      const denied = await request(app)
        .get(`/api/v1/files/${up.body.fileId}/url`)
        .set({ Authorization: `Bearer ${outsider.accessToken}` });
      expect(denied.status).toBe(404);
      expect(
        (
          await request(app)
            .post('/api/v1/files')
            .field('purpose', 'logo')
            .attach('file', PNG, 'a.png')
        ).status,
      ).toBe(401);
    });

    it('refreshes a member session from the body and a web session from cookies with CSRF (IDN-008)', async () => {
      const { app, sessions, security } = await http();
      const acct = await insertAccount(t.db);
      const m = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const body = await request(app)
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: m.refreshToken });
      expect(body.status).toBe(200);
      expect(body.body.refreshToken).toBeDefined();
      expect(body.body.accessToken).toBeDefined();

      const w = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'console',
      });
      const names = cookieNames('console');
      const csrf = csrfTokenFor(security.cipher, w.sessionId);
      const cookies = `${names.refresh}=${w.refreshToken}; ${names.csrf}=${csrf}`;
      const noCsrf = await request(app)
        .post('/api/v1/auth/token/refresh')
        .set('X-RingPe-Surface', 'console')
        .set('Cookie', cookies)
        .send({});
      expect(noCsrf.status).toBe(403);
      const web = await request(app)
        .post('/api/v1/auth/token/refresh')
        .set('X-RingPe-Surface', 'console')
        .set('X-CSRF-Token', csrf)
        .set('Cookie', cookies)
        .send({});
      expect(web.status).toBe(200);
      expect(web.body.refreshToken).toBeUndefined();
      const set = (web.headers['set-cookie'] as unknown as string[]).join('\n');
      expect(set).toContain(`${names.access}=`);
      expect(set).toMatch(
        /__Host-rp_console_at=[^;]+; Max-Age=\d+; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Strict/,
      );
    });

    it('signs out: the session ends and its access token stops at once (IDN-009)', async () => {
      const { app, sessions } = await http();
      const acct = await insertAccount(t.db);
      const s = await sessions.start({
        accountId: acct.id,
        accountPublicId: acct.publicId,
        surface: 'member',
      });
      const auth = { Authorization: `Bearer ${s.accessToken}` };
      expect((await request(app).post('/api/v1/auth/signout').set(auth)).status).toBe(204);
      const after = await request(app)
        .get(`/api/v1/files/0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a/url`)
        .set(auth);
      expect(after.status).toBe(401);
      expect(
        (
          await request(app)
            .post('/api/v1/auth/token/refresh')
            .send({ refreshToken: s.refreshToken })
        ).status,
      ).toBe(401);
    });
  });
});

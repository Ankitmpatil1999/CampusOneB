/**
 * Staff sign-in on a real MySQL (SRS 6.4, 6.38.4 CR-05; IDN-031…037, IDN-079/080): password then
 * a 4-digit code; one refusal message for every reason (RNG-IDN-376); the console only for staff
 * with a role in an active institution, the back office only for operators (RNG-IDN-043); wrong
 * codes end the attempt and abandoned attempts lock the account (RNG-IDN-380); the session lives
 * in __Host- cookies and carries the role's grants.
 */
import { randomInt } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { sql } from 'kysely';
import { adminUrl, createTestDatabase, insertInstitution, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Tvps@2026';
const REFUSED = "That email and password don't match. Give it another go.";

describe.skipIf(!adminUrl)('staff sign-in on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let hash: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    hash = await hashSecret(PASSWORD);
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  const roleId = async (code: string) =>
    String(
      (
        await t.db
          .selectFrom('roles')
          .select('id')
          .where('code', '=', code)
          .executeTakeFirstOrThrow()
      ).id,
    );

  async function account(email: string) {
    const mobile = `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile,
        email,
        first_name: 'PRAKASH',
        last_name: 'SHETTY',
      })
      .executeTakeFirstOrThrow();
    const id = String(r.insertId);
    await t.db
      .insertInto('account_credentials')
      .values({ account_id: id, kind: 'PASSWORD', hash })
      .execute();
    return { id, mobile };
  }

  /** A console user: profile of the given category in an active school, with the role. */
  async function staff(opts: { category?: string; role?: string; active?: boolean } = {}) {
    const inst = await insertInstitution(t.db);
    await t.db
      .updateTable('institutions')
      .set({ status: opts.active === false ? 'SUSPENDED' : 'ACTIVE' })
      .where('id', '=', inst.id)
      .execute();
    const type = await t.db
      .insertInto('user_types')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: inst.id,
        name: 'Staff',
        category: (opts.category ?? 'STAFF') as never,
      })
      .executeTakeFirstOrThrow();
    const email = `staff.${randomInt(0, 1e9)}@school.example.in`;
    const a = await account(email);
    const p = await t.db
      .insertInto('member_profiles')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: inst.id,
        account_id: a.id,
        user_type_id: String(type.insertId),
        first_name: 'PRAKASH',
      })
      .executeTakeFirstOrThrow();
    if (opts.role !== '') {
      await t.db
        .insertInto('profile_roles')
        .values({
          institution_id: inst.id,
          profile_id: String(p.insertId),
          role_id: await roleId(opts.role ?? 'INSTITUTION_ADMIN'),
        })
        .execute();
    }
    return { email, ...a, institution: inst };
  }

  async function operator(role = 'PLATFORM_ADMIN') {
    const email = `ops.${randomInt(0, 1e9)}@campusone.example`;
    const a = await account(email);
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: a.id, role_id: await roleId(role) })
      .execute();
    return { email, ...a };
  }

  const signIn = (path: string, email: string, password = PASSWORD) =>
    request(app).post(path).send({ email, password });
  const cookiesOf = (r: request.Response) =>
    ([] as string[]).concat(r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0] ?? '');

  it('signs a console user in with the password and then the code; the session carries the grants', async () => {
    const s = await staff();
    const step1 = await signIn('/api/v1/auth/console/signin', s.email.toUpperCase());
    expect(step1.status).toBe(202);
    expect(step1.body).toMatchObject({ channel: 'SMS', sentTo: `••••••${s.mobile.slice(-4)}` });
    expect(step1.body.emailFallback).toMatch(/^s•••@school\.example\.in$/);
    // No session before the code (RNG-IDN-375).
    expect(step1.headers['set-cookie']).toBeUndefined();

    const verified = await request(app)
      .post('/api/v1/auth/console/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(verified.status).toBe(200);
    expect(verified.body.name).toBe('PRAKASH SHETTY');
    const cookies = cookiesOf(verified);
    expect(cookies.map((c) => c.split('=')[0])).toEqual([
      '__Host-rp_console_at',
      '__Host-rp_console_rt',
      '__Host-rp_console_csrf',
    ]);

    const session = await request(app).get('/api/v1/console/session').set('Cookie', cookies);
    expect(session.status).toBe(200);
    expect(session.body.institution.id).toBe(s.institution.publicId);
    expect(session.body.roles).toEqual([
      { code: 'INSTITUTION_ADMIN', name: 'Institution Administrator', readOnly: false },
    ]);
    expect(session.body.subTasks).toEqual(
      expect.arrayContaining(['members.view', 'approvals.decide', 'home.view']),
    );
    // The console session does not open the back office.
    expect(
      (await request(app).get('/api/v1/ops/session').set('Cookie', cookies)).status,
    ).toBeGreaterThanOrEqual(401);

    // A refreshed access token still carries the active profile (the session stays usable).
    const csrf = cookies.find((c) => c.startsWith('__Host-rp_console_csrf='))!.split('=')[1]!;
    const refreshed = await request(app)
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', cookies)
      .set('X-CampusOne-Surface', 'console')
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(refreshed.status).toBe(200);
    const fresh = cookiesOf(refreshed);
    const at = fresh.find((c) => c.startsWith('__Host-rp_console_at='))!;
    const again = await request(app)
      .get('/api/v1/console/session')
      .set('Cookie', [at, ...cookies.filter((c) => !c.startsWith('__Host-rp_console_at='))]);
    expect(again.status).toBe(200);
    expect(again.body.institution.id).toBe(s.institution.publicId);

    // A second tab renewing with the same (now rotated) cookie at the same moment: refused as
    // superseded, and the cookies the first renewal set are left alone (client 2026-10-13).
    const late = await request(app)
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', cookies)
      .set('X-CampusOne-Surface', 'console')
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('AUTH.REFRESH_SUPERSEDED');
    expect(late.headers['set-cookie']).toBeUndefined();
    const rt = fresh.find((c) => c.startsWith('__Host-rp_console_rt='))!;
    const next = await request(app)
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', [at, rt, cookies.find((c) => c.startsWith('__Host-rp_console_csrf='))!])
      .set('X-CampusOne-Surface', 'console')
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(next.status).toBe(200);
  });

  it('refuses every reason with the one 6.4 message and issues no code', async () => {
    const sent = () => h.sms.sent.length;
    const before = sent();
    const unknown = await signIn('/api/v1/auth/console/signin', 'nobody@school.example.in');
    const s = await staff();
    const wrong = await signIn('/api/v1/auth/console/signin', s.email, 'Wrong@2026');
    const student = await staff({ category: 'STUDENT' });
    const asStudent = await signIn('/api/v1/auth/console/signin', student.email);
    const noRole = await staff({ role: '' });
    const withoutRole = await signIn('/api/v1/auth/console/signin', noRole.email);
    const suspended = await staff({ active: false });
    const inSuspended = await signIn('/api/v1/auth/console/signin', suspended.email);
    const op = await operator();
    const opIntoConsole = await signIn('/api/v1/auth/console/signin', op.email);
    const staffIntoOps = await signIn('/api/v1/ops/auth/signin', s.email);
    for (const r of [
      unknown,
      wrong,
      asStudent,
      withoutRole,
      inSuspended,
      opIntoConsole,
      staffIntoOps,
    ]) {
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ code: 'IDN.CONSOLE_SIGNIN_REFUSED', detail: REFUSED });
    }
    expect(sent()).toBe(before);
  });

  it('signs an operator into the back office with the operator grants', async () => {
    const op = await operator('SETTLEMENT_MAKER');
    const step1 = await signIn('/api/v1/ops/auth/signin', op.email);
    expect(step1.status).toBe(202);
    const verified = await request(app)
      .post('/api/v1/ops/auth/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(cookiesOf(verified)[0]).toMatch(/^__Host-rp_ops_at=/);
    const session = await request(app)
      .get('/api/v1/ops/session')
      .set('Cookie', cookiesOf(verified));
    expect(session.body).toMatchObject({
      role: { code: 'SETTLEMENT_MAKER', name: 'Settlement Maker' },
    });
    // Sub-tasks for actions, and task.<code> for the menus (RNG-GOV-001).
    expect([...session.body.subTasks].sort()).toEqual([
      'home.view',
      'settle.stage1',
      'settle.view',
      'task.home',
      'task.settle',
    ]);
  });

  it('sends the code by e-mail instead, once; the SMS code stops working', async () => {
    const s = await staff();
    const step1 = await signIn('/api/v1/auth/console/signin', s.email);
    const smsCode = codeOf(h.sms.sent.at(-1));
    const byEmail = await request(app)
      .post('/api/v1/auth/console/otp/resend')
      .send({ challengeId: step1.body.challengeId, channel: 'EMAIL' });
    expect(byEmail.status).toBe(202);
    expect(byEmail.body).toMatchObject({ channel: 'EMAIL', sentTo: expect.stringMatching(/•••@/) });
    const old = await request(app)
      .post('/api/v1/auth/console/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: smsCode });
    expect(old.status).toBe(400);
    const ok = await request(app)
      .post('/api/v1/auth/console/otp/verify')
      .send({ challengeId: byEmail.body.challengeId, otp: codeOf(h.email.sent.at(-1)) });
    expect(ok.status).toBe(200);
  });

  it('ends the attempt after three wrong codes and locks after five abandoned attempts', async () => {
    const s = await staff();
    const wrongCodes = async () => {
      const step1 = await signIn('/api/v1/auth/console/signin', s.email);
      expect(step1.status).toBe(202);
      const id = step1.body.challengeId as string;
      const right = codeOf(h.sms.sent.at(-1));
      const wrong = right === '1111' ? '2222' : '1111';
      const a = await request(app)
        .post('/api/v1/auth/console/otp/verify')
        .send({ challengeId: id, otp: wrong });
      expect(a.body).toMatchObject({ code: 'AUTH.OTP_INVALID', params: { triesLeft: 2 } });
      await request(app)
        .post('/api/v1/auth/console/otp/verify')
        .send({ challengeId: id, otp: wrong });
      return request(app)
        .post('/api/v1/auth/console/otp/verify')
        .send({ challengeId: id, otp: wrong });
    };
    for (let i = 1; i <= 4; i++) {
      const ended = await wrongCodes();
      expect(ended.body).toMatchObject({
        code: 'IDN.SIGNIN_ATTEMPT_ENDED',
        detail: '3 wrong codes ended this sign-in attempt. Enter your password to start again.',
      });
    }
    const locked = await wrongCodes();
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('IDN.CONSOLE_LOCKED');
    // Locked: even the right password is refused until an administrator releases it.
    const again = await signIn('/api/v1/auth/console/signin', s.email);
    expect(again.status).toBe(423);
    const row = await t.db
      .selectFrom('platform_accounts')
      .select(['signin_lock', 'abandoned_code_attempts'])
      .where('id', '=', s.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ signin_lock: 'LOCKED', abandoned_code_attempts: 5 });
  }, 60_000);

  it('locks for a while after five wrong passwords (staff lock-out setting)', async () => {
    const s = await staff();
    for (let i = 1; i <= 4; i++) {
      expect((await signIn('/api/v1/auth/console/signin', s.email, 'Wrong@2026')).status).toBe(401);
    }
    const fifth = await signIn('/api/v1/auth/console/signin', s.email, 'Wrong@2026');
    expect(fifth.status).toBe(429);
    expect(fifth.body).toMatchObject({ code: 'IDN.SIGNIN_LOCKED', params: { minutes: 30 } });
    expect((await signIn('/api/v1/auth/console/signin', s.email)).status).toBe(429);
    await t.db
      .updateTable('platform_accounts')
      .set({ locked_until: sql<Date>`UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE` })
      .where('id', '=', s.id)
      .execute();
    expect((await signIn('/api/v1/auth/console/signin', s.email)).status).toBe(202);
  }, 60_000);

  it('resets a staff password from the e-mailed link once; sessions end (IDN-034, IDN-083)', async () => {
    const s = await staff();
    const step1 = await signIn('/api/v1/auth/console/signin', s.email);
    const verified = await request(app)
      .post('/api/v1/auth/console/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(verified.status).toBe(200);

    const mails = h.email.sent.length;
    const forgot = await request(app)
      .post('/api/v1/auth/console/password/forgot')
      .send({ email: s.email.toUpperCase() });
    expect(forgot.status).toBe(202);
    expect(h.email.sent).toHaveLength(mails + 1);
    const mail = h.email.sent.at(-1)!;
    expect(mail.to).toBe(s.email);
    const link = /(\S+\/console\/reset-password#token=)(\S+)/.exec(mail.text);
    expect(link).not.toBeNull();
    const resetToken = link![2]!;

    const weak = await request(app)
      .post('/api/v1/auth/staff/password/reset')
      .send({ resetToken, newPassword: 'short' });
    expect(weak.status).toBe(422);
    const changed = await request(app)
      .post('/api/v1/auth/staff/password/reset')
      .send({ resetToken, newPassword: 'Tvps@2027new' });
    expect(changed.status).toBe(204);

    // Single use: the password's version moved on.
    const again = await request(app)
      .post('/api/v1/auth/staff/password/reset')
      .send({ resetToken, newPassword: 'Tvps@2028new' });
    expect(again.status).toBe(401);
    expect(again.body).toMatchObject({ code: 'IDN.RESET_LINK_INVALID' });

    // The open session ended; the old password no longer works, the new one does.
    const session = await request(app)
      .get('/api/v1/console/session')
      .set('Cookie', cookiesOf(verified));
    expect(session.status).toBe(401);
    expect((await signIn('/api/v1/auth/console/signin', s.email)).status).toBe(401);
    expect((await signIn('/api/v1/auth/console/signin', s.email, 'Tvps@2027new')).status).toBe(202);
  }, 60_000);

  it('answers the same for unknown or ineligible e-mails and sends nothing (IDN-034, IDN-082)', async () => {
    const op = await operator();
    const s = await staff();
    const mails = h.email.sent.length;
    for (const [path, email] of [
      ['/api/v1/auth/console/password/forgot', `nobody.${randomInt(0, 1e9)}@school.example.in`],
      ['/api/v1/auth/console/password/forgot', op.email],
      ['/api/v1/ops/auth/password/forgot', s.email],
      ['/api/v1/ops/auth/password/forgot', 'not-an-email'],
    ] as const) {
      expect((await request(app).post(path).send({ email })).status).toBe(202);
    }
    expect(h.email.sent).toHaveLength(mails);
    expect(
      (await request(app).post('/api/v1/ops/auth/password/forgot').send({ email: op.email }))
        .status,
    ).toBe(202);
    expect(h.email.sent).toHaveLength(mails + 1);
    expect(h.email.sent.at(-1)!.text).toMatch(/\/backoffice\/reset-password#token=/);
  }, 60_000);
});

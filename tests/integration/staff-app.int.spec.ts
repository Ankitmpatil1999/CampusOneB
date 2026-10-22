/**
 * The staff app's foundation on a real MySQL (client 2026-10-19; IDN-088/089, COM-034/037):
 * - a console session of the app, beside the web console's: signing in on the phone keeps the web
 *   session, and a second phone sign-in ends the first; tokens in the body, sent as Bearer;
 * - its renewal by body, which refuses another surface's token;
 * - device tokens for push, and a console notification pushed to the staff app's phone through
 *   the push relay (the member app's phones get member notices only);
 * - the new staff notifications: a school fee paid online reaches whoever collects fees.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { capturingLoggers } from '../helpers';
import { adminUrl } from './db';
import { codeOf } from './http-app';
import { PASSWORD, inr, mobile, schoolFixture, type Auth, type Payer } from './school';
import type { PushMessage, PushSender } from '../../integrations/push.provider';
import { notify } from '../../services/notifications.service';
import { PushRelay } from '../../services/push-relay.service';
import { tokenHash } from '../../services/push.service';
import { uuidToBin } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('the staff app: sign-in, push and staff notifications', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;

  /** The app's sign-in: the console's step 1, then its own step 2. */
  const appSignIn = async () => {
    const step1 = await request(f.app)
      .post('/api/v1/auth/console/signin')
      .send({ email: f.school.adminEmail, password: PASSWORD });
    expect(step1.status, JSON.stringify(step1.body)).toBe(202);
    const r = await request(f.app)
      .post('/api/v1/auth/staff-app/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(f.h.sms.sent.at(-1)) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as {
      sessionId: string;
      accessToken: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
      name: string;
    };
  };
  const bearer = (t: { accessToken: string }) => ({ Authorization: `Bearer ${t.accessToken}` });

  beforeAll(async () => {
    f = await schoolFixture('Staff App School');
    con = f.school.con;
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('signs in on the phone beside the web console, renews by body, and one phone at a time (IDN-088/089)', async () => {
    const app1 = await appSignIn();
    // Tokens in the body, never cookies; a long-lived renewal (days, not the web's minutes).
    expect(app1.accessToken).toBeTruthy();
    const days = (Date.parse(app1.refreshTokenExpiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    const session = await request(f.app).get('/api/v1/console/session').set(bearer(app1));
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    expect(session.body.subTasks).toEqual(expect.arrayContaining(['fees.collect']));
    // The web console's session goes on.
    expect((await request(f.app).get('/api/v1/console/session').set(con)).status).toBe(200);

    // Renewed by body; the old refresh token is spent.
    const renewed = await request(f.app)
      .post('/api/v1/auth/staff-app/token/refresh')
      .send({ refreshToken: app1.refreshToken });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    expect(renewed.body.sessionId).toBe(app1.sessionId);
    expect(
      (await request(f.app).get('/api/v1/console/session').set(bearer(renewed.body))).status,
    ).toBe(200);

    // A second phone: the first phone's session ends, the web's still does not.
    const app2 = await appSignIn();
    const old = await request(f.app)
      .post('/api/v1/auth/staff-app/token/refresh')
      .send({ refreshToken: renewed.body.refreshToken });
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('AUTH.SIGNED_IN_ELSEWHERE');
    expect((await request(f.app).get('/api/v1/console/session').set(bearer(app2))).status).toBe(
      200,
    );
    expect((await request(f.app).get('/api/v1/console/session').set(con)).status).toBe(200);

    // A member app's refresh token is not renewed here.
    const member = await f.signUp(mobile());
    const refused = await request(f.app)
      .post('/api/v1/auth/staff-app/token/refresh')
      .send({ refreshToken: member.refresh });
    expect(refused.status).toBe(401);
    // Nor is the member's session spent by the attempt.
    expect(
      (
        await request(f.app)
          .post('/api/v1/auth/token/refresh')
          .send({ refreshToken: member.refresh })
      ).status,
    ).toBe(200);
  });

  it('pushes a fee paid online to the staff app of whoever collects fees (COM-034/037, NTF.FEE_PAID_ONLINE)', async () => {
    // The platform's push channel on (back office, INT-010): pushes are queued from now on.
    await f.t.db
      .updateTable('messaging_channels')
      .set({ enabled: 1 })
      .where('channel', '=', 'PUSH')
      .execute();
    const tokenRow = (token: string) =>
      f.t.db
        .selectFrom('session_push_tokens as t')
        .innerJoin('sessions as s', 's.id', 't.session_id')
        .select(['s.surface', 's.staff_app', 't.platform', 't.lang_code'])
        .where('t.token_hash', '=', tokenHash(token))
        .executeTakeFirst();
    const phone = await appSignIn();
    const token = `fcm-${randomUUID()}-${randomUUID()}`;
    const reg = await request(f.app)
      .put('/api/v1/console/push-token')
      .set(bearer(phone))
      .send({ token, platform: 'ANDROID' });
    expect(reg.status, JSON.stringify(reg.body)).toBe(204);
    expect(await tokenRow(token)).toEqual({
      surface: 'CONSOLE',
      staff_app: 1,
      platform: 'ANDROID',
      lang_code: 'en',
    });
    // The web console's session has no phone.
    expect(
      (
        await request(f.app)
          .put('/api/v1/console/push-token')
          .set(con)
          .send({ token: `fcm-${randomUUID()}`, platform: 'ANDROID' })
      ).status,
    ).toBe(404);

    // The member app's token, worded in its language (COM-034).
    const student: Payer = await f.student('Ravi', 0);
    const memberToken = `fcm-${randomUUID()}-${randomUUID()}`;
    expect(
      (
        await request(f.app)
          .put('/api/v1/me/push-token')
          .set(student.auth)
          .send({ token: memberToken, platform: 'ANDROID', language: 'kn' })
      ).status,
    ).toBe(204);
    expect(await tokenRow(memberToken)).toMatchObject({ surface: 'MEMBER', lang_code: 'kn' });

    // A student pays an instalment online from a payment link.
    const ef = (await request(f.app).get('/api/v1/console/entry-fees').set(con)).body.items as {
      year: { id: string; current: boolean };
    }[];
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const rec = await request(f.app)
      .post('/api/v1/console/fee-records')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({
        studentId: student.id,
        yearId: ef.find((x) => x.year.current)!.year.id,
        label: 'Term 1',
        dueDate: today,
        amount: inr('1500.00'),
      });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const qr = await request(f.app)
      .post(`/api/v1/console/fee-records/${rec.body.id}/payment-requests`)
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ channel: 'QR' });
    const u = new URL(qr.body.link);
    const id = u.pathname.split('/').at(-1)!;
    const tok = u.searchParams.get('token')!;
    const order = await request(f.app)
      .post(`/api/v1/public/fee-payments/${id}/orders`)
      .set('X-Fee-Pay-Token', tok)
      .set('Idempotency-Key', randomUUID())
      .send({});
    const t = order.body.gatewayOrder.test as { paymentId: string; signature: string };
    const paid = await request(f.app)
      .post(`/api/v1/public/fee-payments/${id}/verify`)
      .set('X-Fee-Pay-Token', tok)
      .send({ gatewayPaymentId: t.paymentId, signature: t.signature });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);

    // The bell of the staff app shows it.
    const bell = await request(f.app).get('/api/v1/console/notifications').set(bearer(phone));
    expect(bell.status, JSON.stringify(bell.body)).toBe(200);
    expect(JSON.stringify(bell.body)).toContain('Term 1 paid online for Ravi Rao');

    // The relay pushes it to the registered phone, with the staff app's unread count.
    const sent: PushMessage[] = [];
    let gone: string[] = [];
    const sender: PushSender = {
      provider: 'log',
      async send(m) {
        sent.push(m);
        return gone.includes(m.token) ? 'GONE' : 'SENT';
      },
    };
    const relay = new PushRelay({ db: f.t.db, push: sender, loggers: capturingLoggers().loggers });
    const drain = async () => {
      sent.length = 0;
      await relay.runOnce(100);
    };
    await drain();
    expect(sent.find((m) => m.token === token)).toMatchObject({
      title: 'Term 1 paid online for Ravi Rao',
      link: '/console/feecollection',
    });
    expect(sent.find((m) => m.token === token)!.badge).toBeGreaterThan(0);
    // The console notice never reaches the member app's phone.
    expect(sent.filter((m) => m.token === memberToken).map((m) => m.title)).not.toContain(
      'Term 1 paid online for Ravi Rao',
    );

    // Signed in on another phone: the first phone's session ended, so it gets no more pushes; the
    // new phone's token Firebase no longer knows is forgotten.
    const other = await appSignIn();
    const otherToken = `fcm-${randomUUID()}-${randomUUID()}`;
    await request(f.app)
      .put('/api/v1/console/push-token')
      .set(bearer(other))
      .send({ token: otherToken, platform: 'ANDROID' });
    gone = [otherToken];
    const phoneAccount = (
      await f.t.db
        .selectFrom('sessions')
        .select('account_id')
        .where('public_id', '=', uuidToBin(other.sessionId))
        .executeTakeFirstOrThrow()
    ).account_id;
    await notify(f.t.db, {
      institutionId: f.school.rowId,
      accountIds: [String(phoneAccount)],
      surface: 'CONSOLE',
      category: 'PAYMENT',
      titleKey: 'NTF.FEE_PAID_ONLINE',
      params: { label: 'Term 2', name: 'Ravi Rao' },
      body: 'Test',
      link: null,
    });
    await drain();
    expect(sent.map((m) => m.token)).toEqual([otherToken]);
    expect(await tokenRow(otherToken)).toBeUndefined();
  });
});

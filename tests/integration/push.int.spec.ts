/**
 * Phone pushes (client 2026-10-19; COM-034, migration 0079) on a real MySQL:
 * - the member app registers its Firebase token for its signed-in session; nothing else can;
 * - with the platform's push channel off nothing is queued; on, a notice for a member with a
 *   registered phone is queued in the notice's transaction and the relay pushes it after the
 *   commit — the title in the app's language, the notice's line, the unread count — and logs it
 *   (CR-16) without the token;
 * - the school's phone alert off for the event: no push;
 * - a token Firebase no longer knows is dropped; a failed push is retried, then given up;
 * - a phone signed in as someone else takes its token along; a signed-out session gets nothing.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PushMessage, PushResult, PushSender } from '../../integrations/push.provider';
import { PushRelay } from '../../services/push-relay.service';
import { adminUrl } from './db';
import { inr, schoolFixture, type Auth, type Payer } from './school';

const token = (n: string) => `fcm-${n}:${'A'.repeat(140)}`;

function fakePush(answer: (m: PushMessage) => PushResult | Promise<PushResult> = () => 'SENT') {
  const sent: PushMessage[] = [];
  const sender: PushSender & { sent: PushMessage[] } = {
    provider: 'fcm',
    sent,
    async send(m) {
      const r = await answer(m);
      if (r === 'SENT') sent.push(m);
      return r;
    },
  };
  return sender;
}

describe.skipIf(!adminUrl)('phone pushes on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let year: { id: string; label: string };
  let today: string;
  let asha: Payer;
  let bala: Payer;

  const register = (auth: Auth, body: object) =>
    request(f.app).put('/api/v1/me/push-token').set(auth).send(body);
  const raise = async (studentId: string, label: string, amount: string) => {
    const r = await request(f.app)
      .post('/api/v1/console/fee-records')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ studentId, yearId: year.id, label, dueDate: today, amount: inr(amount) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const queued = (accountId: string) =>
    f.t.db.selectFrom('push_outbox').selectAll().where('account_id', '=', accountId).execute();
  const channel = (enabled: boolean) =>
    f.t.db
      .updateTable('messaging_channels')
      .set({ enabled: enabled ? 1 : 0 })
      .where('channel', '=', 'PUSH')
      .execute();
  const relay = (push: PushSender | null, now?: () => Date) =>
    new PushRelay({ db: f.t.db, push, loggers: f.h.services.loggers, ...(now ? { now } : {}) });
  const pushLog = (accountId: string) =>
    f.t.db
      .selectFrom('comm_log')
      .select(['kind', 'outcome', 'recipient_masked', 'reason'])
      .where('recipient_account_id', '=', accountId)
      .where('channel', '=', 'PUSH')
      .orderBy('id')
      .execute();

  beforeAll(async () => {
    f = await schoolFixture('Push School');
    con = f.school.con;
    today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const fees = await f.merchant('Fees Office');
    const inst = await request(f.app).get('/api/v1/console/institution').set(con);
    expect(
      (
        await request(f.app)
          .put('/api/v1/console/institution/fee-account')
          .set(con)
          .set('If-Match', `"v${inst.body.version}"`)
          .send({ merchantId: fees.id })
      ).status,
    ).toBe(200);
    const ef = (await request(f.app).get('/api/v1/console/entry-fees').set(con)).body.items as {
      year: { id: string; label: string; current: boolean };
    }[];
    year = ef.find((x) => x.year.current)!.year;
    asha = await f.student('Asha');
    bala = await f.student('Bala');
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('registers the phone for the signed-in member session only (COM-034)', async () => {
    expect((await register(asha.auth, { token: token('asha'), platform: 'ANDROID' })).status).toBe(
      204,
    );
    const row = await f.t.db
      .selectFrom('session_push_tokens')
      .selectAll()
      .where('account_id', '=', asha.accountId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ token: token('asha'), platform: 'ANDROID', lang_code: 'en' });
    // Again with the app in Kannada: the same row, updated.
    expect(
      (await register(asha.auth, { token: token('asha'), platform: 'ANDROID', language: 'kn' }))
        .status,
    ).toBe(204);
    const rows = await f.t.db
      .selectFrom('session_push_tokens')
      .select('lang_code')
      .where('account_id', '=', asha.accountId)
      .execute();
    expect(rows).toEqual([{ lang_code: 'kn' }]);

    expect(
      (await register(asha.auth, { token: 'no spaces allowed', platform: 'ANDROID' })).status,
    ).toBe(422);
    expect((await register(asha.auth, { token: token('x'), platform: 'WINDOWS' })).status).toBe(
      422,
    );
    // A console session is not a member session: refused as the member routes refuse it.
    expect((await register(con, { token: token('console'), platform: 'ANDROID' })).status).toBe(
      401,
    );
    expect(
      (
        await request(f.app)
          .put('/api/v1/me/push-token')
          .send({ token: token('anon') })
      ).status,
    ).toBe(401);
  });

  it('queues nothing while the platform push channel is off', async () => {
    await channel(false);
    await raise(asha.id, 'Books', '300.00');
    expect(await queued(asha.accountId)).toHaveLength(0);
  });

  it('pushes a notice to the phone in the app language, with the unread count, and logs it', async () => {
    await channel(true);
    await f.t.db
      .insertInto('translations')
      .values({
        lang_code: 'kn',
        msg_key: 'NTF.FEE_ASSIGNED',
        text: 'ಶುಲ್ಕ {amount} — {name} ({year})',
        source: 'HUMAN',
      })
      .onDuplicateKeyUpdate({ text: 'ಶುಲ್ಕ {amount} — {name} ({year})' })
      .execute();
    await raise(asha.id, 'Term 1', '800.00');
    const rows = await queued(asha.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_key: 'FEE_ASSIGNED', title_key: 'NTF.FEE_ASSIGNED' });
    expect(await queued(bala.accountId)).toHaveLength(0); // no phone registered

    const push = fakePush();
    expect(await relay(push).runOnce()).toMatchObject({ sent: 1 });
    const unread = (await request(f.app).get('/api/v1/me/notifications').set(asha.auth)).body;
    expect(push.sent).toEqual([
      expect.objectContaining({
        token: token('asha'),
        title: `ಶುಲ್ಕ ₹800.00 — Asha Rao (${year.label})`,
        notificationId: unread.items.find(
          (n: { titleKey: string }) => n.titleKey === 'NTF.FEE_ASSIGNED',
        ).id,
        badge: unread.unread,
      }),
    ]);
    expect(await queued(asha.accountId)).toHaveLength(0);
    expect(await pushLog(asha.accountId)).toEqual([
      expect.objectContaining({
        kind: 'NOTIFICATION',
        outcome: 'SUCCESS',
        recipient_masked: 'Phone',
      }),
    ]);
  });

  it('sends no push for an event whose phone alert the school switched off', async () => {
    const off = await request(f.app)
      .patch('/api/v1/console/notification-events')
      .set(con)
      .send({ changes: [{ event: 'FEE_ASSIGNED', version: 0, alert: false }] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await raise(asha.id, 'Term 2', '400.00');
    expect(await queued(asha.accountId)).toHaveLength(0);
    const on = await request(f.app)
      .patch('/api/v1/console/notification-events')
      .set(con)
      .send({ changes: [{ event: 'FEE_ASSIGNED', version: 1, alert: true }] });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  });

  it('retries a failed push and gives up after five tries; drops a token Firebase no longer knows', async () => {
    await raise(asha.id, 'Term 3', '500.00');
    let clock = Date.now();
    const failing = relay(
      fakePush(() => Promise.reject(new Error('Firebase refused the push (503 UNAVAILABLE)'))),
      () => new Date(clock),
    );
    for (let i = 0; i < 4; i++) {
      expect(await failing.runOnce()).toMatchObject({ retried: 1 });
      clock += 2 * 60 * 60_000;
    }
    expect(await failing.runOnce()).toMatchObject({ failed: 1 });
    expect((await queued(asha.accountId))[0]).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect((await pushLog(asha.accountId)).at(-1)).toMatchObject({
      outcome: 'FAILED',
      reason: 'Firebase refused the push (503 UNAVAILABLE)',
    });

    await raise(asha.id, 'Term 4', '600.00');
    expect(await relay(fakePush(() => 'GONE')).runOnce()).toMatchObject({ skipped: 1 });
    expect(
      await f.t.db
        .selectFrom('session_push_tokens')
        .select('session_id')
        .where('account_id', '=', asha.accountId)
        .execute(),
    ).toHaveLength(0);
    expect((await pushLog(asha.accountId)).at(-1)).toMatchObject({ outcome: 'SKIPPED' });
  });

  it('a phone signed in as someone else takes its token along; signing out stops the pushes', async () => {
    expect(
      (await register(asha.auth, { token: token('shared'), platform: 'ANDROID' })).status,
    ).toBe(204);
    expect(
      (await register(bala.auth, { token: token('shared'), platform: 'ANDROID' })).status,
    ).toBe(204);
    const holders = await f.t.db
      .selectFrom('session_push_tokens')
      .select('account_id')
      .where('token', '=', token('shared'))
      .execute();
    expect(holders.map((h) => String(h.account_id))).toEqual([String(bala.accountId)]);

    await raise(bala.id, 'Term 1', '700.00');
    expect(await queued(bala.accountId)).toHaveLength(1);
    // Bala signs out before the relay runs: the push isn't sent.
    expect(
      (await request(f.app).post('/api/v1/auth/signout').set(bala.auth).send({})).status,
    ).toBeLessThan(300);
    const push = fakePush();
    expect(await relay(push).runOnce()).toMatchObject({ skipped: 1 });
    expect(push.sent).toHaveLength(0);
    // Nor is the next one queued.
    await raise(bala.id, 'Term 2', '700.00');
    expect(await queued(bala.accountId)).toHaveLength(0);
  });
});

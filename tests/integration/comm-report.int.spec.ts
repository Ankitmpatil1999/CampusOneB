/**
 * The communication report and exports on a real MySQL (Phase 8.4; SRS 23.18.1 CR-16
 * RNG-COM-172…186, 18.6; COM-007, COM-008, RPT-005):
 * - every path is logged — announcements, direct messages, in-app notifications, e-mail and SMS
 *   (one-time codes as "One-time code") — and the report shows them with totals over the filtered set;
 * - never a direct message's body or a code, in the report or its export;
 * - an export is exactly the filtered rows, prepared off the request, readable only by its requester;
 * - the purge deletes nothing until switched on, then only rows past retention.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { loggedSender } from '../../services/comm-log.service';
import { notify } from '../../services/notifications.service';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!adminUrl)('communication report on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let ravi: Payer;
  let asha: Payer;
  let meena: Payer;
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth = con) =>
    request(f.app).get(`/api/v1${path}`).set(auth).set('X-RingPe-Surface', 'console');
  const setting = async (key: string, value: number) => {
    const s = (await request(f.app).get('/api/v1/ops/settings').set(f.ops)).body.items.find(
      (x: { key: string }) => x.key === key,
    );
    const r = await request(f.app)
      .put(`/api/v1/ops/settings/${key}`)
      .set(f.ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value, reason: 'Communication report test' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  beforeAll(async () => {
    f = await schoolFixture('Comm Report School');
    con = f.school.con;
    ravi = await f.payer('Ravi', 0);
    meena = await f.payer('Meena', 0);
    asha = await f.student('Asha');
    const classes = (await get('/console/classes')).body.items as {
      name: string;
      sections: { id: string }[];
    }[];
    const section6A = classes.find((c) => c.name === 'Grade 6')!.sections[0]!.id;
    await post('/console/teacher-assignments', con, {
      kind: 'CLASS_TEACHER',
      teacherId: ravi.id,
      sectionIds: [section6A],
    });
    // An announcement to the students, in the app.
    const ann = await post('/console/announcements', con, {
      title: 'Science fair on Friday',
      text: 'Bring your models to the hall by 9 AM.',
      category: 'EVT',
      targets: { groups: ['STUDENTS'] },
      channels: ['IN_APP'],
    });
    expect(ann.status, JSON.stringify(ann.body)).toBe(202);
    for (let i = 0; i < 50; i++) {
      const d = await get(`/console/announcements/${ann.body.announcementId}`);
      if (d.body.dispatch?.status === 'COMPLETED') break;
      await wait(100);
    }
    // A private direct message, between two teachers (chat is not for students, client 2026-10-23).
    const dm = await post('/me/conversations', ravi.auth, {
      recipientProfileId: meena.id,
      text: 'Your marks card is ready to collect.',
    });
    expect(dm.status, JSON.stringify(dm.body)).toBe(201);
    // A notification raised by a business event, and two e-mail/SMS sends (one fails).
    await notify(f.t.db, {
      institutionId: f.school.rowId,
      accountIds: [
        String(
          (
            await f.t.db
              .selectFrom('member_profiles')
              .select('account_id')
              .where('id', '=', asha.rowId)
              .executeTakeFirstOrThrow()
          ).account_id,
        ),
      ],
      surface: 'MEMBER',
      category: 'PAYMENT',
      titleKey: 'NTF.DIRECT_MESSAGE',
      params: { name: 'Fee desk' },
      body: 'Fee receipt',
    });
    const ok = loggedSender({ channel: 'sms', send: async () => undefined }, f.t.db);
    await ok.send({
      to: '9886112345',
      purpose: 'otp.console_2fa',
      text: 'Your code is 482913',
      log: { institutionId: f.school.rowId },
    });
    const bad = loggedSender(
      {
        channel: 'email',
        send: async () => {
          throw new Error('Mailbox unavailable');
        },
      },
      f.t.db,
    );
    await expect(
      bad.send({
        to: 'parent@example.com',
        purpose: 'staff.onboarded',
        text: 'Welcome',
        log: { institutionId: f.school.rowId },
      }),
    ).rejects.toThrow('Mailbox unavailable');
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('reports every path with totals, never a direct message’s body or a code', async () => {
    const r = await get('/console/communication-log');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Two notifications: Ravi told he is class teacher (client 2026-10-22), and the fee desk's.
    expect(r.body.totals.byKind).toMatchObject({
      ANNOUNCEMENT: 1,
      DIRECT_MESSAGE: 1,
      NOTIFICATION: 2,
      OTP: 1,
      TRANSACTIONAL: 1,
    });
    expect(r.body.totals).toMatchObject({ attempts: 6, byOutcome: { SUCCESS: 5, FAILED: 1 } });
    expect(r.body.totals.failedShare).toBe(0.1667);
    expect(r.body.retention).toMatchObject({ purging: false, successDays: 30, failedDays: 90 });
    expect(r.body.completeFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.unrecorded).toBe(0);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('marks card');
    expect(text).not.toContain('482913');
    const byKind = Object.fromEntries(
      r.body.items.map((x: { kind: string }) => [x.kind, x]),
    ) as Record<
      string,
      { subject: string | null; raisedBy: object; recipient: object; reason: string | null }
    >;
    expect(byKind['ANNOUNCEMENT']).toMatchObject({
      subject: 'Science fair on Friday',
      recipient: { name: 'Asha Rao' },
    });
    expect(byKind['DIRECT_MESSAGE']).toMatchObject({
      subject: null,
      raisedBy: { name: expect.stringMatching(/ravi/i) },
      recipient: { name: expect.stringMatching(/meena/i) },
    });
    expect(
      r.body.items.find(
        (x: { kind: string; subject: string | null }) =>
          x.kind === 'NOTIFICATION' && x.subject === 'Message from Fee desk',
      ),
    ).toMatchObject({ raisedBy: { name: null, event: 'notification.payment' } });
    expect(
      r.body.items.some(
        (x: { kind: string; subject: string | null }) =>
          x.kind === 'NOTIFICATION' && x.subject === 'You are now class teacher of Grade 6 A',
      ),
    ).toBe(true);
    expect(byKind['OTP']).toMatchObject({
      subject: 'One-time code',
      recipient: { address: '••••••2345' },
    });
    expect(byKind['TRANSACTIONAL']).toMatchObject({ reason: 'Mailbox unavailable' });

    const dms = await get('/console/communication-log?kind=DIRECT_MESSAGE');
    expect(dms.body.totals).toMatchObject({ attempts: 1, byKind: { DIRECT_MESSAGE: 1 } });
    const failed = await get('/console/communication-log?outcome=FAILED');
    expect(failed.body.items).toHaveLength(1);
    expect(
      (await get('/console/communication-log?from=2026-10-10&to=2026-10-01')).body.errors[0].code,
    ).toBe('COM.REPORT_RANGE');
    // Paged newest first.
    const p1 = await get('/console/communication-log?limit=2');
    expect(p1.body.items).toHaveLength(2);
    const p2 = await get(`/console/communication-log?limit=2&cursor=${p1.body.nextCursor}`);
    expect(Number(p2.body.items[0].id)).toBeLessThan(Number(p1.body.items[1].id));
  });

  it('exports exactly the filtered rows, for the requester only', async () => {
    const x = await post('/console/communication-log/exports', con, {
      filters: { outcome: 'SUCCESS' },
    });
    expect(x.status, JSON.stringify(x.body)).toBe(202);
    let e = await get(`/exports/${x.body.exportId}`);
    for (let i = 0; i < 20 && e.body.status !== 'READY'; i++) {
      await wait(100);
      e = await get(`/exports/${x.body.exportId}`);
    }
    expect(e.body, JSON.stringify(e.body)).toMatchObject({
      status: 'READY',
      rows: 5,
      truncated: false,
    });
    expect(e.body.file.name).toMatch(/^communication-report_last-30-days_today\.csv$/);
    const file = await request(f.app).get(e.body.file.url).buffer(true);
    expect(file.status).toBe(200);
    const csv = file.text ?? String(file.body);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.trim().split('\r\n')).toHaveLength(6);
    expect(csv).toContain('Time,Kind,Channel,Raised by,Recipient,Address,Subject,Outcome,Reason');
    expect(csv).toContain('Private message');
    expect(csv).not.toContain('marks card');
    expect(csv).not.toContain('482913');
    // An operator, or anyone asking with another id, gets 404.
    expect(
      (
        await request(f.app)
          .get(`/api/v1/exports/${x.body.exportId}`)
          .set(f.ops)
          .set('X-RingPe-Surface', 'ops')
      ).status,
    ).toBe(404);
    expect((await get(`/exports/${randomUUID()}`)).body.code).toBe('RPT.EXPORT_NOT_FOUND');
  });

  it('purges nothing until switched on, then only rows past retention', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const oldDay = old.toISOString().slice(0, 10);
    await f.t.db
      .insertInto('comm_log')
      .values({
        logged_on: oldDay,
        at: old,
        institution_id: f.school.rowId,
        kind: 'NOTIFICATION',
        channel: 'IN_APP',
        outcome: 'SUCCESS',
        subject: 'Old notice',
      })
      .execute();
    const count = async () =>
      Number(
        (
          await f.t.db
            .selectFrom('comm_log')
            .select(sql<number>`COUNT(*)`.as('n'))
            .where('institution_id', '=', f.school.rowId)
            .executeTakeFirst()
        )?.n,
      );
    // A finished day's totals are counted once and kept (0064); filters apply; the purge removes them.
    const range = `/console/communication-log?from=${oldDay}&to=${oldDay}`;
    expect((await get(range)).body.totals).toMatchObject({
      attempts: 1,
      byKind: { NOTIFICATION: 1 },
    });
    expect((await get(range)).body.totals.attempts).toBe(1);
    expect((await get(`${range}&channel=SMS`)).body.totals.attempts).toBe(0);
    const kept = await f.t.db
      .selectFrom('comm_log_daily')
      .select(['n'])
      .where('institution_id', '=', f.school.rowId)
      .where('day', '=', oldDay)
      .execute();
    expect(kept.map((k) => Number(k.n))).toEqual([1]);
    const before = await count();
    const run = () =>
      request(f.app)
        .post('/api/v1/ops/jobs/comm-log-purge/runs')
        .set(f.ops)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Integration test of the purge' });
    expect([200, 201, 202]).toContain((await run()).status);
    expect(await count()).toBe(before);
    await setting('com.log.purge.enabled', 1);
    expect([200, 201, 202]).toContain((await run()).status);
    expect(await count()).toBe(before - 1);
    expect((await get(range)).body.totals.attempts).toBe(0);
    const r = await get('/console/communication-log');
    expect(r.body.retention.purging).toBe(true);
    await setting('com.log.purge.enabled', 0);
  });
});

/**
 * Notification e-mails, settings per event and fee notices (client 2026-10-16; COM-032/033, job
 * fee-reminders, migration 0078) on a real MySQL:
 * - a new parent's e-mail is required (and a parent's e-mail can't be cleared);
 * - a fee added for a child whose parent has no app still e-mails the parent (as the earlier
 *   application): the relay sends it from the school (sender name) and logs it (CR-16);
 * - a student with the app gets the in-app notice with the phone alert;
 * - every event is on by default; switching an event's e-mail off queues nothing, and its phone alert
 *   off leaves the notice out of the alert count; stale or unknown changes are refused;
 * - a failed send is retried and given up after com.email.maxAttempts, masked and logged FAILED;
 * - the fee reminder job reminds an instalment due today once a day.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { EmailRelay } from '../../services/email-relay.service';
import { binToUuid, uuidToBin } from '../../utils/idGenerator';
import type { Principal } from '../../utils/principal';
import { adminUrl } from './db';
import { inr, mobile, schoolFixture, type Auth, type Payer } from './school';

describe.skipIf(!adminUrl)('notification e-mails and settings on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let year: { id: string; label: string };
  let today: string;
  let guardianMobile = '';
  let childId = '';
  let parentProfile = '';
  let asha: Payer;
  let ashaPrincipal: Principal;
  const parentEmail = () => `guardian.${guardianMobile}@example.in`;

  const post = (path: string, body: object) =>
    request(f.app).post(path).set(con).set('Idempotency-Key', randomUUID()).send(body);
  const raise = async (studentId: string, label: string, amount: string) => {
    const r = await post('/api/v1/console/fee-records', {
      studentId,
      yearId: year.id,
      label,
      dueDate: today,
      amount: inr(amount),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  /** E-mails waiting for the parent (no app: no account). */
  const outbox = (event?: string) => {
    let q = f.t.db.selectFrom('email_outbox').selectAll().where('profile_id', '=', parentProfile);
    if (event) q = q.where('event_key', '=', event);
    return q.execute();
  };
  const events = async () =>
    (await request(f.app).get('/api/v1/console/notification-events').set(con)).body;
  const ashaNotices = () => f.h.services.notifications.list(ashaPrincipal, 'MEMBER', {});

  beforeAll(async () => {
    f = await schoolFixture('Notices School');
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
    guardianMobile = mobile();
    childId = await f.ward('Kiran', guardianMobile);
    const child = await f.profileRow(childId);
    parentProfile = String(
      (
        await f.t.db
          .selectFrom('guardianships')
          .select('guardian_profile_id')
          .where('ward_profile_id', '=', String(child.id))
          .executeTakeFirstOrThrow()
      ).guardian_profile_id,
    );
    asha = await f.student('Asha');
    const acc = await f.t.db
      .selectFrom('platform_accounts')
      .select('public_id')
      .where('id', '=', asha.accountId)
      .executeTakeFirstOrThrow();
    ashaPrincipal = {
      subject: binToUuid(acc.public_id),
      surface: 'member',
      sessionId: randomUUID(),
    } as Principal;
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('requires a new parent’s e-mail, and keeps a parent’s e-mail from being cleared', async () => {
    const types = (await request(f.app).get('/api/v1/console/user-types').set(con)).body
      .items as { id: string; name: string }[];
    const classes = (await request(f.app).get('/api/v1/console/classes').set(con)).body.items as {
      sections: { id: string }[];
    }[];
    const r = await post('/api/v1/console/members', {
      userTypeId: types.find((x) => x.name === 'Student')!.id,
      firstName: 'Nila',
      lastName: 'Rao',
      gender: 'FEMALE',
      dateOfBirth: '2015-02-01',
      admissionNo: `ADM/N/${Date.now()}`,
      sectionId: classes[0]!.sections[0]!.id,
      guardians: [{ firstName: 'Mohan', lastName: 'Rao', mobile: mobile(), relation: 'FATHER' }],
    });
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'guardians.0.email' })]),
    );

    const parent = await f.t.db
      .selectFrom('member_profiles')
      .select(['public_id', 'row_version'])
      .where('id', '=', parentProfile)
      .executeTakeFirstOrThrow();
    const clear = await request(f.app)
      .patch(`/api/v1/console/members/${binToUuid(parent.public_id)}`)
      .set(con)
      .set('If-Match', `"v${parent.row_version}"`)
      .send({ email: null });
    expect(clear.status).toBe(422);
    expect(clear.body.errors).toEqual([expect.objectContaining({ field: 'email' })]);
  });

  it('a fee for a child e-mails the parent who has no app, from the school (CR-16)', async () => {
    await raise(childId, 'Term 1', '1500.00');
    const queued = await outbox('FEE_ASSIGNED');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      account_id: null,
      to_email: parentEmail(),
      subject: `Fee of ₹1,500.00 assigned to Kiran Rao for ${year.label}`,
    });

    const before = f.h.email.sent.length;
    const out = await f.h.services.emailRelay.runOnce();
    expect(out.sent).toBeGreaterThanOrEqual(1);
    const mail = f.h.email.sent.slice(before).find((m) => m.to === parentEmail());
    expect(mail).toMatchObject({
      purpose: 'notification.fee_assigned',
      subject: `Fee of ₹1,500.00 assigned to Kiran Rao for ${year.label}`,
      fromName: expect.stringMatching(/^Notices School/),
    });
    expect(mail!.text).toContain('Open the RingPe app');
    expect(await outbox()).toHaveLength(0);
    const logged = await f.t.db
      .selectFrom('comm_log')
      .select(['kind', 'channel', 'outcome', 'recipient_masked'])
      .where('recipient_profile_id', '=', parentProfile)
      .where('channel', '=', 'EMAIL')
      .execute();
    expect(logged).toEqual([
      expect.objectContaining({
        kind: 'NOTIFICATION',
        outcome: 'SUCCESS',
        recipient_masked: 'g•••@example.in',
      }),
    ]);
  });

  it('a student with the app gets the notice with the phone alert', async () => {
    await raise(asha.id, 'Term 1', '800.00');
    const list = await ashaNotices();
    expect(list.items.find((n) => n.titleKey === 'NTF.FEE_ASSIGNED')).toMatchObject({
      alert: true,
      read: false,
    });
    expect(list.alertUnread).toBe(list.unread);
  });

  it('every event is on by default; switching one off stops its e-mail and phone alert (COM-032/033)', async () => {
    const view = await events();
    expect(view.emailChannel).toBe(true);
    expect(view.items).toHaveLength(16);
    expect(view.items.every((x: { email: boolean; alert: boolean }) => x.email && x.alert)).toBe(
      true,
    );

    const off = await request(f.app)
      .patch('/api/v1/console/notification-events')
      .set(con)
      .send({ changes: [{ event: 'FEE_ASSIGNED', version: 0, email: false, alert: false }] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.items.find((x: { event: string }) => x.event === 'FEE_ASSIGNED')).toMatchObject(
      { email: false, alert: false, version: 1 },
    );
    const stale = await request(f.app)
      .patch('/api/v1/console/notification-events')
      .set(con)
      .send({ changes: [{ event: 'FEE_ASSIGNED', version: 0, email: true }] });
    expect(stale.status).toBe(412);
    const unknown = await request(f.app)
      .patch('/api/v1/console/notification-events')
      .set(con)
      .send({ changes: [{ event: 'NOPE', version: 0, email: true }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('COM.EVENT_UNKNOWN');

    await raise(childId, 'Term 2', '900.00');
    expect(await outbox('FEE_ASSIGNED')).toHaveLength(0);
    const list = await ashaNotices();
    const fees = list.items.filter((n) => n.titleKey === 'NTF.FEE_ASSIGNED');
    expect(fees.every((n) => n.alert === false)).toBe(true);
    expect(list.alertUnread).toBe(list.unread - fees.length);

    // The school's e-mail channel off: e-mail can't go, whatever the events say.
    const chan = (enabled: boolean) =>
      f.t.db
        .updateTable('notification_channel_settings')
        .set({ enabled })
        .where('institution_id', '=', f.school.rowId)
        .where('channel', '=', 'EMAIL')
        .execute();
    await chan(false);
    expect((await events()).emailChannel).toBe(false);
    await chan(true);
  });

  it('retries a failed send and gives up after the set attempts, masked and logged FAILED', async () => {
    await f.h.services.emailRelay.runOnce(); // what earlier steps queued
    await f.t.db
      .insertInto('email_outbox')
      .values({
        institution_id: f.school.rowId,
        account_id: null,
        profile_id: parentProfile,
        to_email: 'kiran.parent@example.in',
        event_key: 'ATTENDANCE',
        notification_ref: uuidToBin(randomUUID()),
        subject: 'Kiran Rao was marked absent',
        body: 'Absent today',
        next_attempt_at: new Date(),
        created_at: new Date(),
      })
      .execute();
    let clock = Date.now();
    const relay = new EmailRelay({
      db: f.t.db,
      email: { channel: 'email', send: () => Promise.reject(new Error('550 mailbox unavailable')) },
      loggers: f.h.services.loggers,
      now: () => new Date(clock),
    });
    for (let i = 0; i < 4; i++) {
      expect(await relay.runOnce()).toMatchObject({ retried: 1 });
      clock += 2 * 60 * 60_000;
    }
    expect(await relay.runOnce()).toMatchObject({ failed: 1 });
    const [row] = await outbox('ATTENDANCE');
    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 5,
      last_error: '550 mailbox unavailable',
      to_email: 'k•••@example.in',
    });
    const failed = await f.t.db
      .selectFrom('comm_log')
      .select(['outcome', 'reason'])
      .where('recipient_profile_id', '=', parentProfile)
      .where('outcome', '=', 'FAILED')
      .execute();
    expect(failed).toEqual([{ outcome: 'FAILED', reason: '550 mailbox unavailable' }]);
    expect(await relay.runOnce()).toMatchObject({ failed: 0, retried: 0, sent: 0 });
  });

  it('reminds an instalment due today once a day (fee-reminders)', async () => {
    const ashaDue = async () =>
      (await ashaNotices()).items.filter((n) => n.titleKey === 'NTF.FEE_DUE');
    await f.h.services.jobs.runNow('fee-reminders', { reason: 'Fee reminder test run' });
    // Kiran's Term 1 and Term 2 are due today: two e-mails to the parent; Asha's Term 1: a notice.
    expect(await outbox('FEE_DUE')).toHaveLength(2);
    expect(await ashaDue()).toHaveLength(1);
    await f.h.services.jobs.runNow('fee-reminders', { reason: 'Fee reminder second run' });
    expect(await outbox('FEE_DUE')).toHaveLength(2);
    expect(await ashaDue()).toHaveLength(1);
  });
});

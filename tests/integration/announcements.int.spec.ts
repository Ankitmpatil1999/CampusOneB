/**
 * Announcements on a real MySQL (Phase 8.2; SRS 23.2–23.6; COM-001…006, COM-011…013, COM-022…024; BR-70;
 * CR-16; RC-24; OI-COM-03…17):
 * - channels limited to those the platform and the school have on; targets resolved once and kept;
 * - dispatch off the request: in-app notifications, one per account and channel, every attempt logged
 *   without the body; a scheduled one can be edited, a sent one only withdrawn;
 * - each member sees only what was sent to them and acknowledges for themselves; reminders;
 * - a class teacher's announcement reaches the class and its families; the principal's like the console;
 * - a dispatch left sending (a stopped worker) is claimed again and reaches only those not yet reached.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, schoolFixture, type Auth, type Payer } from './school';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!adminUrl)('announcements on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let ravi: Payer;
  let meena: Payer;
  let asha: Payer;
  let bala: Payer;
  let principal: Auth;
  let section6A: string;
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth = con) => request(f.app).get(`/api/v1${path}`).set(auth);
  /** Waits for the dispatch that runs after the request. */
  const sent = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      const d = await get(`/console/announcements/${id}`);
      if (d.body.dispatch?.status === 'COMPLETED' || d.body.dispatch?.status === 'FAILED')
        return d.body;
      await wait(100);
    }
    throw new Error('dispatch did not finish');
  };
  const base = {
    title: 'Half-yearly examination timetable',
    text: 'The half-yearly examinations begin on Monday 12 October.',
    category: 'ACA',
    important: true,
    ackRequired: true,
  };

  beforeAll(async () => {
    f = await schoolFixture('Announcements School');
    con = f.school.con;
    ravi = await f.payer('Ravi', 0);
    meena = await f.payer('Meena', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    const classes = (await get('/console/classes')).body.items as {
      name: string;
      sections: { id: string }[];
    }[];
    section6A = classes.find((c) => c.name === 'Grade 6')!.sections[0]!.id;
    expect(
      (
        await post('/console/teacher-assignments', con, {
          kind: 'CLASS_TEACHER',
          teacherId: ravi.id,
          sectionIds: [section6A],
        })
      ).status,
    ).toBe(201);
    const t = await post('/console/user-types', con, {
      name: 'Principal',
      category: 'PRINCIPAL',
      departments: ['Leadership'],
    });
    expect(t.status).toBe(201);
    const typeId = (await get('/console/user-types')).body.items.find(
      (x: { name: string }) => x.name === 'Principal',
    ).id;
    const mob = mobile();
    const tokens = await f.signUp(mob, 'Lakshmi');
    const pr = await post('/console/members', con, {
      userTypeId: typeId,
      firstName: 'Lakshmi',
      mobile: mob,
    });
    principal = await f.onProfile(tokens, pr.body.id);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('sends to the resolved recipients through the channels on, and logs every attempt without the body', async () => {
    const list = await get('/console/announcements');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.categories.map((c: { code: string }) => c.code)).toContain('SAF');
    expect(list.body.channels).toContain('IN_APP');
    expect(
      (
        await post('/console/announcements', con, {
          ...base,
          targets: { groups: ['STUDENTS'] },
          channels: ['WHATSAPP'],
        })
      ).body,
    ).toMatchObject({ code: 'COM.CHANNEL_DISABLED', params: { channel: 'WHATSAPP' } });
    expect(
      (
        await post('/console/announcements', con, {
          ...base,
          title: 'Hi',
          targets: { groups: ['STUDENTS'] },
          channels: [],
        })
      ).body.errors[0].code,
    ).toBe('COM.TITLE');
    expect(
      (
        await post('/console/announcements', con, {
          ...base,
          targets: { groups: [] },
          channels: [],
        })
      ).body.errors[0].code,
    ).toBe('COM.TARGETS');
    const smsOn = list.body.channels.includes('SMS');
    const created = await post('/console/announcements', con, {
      ...base,
      targets: { groups: ['STUDENTS', 'TEACHERS'] },
      channels: smsOn ? ['IN_APP', 'SMS'] : ['IN_APP'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    // Two students, two teachers and the principal (the teachers' group includes the principal).
    expect(created.body.recipientsEstimated).toBe(5);
    const done = await sent(created.body.announcementId);
    expect(done).toMatchObject({
      important: true,
      code: expect.stringMatching(/^ANN-\d{4}-0001$/),
      dispatch: { status: 'COMPLETED', recipients: 5 },
    });
    expect(done.perChannel.find((c: { channel: string }) => c.channel === 'IN_APP')).toMatchObject({
      success: 5,
    });
    const logged = await f.t.db
      .selectFrom('comm_log')
      .selectAll()
      .where('ref_id', '=', created.body.announcementId)
      .execute();
    expect(logged.every((r) => r.kind === 'ANNOUNCEMENT')).toBe(true);
    expect(JSON.stringify(logged)).not.toContain('half-yearly examinations begin');
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain(
      'Half-yearly examination timetable',
    );
  });

  it('shows each member only what was sent to them; acknowledgement is per member; reminders reach the rest', async () => {
    const forStudents = await post('/console/announcements', con, {
      ...base,
      title: 'Sports day kit',
      targets: { groups: ['STUDENTS'] },
      channels: ['IN_APP'],
    });
    await sent(forStudents.body.announcementId);
    const forTeachers = await post('/console/announcements', con, {
      ...base,
      title: 'Staff meeting',
      important: false,
      ackRequired: false,
      targets: { groups: ['TEACHERS'] },
      channels: ['IN_APP'],
    });
    await sent(forTeachers.body.announcementId);
    const ashas = await get('/me/announcements', asha.auth);
    expect(ashas.body.items.map((a: { title: string }) => a.title)).toEqual([
      'Sports day kit',
      'Half-yearly examination timetable',
    ]);
    expect(ashas.body.unacknowledged).toBe(2);
    expect(
      (await get(`/me/announcements/${forTeachers.body.announcementId}`, asha.auth)).body.code,
    ).toBe('COM.NOT_FOUND');
    const ack = await post(
      `/me/announcements/${forStudents.body.announcementId}/acknowledgement`,
      asha.auth,
    );
    expect(ack.body).toMatchObject({ acknowledged: true });
    expect(
      (
        await post(
          `/me/announcements/${forStudents.body.announcementId}/acknowledgement`,
          asha.auth,
        )
      ).body.acknowledged,
    ).toBe(true);
    expect(
      (await get(`/me/announcements/${forStudents.body.announcementId}`, bala.auth)).body
        .acknowledged,
    ).toBe(false);
    expect(
      (
        await post(
          `/me/announcements/${forTeachers.body.announcementId}/acknowledgement`,
          meena.auth,
        )
      ).body.code,
    ).toBe('COM.ACK_NOT_REQUIRED');
    const acks = await get(
      `/console/announcements/${forStudents.body.announcementId}/acknowledgements?acked=false`,
    );
    expect(acks.body.items).toEqual([
      expect.objectContaining({
        member: expect.objectContaining({ name: 'Bala Rao', class: 'Grade 6', section: 'A' }),
        acknowledgedAt: null,
      }),
    ]);
    const remind = await post(
      `/console/announcements/${forStudents.body.announcementId}/reminders`,
      con,
      { channels: [] },
    );
    expect(remind.status, JSON.stringify(remind.body)).toBe(202);
    expect(remind.body.reminded).toBe(1);
    expect(JSON.stringify((await get('/me/notifications', bala.auth)).body)).toContain(
      'Please acknowledge: Sports day kit',
    );
  });

  it('edits a scheduled announcement, then only withdraws once sent', async () => {
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const s = await post('/console/announcements', con, {
      ...base,
      title: 'Holiday on Friday',
      category: 'HOL',
      ackRequired: false,
      targets: { groups: ['ALL'] },
      channels: ['IN_APP'],
      sendAt: later,
    });
    expect(s.status, JSON.stringify(s.body)).toBe(202);
    const d = await get(`/console/announcements/${s.body.announcementId}`);
    expect(d.body).toMatchObject({ scheduled: true, dispatch: { status: 'QUEUED' } });
    const patch = (id: string, body: object, ver: number) =>
      request(f.app)
        .patch(`/api/v1/console/announcements/${id}`)
        .set(con)
        .set('If-Match', `"v${ver}"`)
        .send(body);
    const edited = await patch(
      s.body.announcementId,
      { title: 'Holiday on Friday 2 October' },
      d.body.version,
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.title).toBe('Holiday on Friday 2 October');
    expect(
      (await get('/me/announcements', asha.auth)).body.items.some((a: { title: string }) =>
        a.title.startsWith('Holiday'),
      ),
    ).toBe(false);
    const first = (await get('/console/announcements')).body.items.find(
      (a: { title: string }) => a.title === 'Half-yearly examination timetable',
    );
    expect(
      (await patch(first.id, { title: 'Changed after sending' }, first.version)).body.code,
    ).toBe('COM.ALREADY_DISPATCHED');
    expect(
      (await patch(first.id, { withdrawn: true, reason: 'No' }, first.version)).body.errors[0].code,
    ).toBe('COM.WITHDRAW_REASON');
    const withdrawn = await patch(
      first.id,
      { withdrawn: true, reason: 'Dates changed; a new notice follows' },
      first.version,
    );
    expect(withdrawn.body.withdrawn).toMatchObject({
      reason: 'Dates changed; a new notice follows',
    });
    expect(
      (await get('/me/announcements', asha.auth)).body.items.some(
        (a: { id: string }) => a.id === first.id,
      ),
    ).toBe(false);
  });

  it('lets a class teacher announce to the class and the principal announce like the console', async () => {
    expect(
      (
        await post('/teacher/class-announcements', meena.auth, {
          classSectionId: section6A,
          title: 'Geometry box',
          text: 'Bring your compass and protractor tomorrow.',
        })
      ).body.code,
    ).toBe('ACA.NOT_ASSIGNED');
    const ca = await post('/teacher/class-announcements', ravi.auth, {
      classSectionId: section6A,
      title: 'Geometry box',
      text: 'Bring your compass and protractor tomorrow.',
      ackRequired: true,
    });
    expect(ca.status, JSON.stringify(ca.body)).toBe(202);
    expect(ca.body.recipientsEstimated).toBe(2);
    await sent(ca.body.announcementId);
    const mine = await get('/teacher/class-announcements', ravi.auth);
    expect(mine.body.items[0]).toMatchObject({
      title: 'Geometry box',
      source: 'TEACHER',
      classSection: 'Grade 6 A',
      acknowledgements: { acknowledged: 0, of: 2 },
    });
    // The teacher sees who hasn't acknowledged and reminds them; another teacher can't.
    const id = ca.body.announcementId as string;
    const acks = await get(
      `/teacher/class-announcements/${id}/acknowledgements?acked=false`,
      ravi.auth,
    );
    expect(acks.status, JSON.stringify(acks.body)).toBe(200);
    expect(acks.body.items).toHaveLength(2);
    expect(
      (await get(`/teacher/class-announcements/${id}/acknowledgements`, meena.auth)).body.code,
    ).toBe('COM.NOT_FOUND');
    expect((await post(`/teacher/class-announcements/${id}/reminders`, meena.auth)).body.code).toBe(
      'COM.NOT_FOUND',
    );
    const reminded = await post(`/teacher/class-announcements/${id}/reminders`, ravi.auth);
    expect(reminded.status, JSON.stringify(reminded.body)).toBe(202);
    expect(reminded.body.reminded).toBe(2);
    expect((await get('/me/announcement-options', ravi.auth)).body).toMatchObject({
      channels: ['IN_APP'],
      groups: ['STUDENTS', 'PARENTS'],
      limits: { titleMin: 3, titleMax: 120, textMin: 10, textMax: 5000 },
    });
    expect((await get('/me/announcement-options', bala.auth)).body.code).toBe('ACA.TEACHERS_ONLY');
    expect((await get('/me/announcements', bala.auth)).body.items[0]).toMatchObject({
      title: 'Geometry box',
      classSection: 'Grade 6 A',
    });
    expect(
      (
        await post('/principal/announcements', meena.auth, {
          ...base,
          targets: { groups: ['ALL'] },
          channels: [],
        })
      ).body.code,
    ).toBe('ACA.PRINCIPAL_ONLY');
    const pa = await post('/principal/announcements', principal, {
      ...base,
      title: 'Welcome back',
      targets: { groups: ['ALL'] },
      channels: [],
    });
    expect(pa.status, JSON.stringify(pa.body)).toBe(202);
    const done = await sent(pa.body.announcementId);
    expect(done).toMatchObject({ source: 'PRINCIPAL', author: expect.any(String) });
    // The principal's list in the app: the school's announcements with their counts.
    const list = await get('/principal/announcements', principal);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((a: { title: string }) => a.title)).toEqual(
      expect.arrayContaining(['Welcome back', 'Geometry box']),
    );
    expect((await get('/principal/announcements', meena.auth)).body.code).toBe(
      'ACA.PRINCIPAL_ONLY',
    );
    // The principal sees who is waiting on one of the school's announcements and reminds them.
    const geo = list.body.items.find((x: { title: string }) => x.title === 'Geometry box');
    const waiting = await get(
      `/principal/announcements/${geo.id}/acknowledgements?acked=false`,
      principal,
    );
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
    expect(waiting.body.items.length).toBeGreaterThan(0);
    expect(
      (await get(`/principal/announcements/${geo.id}/acknowledgements`, meena.auth)).body.code,
    ).toBe('ACA.PRINCIPAL_ONLY');
    const nudged = await post(`/principal/announcements/${geo.id}/reminders`, principal, {
      channels: [],
    });
    expect(nudged.status, JSON.stringify(nudged.body)).toBe(202);
    expect(nudged.body.reminded).toBe(waiting.body.items.length);
    expect((await get('/me/announcement-options', principal)).body.groups).toEqual([
      'ALL',
      'STUDENTS',
      'PARENTS',
      'TEACHERS',
      'STAFF',
    ]);
  });

  it('claims a dispatch left sending again and reaches only those not yet reached', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    const s = await post('/console/announcements', con, {
      ...base,
      title: 'Annual day costume',
      ackRequired: false,
      targets: { groups: ['STUDENTS'] },
      channels: ['IN_APP'],
      sendAt: tomorrow,
    });
    expect(s.status, JSON.stringify(s.body)).toBe(202);
    const id = s.body.announcementId as string;
    const row = await f.t.db
      .selectFrom('announcements')
      .select('id')
      .where('public_id', '=', sql<Buffer>`UUID_TO_BIN(${id})`)
      .executeTakeFirstOrThrow();
    // A worker stopped mid-way: Asha was reached, Bala not; nothing has touched it for 11 minutes.
    await f.t.db
      .insertInto('announcement_recipients')
      .values({
        announcement_id: row.id,
        profile_id: asha.rowId,
        institution_id: f.school.rowId,
        delivered_at: new Date(Date.now() - 12 * 60_000),
      })
      .execute();
    await f.t.db
      .updateTable('announcements')
      .set({
        status: 'PROCESSING',
        send_at: new Date(Date.now() - 3600_000),
        updated_at: new Date(Date.now() - 11 * 60_000),
      })
      .where('id', '=', row.id)
      .execute();
    const run = await request(f.app)
      .post('/api/v1/ops/jobs/announcement-dispatch/runs')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Integration test of a stalled dispatch' });
    expect([200, 201, 202], JSON.stringify(run.body)).toContain(run.status);
    const done = await sent(id);
    expect(done.dispatch).toMatchObject({ status: 'COMPLETED', recipients: 2 });
    const logged = await f.t.db
      .selectFrom('comm_log')
      .select('recipient_profile_id')
      .where('ref_id', '=', id)
      .execute();
    expect(logged.map((r) => String(r.recipient_profile_id))).toEqual([bala.rowId]);
    expect(JSON.stringify((await get('/me/notifications', bala.auth)).body)).toContain(
      'Annual day costume',
    );
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).not.toContain(
      'Annual day costume',
    );
  });
});

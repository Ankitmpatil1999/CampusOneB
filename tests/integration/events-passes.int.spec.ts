/**
 * Paid events and entry passes on a real MySQL (Phase 4.5; SRS 13.7–13.10, 13.16, 9.7–9.9; FEE-028…033,
 * PAY-002 with eventId, PAY-003…006, PAY-026…028, job event-status):
 * - an event is created with server-checked dates and heads, paid once per member through the engine
 *   (RPEE, P2) only while Active and within its period and audience, reported with a CSV export, and
 *   closed by the 23:50 job after its end date; heads can't change after a payment;
 * - a pass is issued to a student with a registered phone for a coming day, authorised on that phone
 *   on its day, scanned by staff within the window and the scans (each scan recorded), cancelled, and
 *   expired by the job.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Auth } from './school';
import { istBusinessDate } from '../../utils/format';

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!adminUrl)('events and entry passes on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  const today = istBusinessDate(new Date());
  const ctx = (periodKey = today) => ({ periodKey, item: () => undefined });

  const post = (path: string, body: object, auth: Auth = con) =>
    request(f.app).post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const event = (body: object = {}) =>
    post('/api/v1/console/events', {
      title: 'Science Fair',
      description: 'Stalls and projects',
      startDate: today,
      endDate: addDays(today, 2),
      heads: [
        { name: 'Entry', amount: inr('100.00') },
        { name: 'Food', amount: inr('50.00') },
      ],
      ...body,
    });
  const payEvent = (who: { auth: Auth }, eventId: string) =>
    post('/api/v1/me/payments', { eventId, pin: PIN }, who.auth);
  const patch = (id: string, version: number, body: object) =>
    request(f.app)
      .patch(`/api/v1/console/events/${id}`)
      .set(con)
      .set('If-Match', `"v${version}"`)
      .send(body);

  beforeAll(async () => {
    f = await schoolFixture('Event School');
    con = f.school.con;
    // The fee account receives event payments (FR-INS-06).
    const fees = await f.merchant('Fees Office');
    const inst = await request(f.app).get('/api/v1/console/institution').set(con);
    const set = await request(f.app)
      .put('/api/v1/console/institution/fee-account')
      .set(con)
      .set('If-Match', `"v${inst.body.version}"`)
      .send({ merchantId: fees.id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    await f.feature('events', true);
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('creates an event with checked dates and heads, and pays it once (FEE-028…033, PAY-002)', async () => {
    expect((await event({ startDate: addDays(today, -1) })).body.errors[0]).toMatchObject({
      field: 'startDate',
      code: 'FEE.EVENT_OPENS_PAST',
    });
    // Neither date may be in the past, and the event closes on or after it opens (client 2026-10-15).
    expect(
      (await event({ endDate: addDays(today, -1), startDate: today })).body.errors[0],
    ).toMatchObject({ field: 'endDate', code: 'FEE.EVENT_CLOSES_PAST' });
    expect(
      (await event({ startDate: addDays(today, 5), endDate: addDays(today, 2) })).body.errors[0]
        .code,
    ).toBe('FEE.EVENT_DATES_INVALID');
    const e = await event();
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect(e.body).toMatchObject({ total: inr('150.00'), status: 'ACTIVE', audience: null });

    const s = await f.student('Asha', 50_000);
    const mine = await request(f.app).get('/api/v1/me/events').set(s.auth);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ id: e.body.id, open: true, paid: false, total: inr('150.00') }),
    ]);

    const paid = await payEvent(s, e.body.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.receipt.reference).toMatch(/^RPEE/);
    expect(await f.balance(s.wallet)).toBe(35_000);
    const again = await payEvent(s, e.body.id);
    expect(again.body).toMatchObject({ code: 'FEE.EVENT_ALREADY_PAID', check: 'P2' });
    const detail = await request(f.app).get(`/api/v1/me/events/${e.body.id}`).set(s.auth);
    expect(detail.body).toMatchObject({ paid: true, receipt: paid.body.receipt.reference });

    // Heads can't change after a payment; the title can.
    expect(
      (await patch(e.body.id, e.body.version, { heads: [{ name: 'Entry', amount: inr('10.00') }] }))
        .body.code,
    ).toBe('FEE.EVENT_HAS_PAYMENTS');
    const renamed = await patch(e.body.id, e.body.version, { title: 'Science Fair 2026' });
    expect(renamed.body).toMatchObject({
      title: 'Science Fair 2026',
      payments: { count: 1, collected: inr('150.00') },
    });

    const report = await request(f.app).get(`/api/v1/console/events/${e.body.id}/report`).set(con);
    // The second attempt was refused at P2, before any record: no failure is listed (RNG-PAY-123).
    expect(report.body.totals).toEqual({ paid: 1, failed: 0, collected: inr('150.00') });
    expect(report.body.items.find((x: { status: string }) => x.status === 'SUCCESS')).toMatchObject(
      {
        payer: 'Asha Rao',
        grade: 'Grade 6 A',
      },
    );
    const csv = await request(f.app)
      .get(`/api/v1/console/events/${e.body.id}/report?format=csv`)
      .set(con);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Asha Rao');
    expect(csv.text).toContain('150.00');
  });

  it('pays only an Active event within its period and audience; the job closes ended events', async () => {
    const s = await f.student('Ravi', 50_000);
    const later = (
      await event({ title: 'Annual Day', startDate: addDays(today, 3), endDate: addDays(today, 3) })
    ).body;
    expect((await payEvent(s, later.id)).body).toMatchObject({
      code: 'FEE.EVENT_CLOSED',
      check: 'P2',
    });

    const cls = await request(f.app)
      .post('/api/v1/console/classes')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Grade 9', sections: [{ name: 'A' }] });
    const other = (await event({ title: 'Grade 9 Trip', audienceClassIds: [cls.body.id] })).body;
    expect((await payEvent(s, other.id)).body.code).toBe('FEE.EVENT_NOT_FOR_YOU');
    const list = await request(f.app).get('/api/v1/me/events').set(s.auth);
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(other.id);

    const fair = (await event({ title: 'Book Fair' })).body;
    const off = await patch(fair.id, fair.version, { status: 'INACTIVE' });
    expect(off.body.status).toBe('INACTIVE');
    expect((await payEvent(s, fair.id)).body.code).toBe('FEE.EVENT_CLOSED');

    // Two payments of one event at once: one is taken.
    const race = (await event({ title: 'Sports Day' })).body;
    const both = await Promise.all([payEvent(s, race.id), payEvent(s, race.id)]);
    expect(both.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await f.balance(s.wallet)).toBe(35_000);

    // The day after its end date the job deactivates it.
    await f.t.db
      .updateTable('events')
      .set({ start_date: addDays(today, -3), end_date: addDays(today, -1) })
      .where('title', '=', 'Sports Day')
      .execute();
    const run = await f.h.services.events.deactivateEnded(ctx());
    expect(run.deactivated).toBeGreaterThanOrEqual(1);
    const listed = await request(f.app).get('/api/v1/console/events?status=INACTIVE').set(con);
    expect(listed.body.items.map((x: { title: string }) => x.title)).toContain('Sports Day');
    // An ended event can't be switched on again (OI-FEE-14).
    const ended = listed.body.items.find((x: { title: string }) => x.title === 'Sports Day');
    expect((await patch(ended.id, ended.version, { status: 'ACTIVE' })).body.code).toBe(
      'FEE.EVENT_ENDED',
    );
    // With the Events feature off, nothing new is registered.
    await f.feature('events', false);
    expect((await event({ title: 'Science Fair' })).body.code).toBe('FEE.EVENTS_OFF');
    await f.feature('events', true);
  });

  it('issues, authorises on the phone, scans and cancels entry passes (PAY-003…006, PAY-026…028)', async () => {
    const holder = await f.student('Kavya');
    const teacher = await f.payer('Mohan', 0);
    const issue = (body: object) =>
      post('/api/v1/console/passes', {
        type: 'FEST-ENTRY',
        purpose: 'Annual fest',
        description: 'Main gate entry',
        validOn: addDays(today, 1),
        maxScans: 2,
        ...body,
      });
    expect((await issue({ holderIds: [holder.id], validOn: today })).body.errors[0].code).toBe(
      'PAY.PASS_DATE_NOT_FUTURE',
    );
    expect((await issue({ holderIds: [holder.id], type: 'VIP' })).status).toBe(422);
    const r = await issue({ holderIds: [holder.id, teacher.id] });
    expect(r.status).toBe(201);
    expect(r.body.issued).toHaveLength(1);
    expect(r.body.refused).toEqual([{ holderId: teacher.id, code: 'PAY.PASS_HOLDER_TYPE' }]);
    expect((await issue({ holderIds: [holder.id] })).body.refused[0].code).toBe(
      'PAY.PASS_DUPLICATE',
    );
    const passId = r.body.issued[0].passId as string;

    const authorise = () => post(`/api/v1/me/passes/${passId}/authorisations`, {}, holder.auth);
    expect((await authorise()).body.code).toBe('PAY.PASS_NOT_TODAY');
    const mine = await request(f.app).get('/api/v1/me/passes').set(holder.auth);
    expect(mine.body.items[0]).toMatchObject({
      id: passId,
      visibility: 'VALID_IN_FUTURE',
      status: 'ACTIVE',
    });

    // Its day arrives.
    await f.t.db
      .updateTable('entry_passes')
      .set({ valid_on: today })
      .where('valid_on', '=', addDays(today, 1))
      .execute();
    const auth = await authorise();
    expect(auth.status).toBe(201);
    expect(auth.body).toMatchObject({
      minutes: 5,
      qrToken: expect.stringMatching(/^campusone:\/\/pass\/[A-Z2-7]{26}$/),
    });

    const scan = (who: { auth: Auth }, token: string) =>
      post('/api/v1/passes/scans', { qrToken: token }, who.auth);
    expect((await scan(holder, auth.body.qrToken)).body.code).toBe('PAY.PASS_CHECKER');
    const first = await scan(teacher, auth.body.qrToken);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      result: 'ACCEPTED',
      holder: { maskedName: 'Kavya R.', classSection: 'Grade 6 A' },
      pass: { usedScans: 1, maxScans: 2 },
    });
    // The window closes: a scan needs a new authorisation.
    await f.t.db
      .updateTable('entry_passes')
      .set({ authorised_until: new Date(Date.now() - 1000) })
      .execute();
    expect((await scan(teacher, auth.body.qrToken)).body.code).toBe('PAY.PASS_NOT_AUTHORISED');
    const again = await authorise();
    const last = await scan(teacher, again.body.qrToken);
    expect(last.body.result).toBe('ACCEPTED_LAST');
    expect((await authorise()).body.code).toBe('PAY.PASS_USED');
    const detail = await request(f.app).get(`/api/v1/me/passes/${passId}`).set(holder.auth);
    expect(detail.body).toMatchObject({ status: 'USED', visibility: 'USED', usedScans: 2 });
    expect(detail.body.scans.map((x: { checker: string }) => x.checker)).toEqual([
      'Mohan',
      'Mohan',
    ]);

    // Console: the list and counts; a used pass can't be cancelled, a live one can.
    const holder2 = await f.student('Divya');
    const p2 = (await issue({ holderIds: [holder2.id] })).body.issued[0].passId as string;
    const cancel = (id: string) =>
      request(f.app)
        .post(`/api/v1/console/passes/${id}/cancellation`)
        .set(con)
        .send({ reason: 'Fest postponed' });
    expect((await cancel(passId)).body.code).toBe('PAY.PASS_USED');
    const cancelled = await cancel(p2);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Fest postponed' });
    const list = await request(f.app).get('/api/v1/console/passes').set(con);
    expect(list.body.counts).toMatchObject({ used: 1, cancelled: 1 });
    expect(list.body.types.map((t: { code: string }) => t.code)).toEqual([
      'FEST-ENTRY',
      'COLLEGE-ENTRY',
    ]);

    // A pass whose day has passed expires with the job.
    const holder3 = await f.student('Gita');
    const p3 = (await issue({ holderIds: [holder3.id] })).body.issued[0].passId as string;
    await f.t.db
      .updateTable('entry_passes')
      .set({ valid_on: addDays(today, -1) })
      .where('holder_profile_id', '=', holder3.rowId)
      .execute();
    expect((await f.h.services.passes.expire(ctx())).expired).toBeGreaterThanOrEqual(1);
    const gone = await request(f.app).get(`/api/v1/me/passes/${p3}`).set(holder3.auth);
    expect(gone.body.status).toBe('EXPIRED');
  });

  it("refuses another school's events and passes (tenant isolation)", async () => {
    const e = (await event({ title: 'Isolation Fair' })).body;
    const other = await schoolFixture('Other Event School');
    try {
      const r = await request(other.app)
        .patch(`/api/v1/console/events/${e.id}`)
        .set(other.school.con)
        .set('If-Match', '"v1"')
        .send({ status: 'INACTIVE' });
      expect(r.status).toBe(404);
      const s = await other.student('Nisha', 50_000);
      expect(
        (
          await request(other.app)
            .post('/api/v1/me/payments')
            .set(s.auth)
            .set('Idempotency-Key', randomUUID())
            .send({ eventId: e.id, pin: PIN })
        ).status,
      ).toBe(404);
    } finally {
      await other.t.drop();
    }
  }, 180_000);
});

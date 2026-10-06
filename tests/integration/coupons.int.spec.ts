/**
 * Meal coupons and coupon types on a real MySQL (Phase 4.4; SRS 11, CR-15, ATT 21.20.1; CPN-001…014,
 * job coupon-expiry):
 * - the four meal slots and types appear the first time; slots and types are maintained (names
 *   unique, a used slot kept, value-bearing types off, If-Match);
 * - issuing makes one coupon per student, type and day, skips duplicates, refuses a student over a
 *   holding maximum and the whole request over the per-student cap;
 * - the holder redeems their own coupon by QR, today, in the window, at a merchant the type accepts,
 *   once; a coupon counter tap lists the eligible types and redeems within the choice window, once;
 * - future coupons are cancelled, past ones expire (the job), reports add up; another school sees none.
 *
 * Redemption happens on a coupon's own date: the tests issue for tomorrow, then move the coupons to
 * today in the database (the day arriving), since issuing for today is refused (RNG-CPN-009).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, schoolFixture, type Auth, type Merchant } from './school';
import { istBusinessDate } from '../../utils/format';

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!adminUrl)('coupons on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  const today = istBusinessDate(new Date());
  const tomorrow = addDays(today, 1);
  const istHour = new Date(Date.now() + 330 * 60_000).getUTCHours();
  /** A window that doesn't include now. */
  const closed = istHour < 12 ? { start: '22:00', end: '23:00' } : { start: '01:00', end: '02:00' };

  const post = (path: string, body: object) =>
    request(f.app).post(path).set(con).set('Idempotency-Key', randomUUID()).send(body);
  const type = (body: object) =>
    post('/api/v1/console/coupon-types', { holdMax: 5, redeemMax: 1, kind: 'OTHER', ...body });
  const issue = (body: object) => post('/api/v1/console/coupon-issuances', body);
  const couponQr = async (m: Merchant) => {
    const r = await request(f.app)
      .post(`/api/v1/console/merchants/${m.id}/qr-codes`)
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'COUPON' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.payload as string;
  };
  /** The day arrives: the student's coupons of tomorrow become today's. */
  const arrive = (profileRowId: string) =>
    f.t.db
      .updateTable('coupons')
      .set({ valid_on: today })
      .where('profile_id', '=', profileRowId)
      .where('valid_on', '=', tomorrow)
      .execute();
  const redeem = (who: { auth: Auth }, payload: string, couponTypeId: string) =>
    request(f.app)
      .post('/api/v1/me/coupons/redemptions')
      .set(who.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ merchantQrPayload: payload, couponTypeId });

  beforeAll(async () => {
    f = await schoolFixture('Coupon School');
    con = f.school.con;
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('creates the four meal slots and types, and maintains slots and types (CPN-003…007)', async () => {
    const slots = await request(f.app).get('/api/v1/console/coupon-slots').set(con);
    expect(
      slots.body.items.map(
        (s: { name: string; start: string; end: string }) => `${s.name} ${s.start}-${s.end}`,
      ),
    ).toEqual([
      'Breakfast 07:00-11:00',
      'Lunch 12:00-15:00',
      'Snacks 15:00-18:00',
      'Dinner 19:00-22:00',
    ]);
    const types = await request(f.app).get('/api/v1/console/coupon-types').set(con);
    expect(types.body.items.map((t: { name: string }) => t.name).sort()).toEqual([
      'Breakfast',
      'Dinner',
      'Lunch',
      'Snacks',
    ]);
    expect(types.body.items[0]).toMatchObject({
      kind: 'MEAL',
      acceptsAll: true,
      holdMax: 31,
      redeemMax: 1,
      period: 'DAY',
    });

    // Slots: a bad window, a used slot that can't go, a renamed slot and a new one.
    const items = (
      slots.body.items as { id: string; name: string; start: string; end: string }[]
    ).map(({ id, name, start, end }) => ({ id, name, start, end }));
    const put = (list: object[]) =>
      request(f.app).put('/api/v1/console/coupon-slots').set(con).send({ slots: list });
    expect(
      (await put([{ name: 'Brunch', start: '11:00', end: '10:00' }])).body.errors[0].code,
    ).toBe('CPN.WINDOW_INVALID');
    expect((await put(items.slice(1))).body).toMatchObject({
      code: 'CPN.SLOT_IN_USE',
      params: { slot: 'Breakfast' },
    });
    const changed = await put([
      ...items.map((s) => (s.name === 'Snacks' ? { ...s, start: '16:00' } : s)),
      { name: 'Milk break', start: '10:30', end: '11:15' },
    ]);
    expect(changed.status).toBe(200);
    expect(changed.body.items.find((s: { name: string }) => s.name === 'Snacks').start).toBe(
      '16:00',
    );
    expect(changed.body.items).toHaveLength(5);

    // Types: unique names, value-bearing off, If-Match.
    const canteen = await f.merchant('Mess Canteen');
    const created = await type({
      name: 'Milk & fruit',
      kind: 'NUTRITION',
      window: { start: '10:30', end: '11:15' },
      merchantIds: [canteen.id],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      acceptsAll: false,
      merchants: [{ name: 'Mess Canteen' }],
      status: 'ACTIVE',
    });
    expect(
      (await type({ name: 'Milk & fruit', window: { start: '10:30', end: '11:15' } })).body.code,
    ).toBe('CPN.TYPE_NAME_TAKEN');
    expect(
      (
        await type({
          name: 'Fest stall',
          window: { start: '09:00', end: '20:00' },
          value: inr('100.00'),
        })
      ).body.code,
    ).toBe('CPN.VALUE_TYPES_OFF');
    const patch = (version: number, body: object) =>
      request(f.app)
        .patch(`/api/v1/console/coupon-types/${created.body.id}`)
        .set(con)
        .set('If-Match', `"v${version}"`)
        .send(body);
    expect((await patch(created.body.version + 1, { redeemMax: 2 })).status).toBe(412);
    const off = await patch(created.body.version, { active: false, redeemMax: 2 });
    expect(off.body).toMatchObject({ status: 'INACTIVE', redeemMax: 2 });
  });

  it('issues one coupon per student, type and day; skips duplicates; refuses over the maxima (CPN-008/009)', async () => {
    const [a, b] = [await f.student('Asha'), await f.student('Ravi')];
    const teacher = await f.payer('Meena', 0);
    const allDay = (
      await type({ name: 'All-day snack', window: { start: '00:00', end: '23:59' }, holdMax: 3 })
    ).body;
    const body = {
      typeIds: [allDay.id],
      from: tomorrow,
      to: addDays(tomorrow, 2),
      excludedDates: [addDays(tomorrow, 1)],
      studentIds: [a.id, b.id, teacher.id],
    };

    await f.feature('coupons', false);
    expect((await issue(body)).body.code).toBe('CPN.FEATURE_OFF');
    await f.feature('coupons', true);
    expect((await issue({ ...body, from: today })).body.errors[0].code).toBe(
      'CPN.DATES_NOT_FUTURE',
    );
    expect(
      (await issue({ ...body, to: tomorrow, excludedDates: [tomorrow] })).body.errors[0].code,
    ).toBe('CPN.NO_DAYS');

    const first = await issue(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: 4, skipped: 0 });
    expect(
      first.body.perStudent.find((x: { studentId: string }) => x.studentId === teacher.id).refused,
    ).toBe('CPN.NO_STUDENTS');
    const again = await issue(body);
    expect(again.body).toMatchObject({ created: 0, skipped: 4 });

    // Holding at most 3: two held, two more days → refused for that student, nothing written.
    const more = await issue({
      typeIds: [allDay.id],
      from: addDays(tomorrow, 3),
      to: addDays(tomorrow, 4),
      studentIds: [a.id],
    });
    expect(more.body.perStudent[0]).toMatchObject({ created: 0, refused: 'CPN.HOLD_MAX' });

    // More than 124 new coupons for one student refuses the whole request.
    const big = (
      await type({ name: 'Big', window: { start: '00:00', end: '23:59' }, holdMax: 500 })
    ).body;
    const meals = (await request(f.app).get('/api/v1/console/coupon-types').set(con)).body.items
      .filter((t: { kind: string }) => t.kind === 'MEAL')
      .map((t: { id: string }) => t.id);
    const cap = await issue({
      typeIds: [...meals, big.id],
      from: addDays(tomorrow, 10),
      to: addDays(tomorrow, 34),
      studentIds: [b.id],
    });
    expect(cap.status).toBe(422);
    expect(cap.body.code).toBe('CPN.ISSUE_LIMIT');

    const log = await request(f.app).get('/api/v1/console/coupon-issuances').set(con);
    expect(log.body.items.length).toBeGreaterThanOrEqual(3);
    expect(log.body.items.at(-1)).toMatchObject({
      created: 4,
      refused: 1,
      types: [{ name: 'All-day snack' }],
    });
    const list = await request(f.app)
      .get(`/api/v1/console/coupons?studentId=${a.id}&state=ACTIVE`)
      .set(con);
    expect(list.body.items).toHaveLength(2);
  });

  it('redeems the holder’s own coupon by QR: today, in the window, at an accepting merchant, once (CPN-001/002)', async () => {
    await f.feature('coupons', true);
    const s = await f.student('Kavya');
    const canteen = await f.merchant('QR Canteen');
    const books = await f.merchant('QR Books');
    const qr = await couponQr(canteen);
    const allDay = (await type({ name: 'Any time', window: { start: '00:00', end: '23:59' } }))
      .body;
    const later = (await type({ name: 'Late snack', window: closed })).body;
    const booksOnly = (
      await type({
        name: 'Book voucher',
        window: { start: '00:00', end: '23:59' },
        merchantIds: [books.id],
      })
    ).body;
    await issue({
      typeIds: [allDay.id, later.id, booksOnly.id],
      from: tomorrow,
      to: tomorrow,
      studentIds: [s.id],
    });

    // Not yet its day.
    expect((await redeem(s, qr, allDay.id)).body.code).toBe('CPN.NONE_ACTIVE');
    await arrive(s.rowId);

    const mine = await request(f.app).get('/api/v1/me/coupons').set(s.auth);
    expect(mine.status).toBe(200);
    expect(
      mine.body.today
        .map((c: { type: { name: string }; usableNow: boolean }) => `${c.type.name}:${c.usableNow}`)
        .sort(),
    ).toEqual(['Any time:true', 'Book voucher:true', 'Late snack:false']);

    expect((await redeem(s, qr, later.id)).body).toMatchObject({
      code: 'CPN.OUTSIDE_WINDOW',
      params: { type: 'Late snack', start: closed.start, end: closed.end },
    });
    expect((await redeem(s, qr, booksOnly.id)).body).toMatchObject({
      code: 'CPN.TYPE_NOT_ACCEPTED',
      params: { merchant: 'QR Canteen', type: 'Book voucher' },
    });
    const ok = await redeem(s, qr, allDay.id);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      coupon: { type: 'Any time' },
      merchant: { name: 'QR Canteen' },
      holder: { name: 'Kavya Rao' },
    });
    expect((await redeem(s, qr, allDay.id)).body.code).toBe('CPN.NONE_ACTIVE');

    const after = await request(f.app).get('/api/v1/me/coupons').set(s.auth);
    expect(after.body.history[0]).toMatchObject({ state: 'USED', merchant: 'QR Canteen' });
    // A payment QR is not a coupon QR.
    expect((await redeem(s, canteen.qr.payload, booksOnly.id)).body.code).toBe('PAY.QR_UNKNOWN');
  });

  it('a coupon counter tap lists the eligible types and redeems once, before it lapses (CPN-013/014)', async () => {
    await f.feature('coupons', true);
    const s = await f.student('Divya');
    const mess = await f.merchant('Hostel Mess');
    const counter = await f.terminal('COUPON', { merchantId: mess.id });
    const token = await f.card(s.rowId);
    const allDay = (await type({ name: 'Mess meal', window: { start: '00:00', end: '23:59' } }))
      .body;
    await issue({ typeIds: [allDay.id], from: tomorrow, to: tomorrow, studentIds: [s.id] });
    await arrive(s.rowId);

    const tapId = randomUUID();
    const tap = await request(f.app)
      .post('/api/v1/terminal/reader/coupon-taps')
      .set(counter.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ cardToken: token, tapId });
    expect(tap.status).toBe(200);
    expect(tap.body).toMatchObject({
      holder: { maskedName: 'Divya R.', classSection: 'Grade 6 A' },
      eligibleTypes: [{ id: allDay.id, name: 'Mess meal' }],
      chooseWithinSec: 30,
    });
    const take = () =>
      request(f.app)
        .post('/api/v1/terminal/reader/coupon-redemptions')
        .set(counter.auth)
        .set('Idempotency-Key', randomUUID())
        .send({ tapId, couponTypeId: allDay.id });
    const first = await take();
    expect(first.status).toBe(201);
    const repeat = await take();
    expect(repeat.body.id).toBe(first.body.id);

    // A lapsed tap is refused; a second tap finds nothing left today.
    const late = randomUUID();
    await f.t.db
      .insertInto('coupon_taps')
      .values({
        institution_id: f.school.rowId,
        terminal_id: String(
          (
            await f.t.db
              .selectFrom('terminals')
              .select('id')
              .orderBy('id', 'desc')
              .executeTakeFirstOrThrow()
          ).id,
        ),
        tap_ref: late,
        profile_id: s.rowId,
        expires_at: new Date(Date.now() - 1000),
      })
      .execute();
    expect(
      (
        await request(f.app)
          .post('/api/v1/terminal/reader/coupon-redemptions')
          .set(counter.auth)
          .set('Idempotency-Key', randomUUID())
          .send({ tapId: late, couponTypeId: allDay.id })
      ).body.code,
    ).toBe('CPN.TAP_LAPSED');
    const none = await request(f.app)
      .post('/api/v1/terminal/reader/coupon-taps')
      .set(counter.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ cardToken: token, tapId: randomUUID() });
    expect(none.body.code).toBe('CPN.NONE_ACTIVE');
  });

  it('cancels future coupons, expires past ones (job) and reports them; another school sees none (CPN-010…012)', async () => {
    await f.feature('coupons', true);
    const s = await f.student('Mohan');
    const t = (
      await type({ name: 'Report meal', window: { start: '00:00', end: '23:59' }, holdMax: 10 })
    ).body;
    await issue({ typeIds: [t.id], from: tomorrow, to: addDays(tomorrow, 3), studentIds: [s.id] });

    const cancel = await post('/api/v1/console/coupons/cancellations', {
      studentIds: [s.id],
      from: addDays(tomorrow, 2),
      to: addDays(tomorrow, 3),
      reason: 'Away on a trip',
    });
    expect(cancel.body).toEqual({ cancelled: 2 });
    const cancelled = await request(f.app)
      .get(`/api/v1/console/coupons?studentId=${s.id}&state=CANCELLED`)
      .set(con);
    expect(cancelled.body.items).toHaveLength(2);
    expect(cancelled.body.items[0]).toMatchObject({
      status: 'EXPIRED',
      state: 'CANCELLED',
      cancelReason: 'Away on a trip',
    });

    // The first day passes unused: the job expires it, once.
    await f.t.db
      .updateTable('coupons')
      .set({ valid_on: addDays(today, -1) })
      .where('profile_id', '=', s.rowId)
      .where('valid_on', '=', tomorrow)
      .execute();
    const run = () => f.h.services.coupons.expire({ periodKey: today, item: () => undefined });
    expect((await run()).expired).toBeGreaterThanOrEqual(1);
    expect((await run()).expired).toBe(0);
    const expired = await request(f.app)
      .get(`/api/v1/console/coupons?studentId=${s.id}&state=EXPIRED`)
      .set(con);
    expect(expired.body.items).toHaveLength(1);

    const rep = await request(f.app)
      .get(`/api/v1/console/coupons/reports?from=${addDays(today, -1)}&to=${addDays(today, 4)}`)
      .set(con);
    expect(rep.status).toBe(200);
    const mine = rep.body.perStudent.find(
      (x: { student: { name: string } }) => x.student.name === 'Mohan Rao',
    );
    expect(mine).toMatchObject({ issued: 2, expired: 1, active: 1, used: 0 });
    expect(rep.body.kpis.cancelled).toBeGreaterThanOrEqual(2);

    const other = await schoolFixture('Other Coupon School');
    try {
      const r = await request(other.app)
        .patch(`/api/v1/console/coupon-types/${t.id}`)
        .set(other.school.con)
        .set('If-Match', '"v1"')
        .send({ active: false });
      expect(r.status).toBe(404);
      const list = await request(other.app)
        .get(`/api/v1/console/coupons?studentId=${s.id}`)
        .set(other.school.con);
      expect(list.body.items).toEqual([]);
    } finally {
      await other.t.drop();
    }
  }, 180_000);
});

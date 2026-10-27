/**
 * Staff attendance at the front desk on a real MySQL (client 2026-10-22; ATT-029…031):
 * - a staff card on the desk's reader checks the person in, the next tap checks them out, a later
 *   tap says the day is complete; a student's card is refused;
 * - the desk checks a staff member in or out by name (with the reason), as the gate would; a day
 *   marked Absent can still be checked in; a second check-in or a check-out before a check-in is
 *   refused;
 * - the records reach the staff list, the console's overview and the staff member's own app.
 */
import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';

const IST = { timeZone: 'Asia/Kolkata' } as const;
const today = () => new Intl.DateTimeFormat('en-CA', IST).format(new Date());
/** What a check-in now is: Present up to 10:15 (the register's cut-off), Late after. */
const checkInNow = () => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    ...IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .split(':')
    .map(Number);
  return (h ?? 0) * 60 + (m ?? 0) <= 615 ? 'PRESENT' : 'LATE';
};

describe.skipIf(!adminUrl)('staff attendance at the front desk on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let raju: Payer;
  let kumar: Payer;
  let asha: Payer;
  let rajuCard: string;
  let ashaCard: string;
  const post = (path: string, body: object, auth: Auth = con) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth = con) => request(f.app).get(`/api/v1${path}`).set(auth);
  const row = async (name: string) =>
    (await get('/console/attendance/staff')).body.items.find((i: { member: { name: string } }) =>
      i.member.name.startsWith(name),
    );

  beforeAll(async () => {
    f = await schoolFixture('Front Desk School');
    con = f.school.con;
    raju = await f.payer('Raju', 0);
    kumar = await f.payer('Kumar', 0);
    asha = await f.student('Asha');
    rajuCard = await f.card(raju.rowId);
    ashaCard = await f.card(asha.rowId);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('lists the staff of the day, not yet marked', async () => {
    const list = await get('/console/attendance/staff');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toMatchObject({ date: today(), today: true });
    const r = list.body.items.find((i: { member: { name: string } }) =>
      i.member.name.startsWith('Raju'),
    );
    expect(r).toMatchObject({
      status: null,
      checkInAt: null,
      member: { hasCard: true, teaching: true },
    });
    expect(
      list.body.items.some((i: { member: { name: string } }) => i.member.name.startsWith('Asha')),
    ).toBe(false);
    expect(list.body.counts.notMarked).toBeGreaterThanOrEqual(2);
    // Non-teaching staff only: no teacher in that list.
    const others = (await get('/console/attendance/staff?type=STAFF')).body.items;
    expect(others.every((i: { member: { teaching: boolean } }) => !i.member.teaching)).toBe(true);
  });

  it('checks a staff member in and out with their card; refuses a student’s card', async () => {
    const tap = (cardToken: string) => post('/console/attendance/staff/card-taps', { cardToken });
    const first = await tap(rajuCard);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      result: 'CHECKED_IN',
      status: checkInNow(),
      member: { name: expect.stringMatching(/^Raju/) },
    });
    // Within the double-tap interval: refused, as at a gate reader.
    expect((await tap(rajuCard)).body.code).toBe('ATT.DOUBLE_TAP');
    await f.t.db
      .updateTable('cards')
      .set({ last_tap_at: new Date(Date.now() - 60_000) })
      .where('token', '=', rajuCard)
      .execute();
    // Client 2026-10-26: within 10 minutes of the check-in a tap is a repeated scan, not a check-out.
    const soon = await tap(rajuCard);
    expect(soon.status).toBe(409);
    expect(soon.body.code).toBe('ATT.CHECKOUT_TOO_SOON');
    expect(soon.body.detail).toMatch(
      /^Raju\b.* is already checked in \(at \d{1,2}:\d{2} [AP]M\)\. Tap again after \d{1,2}:\d{2} [AP]M to check out\.$/,
    );
    const rajuDay = f.t.db
      .selectFrom('attendance_days')
      .select(['id', 'check_out_at'])
      .where(
        'profile_id',
        '=',
        f.t.db.selectFrom('cards').select('profile_id').where('token', '=', rajuCard),
      );
    expect((await rajuDay.executeTakeFirstOrThrow()).check_out_at).toBeNull();
    // Eleven minutes on (the check-in moved back), the card checks out as before.
    await f.t.db
      .updateTable('attendance_days')
      .set({ check_in_at: new Date(Date.now() - 11 * 60_000) })
      .where('id', '=', (await rajuDay.executeTakeFirstOrThrow()).id)
      .execute();
    await f.t.db
      .updateTable('cards')
      .set({ last_tap_at: new Date(Date.now() - 60_000) })
      .where('token', '=', rajuCard)
      .execute();
    const out = await tap(rajuCard);
    // Checked out at once: before the half-day time.
    expect(out.body).toMatchObject({ result: 'CHECKED_OUT', status: 'HALF_DAY' });
    await f.t.db
      .updateTable('cards')
      .set({ last_tap_at: new Date(Date.now() - 60_000) })
      .where('token', '=', rajuCard)
      .execute();
    expect((await tap(rajuCard)).body).toMatchObject({ result: 'COMPLETE', status: 'HALF_DAY' });
    expect((await tap(ashaCard)).body).toMatchObject({
      code: 'ATT.NOT_STAFF',
      params: { name: expect.stringMatching(/^Asha/) },
    });
    // Raju is told of each (client 2026-10-22), once.
    const told = (await get('/me/notifications?limit=50', raju.auth)).body.items.map(
      (n: { titleKey: string }) => n.titleKey,
    );
    expect(told.filter((k: string) => k === 'NTF.CHECKED_IN')).toHaveLength(1);
    expect(told.filter((k: string) => k === 'NTF.CHECKED_OUT')).toHaveLength(1);
    const r = await row('Raju');
    expect(r).toMatchObject({ status: 'HALF_DAY', method: 'NFC' });
    expect(r.checkInAt).toBeTruthy();
    expect(r.checkOutAt).toBeTruthy();
  });

  it('checks a staff member in and out by name, over a day marked Absent', async () => {
    const check = (action: 'IN' | 'OUT', remark?: string) =>
      post('/console/attendance/staff/checks', {
        memberId: kumar.id,
        action,
        ...(remark ? { remark } : {}),
      });
    expect((await check('OUT')).body.code).toBe('ATT.NOT_CHECKED_IN');
    // Marked Absent first (manual marking, ATT-010), then he arrives without his card.
    const marked = await request(f.app)
      .put('/api/v1/console/attendance/daily')
      .set(con)
      .send({ date: today(), entries: [{ memberId: kumar.id, status: 'ABSENT' }] });
    expect([200, 201]).toContain(marked.status);
    const inn = await check('IN', 'Forgot his card');
    expect(inn.status, JSON.stringify(inn.body)).toBe(200);
    expect(inn.body).toMatchObject({ result: 'CHECKED_IN', status: checkInNow() });
    expect((await check('IN')).body.code).toBe('ATT.ALREADY_CHECKED_IN');
    expect(await row('Kumar')).toMatchObject({
      status: checkInNow(),
      method: 'MANUAL',
      remark: null,
      checkOutAt: null,
    });
    const out = await check('OUT');
    expect(out.body).toMatchObject({ result: 'CHECKED_OUT', status: 'HALF_DAY' });
    expect((await check('OUT')).body.code).toBe('ATT.ALREADY_COMPLETED');
    expect(
      (await post('/console/attendance/staff/checks', { memberId: asha.id, action: 'IN' })).body
        .code,
    ).toBe('ATT.NOT_STAFF');
    expect(
      (await post('/console/attendance/staff/checks', { memberId: randomUUID(), action: 'IN' }))
        .status,
    ).toBe(404);
    const events = await f.t.db
      .selectFrom('attendance_events as e')
      .innerJoin('attendance_days as d', 'd.id', 'e.day_id')
      .select(['e.action', 'e.old_status', 'e.new_status', 'e.remark'])
      .where('d.profile_id', '=', kumar.rowId)
      .orderBy('e.id')
      .execute();
    expect(events.map((e) => e.action)).toEqual(['MANUAL-ATTENDANCE', 'CHECK-IN', 'CHECK-OUT']);
    expect(events[1]).toMatchObject({ old_status: 'ABSENT', remark: 'Forgot his card' });
  });

  it('reaches the console’s overview and the staff member’s own app', async () => {
    const list = await get('/console/attendance/staff');
    expect(list.body.counts).toMatchObject({ halfDay: 2, onCampus: 0 });
    const overview = await get('/console/attendance/overview');
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.staff.teachers.halfDay).toBe(2);
    const mine = await get('/me/attendance', raju.auth);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const day = mine.body.items.find((d: { date: string }) => d.date === today());
    expect(day).toMatchObject({ status: 'HALF_DAY' });
    expect(day.checkInAt).toBeTruthy();
  });

  // Last: Kumar's day is complete by now, so the tap only has to find him.
  it('finds a staff card carried over from the earlier application by its value (2026-10-23)', async () => {
    const kumarCard = await f.card(kumar.rowId);
    // Such a card holds the earlier application's encrypted token; the card row keeps its SHA-256.
    const cug = 'U2FsdGVkX1+iHwx1dvayNs1hBmdPsYCkB8aDTE74fQzQPbFs3xMgnbZ8dhbzHVda';
    await f.t.db
      .updateTable('cards')
      .set({ legacy_token_hash: createHash('sha256').update(cug).digest() })
      .where('token', '=', kumarCard)
      .execute();
    const tap = await post('/console/attendance/staff/card-taps', { cardToken: cug });
    expect(tap.status, JSON.stringify(tap.body)).toBe(200);
    expect(tap.body).toMatchObject({
      result: 'COMPLETE',
      member: { name: expect.stringMatching(/^Kumar/) },
    });
    // Another earlier value, or the same one changed, finds no card.
    const other = await post('/console/attendance/staff/card-taps', {
      cardToken: cug.slice(0, -4) + 'AAAA',
    });
    expect(other.body.code).toBe('ATT.CARD_NOT_ACTIVE');
  });
});

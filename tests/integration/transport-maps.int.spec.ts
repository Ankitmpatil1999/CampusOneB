/**
 * Maps, live tracking and the transport fee by distance on a real MySQL (client 2026-10-21;
 * TRN-036…042):
 * - road distances for a route through the map service (test mode here), stops placed on the map;
 * - the Institution Administrator's rule; an allocation raises one due a month, both ways at the yearly
 *   rate; a farther stop raises the months left (in place, or an extra due for a month already
 *   paid); a nearer stop changes nothing; re-applying adds nothing; staff pay transport dues too;
 * - the driver's phone: fixes stored once, inaccurate ones not used, the trip's latest position and
 *   km run, "the bus is near your stop" once, the passenger's live view, the console's trip;
 * - positions past their retention are deleted by the job.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { sql } from 'kysely';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';
import { testRouter } from '../../integrations/maps.provider';
import { monthlyParts, monthsOf, yearlyFee } from '../../services/transport-fees.service';
import { binToUuid } from '../../utils/idGenerator';

const IST = { timeZone: 'Asia/Kolkata' } as const;
const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', IST).format(d);
const today = () => dayOf(new Date());
const tomorrow = () => dayOf(new Date(Date.now() + 86_400_000));
const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const RATE = 150_000; // ₹1,500 a km a year

describe.skipIf(!adminUrl)('maps, live tracking and the transport fee on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let raju: Payer;
  let kumar: Payer;
  let asha: Payer;
  let year: { startsOn: string; endsOn: string };
  const ids: Record<string, string> = {};
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const send = (method: 'put' | 'patch', path: string, body: object, ver: number) =>
    request(f.app)[method](`/api/v1${path}`).set(con).set('If-Match', `"v${ver}"`).send(body);
  const get = (path: string, auth: Auth = con) => request(f.app).get(`/api/v1${path}`).set(auth);
  const dues = (rowId: string) =>
    f.t.db
      .selectFrom('fee_records')
      .select(['public_id', 'label', 'amount_paise', 'transport_month', 'status', 'due_date'])
      .where('student_profile_id', '=', rowId)
      .where('source', '=', 'TRANSPORT')
      .orderBy('instalment_seq')
      .execute();
  const month = (d: Date | string) => (typeof d === 'string' ? d : dayOf(d)).slice(0, 7) + '-01';
  /** What each month from `from` should carry for a stop `km` from the school. */
  const expected = (km: number, from: string) => {
    const months = monthsOf(year.startsOn, year.endsOn);
    const parts = monthlyParts(yearlyFee(km, RATE), months.length);
    return months.map((m, i) => [m, parts[i]!] as const).filter(([m]) => m >= month(from));
  };

  beforeAll(async () => {
    f = await schoolFixture('Maps School', { overrides: { maps: testRouter() } });
    con = f.school.con;
    raju = await f.payer('Raju', 0);
    kumar = await f.payer('Kumar', 0);
    asha = await f.student('Asha');
    year = (await get('/console/academic-years')).body.items.find(
      (y: { current: boolean }) => y.current,
    );
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('measures a route’s road distances once every stop is on the map', async () => {
    const places: [string, number | null, number | null][] = [
      ['School Gate', 13.93, 75.56],
      ['Ashok Nagar', 13.9405, 75.5655],
      ['Vinobanagar Circle', 13.9505, 75.5755],
      ['Gopala', 13.962, 75.586],
      ['Unplaced', null, null],
    ];
    for (const [name, lat, lng] of places) {
      const s = await post('/console/stops', con, { name, lat, lng });
      expect(s.status, JSON.stringify(s.body)).toBe(201);
      ids[name] = s.body.id;
    }
    const route = await post('/console/routes', con, { code: 'M1', name: 'Vinobanagar – School' });
    ids['route'] = route.body.id;
    const stops = await send(
      'put',
      `/console/routes/${ids['route']}/stops`,
      {
        stops: [
          { stopId: ids['School Gate'], seq: 0 },
          { stopId: ids['Ashok Nagar'], seq: 1, distanceKm: 1.6 },
          { stopId: ids['Vinobanagar Circle'], seq: 2, distanceKm: 2 },
          { stopId: ids['Gopala'], seq: 3, distanceKm: 2.4 },
        ],
      },
      route.body.version,
    );
    expect(stops.status, JSON.stringify(stops.body)).toBe(200);
    // What the fee is charged on: from the school along the route.
    expect(stops.body.stops.map((s: { fromSchoolKm: number }) => s.fromSchoolKm)).toEqual([
      0, 1.6, 3.6, 6,
    ]);
    expect(stops.body.stops[1].stop).toMatchObject({ lat: 13.9405, lng: 75.5655 });
    ids['routeVersion'] = String(stops.body.version);

    const measured = await post(`/console/routes/${ids['route']}/distances`, con);
    expect(measured.status, JSON.stringify(measured.body)).toBe(200);
    expect(measured.body).toMatchObject({ provider: 'test', estimate: true });
    expect(measured.body.items).toHaveLength(4);
    expect(measured.body.items[0].distanceKm).toBe(0);
    expect(measured.body.items[1].distanceKm).toBeGreaterThan(1);

    const loose = await post('/console/routes', con, { code: 'M2', name: 'Loose' });
    await send(
      'put',
      `/console/routes/${loose.body.id}/stops`,
      {
        stops: [
          { stopId: ids['School Gate'], seq: 0 },
          { stopId: ids['Unplaced'], seq: 1, distanceKm: 1 },
        ],
      },
      loose.body.version,
    );
    const refused = await post(`/console/routes/${loose.body.id}/distances`, con);
    expect(refused.body.errors[0]).toMatchObject({
      code: 'TRN.STOPS_WITHOUT_PLACE',
      params: { stops: 'Unplaced' },
    });
    expect((await post(`/console/routes/${randomUUID()}/distances`, con)).status).toBe(404);
    expect((await get('/console/maps')).body).toMatchObject({
      provider: 'test',
      browserKey: null,
      refreshSeconds: 15,
      staleSeconds: 120,
    });
  });

  it('lets the Institution Administrator set the yearly rate per km', async () => {
    const rule = await get('/console/transport/fee-rule');
    expect(rule.body).toMatchObject({ active: false, ratePaisePerKm: 0, dueDay: 5, version: 0 });
    expect(rule.body.year.months).toBe(monthsOf(year.startsOn, year.endsOn).length);
    const set = (body: object, ver: number) =>
      send('put', '/console/transport/fee-rule', body, ver);
    expect((await set({ active: true, ratePaisePerKm: 0, dueDay: 5 }, 0)).body.errors[0].code).toBe(
      'TRN.FEE_RATE',
    );
    expect(
      (await set({ active: true, ratePaisePerKm: RATE, dueDay: 31 }, 0)).body.errors[0].code,
    ).toBe('TRN.FEE_DUE_DAY');
    expect((await post('/console/transport/fee-rule/apply', con)).body.code).toBe(
      'TRN.FEE_RULE_OFF',
    );
    const ok = await set({ active: true, ratePaisePerKm: RATE, dueDay: 5 }, 0);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      active: true,
      ratePerKm: { amount: '1500.00', currency: 'INR' },
      version: 1,
    });
    expect((await set({ active: true, ratePaisePerKm: RATE, dueDay: 5 }, 0)).status).toBe(412);
  });

  it('raises a due a month on allocation, both ways at the rate, for students and staff', async () => {
    const bus = await post('/console/vehicles', con, {
      name: 'Bus 07',
      registration: 'KA-14-F-2231',
      capacity: 40,
    });
    const next = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    const driver = await post('/console/crew', con, {
      memberId: raju.id,
      role: 'DRIVER',
      licenceNo: 'KA14 20110004521',
      licenceExpiry: next,
      employeeRef: 'MS-D-0001',
    });
    const session = await post('/console/transport-sessions', con, {
      name: 'Afternoon drop',
      direction: 'DROP',
      startTime: '15:40',
      days: ALL_DAYS,
    });
    const a = await post('/console/vehicle-assignments', con, {
      routeId: ids['route'],
      sessionId: session.body.id,
      vehicleId: bus.body.id,
      driverId: driver.body.id,
      from: today(),
      to: year.endsOn,
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);

    const allocate = (memberIds: string[], stop: string, from = today()) =>
      post('/console/passenger-allocations', con, {
        memberIds,
        routeId: ids['route'],
        stopId: ids[stop],
        from,
        to: year.endsOn,
      });
    const asha1 = await allocate([asha.id], 'Vinobanagar Circle');
    expect(asha1.status, JSON.stringify(asha1.body)).toBe(201);
    const want = expected(3.6, today());
    expect(asha1.body.fees.records).toBe(want.length);
    const rows = await dues(asha.rowId);
    expect(rows.map((r) => [month(r.transport_month!), Number(r.amount_paise)])).toEqual(want);
    expect(rows[0]!.label).toMatch(/^Transport [A-Z][a-z]{2} \d{4}$/);
    expect(
      rows.every((r) => String(r.due_date) >= today() || dayOf(new Date(r.due_date)) >= today()),
    ).toBe(true);
    // The family is told, and the dues are in the app's fees.
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain('Fee');
    expect(JSON.stringify((await get('/me/fees', asha.auth)).body)).toContain('Transport');

    // A staff member pays transport dues too: in the app, and at the office.
    const staff = await allocate([kumar.id], 'Ashok Nagar');
    expect(staff.body.fees.records).toBe(expected(1.6, today()).length);
    const mine = await get('/me/fees', kumar.auth);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(JSON.stringify(mine.body)).toContain('Transport');
    const picker = await get('/console/fee-records/students?q=Kumar');
    expect(JSON.stringify(picker.body)).toContain('Kumar');
    const desk = await get(`/console/fee-collection/students/${kumar.id}/collect`);
    expect(desk.status, JSON.stringify(desk.body)).toBe(200);
    // Re-applying the rule adds nothing.
    const again = await post('/console/transport/fee-rule/apply', con);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ records: 0, members: 0 });
  });

  it('raises the months left for a farther stop, never lowers for a nearer one', async () => {
    const before = await dues(asha.rowId);
    // The last month is paid at the office before the change.
    const last = before.at(-1)!;
    const paid = await post(`/console/fee-records/${binToUuid(last.public_id)}/cash`, con, {});
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    const current = (await get('/console/passenger-allocations?assigned=true')).body.items.find(
      (x: { member: { id: string } }) => x.member.id === asha.id,
    ).allocation;
    const ended = await post(`/console/passenger-allocations/${current.id}/end`, con, {
      endDate: today(),
      reason: 'Moved house',
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    if (tomorrow() > year.endsOn) return; // the year's last day: nothing left to raise
    const farther = await post('/console/passenger-allocations', con, {
      memberIds: [asha.id],
      routeId: ids['route'],
      stopId: ids['Gopala'],
      from: tomorrow(),
      to: year.endsOn,
    });
    expect(farther.status, JSON.stringify(farther.body)).toBe(201);
    const after = await dues(asha.rowId);
    const byMonth = new Map<string, number>();
    for (const r of after) {
      const m = month(r.transport_month!);
      byMonth.set(m, (byMonth.get(m) ?? 0) + Number(r.amount_paise));
    }
    for (const [m, amount] of expected(6, tomorrow())) expect(byMonth.get(m)).toBe(amount);
    // The paid month got an extra due; the others were raised in place.
    const lastMonth = month(last.transport_month!);
    const extra = after.filter((r) => month(r.transport_month!) === lastMonth);
    expect(extra).toHaveLength(2);
    expect(extra[1]!.label).toContain('(extra)');
    expect(after.length).toBe(before.length + 1);

    // A nearer stop changes nothing for the year.
    const farRow = await f.t.db
      .selectFrom('transport_allocations')
      .select('public_id')
      .where('profile_id', '=', asha.rowId)
      .where('effective_from', '=', tomorrow())
      .executeTakeFirstOrThrow();
    const now = { id: binToUuid(farRow.public_id) };
    await post(`/console/passenger-allocations/${now.id}/end`, con, {
      endDate: tomorrow(),
      reason: 'Moved again',
    });
    const dayAfter = dayOf(new Date(Date.now() + 2 * 86_400_000));
    if (dayAfter <= year.endsOn) {
      const nearer = await post('/console/passenger-allocations', con, {
        memberIds: [asha.id],
        routeId: ids['route'],
        stopId: ids['Ashok Nagar'],
        from: dayAfter,
        to: year.endsOn,
      });
      expect(nearer.status, JSON.stringify(nearer.body)).toBe(201);
      expect(nearer.body.fees.records).toBe(0);
      expect((await dues(asha.rowId)).length).toBe(after.length);
    }
  });

  it('takes the driver’s positions, tells the stop the bus is near, and shows the bus', async () => {
    const trips = await get('/crew/trips', raju.auth);
    expect(trips.status, JSON.stringify(trips.body)).toBe(200);
    const trip = trips.body.items.find((t: { direction: string }) => t.direction === 'DROP');
    const t = `/crew/trips/${trip.id}`;
    const fix = (lat: number, lng: number, at: Date, extra: object = {}) => ({
      lat,
      lng,
      accuracy: 8,
      speed: 20,
      heading: 45,
      at: at.toISOString(),
      ...extra,
    });
    // Not running yet: the phone is told to stop.
    expect(
      (await post(`${t}/positions`, raju.auth, { points: [fix(13.93, 75.56, new Date())] })).body
        .code,
    ).toBe('TRN.TRIP_NOT_RUNNING');
    expect((await post(`${t}/start`, raju.auth)).status).toBe(200);
    expect(
      (await post(`${t}/positions`, kumar.auth, { points: [fix(13.93, 75.56, new Date())] })).body
        .code,
    ).toBe('TRN.NOT_CREW');
    expect(
      (
        await post(`${t}/positions`, raju.auth, {
          points: [{ lat: 95, lng: 75, at: new Date().toISOString() }],
        })
      ).body.errors[0].code,
    ).toBe('TRN.POSITION');

    // Kumar's family sees the bus once the trip runs — no position yet.
    const early = await get('/me/transport/live', kumar.auth);
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    expect(early.body.trip).toMatchObject({ bus: null, stale: true, direction: 'DROP' });
    expect(early.body.school).toMatchObject({ name: 'School Gate' });

    const t0 = new Date(Date.now() - 120_000);
    const batch = {
      points: [
        fix(13.93, 75.56, t0),
        // ~1 km on, one minute later.
        fix(13.937, 75.5655, new Date(t0.getTime() + 60_000)),
        // Too inaccurate to use.
        fix(13.99, 75.6, new Date(t0.getTime() + 90_000), { accuracy: 5000 }),
      ],
    };
    const sent = await post(`${t}/positions`, raju.auth, batch);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ accepted: 2, running: true, intervalSeconds: 15 });
    // Sent again (the phone retried): nothing added.
    expect((await post(`${t}/positions`, raju.auth, batch)).body.accepted).toBe(0);

    // Ashok Nagar is ~400 m away: Kumar is told once; Asha (another stop) isn't.
    const notices = JSON.stringify((await get('/me/notifications', kumar.auth)).body);
    expect(notices).toContain('Bus 07 is near Ashok Nagar');
    await post(`${t}/positions`, raju.auth, {
      points: [fix(13.9375, 75.566, new Date(t0.getTime() + 70_000))],
    });
    const count = (s: string) => s.split('Bus 07 is near Ashok Nagar').length - 1;
    expect(count(JSON.stringify((await get('/me/notifications', kumar.auth)).body))).toBe(1);
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).not.toContain(
      'is near Ashok Nagar',
    );

    const live = await get('/me/transport/live', kumar.auth);
    expect(live.body.trip).toMatchObject({
      stale: false,
      bus: { lat: 13.9375, lng: 75.566 },
      nextStop: { name: 'School Gate' },
      myStop: expect.objectContaining({ status: 'UPCOMING' }),
    });
    expect(live.body.trip.myStop.etaMinutes).toBeGreaterThanOrEqual(1);
    expect(live.body.trip.trail.length).toBe(3);
    expect(live.body.allocation.stop).toMatchObject({ name: 'Ashok Nagar', lat: 13.9405 });

    const listed = (await get('/console/trips')).body.items.find(
      (x: { id: string }) => x.id === trip.id,
    );
    expect(listed.bus).toMatchObject({ lat: 13.9375, lng: 75.566 });
    expect(listed.kmRun).toBeGreaterThan(0.5);
    expect(listed.kmRun).toBeLessThan(2);
    const detail = await get(`/console/trips/${trip.id}`);
    expect(detail.body.trail).toHaveLength(3);
    expect(detail.body.stops[0].stop).toMatchObject({ lat: 13.93, lng: 75.56 });
  });

  it('deletes positions past their retention in the trip job', async () => {
    const trip = await f.t.db.selectFrom('transport_trips').select('id').executeTakeFirstOrThrow();
    const old = new Date(Date.now() - 40 * 86_400_000);
    await f.t.db
      .insertInto('transport_trip_positions')
      .values({
        institution_id: f.school.rowId,
        trip_id: String(trip.id),
        lat: '13.900000',
        lng: '75.500000',
        recorded_at: old,
        received_at: old,
      })
      .execute();
    const count = async () =>
      Number(
        (
          await f.t.db
            .selectFrom('transport_trip_positions')
            .select(sql<number>`COUNT(*)`.as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    const n = await count();
    const run = await request(f.app)
      .post('/api/v1/ops/jobs/trip-generation/runs')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Integration test of the retention' });
    expect([200, 201, 202]).toContain(run.status);
    await expect.poll(count, { timeout: 10_000 }).toBe(n - 1);
  });
});

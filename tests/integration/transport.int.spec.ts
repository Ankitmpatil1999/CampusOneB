/**
 * Transport on a real MySQL (Phase 7.6; SRS 22; TRN-001…034; BR-60…62; RC-25; OI-TRN-05…30):
 * - masters keep their rules (an ordered stop list without gaps or repeats, unique codes and
 *   registrations, a driver's licence, unique employee references, session days);
 * - assignments never double-book a vehicle, crew member or route-session; allocations never overlap;
 * - the job generates one trip per assignment and day; the crew starts it, passes the stops in order,
 *   records boarding and completes it; the console cancels a scheduled trip; families are told; the
 *   reports and the family's view.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';
import { newPublicIdPair } from '../../utils/idGenerator';

const IST = { timeZone: 'Asia/Kolkata' } as const;
const today = () => new Intl.DateTimeFormat('en-CA', IST).format(new Date());
const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

describe.skipIf(!adminUrl)('transport on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let raju: Payer;
  let savitha: Payer;
  let kumar: Payer;
  let asha: Payer;
  let bala: Payer;
  let yearEnd: string;
  const ids: Record<string, string> = {};
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const send = (method: 'put' | 'patch', path: string, body: object, ver: number) =>
    request(f.app)[method](`/api/v1${path}`).set(con).set('If-Match', `"v${ver}"`).send(body);
  const get = (path: string, auth: Auth = con) => request(f.app).get(`/api/v1${path}`).set(auth);

  beforeAll(async () => {
    f = await schoolFixture('Transport School');
    con = f.school.con;
    raju = await f.payer('Raju', 0);
    savitha = await f.payer('Savitha', 0);
    kumar = await f.payer('Kumar', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    yearEnd = (await get('/console/academic-years')).body.items.find(
      (y: { current: boolean }) => y.current,
    ).endsOn;
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('keeps the masters’ rules: stops, routes and their order, vehicles, crew and sessions', async () => {
    const stop = (name: string, extra: object = {}) =>
      post('/console/stops', con, {
        name,
        landmark: 'Near the circle',
        lat: 13.94,
        lng: 75.56,
        ...extra,
      });
    for (const n of ['Vinobanagar Circle', 'Ashok Nagar', 'School Gate', 'Gandhi Bazaar']) {
      const s = await stop(n);
      expect(s.status, JSON.stringify(s.body)).toBe(201);
      ids[n] = s.body.id;
    }
    expect((await stop('Ashok Nagar')).body.code).toBe('TRN.STOP_NAME_TAKEN');
    expect((await stop('Far away', { lat: 100 })).body.errors[0].code).toBe('TRN.LAT');

    const r3 = await post('/console/routes', con, {
      code: 'r3',
      name: 'Vinobanagar – School',
      type: 'MORNING',
    });
    expect(r3.status, JSON.stringify(r3.body)).toBe(201);
    expect(r3.body.code).toBe('R3');
    ids['route'] = r3.body.id;
    expect((await post('/console/routes', con, { code: 'R3', name: 'Again' })).body.code).toBe(
      'TRN.ROUTE_CODE_TAKEN',
    );
    const list = (stops: object[]) =>
      send('put', `/console/routes/${ids['route']}/stops`, { stops }, r3.body.version);
    expect(
      (
        await list([
          { stopId: ids['Vinobanagar Circle'], seq: 0 },
          { stopId: ids['Ashok Nagar'], seq: 2 },
        ])
      ).body.errors[0].code,
    ).toBe('TRN.STOP_SEQUENCE');
    expect(
      (
        await list([
          { stopId: ids['Ashok Nagar'], seq: 0 },
          { stopId: ids['Ashok Nagar'], seq: 1 },
        ])
      ).body.errors[0],
    ).toMatchObject({ code: 'TRN.DUPLICATE_STOP', params: { stop: 'Ashok Nagar' } });
    const ok = await list([
      { stopId: ids['Vinobanagar Circle'], seq: 0 },
      { stopId: ids['Ashok Nagar'], seq: 1, distanceKm: 0.9 },
      { stopId: ids['School Gate'], seq: 2, distanceKm: 1.8 },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      distanceKm: 2.7,
      stops: [
        expect.objectContaining({ seq: 0 }),
        expect.anything(),
        expect.objectContaining({ stop: expect.objectContaining({ name: 'School Gate' }) }),
      ],
    });
    const stops = (await get('/console/stops')).body.items as { id: string; version: number }[];
    const gate = stops.find((s) => s.id === ids['School Gate'])!;
    expect(
      (await send('patch', `/console/stops/${gate.id}`, { active: false }, gate.version)).body.code,
    ).toBe('TRN.STOP_IN_USE');

    const bus = await post('/console/vehicles', con, {
      name: 'Bus 07',
      registration: 'ka 14 f 2231',
      capacity: 40,
    });
    expect(bus.status, JSON.stringify(bus.body)).toBe(201);
    expect(bus.body.registration).toBe('KA-14-F-2231');
    ids['bus'] = bus.body.id;
    expect(
      (
        await post('/console/vehicles', con, {
          name: 'Bus 08',
          registration: 'KA-14-F-2231',
          capacity: 40,
        })
      ).body.code,
    ).toBe('TRN.REGISTRATION_TAKEN');
    expect(
      (await post('/console/vehicles', con, { name: 'Bus 09', registration: 'KA-1', capacity: 0 }))
        .body.errors[0].code,
    ).toBe('TRN.CAPACITY');
    ids['bus2'] = (
      await post('/console/vehicles', con, {
        name: 'Bus 03',
        registration: 'KA-14-F-1187',
        capacity: 36,
      })
    ).body.id;

    const next = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    expect(
      (
        await post('/console/crew', con, {
          memberId: raju.id,
          role: 'DRIVER',
          employeeRef: 'TVPS-D-0007',
        })
      ).body.errors[0].code,
    ).toBe('TRN.LICENCE_REQUIRED');
    const driver = await post('/console/crew', con, {
      memberId: raju.id,
      role: 'DRIVER',
      licenceNo: 'KA14 20110004521',
      licenceExpiry: next,
      employeeRef: 'TVPS-D-0007',
    });
    expect(driver.status, JSON.stringify(driver.body)).toBe(201);
    ids['driver'] = driver.body.id;
    const att = await post('/console/crew', con, {
      memberId: savitha.id,
      role: 'ATTENDANT',
      employeeRef: 'TVPS-D-0008',
    });
    expect(att.status, JSON.stringify(att.body)).toBe(201);
    ids['attendant'] = att.body.id;
    expect(
      (
        await post('/console/crew', con, {
          memberId: raju.id,
          role: 'ATTENDANT',
          employeeRef: 'TVPS-D-0099',
        })
      ).body.code,
    ).toBe('TRN.ALREADY_CREW');
    expect(
      (
        await post('/console/crew', con, {
          memberId: kumar.id,
          role: 'ATTENDANT',
          employeeRef: 'TVPS-D-0008',
        })
      ).body,
    ).toMatchObject({ code: 'TRN.EMPLOYEE_REF_TAKEN' });

    expect(
      (
        await post('/console/transport-sessions', con, {
          name: 'Never',
          direction: 'DROP',
          startTime: '15:40',
          days: [],
        })
      ).body.errors[0].code,
    ).toBe('TRN.SESSION_DAYS');
    const morning = await post('/console/transport-sessions', con, {
      name: 'Morning pickup',
      direction: 'PICKUP',
      startTime: '07:15',
      endTime: '08:30',
      days: ALL_DAYS,
    });
    expect(morning.status, JSON.stringify(morning.body)).toBe(201);
    expect(morning.body).toMatchObject({ daily: true, days: ALL_DAYS });
    ids['morning'] = morning.body.id;
    ids['drop'] = (
      await post('/console/transport-sessions', con, {
        name: 'Afternoon drop',
        direction: 'DROP',
        startTime: '15:40',
        days: ALL_DAYS,
      })
    ).body.id;
    expect(
      (
        await post('/console/transport-sessions', con, {
          name: 'Morning pickup',
          direction: 'PICKUP',
          startTime: '07:00',
          days: ['MON'],
        })
      ).body.code,
    ).toBe('TRN.SESSION_NAME_TAKEN');
  });

  it('assigns without double booking and allocates passengers without overlaps', async () => {
    const assign = (body: object) =>
      post('/console/vehicle-assignments', con, {
        routeId: ids['route'],
        sessionId: ids['morning'],
        vehicleId: ids['bus'],
        driverId: ids['driver'],
        attendantId: ids['attendant'],
        from: today(),
        to: yearEnd,
        ...body,
      });
    expect((await assign({ attendantId: ids['driver'] })).body.errors[0].code).toBe(
      'TRN.SAME_CREW',
    );
    expect((await assign({ driverId: ids['attendant'] })).body.errors[0].code).toBe(
      'TRN.NOT_DRIVER',
    );
    const a = await assign({});
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect((await assign({})).body.code).toBe('TRN.ROUTE_SESSION_TAKEN');
    const r1 = await post('/console/routes', con, { code: 'R1', name: 'Ravindranagar – School' });
    expect((await assign({ routeId: r1.body.id })).body.code).toBe('TRN.VEHICLE_BOOKED');
    expect((await assign({ routeId: r1.body.id, vehicleId: ids['bus2'] })).body.code).toBe(
      'TRN.DRIVER_BOOKED',
    );
    const drop = await assign({ sessionId: ids['drop'] });
    expect(drop.status, JSON.stringify(drop.body)).toBe(201);

    const allocate = (body: object) =>
      post('/console/passenger-allocations', con, {
        memberIds: [asha.id, bala.id],
        routeId: ids['route'],
        stopId: ids['Ashok Nagar'],
        from: today(),
        to: yearEnd,
        ...body,
      });
    expect((await allocate({ stopId: ids['Gandhi Bazaar'] })).body.errors[0].code).toBe(
      'TRN.STOP_NOT_ON_ROUTE',
    );
    const al = await allocate({});
    expect(al.status, JSON.stringify(al.body)).toBe(201);
    expect(al.body.allocated).toBe(2);
    expect((await allocate({ memberIds: [asha.id] })).body.code).toBe('TRN.ALREADY_ALLOCATED');
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain(
      'Transport: R3 · Vinobanagar – School',
    );
    const list = await get('/console/passenger-allocations?assigned=true');
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({
      member: expect.objectContaining({ class: 'Grade 6', section: 'A' }),
      allocation: expect.objectContaining({
        stop: expect.objectContaining({ name: 'Ashok Nagar' }),
      }),
    });
    expect(
      (await get('/console/passenger-allocations?assigned=false')).body.items.some(
        (r: { member: { name: string } }) => r.member.name === 'Asha Rao',
      ),
    ).toBe(false);
  });

  it('generates trips once, and the crew runs them in order with boarding', async () => {
    const run = () =>
      request(f.app)
        .post('/api/v1/ops/jobs/trip-generation/runs')
        .set(f.ops)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Integration test of trips' });
    // Read before the day's job has run: today's trips are made on reading (client 2026-10-15:
    // "Active trips are not displaying in Live today").
    const early = await get('/crew/trips', raju.auth);
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    expect(early.body.items.map((x: { status: string }) => x.status)).toEqual([
      'SCHEDULED',
      'SCHEDULED',
    ]);
    // The job after them makes none twice.
    expect([200, 201, 202]).toContain((await run()).status);
    await run();
    const trips = await get('/console/trips');
    expect(trips.status, JSON.stringify(trips.body)).toBe(200);
    expect(trips.body.counts).toMatchObject({ scheduled: 2 });
    const pickup = trips.body.items.find((t: { direction: string }) => t.direction === 'PICKUP');
    const dropTrip = trips.body.items.find((t: { direction: string }) => t.direction === 'DROP');
    ids['trip'] = pickup.id;
    const detail = await get(`/console/trips/${pickup.id}`);
    // A pickup runs the route backwards (27.2).
    expect(detail.body.stops.map((s: { stop: { name: string } }) => s.stop.name)).toEqual([
      'School Gate',
      'Ashok Nagar',
      'Vinobanagar Circle',
    ]);
    expect(detail.body.stops[1].passengers.map((p: { name: string }) => p.name).sort()).toEqual([
      'Asha Rao',
      'Bala Rao',
    ]);

    expect((await get('/crew/trips', kumar.auth)).body.code).toBe('TRN.NOT_CREW');
    const mine = await get('/crew/trips', raju.auth);
    expect(mine.body.items).toHaveLength(2);
    const t = `/crew/trips/${pickup.id}`;
    expect(
      (await post(`${t}/stop-events`, raju.auth, { seq: 0, event: 'REACHED' })).body.code,
    ).toBe('TRN.TRIP_NOT_STARTED');
    const started = await post(`${t}/start`, savitha.auth);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.status).toBe('STARTED');
    expect((await post(`${t}/start`, raju.auth)).body.code).toBe('TRN.TRIP_NOT_SCHEDULED');
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain(
      'Bus 07 has started — Morning pickup',
    );
    const ev = (seq: number, event: string, remarks?: string) =>
      post(`${t}/stop-events`, raju.auth, { seq, event, ...(remarks ? { remarks } : {}) });
    expect((await ev(1, 'REACHED')).body.code).toBe('TRN.STOP_OUT_OF_ORDER');
    expect((await ev(0, 'DEPARTED')).body.code).toBe('TRN.STOP_NOT_REACHED');
    expect((await ev(0, 'REACHED')).status).toBe(200);
    expect((await ev(0, 'REACHED')).body.code).toBe('TRN.STOP_NOT_UPCOMING');
    expect((await ev(0, 'DEPARTED')).status).toBe(200);
    expect((await ev(1, 'SKIPPED')).body.errors[0].code).toBe('TRN.SKIP_REMARKS');
    expect((await ev(1, 'REACHED')).status).toBe(200);

    const board = (memberId: string, event: string, stopSeq = 1) =>
      post(`${t}/boardings`, raju.auth, { memberId, event, stopSeq });
    expect((await board(asha.id, 'CHECKED_IN')).status).toBe(200);
    const deviated = await board(bala.id, 'CHECKED_IN', 0);
    expect(
      deviated.body.stops[1].passengers.find((p: { name: string }) => p.name === 'Bala Rao')
        .boarding,
    ).toMatchObject({ status: 'CHECKED_IN', deviation: true });
    expect((await board(kumar.id, 'CHECKED_IN')).body.errors[0]).toMatchObject({
      code: 'TRN.NOT_A_PASSENGER',
    });
    expect((await board(asha.id, 'CHECKED_OUT', 2)).status).toBe(200);
    expect((await board(asha.id, 'CHECKED_IN')).body.code).toBe('TRN.BOARDING_ORDER');
    // The list shows where the bus is and who is on it, without reading each trip.
    const listed = (await get('/console/trips')).body.items.find(
      (x: { id: string }) => x.id === pickup.id,
    );
    expect(listed).toMatchObject({
      status: 'STARTED',
      nextStop: 'Ashok Nagar',
      lastStop: 'Vinobanagar Circle',
      passengers: { onBoard: 1, boarded: 2 },
    });

    expect((await post(`${t}/completion`, raju.auth)).body.code).toBe('TRN.STOPS_PENDING');
    await ev(1, 'DEPARTED');
    await ev(2, 'REACHED');
    const done = await post(`${t}/completion`, raju.auth);
    expect(done.body).toMatchObject({ status: 'COMPLETED', boarded: 2 });
    expect((await ev(2, 'DEPARTED')).body.code).toBe('TRN.TRIP_COMPLETED_UPDATE');
    const timeline = (await get(`/console/trips/${pickup.id}`)).body.events.map(
      (e: { event: string }) => e.event,
    );
    expect(timeline).toEqual([
      'SCHEDULED',
      'STARTED',
      'REACHED',
      'DEPARTED',
      'REACHED',
      'DEPARTED',
      'REACHED',
      'COMPLETED',
    ]);

    // The console cancels the scheduled drop; a completed trip can't be cancelled.
    expect(
      (await post(`/console/trips/${dropTrip.id}/cancellation`, con, { remarks: 'No' })).body
        .errors[0].code,
    ).toBe('TRN.CANCEL_REMARKS');
    const cancelled = await post(`/console/trips/${dropTrip.id}/cancellation`, con, {
      remarks: 'Road closed for the procession',
    });
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      cancelRemarks: 'Road closed for the procession',
    });
    expect(
      (await post(`/console/trips/${dropTrip.id}/cancellation`, con, { remarks: 'Again please' }))
        .body.code,
    ).toBe('TRN.TRIP_ALREADY_CANCELLED');
    expect(
      (await post(`/console/trips/${pickup.id}/cancellation`, con, { remarks: 'Too late now' }))
        .body.code,
    ).toBe('TRN.TRIP_COMPLETED_CANCEL');
    expect(JSON.stringify((await get('/me/notifications', bala.auth)).body)).toContain(
      'Afternoon drop on R3 · Vinobanagar – School is cancelled',
    );
  });

  it('reports, shows the family their trips and keeps the crew’s history', async () => {
    const mine = await get('/me/transport', asha.auth);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.allocation).toMatchObject({
      route: { code: 'R3' },
      stop: { name: 'Ashok Nagar' },
    });
    expect(
      mine.body.trips.find((t: { direction: string }) => t.direction === 'PICKUP'),
    ).toMatchObject({
      status: 'COMPLETED',
      myStop: { status: 'DEPARTED' },
      vehicle: { name: 'Bus 07' },
    });
    const daily = await get('/console/transport/reports/daily-summary');
    expect(daily.body.items).toEqual([
      expect.objectContaining({ date: today(), trips: 2, completed: 1, cancelled: 1 }),
    ]);
    const util = await get('/console/transport/reports/vehicle-utilisation');
    expect(util.body.items).toEqual([
      expect.objectContaining({ vehicle: 'Bus 07 · KA-14-F-2231', distanceKm: 2.7 }),
    ]);
    expect((await get('/console/transport/reports/cancelled-trips')).body.items).toEqual([
      expect.objectContaining({ remarks: 'Road closed for the procession' }),
    ]);
    expect((await get('/console/transport/reports/allocation')).body.items).toEqual([
      expect.objectContaining({ stop: 'Ashok Nagar', passengers: 2 }),
    ]);
    expect((await get('/console/transport/reports/nonsense')).body.code).toBe(
      'TRN.REPORT_NOT_FOUND',
    );
    const history = await get('/crew/history', raju.auth);
    expect(history.body.counts).toMatchObject({ trips: 2, completed: 1, cancelled: 1 });
    const allocations = (await get('/console/passenger-allocations?assigned=true')).body.items as {
      member: { name: string };
      allocation: { id: string };
    }[];
    const balas = allocations.find((r) => r.member.name === 'Bala Rao')!.allocation.id;
    const ended = await post(`/console/passenger-allocations/${balas}/end`, con, {
      endDate: yearEnd,
      reason: 'Moving house',
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    // The family is told the transport ends (OI-TRN-13).
    expect(JSON.stringify((await get('/me/notifications', bala.auth)).body)).toContain(
      `ends on ${yearEnd}`,
    );
  });

  it('allocates only students who opted for school transport on the admission form (client 2026-10-12)', async () => {
    // Asha and Bala were added directly: no choice on record, so they stayed eligible (above).
    const chitra = await f.student('Chitra');
    const deepa = await f.student('Deepa');
    const year = await f.t.db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', f.school.rowId)
      .executeTakeFirstOrThrow();
    const at = new Date();
    const approved = (who: Payer, n: number, parents: object) => ({
      public_id: newPublicIdPair().bin,
      institution_id: f.school.rowId,
      application_no: `TS/2026/00010${n}`,
      source: 'PUBLIC' as const,
      status: 'APPROVED' as const,
      year_id: String(year.id),
      mid_term: 0,
      data: JSON.stringify({ parents }),
      member_profile_id: who.rowId,
      created_at: at,
      updated_at: at,
    });
    await f.t.db
      .insertInto('admission_applications')
      .values([
        approved(chitra, 1, { primary: 'MOTHER', transport: false, transportStop: null }),
        approved(deepa, 2, {
          primary: 'MOTHER',
          transport: true,
          transportStop: { id: ids['Ashok Nagar'], name: 'Ashok Nagar' },
        }),
      ])
      .execute();
    const open = (await get('/console/passenger-allocations?assigned=false')).body.items as {
      member: { name: string };
      transport: { opted: boolean; stop: string | null } | null;
    }[];
    const choice = (name: string) => open.find((r) => r.member.name === name)?.transport;
    expect(choice('Chitra Rao')).toEqual({ opted: false, stop: null });
    expect(choice('Deepa Rao')).toEqual({ opted: true, stop: 'Ashok Nagar' });
    const allocate = (memberIds: string[]) =>
      post('/console/passenger-allocations', con, {
        memberIds,
        routeId: ids['route'],
        stopId: ids['Ashok Nagar'],
        from: today(),
        to: yearEnd,
      });
    // One who declined stops the whole batch, and nothing is allocated.
    const refused = await allocate([deepa.id, chitra.id]);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'TRN.NOT_OPTED', params: { names: 'Chitra Rao' } });
    expect(
      (await get('/console/passenger-allocations?assigned=true')).body.items.map(
        (r: { member: { name: string } }) => r.member.name,
      ),
    ).not.toContain('Deepa Rao');
    const ok = await allocate([deepa.id]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    // The family changes its mind: the transport desk records it, with a reason (TRN-035).
    const choose = (who: Payer, body: object) =>
      request(f.app).put(`/api/v1/console/transport-choices/${who.id}`).set(con).send(body);
    expect((await choose(chitra, { opted: true, reason: 'x' })).body.errors[0].code).toBe(
      'TRN.CHOICE_REASON',
    );
    const changed = await choose(chitra, { opted: true, reason: 'Parent asked at the desk' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toEqual({ memberId: chitra.id, transport: { opted: true, stop: null } });
    expect((await allocate([chitra.id])).status).toBe(201);
    const audit = await f.t.db
      .selectFrom('audit_log')
      .select(['action'])
      .where('institution_id', '=', f.school.rowId)
      .where('action', '=', 'TRANSPORT_CHOICE_CHANGED')
      .execute();
    expect(audit).toHaveLength(1);
    // Not opted while still allocated: the allocation is ended first.
    expect((await choose(deepa, { opted: false, reason: 'Moving away' })).body.code).toBe(
      'TRN.OPT_OUT_ALLOCATED',
    );
    // Added directly: no choice on record to change, and they can be allocated already.
    expect((await choose(asha, { opted: false, reason: 'Testing' })).body.code).toBe(
      'TRN.NO_TRANSPORT_CHOICE',
    );
  });
});

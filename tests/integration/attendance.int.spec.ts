/**
 * Attendance on a real MySQL (Phase 7.5; SRS 21.5–21.16; ATT-002, ATT-008…023, ATT-026; RC-38;
 * OI-ATT-05…24; OQ-14):
 * - gate taps: one record per member and day, a student Present, a non-student Present or Late by the
 *   cut-off and checked out (Half day before the threshold), the double-tap guard, a closed record;
 * - period and location readers; the front desk; attendance types and visitors;
 * - manual marking and the class teacher's register override a record and keep old → new; an Absent
 *   tells the family; the overview, reports, the member's month and the principal's day;
 * - auto-absent is off until set and runs once a day after the cut-off.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import { adminUrl } from './db';
import { mobile, schoolFixture, type Auth, type Payer } from './school';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';

const IST = { timeZone: 'Asia/Kolkata' } as const;
const today = () => new Intl.DateTimeFormat('en-CA', IST).format(new Date());
const istMinutes = () => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    ...IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .split(':')
    .map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

describe.skipIf(!adminUrl)('attendance on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let ravi: Payer;
  let meena: Payer;
  let asha: Payer;
  let bala: Payer;
  let principal: Auth;
  let section6A: string;
  let ashaCard: string;
  let meenaCard: string;
  let gate: Awaited<ReturnType<Awaited<ReturnType<typeof schoolFixture>>['terminal']>>;
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const put = (path: string, auth: Auth, body: object, ver?: number) => {
    let r = request(f.app).put(`/api/v1${path}`).set(auth);
    if (ver !== undefined) r = r.set('If-Match', `"v${ver}"`);
    return r.send(body);
  };
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const tap = (reader: { auth: Auth }, cardToken: string) =>
    post('/terminal/reader/taps', reader.auth, { cardToken });
  /** Lets the next tap of a card through the double-tap guard. */
  const wait = async (profileRowId: string) =>
    f.t.db
      .updateTable('cards')
      .set({ last_tap_at: new Date(Date.now() - 5 * 60_000) })
      .where('profile_id', '=', profileRowId)
      .execute();

  beforeAll(async () => {
    f = await schoolFixture('Attendance School');
    con = f.school.con;
    ravi = await f.payer('Ravi', 0);
    meena = await f.payer('Meena', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    const classes = (await get('/console/classes', con)).body.items as {
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
    ashaCard = await f.card(asha.rowId);
    meenaCard = await f.card(meena.rowId);
    gate = await f.terminal('ATTENDANCE');
    // A principal.
    const t = await post('/console/user-types', con, {
      name: 'Principal',
      category: 'PRINCIPAL',
      departments: ['Leadership'],
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const typeId = (await get('/console/user-types', con)).body.items.find(
      (x: { name: string }) => x.name === 'Principal',
    ).id;
    const mob = mobile();
    const tokens = await f.signUp(mob, 'Lakshmi');
    const pr = await onboardStaff(f.app, con, {
      userTypeId: typeId,
      firstName: 'Lakshmi',
      mobile: mob,
    });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    principal = await f.onProfile(tokens, pr.body.id);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('records gate taps: one record a day, late after the cut-off, check-out and the double-tap guard', async () => {
    const student = await tap(gate, ashaCard);
    expect(student.status, JSON.stringify(student.body)).toBe(200);
    expect(student.body).toMatchObject({
      result: 'CHECKED_IN',
      status: 'PRESENT',
      member: { name: 'Asha Rao', classSection: 'Grade 6 A' },
    });
    expect((await tap(gate, ashaCard)).body.code).toBe('ATT.DOUBLE_TAP');
    await wait(asha.rowId);
    expect((await tap(gate, ashaCard)).body.code).toBe('ATT.ALREADY_COMPLETED');

    const teacher = await tap(gate, meenaCard);
    expect(teacher.body).toMatchObject({
      result: 'CHECKED_IN',
      status: istMinutes() <= 615 ? 'PRESENT' : 'LATE',
    });
    await wait(meena.rowId);
    const out = await tap(gate, meenaCard);
    expect(out.body).toMatchObject({ result: 'CHECKED_OUT', status: 'HALF_DAY' });
    await wait(meena.rowId);
    expect((await tap(gate, meenaCard)).body.code).toBe('ATT.ALREADY_COMPLETED');
    expect((await tap(gate, 'NFC9999999999999')).body.code).toBe('ATT.CARD_NOT_ACTIVE');
    const events = await f.t.db
      .selectFrom('attendance_events')
      .select(['action', 'old_status', 'new_status'])
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.action)).toEqual(['CHECK-IN', 'CHECK-IN', 'CHECK-OUT']);
  });

  it('records period and location taps, the front desk and visitors', async () => {
    // A period running now for 6 A today (written directly: the timetable API keeps Monday–Saturday).
    const now = istMinutes();
    const start = Math.max(0, now - 5);
    const end = Math.min(23 * 60 + 59, now + 30);
    const period = newPublicIdPair();
    const inst = String(f.school.rowId);
    const p = await f.t.db
      .insertInto('periods')
      .values({
        public_id: period.bin,
        institution_id: inst,
        name: 'Period X',
        starts_at: hhmm(start),
        ends_at: hhmm(end),
        is_break: 0,
      })
      .executeTakeFirstOrThrow();
    const subject = await post('/console/subjects', con, { code: 'MAT', name: 'Mathematics' });
    const sec = await f.t.db
      .selectFrom('sections')
      .select(['id'])
      .where('public_id', '=', uuidToBin(section6A))
      .executeTakeFirstOrThrow();
    const sub = await f.t.db
      .selectFrom('subjects')
      .select('id')
      .where('public_id', '=', uuidToBin(subject.body.id))
      .executeTakeFirstOrThrow();
    const year = await f.t.db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', inst)
      .where('is_current', '=', 1)
      .executeTakeFirstOrThrow();
    const wd = new Date(`${today()}T00:00:00Z`).getUTCDay();
    await f.t.db
      .insertInto('timetable_slots')
      .values({
        institution_id: inst,
        year_id: String(year.id),
        section_id: String(sec.id),
        day: wd === 0 ? 7 : wd,
        period_id: String(p.insertId),
        subject_id: String(sub.id),
        teacher_profile_id: meena.rowId,
        updated_at: new Date(),
      })
      .execute();
    const reader = await f.terminal('PERIOD_ATTENDANCE', { sectionId: section6A });
    await wait(asha.rowId);
    const ptap = await tap(reader, ashaCard);
    expect(ptap.status, JSON.stringify(ptap.body)).toBe(200);
    expect(ptap.body).toMatchObject({
      result: 'PERIOD_RECORDED',
      status: now > start ? 'LATE' : 'PRESENT',
      period: { name: 'Period X', subject: 'Mathematics' },
    });
    await wait(asha.rowId);
    expect((await tap(reader, ashaCard)).body.code).toBe('ATT.PERIOD_COMPLETED');
    await wait(meena.rowId);
    expect((await tap(reader, meenaCard)).body.code).toBe('ATT.NOT_IN_CLASS');
    const config = await get('/terminal/reader/config', reader.auth);
    expect(config.body).toMatchObject({
      section: 'Grade 6 A',
      attendance: { doubleTapSeconds: 30, period: { name: 'Period X' } },
    });

    // The teacher's periods and marking (slot = section.period).
    const mine = await get('/teacher/attendance/periods', meena.auth);
    expect(mine.body.items).toEqual([expect.objectContaining({ captured: 1, students: 2 })]);
    const slotId = mine.body.items[0].slotId as string;
    expect(slotId).toBe(`${section6A}.${period.id}`);
    expect(
      (
        await put(`/teacher/attendance/periods/${slotId}`, ravi.auth, {
          date: today(),
          entries: [{ studentId: bala.id, status: 'PRESENT' }],
        })
      ).body.code,
    ).toBe('ATT.NOT_YOUR_PERIOD');
    const marked = await put(`/teacher/attendance/periods/${slotId}`, meena.auth, {
      date: today(),
      entries: [
        { studentId: bala.id, status: 'PRESENT' },
        { studentId: asha.id, status: 'ABSENT' },
      ],
    });
    expect(marked.body).toMatchObject({ saved: 1 }); // Asha's card tap stays
    expect((await get('/teacher/attendance/periods', meena.auth)).body.items[0].captured).toBe(2);

    // Location: an attendance type, its reader and the front desk.
    const type = await post('/console/attendance-types', con, {
      name: 'Library',
      cooldownSeconds: 60,
    });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    expect((await post('/console/attendance-types', con, { name: 'Library' })).body.code).toBe(
      'ATT.TYPE_TAKEN',
    );
    const library = await f.terminal('LOCATION', { locationType: 'Library' });
    await wait(asha.rowId);
    expect((await tap(library, ashaCard)).body).toMatchObject({
      result: 'LOCATION_RECORDED',
      location: 'Library',
    });
    await wait(asha.rowId);
    const again = await tap(library, ashaCard);
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: 'ATT.LOCATION_WAIT' });
    const desk = await post('/console/location-attendance', con, {
      attendanceTypeId: type.body.id,
      memberId: bala.id,
    });
    expect(desk.status, JSON.stringify(desk.body)).toBe(201);
    expect(desk.body).toMatchObject({ method: 'MANUAL', location: 'Library' });
    expect(
      (
        await post('/console/location-attendance', con, {
          attendanceTypeId: type.body.id,
          memberId: bala.id,
        })
      ).body.code,
    ).toBe('ATT.LOCATION_WAIT');
    expect((await get('/console/attendance-types', con)).body.items[0]).toMatchObject({
      name: 'Library',
      checkInsToday: 2,
      readers: 1,
    });

    const v = await post('/console/visitors', con, {
      name: 'Suresh Kamath',
      mobile: '9845012345',
      purpose: 'Parent meeting',
      toMeet: 'Ravi',
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body).toMatchObject({ mobile: '••••••2345', inside: true });
    expect(
      (await post('/console/visitors', con, { name: 'X', mobile: '123', purpose: 'Hi' })).body
        .errors[0].code,
    ).toBe('ATT.VISITOR_DETAILS');
    expect((await post(`/console/visitors/${v.body.id}/checkout`, con)).body.inside).toBe(false);
    expect((await post(`/console/visitors/${v.body.id}/checkout`, con)).body.code).toBe(
      'ATT.VISITOR_OUT',
    );
    expect((await get('/console/visitors', con)).body.counts).toMatchObject({
      total: 1,
      inside: 0,
    });
  });

  it('marks and overrides by hand, keeps old → new, tells the family and reports', async () => {
    expect(
      (
        await put('/console/attendance/daily', con, {
          date: '2099-01-01',
          entries: [{ memberId: bala.id, status: 'ABSENT' }],
        })
      ).body.errors[0].code,
    ).toBe('ATT.FUTURE_DATE');
    const daily = await put('/console/attendance/daily', con, {
      date: today(),
      entries: [
        { memberId: bala.id, status: 'ABSENT', remark: 'No show' },
        { memberId: asha.id, status: 'ABSENT' },
      ],
    });
    expect(daily.status, JSON.stringify(daily.body)).toBe(200);
    expect(daily.body).toMatchObject({ saved: 1, overridden: 1 });
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain(
      'Asha was marked absent on',
    );
    const override = await f.t.db
      .selectFrom('attendance_events')
      .select(['old_status', 'new_status'])
      .where('action', '=', 'MANUAL-ATTENDANCE')
      .orderBy('id')
      .execute();
    expect(override).toEqual(
      expect.arrayContaining([{ old_status: 'PRESENT', new_status: 'ABSENT' }]),
    );

    // The class teacher's register.
    expect((await get('/teacher/attendance/register', meena.auth)).body.code).toBe(
      'ATT.NO_CLASSES',
    );
    const reg = await get('/teacher/attendance/register', ravi.auth);
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(reg.body).toMatchObject({
      section: { label: 'Grade 6 A' },
      counts: { students: 2, absent: 2 },
    });
    const saved = await put('/teacher/attendance/register', ravi.auth, {
      classSectionId: section6A,
      date: today(),
      entries: [
        { studentId: asha.id, status: 'PRESENT' },
        { studentId: bala.id, status: 'LATE' },
      ],
    });
    expect(saved.body).toMatchObject({ saved: 0, overridden: 2 });
    expect(
      (
        await put('/teacher/attendance/register', ravi.auth, {
          classSectionId: section6A,
          date: today(),
          entries: [{ studentId: meena.id, status: 'PRESENT' }],
        })
      ).body.errors[0].code,
    ).toBe('ATT.MEMBER_NOT_FOUND');

    const overview = await get('/console/attendance/overview', con);
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.sections).toEqual([
      expect.objectContaining({
        section: expect.objectContaining({ label: 'Grade 6 A' }),
        students: 2,
        present: 1,
        late: 1,
        absent: 0,
        percentage: 100,
      }),
    ]);
    expect(overview.body.staff.teachers).toMatchObject({ halfDay: 1 });
    const report = await get(
      `/console/attendance/reports?from=${today()}&to=${today()}&type=STUDENT`,
      con,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          member: expect.objectContaining({ name: 'Asha Rao' }),
          present: 1,
        }),
      ]),
    );
    expect(
      (await get('/console/attendance/reports?from=2026-01-01&to=2026-12-31', con)).body.errors[0]
        .code,
    ).toBe('ATT.RANGE');

    const month = await get('/me/attendance', asha.auth);
    expect(month.status, JSON.stringify(month.body)).toBe(200);
    expect(month.body.items.find((d: { date: string }) => d.date === today())).toMatchObject({
      status: 'PRESENT',
    });
    const pDay = await get('/principal/attendance', principal);
    expect(pDay.body.items).toEqual([expect.objectContaining({ students: 2, attended: 2 })]);
    const teachers = await get('/principal/attendance?type=TEACHERS', principal);
    expect(teachers.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          member: expect.objectContaining({ name: 'Meena' }),
          status: 'HALF_DAY',
        }),
      ]),
    );
    const overviewP = await get('/principal/overview', principal);
    expect(overviewP.body.attendanceToday.students).toMatchObject({
      total: 2,
      attended: 2,
      absent: 0,
    });
    const roster = await get(`/teacher/classes/${section6A}/students`, ravi.auth);
    expect(
      roster.body.items.map((r: { attendanceToday: string }) => r.attendanceToday).sort(),
    ).toEqual(['LATE', 'PRESENT']);
  });

  it('keeps auto-absent off until set and runs it once a day after the cut-off', async () => {
    const s = await get('/console/attendance/auto-absent', con);
    expect(s.body).toMatchObject({ enabled: false, version: 0, runs: [] });
    expect(
      (
        await put(
          '/console/attendance/auto-absent',
          con,
          { enabled: true, cutoff: '05:00', appliesTo: ['STUDENTS'] },
          0,
        )
      ).body.errors[0].code,
    ).toBe('ATT.CUTOFF');
    const on = await put(
      '/console/attendance/auto-absent',
      con,
      { enabled: true, cutoff: '07:00', appliesTo: ['STUDENTS', 'STAFF'] },
      0,
    );
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({
      enabled: true,
      cutoff: '07:00',
      appliesTo: ['STUDENTS', 'STAFF'],
      version: 1,
    });
    expect(
      (
        await put(
          '/console/attendance/auto-absent',
          con,
          { enabled: false, cutoff: '07:00', appliesTo: [] },
          0,
        )
      ).status,
    ).toBe(412);
    // A member with no record today: Ravi (staff). Run the job twice.
    const run = () =>
      request(f.app)
        .post('/api/v1/ops/jobs/auto-absent/runs')
        .set(f.ops)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Integration test of auto-absent' });
    const first = await run();
    expect([200, 201, 202], JSON.stringify(first.body)).toContain(first.status);
    await run();
    const after = await get('/console/attendance/auto-absent', con);
    const sunday = new Date(`${today()}T00:00:00Z`).getUTCDay() === 0;
    const ravisDay = await f.t.db
      .selectFrom('attendance_days')
      .select(['status', 'method'])
      .where('profile_id', '=', ravi.rowId)
      .executeTakeFirst();
    if (istMinutes() >= 7 * 60) {
      expect(after.body.runs).toHaveLength(1);
      expect(after.body.runs[0]).toMatchObject({ date: today(), skippedHoliday: sunday });
      if (!sunday) expect(ravisDay).toMatchObject({ status: 'ABSENT', method: null });
    } else {
      expect(after.body.runs).toEqual([]);
    }
  });
});

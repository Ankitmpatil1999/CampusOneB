/**
 * Staff timings by role on a real MySQL (client 2026-10-23; ATT-033…036; the Auto-absent page):
 * - the school keeps as many timings as it needs, each for roles not in another, with the times in
 *   the day's order; one is changed with If-Match and removed;
 * - a staff member's login is Present, Late, a Half day or Absent by their timing, a logout before
 *   the early logout time makes the day a Half day; staff without a timing keep the school's rules;
 * - after a timing's absent time the job `auto-absent` marks its staff with no login Absent, once.
 *
 * The check-ins and the job run on their own clock (the services, not the HTTP app), on a school day.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';
import { AttendanceAdminService } from '../../services/attendance-admin.service';
import { AttendanceService } from '../../services/attendance.service';
import type { Principal } from '../../utils/principal';

const IST = { timeZone: 'Asia/Kolkata' } as const;
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', IST).format(d);
/** Today, or tomorrow when today is a Sunday. */
const schoolDay = () => {
  const today = ymd(new Date());
  return new Date(`${today}T00:00:00Z`).getUTCDay() === 0
    ? ymd(new Date(Date.now() + 86_400_000))
    : today;
};

describe.skipIf(!adminUrl)('staff timings by role on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  const staff: Record<string, Payer> = {};
  let teacherRole: string;
  let deskRole: string;
  const post = (path: string, body: object) =>
    request(f.app).post(`/api/v1${path}`).set(con).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string) => request(f.app).get(`/api/v1${path}`).set(con);
  const times = {
    loginTime: '08:30',
    lateLoginTime: '08:45',
    halfDayTime: '11:00',
    absentTime: '13:00',
    earlyLogoutTime: '16:00',
    logoutTime: '16:30',
  };

  beforeAll(async () => {
    f = await schoolFixture('Staff Timings School');
    con = f.school.con;
    for (const name of ['Ravi', 'Meena', 'Kavya', 'Raju', 'Lata', 'Suma']) {
      staff[name] = await f.payer(name, 0);
    }
    const roles = await f.t.db
      .selectFrom('roles')
      .select(['id', 'code'])
      .where('code', 'in', ['TEACHER', 'FRONT_DESK'])
      .execute();
    const roleId = (code: string) => String(roles.find((r) => r.code === code)!.id);
    // Everyone but Suma is a Teacher; Suma has no role (the school's rules).
    for (const name of ['Ravi', 'Meena', 'Kavya', 'Raju', 'Lata']) {
      await f.t.db
        .insertInto('profile_roles')
        .values({
          institution_id: f.school.rowId,
          profile_id: staff[name]!.rowId,
          role_id: roleId('TEACHER'),
          created_at: new Date(),
        })
        .execute();
    }
    const offered = (await get('/console/attendance/staff-timings')).body.roles as {
      id: string;
      name: string;
    }[];
    teacherRole = offered.find((r) => r.name === 'Teacher')!.id;
    deskRole = offered.find((r) => r.name === 'Front desk')!.id;
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('keeps timings by role: the times in order, a role in one timing, If-Match (ATT-033…036)', async () => {
    const empty = await get('/console/attendance/staff-timings');
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.items).toEqual([]);
    const names = (empty.body.roles as { name: string; timingId: string | null }[]).map(
      (r) => r.name,
    );
    expect(names).toEqual(expect.arrayContaining(['Teacher', 'Front desk', 'Accountant']));
    expect(names).not.toContain('Merchant');
    expect(names).not.toContain('Vendor merchant');

    const wrong = await post('/console/attendance/staff-timings', {
      name: 'T',
      roleIds: [],
      ...times,
      lateLoginTime: '08:15',
      earlyLogoutTime: '17:00',
    });
    expect(wrong.status).toBe(422);
    expect(
      wrong.body.errors.map((e: { field: string; code: string }) => [e.field, e.code]),
    ).toEqual([
      ['name', 'ATT.TIMING_NAME'],
      ['roleIds', 'ATT.TIMING_ROLES'],
      ['lateLoginTime', 'ATT.TIMING_AFTER'],
      ['earlyLogoutTime', 'ATT.TIMING_BEFORE'],
    ]);
    expect(wrong.body.errors[2].message).toBe('Must be after the login time.');

    const teaching = await post('/console/attendance/staff-timings', {
      name: 'Teaching staff',
      roleIds: [teacherRole],
      ...times,
    });
    expect(teaching.status, JSON.stringify(teaching.body)).toBe(201);
    expect(teaching.body).toMatchObject({
      name: 'Teaching staff',
      roles: [{ id: teacherRole, name: 'Teacher' }],
      ...times,
      staff: 5,
      version: 1,
    });
    // A role is in one timing only; the names are the school's own.
    const twice = await post('/console/attendance/staff-timings', {
      name: 'Office',
      roleIds: [deskRole, teacherRole],
      ...times,
    });
    expect(twice.status).toBe(422);
    expect(twice.body.errors[0]).toMatchObject({
      field: 'roleIds',
      code: 'ATT.TIMING_ROLE_TAKEN',
      message: 'Teacher already follows “Teaching staff”. A role can be in one timing only.',
    });
    const office = await post('/console/attendance/staff-timings', {
      name: 'Office',
      roleIds: [deskRole],
      ...times,
      loginTime: '09:00',
      lateLoginTime: '09:15',
    });
    expect(office.status, JSON.stringify(office.body)).toBe(201);
    expect(office.body.staff).toBe(0);
    expect(
      (
        await post('/console/attendance/staff-timings', {
          name: 'Office',
          roleIds: [deskRole],
          ...times,
        })
      ).body.errors,
    ).toContainEqual(expect.objectContaining({ field: 'name', code: 'ATT.TIMING_TAKEN' }));

    const put = (version: number, body: object) =>
      request(f.app)
        .put(`/api/v1/console/attendance/staff-timings/${office.body.id}`)
        .set(con)
        .set('If-Match', `"v${version}"`)
        .send(body);
    const changed = { name: 'Office', roleIds: [deskRole], ...times, absentTime: '12:30' };
    expect((await put(0, changed)).status).toBe(412);
    const ok = await put(1, changed);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.headers.etag).toBe('"v2"');
    expect(ok.body).toMatchObject({ absentTime: '12:30', version: 2 });

    const list = await get('/console/attendance/staff-timings');
    expect(list.body.items.map((i: { name: string }) => i.name)).toEqual([
      'Teaching staff',
      'Office',
    ]);
    expect(list.body.roles.find((r: { id: string }) => r.id === deskRole).timingId).toBe(
      office.body.id,
    );
    const gone = await request(f.app)
      .delete(`/api/v1/console/attendance/staff-timings/${office.body.id}`)
      .set(con);
    expect(gone.status).toBe(204);
    const after = await get('/console/attendance/staff-timings');
    expect(after.body.items).toHaveLength(1);
    expect(after.body.roles.find((r: { id: string }) => r.id === deskRole).timingId).toBeNull();
    expect(
      (
        await request(f.app)
          .delete(`/api/v1/console/attendance/staff-timings/${office.body.id}`)
          .set(con)
      ).status,
    ).toBe(404);
  });

  it('marks staff by their timing: late, half day, absent, an early logout and the job (client 2026-10-23)', async () => {
    const day = schoolDay();
    let clock = new Date();
    const now = () => clock;
    const s = f.h.services;
    const attendance = new AttendanceService({
      db: f.t.db,
      cards: s.cards,
      settings: s.settings,
      now,
    });
    const admin = new AttendanceAdminService({ db: f.t.db, attendance, now });
    const desk: Principal = {
      subject: randomUUID(),
      surface: 'console',
      sessionId: randomUUID(),
      institutionId: f.school.id,
      subTasks: [],
    };
    const at = (hhmm: string) => {
      clock = new Date(`${day}T${hhmm}:00+05:30`);
    };
    const check = async (name: string, action: 'IN' | 'OUT', hhmm: string) => {
      at(hhmm);
      return attendance.deskCheck(desk, { memberId: staff[name]!.id, action });
    };

    // The Teaching staff timing: Present to 08:45, Late to 11:00, Half day to 13:00, then Absent.
    expect((await check('Ravi', 'IN', '08:40')).status).toBe('PRESENT');
    expect((await check('Meena', 'IN', '09:05')).status).toBe('LATE');
    expect((await check('Kavya', 'IN', '11:20')).status).toBe('HALF_DAY');
    expect((await check('Raju', 'IN', '13:20')).status).toBe('ABSENT');
    // No role, no timing: the school's late cut-off (10:15).
    expect((await check('Suma', 'IN', '09:40')).status).toBe('PRESENT');

    // A logout before 16:00 makes the day a Half day; after it the day stays as it was.
    expect((await check('Ravi', 'OUT', '15:40')).status).toBe('HALF_DAY');
    expect((await check('Meena', 'OUT', '16:20')).status).toBe('LATE');
    expect((await check('Kavya', 'OUT', '16:35')).status).toBe('HALF_DAY');
    await expect(check('Raju', 'OUT', '16:35')).rejects.toMatchObject({
      code: 'ATT.ALREADY_COMPLETED',
    });
    const rows = await f.t.db
      .selectFrom('attendance_days')
      .select(['profile_id', 'checkin_status', 'status'])
      .where('att_date', '=', day)
      .execute();
    const of = (name: string) => rows.find((r) => String(r.profile_id) === staff[name]!.rowId);
    expect(of('Kavya')).toMatchObject({ checkin_status: 'LATE', status: 'HALF_DAY' });
    expect(of('Raju')).toMatchObject({ checkin_status: 'ABSENT', status: 'ABSENT' });

    // The job: nothing before the absent time; after it Lata (no login) is Absent, once. Suma has
    // no timing and the school's auto-absent is off: left alone.
    const run = async (hhmm: string) => {
      at(hhmm);
      const items: { note: string | null; processed: number }[] = [];
      await admin.run({
        item: (i) => items.push(i),
        scope: { institutionId: f.school.rowId },
      });
      return items;
    };
    expect(await run('12:59')).toEqual([]);
    expect(await run('13:05')).toEqual([
      expect.objectContaining({ note: 'Teaching staff: 1 staff marked absent', processed: 1 }),
    ]);
    expect(await run('13:20')).toEqual([]);
    const lata = await f.t.db
      .selectFrom('attendance_days')
      .select(['status'])
      .where('att_date', '=', day)
      .where('profile_id', '=', staff['Lata']!.rowId)
      .execute();
    expect(lata).toEqual([{ status: 'ABSENT' }]);
    const runs = (await get('/console/attendance/auto-absent')).body.runs;
    expect(runs).toContainEqual(
      expect.objectContaining({ date: day, marked: 1, timing: 'Teaching staff' }),
    );
  });
});

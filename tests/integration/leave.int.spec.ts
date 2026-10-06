/**
 * Student and staff leave on a real MySQL (Phase 7.4; SRS 20.26–20.30; ACA-042, ACA-043, ACA-055…064,
 * ACA-072…074, ACA-076; BR-53; OI-ACA-44…51):
 * - a student's leave counts school days only, never overlaps, is decided by the class teacher alone
 *   (remarks when rejecting) and can be withdrawn while pending;
 * - a teacher's leave goes to the coordinator, then the principal (only after a recommendation); other
 *   staff go to the principal; balances, overlaps and cancellation hold; no one decides their own;
 * - the principal's overview and people lists.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, schoolFixture, type Auth, type Payer } from './school';

const istDay = (offset = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + offset * 86_400_000),
  );
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const next = (weekday: number) => {
  let d = istDay(1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== weekday) d = addDays(d, 1);
  return d;
};

describe.skipIf(!adminUrl)('leave on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let meena: Payer;
  let ravi: Payer;
  let asha: Payer;
  let principal: Auth;
  let staff: Auth;
  const mon = next(1);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const thu = addDays(mon, 3);
  const fri = addDays(mon, 4);
  const post = (path: string, auth: Auth, body: object = {}, ver?: number) => {
    let r = request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID());
    if (ver !== undefined) r = r.set('If-Match', `"v${ver}"`);
    return r.send(body);
  };
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const memberOfType = async (name: string, category: string, first: string) => {
    const t = await post('/console/user-types', con, { name, category, departments: [name] });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const typeId = (await get('/console/user-types', con)).body.items.find(
      (x: { name: string }) => x.name === name,
    ).id;
    const mob = mobile();
    const tokens = await f.signUp(mob, first);
    const m = await post('/console/members', con, {
      userTypeId: typeId,
      firstName: first,
      mobile: mob,
    });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    return f.onProfile(tokens, m.body.id);
  };

  beforeAll(async () => {
    f = await schoolFixture('Leave School');
    con = f.school.con;
    meena = await f.payer('Meena', 0);
    ravi = await f.payer('Ravi', 0);
    asha = await f.student('Asha');
    const classes = (await get('/console/classes', con)).body.items as {
      name: string;
      sections: { id: string }[];
    }[];
    const section6A = classes.find((c) => c.name === 'Grade 6')!.sections[0]!.id;
    expect(
      (
        await post('/console/teacher-assignments', con, {
          kind: 'CLASS_TEACHER',
          teacherId: ravi.id,
          sectionIds: [section6A],
        })
      ).status,
    ).toBe(201);
    principal = await memberOfType('Principal', 'PRINCIPAL', 'Lakshmi');
    staff = await memberOfType('Office staff', 'STAFF', 'Sunil');
    // A school holiday on Wednesday for everyone.
    const hol = await post('/console/calendar-events', con, {
      type: 'Holiday',
      title: 'Mid-term break',
      allDay: true,
      startDate: wed,
      endDate: wed,
      audience: { kind: 'ALL' },
    });
    expect(hol.status, JSON.stringify(hol.body)).toBe(201);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('counts school days, refuses overlaps, and lets only the class teacher decide', async () => {
    const apply = (body: object) =>
      post('/me/leaves', asha.auth, { reason: 'Family function in Udupi', ...body });
    expect((await apply({ from: istDay(-1), to: istDay(-1) })).body.errors[0].code).toBe(
      'ACA.LEAVE_PAST',
    );
    expect((await apply({ from: tue, to: mon })).body.errors[0].code).toBe('ACA.LEAVE_DATES');
    expect((await apply({ from: mon, to: mon, reason: 'Fever' })).body.errors[0].code).toBe(
      'ACA.LEAVE_REASON',
    );
    expect((await apply({ from: wed, to: wed })).body.errors[0].code).toBe('ACA.NON_SCHOOL_DAYS');
    const sunday = addDays(mon, -1) >= istDay(0) ? addDays(mon, -1) : addDays(mon, 6);
    expect((await apply({ from: sunday, to: sunday })).body.errors[0].code).toBe(
      'ACA.NON_SCHOOL_DAYS',
    );
    const first = await apply({ from: mon, to: wed });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      status: 'PENDING',
      schoolDays: 2,
      reference: expect.stringMatching(/^SL-\d{6}$/),
      section: { label: 'Grade 6 A' },
    });
    const clash = await apply({ from: tue, to: thu });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'ACA.LEAVE_OVERLAP' });
    expect(JSON.stringify((await get('/me/notifications', ravi.auth)).body)).toContain(
      'Leave request from Asha Rao',
    );

    const queue = await get('/teacher/student-leaves', ravi.auth);
    expect(queue.body).toMatchObject({ classTeacher: true, counts: { pending: 1 } });
    expect((await get('/teacher/student-leaves', meena.auth)).body).toMatchObject({
      classTeacher: false,
      items: [],
    });
    const id = first.body.id as string;
    expect(
      (await post(`/teacher/student-leaves/${id}/decision`, meena.auth, { decision: 'APPROVED' }))
        .body.code,
    ).toBe('ACA.CLASS_TEACHER_ONLY');
    expect(
      (await post(`/teacher/student-leaves/${id}/decision`, ravi.auth, { decision: 'REJECTED' }))
        .body.errors[0].code,
    ).toBe('ACA.DECISION_REMARKS');
    const ok = await post(`/teacher/student-leaves/${id}/decision`, ravi.auth, {
      decision: 'APPROVED',
      remarks: 'Enjoy the function',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'APPROVED',
      decidedBy: 'Ravi',
      remarks: 'Enjoy the function',
    });
    expect(
      (await post(`/teacher/student-leaves/${id}/decision`, ravi.auth, { decision: 'APPROVED' }))
        .body.code,
    ).toBe('ACA.LEAVE_NOT_PENDING');
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain(
      'Leave approved for Asha',
    );

    const second = await apply({ from: thu, to: fri });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const withdrawn = await post(`/me/leaves/${second.body.id}/withdrawal`, asha.auth);
    expect(withdrawn.body.status).toBe('CANCELLED');
    expect((await post(`/me/leaves/${second.body.id}/withdrawal`, asha.auth)).body.code).toBe(
      'ACA.LEAVE_NOT_PENDING',
    );
    const mine = await get('/me/leaves', asha.auth);
    expect(mine.body).toMatchObject({
      classTeacher: 'Ravi',
      counts: { pending: 0, approvedDays: 2 },
    });
    expect((await get('/me/staff-leaves', asha.auth)).body.code).toBe('ACA.STAFF_ONLY');
  });

  it('takes teacher leave through the coordinator, then the principal', async () => {
    const apply = (auth: Auth, body: object) =>
      post('/me/staff-leaves', auth, {
        type: 'CASUAL',
        reason: 'Cousin’s wedding in Hubballi',
        ...body,
      });
    const long = await apply(meena.auth, {
      type: 'EARNED',
      from: addDays(mon, 7),
      to: addDays(mon, 40),
    });
    expect(long.body.errors[0]).toMatchObject({
      code: 'ACA.LEAVE_BALANCE',
      params: { left: 15, type: 'earned' },
    });
    const l = await apply(meena.auth, { from: mon, to: wed });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect(l.body).toMatchObject({
      state: 'PENDING',
      days: 2,
      needsCoordinator: true,
      reference: expect.stringMatching(/^TL-/),
    });
    expect((await apply(meena.auth, { from: tue, to: tue })).body.code).toBe('ACA.LEAVE_OVERLAP');
    expect(
      (
        await post(`/principal/teacher-leaves/${l.body.id}/decision`, principal, {
          decision: 'APPROVED',
        })
      ).body.code,
    ).toBe('ACA.COORDINATOR_REVIEW_REQUIRED');
    const list = await get('/console/teacher-leaves', con);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.counts).toMatchObject({ pending: 1, withPrincipal: 0 });
    const detail = await get(`/console/teacher-leaves/${l.body.id}`, con);
    expect(detail.body.balance).toMatchObject({ type: 'CASUAL', total: 12, used: 0, pending: 2 });
    const rec = await post(
      `/console/teacher-leaves/${l.body.id}/coordinator-decision`,
      con,
      { decision: 'APPROVED', remarks: 'Substitution arranged' },
      detail.body.version,
    );
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body).toMatchObject({
      state: 'WITH_PRINCIPAL',
      coordinator: { status: 'APPROVED', remarks: 'Substitution arranged' },
    });
    expect((await post(`/me/staff-leaves/${l.body.id}/cancellation`, meena.auth)).body.code).toBe(
      'ACA.LEAVE_NOT_PENDING',
    );
    expect(JSON.stringify((await get('/me/notifications', principal)).body)).toContain(
      'Leave for your decision: Meena',
    );
    const queue = await get('/principal/teacher-leaves', principal);
    expect(queue.body.counts).toMatchObject({ awaiting: 1 });
    expect(queue.body.items[0]).toMatchObject({ balance: { total: 12, left: 12 } });
    const done = await post(`/principal/teacher-leaves/${l.body.id}/decision`, principal, {
      decision: 'APPROVED',
      remarks: 'Hand over 6 A',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({
      state: 'APPROVED',
      final: { status: 'APPROVED', by: 'Lakshmi' },
    });
    const mine = await get('/me/staff-leaves', meena.auth);
    expect(mine.body.balances.find((b: { type: string }) => b.type === 'CASUAL')).toMatchObject({
      used: 2,
      left: 10,
    });

    // A teacher can cancel a request no one has reviewed.
    const other = await apply(meena.auth, { type: 'MEDICAL', from: thu, to: thu });
    expect(
      (await post(`/me/staff-leaves/${other.body.id}/cancellation`, meena.auth)).body.state,
    ).toBe('CANCELLED');
  });

  it('sends other staff to the principal, never their own, and shows the overview', async () => {
    const s = await post('/me/staff-leaves', staff, {
      type: 'CASUAL',
      from: thu,
      to: fri,
      reason: 'Personal work',
    });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ needsCoordinator: false, state: 'WITH_PRINCIPAL' });
    expect(
      (
        await post(`/principal/teacher-leaves/${s.body.id}/decision`, principal, {
          decision: 'REJECTED',
        })
      ).body.errors[0].code,
    ).toBe('ACA.DECISION_REMARKS');
    const rej = await post(`/principal/teacher-leaves/${s.body.id}/decision`, principal, {
      decision: 'REJECTED',
      remarks: 'Audit week',
    });
    expect(rej.body).toMatchObject({ state: 'REJECTED', final: { remarks: 'Audit week' } });
    const own = await post('/me/staff-leaves', principal, {
      type: 'CASUAL',
      from: thu,
      to: thu,
      reason: 'Board meeting',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(
      (
        await post(`/principal/teacher-leaves/${own.body.id}/decision`, principal, {
          decision: 'APPROVED',
        })
      ).body.code,
    ).toBe('MKR.OWN_APPROVE');
    const overview = await get('/principal/overview', principal);
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body).toMatchObject({
      people: { students: 1, teachers: 2, staff: expect.any(Number) },
      approvals: {
        teacherLeaveAwaitingYou: 1,
        teacherLeaveWithCoordinator: 0,
        studentLeavePending: 0,
      },
    });
    const students = await get('/principal/people', principal);
    expect(students.body.items).toEqual([
      expect.objectContaining({
        name: 'Asha Rao',
        class: 'Grade 6',
        section: 'A',
        admissionNo: expect.any(String),
      }),
    ]);
    const teachers = await get('/principal/people?type=TEACHERS', principal);
    expect(teachers.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Ravi', classTeacherOf: ['Grade 6 A'] }),
      ]),
    );
    expect((await get('/principal/overview', meena.auth)).body.code).toBe('ACA.PRINCIPAL_ONLY');
  });
});

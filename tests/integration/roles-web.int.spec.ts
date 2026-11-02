/**
 * The principal, merchants and vendor merchants on the web (client 2026-10-13) on a real MySQL: the
 * school gives each the matching console role (Principal, Merchant, Vendor merchant — a role meant for
 * another kind of profile is refused); each signs in to the console with the app account's e-mail and
 * password and a code, and works on the same routes as in the app. Without the grant, the routes stay
 * shut.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import { adminUrl } from './db';
import { inr, mobile, schoolFixture, type Auth } from './school';
import { newPublicIdPair } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('the principal, merchants and vendor merchants on the web', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let roles: Record<string, string>;
  let principalId = '';
  let canteen: Awaited<ReturnType<Awaited<ReturnType<typeof schoolFixture>>['merchant']>>;
  let supplies: typeof canteen;
  let principalWeb: Auth;
  let canteenWeb: Auth;
  let suppliesWeb: Auth;

  const get = (path: string, auth: Auth = con) => request(f.app).get(`/api/v1${path}`).set(auth);
  const post = (path: string, body: object, auth: Auth) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const setRoles = (profileId: string, codes: string[]) =>
    request(f.app)
      .put(`/api/v1/console/staff-accounts/${profileId}/roles`)
      .set(con)
      .send({ roleIds: codes.map((c) => roles[c]) });
  /** A console session as the profile's app account; app routes are named with the surface. */
  const onWeb = async (profileId: string) => {
    const p = await f.profileRow(profileId);
    const acc = await f.t.db
      .selectFrom('platform_accounts')
      .select('email')
      .where('id', '=', String(p.account_id))
      .executeTakeFirstOrThrow();
    return { ...(await f.signedIn('console', acc.email!)), 'X-CampusOne-Surface': 'console' };
  };

  beforeAll(async () => {
    f = await schoolFixture('Roles Web School');
    con = f.school.con;
    roles = Object.fromEntries(
      (await get('/console/roles')).body.items.map((r: { code: string; id: string }) => [
        r.code,
        r.id,
      ]),
    );
    // The principal: a member of the school with the Principal user type and an app account.
    await request(f.app)
      .post('/api/v1/console/user-types')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Principal', category: 'PRINCIPAL', departments: ['Office'] });
    const principalType = (await get('/console/user-types')).body.items.find(
      (x: { name: string }) => x.name === 'Principal',
    ).id as string;
    const mob = mobile();
    await f.signUp(mob, 'Kavitha');
    const p = await onboardStaff(f.app, con, {
      userTypeId: principalType,
      firstName: 'Kavitha',
      mobile: mob,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    principalId = p.body.id as string;
    canteen = await f.merchant('Campus Canteen');
    supplies = await f.merchant('Lab Supplies Co', { subType: 'VENDOR' });
  }, 300_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('offers the three roles and gives each only to the matching profile', async () => {
    expect(Object.keys(roles)).toEqual(
      expect.arrayContaining(['PRINCIPAL', 'MERCHANT', 'VENDOR_MERCHANT']),
    );
    // The administrator's own console holds none of them.
    const admin = (await get('/console/session')).body.subTasks as string[];
    expect(admin).not.toContain('task.principal');
    expect(admin).not.toContain('task.business');
    // Merchants are listed with their type, so the matching role can be chosen.
    const accounts = (await get('/console/staff-accounts')).body.items as {
      id: string;
      merchantType: string | null;
    }[];
    expect(accounts.find((a) => a.id === canteen.id)?.merchantType).toBe('REGULAR');
    expect(accounts.find((a) => a.id === supplies.id)?.merchantType).toBe('VENDOR');
    const wrong = async (profileId: string, codes: string[]) => {
      const r = await setRoles(profileId, codes);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      return r.body;
    };
    expect(await wrong(canteen.id, ['VENDOR_MERCHANT'])).toMatchObject({
      code: 'IDN.ROLE_WRONG_PROFILE',
      detail: 'The Vendor merchant role can be given only to a vendor merchant.',
    });
    expect((await wrong(supplies.id, ['MERCHANT'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    expect((await wrong(canteen.id, ['ACCOUNTANT'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    expect((await wrong(principalId, ['MERCHANT'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    expect((await wrong(canteen.id, ['PRINCIPAL'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    for (const [id, code] of [
      [principalId, 'PRINCIPAL'],
      [canteen.id, 'MERCHANT'],
      [supplies.id, 'VENDOR_MERCHANT'],
    ] as const) {
      const r = await setRoles(id, [code]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    principalWeb = await onWeb(principalId);
    canteenWeb = await onWeb(canteen.id);
    suppliesWeb = await onWeb(supplies.id);
  });

  it('opens the principal’s desk on the web, and nothing else', async () => {
    const s = (await get('/console/session', principalWeb)).body;
    expect(s.subTasks).toEqual(
      expect.arrayContaining([
        'task.principal',
        'principal.view',
        'principal.leave',
        'principal.announce',
      ]),
    );
    expect(s.subTasks).not.toContain('home.view');
    const overview = await get('/principal/overview', principalWeb);
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.principal.name).toContain('Kavitha');
    expect((await get('/principal/people?type=TEACHERS', principalWeb)).status).toBe(200);
    expect((await get('/principal/teacher-leaves', principalWeb)).status).toBe(200);
    expect((await get('/principal/attendance', principalWeb)).status).toBe(200);
    expect((await get('/principal/academics', principalWeb)).status).toBe(200);
    expect((await get('/principal/announcements', principalWeb)).status).toBe(200);
    expect((await get('/me/announcement-options', principalWeb)).status).toBe(200);
    // The principal's own pages, as a teacher's.
    expect((await get('/me/staff-leaves', principalWeb)).status).toBe(200);
    expect((await get('/me/notifications', principalWeb)).status).toBe(200);
    // Not the console's pages, nor a merchant's counter, nor a teacher's classes.
    expect((await get('/console/members', principalWeb)).status).toBe(403);
    expect((await get('/merchant/home', principalWeb)).status).toBe(403);
    expect((await get('/teacher/today', principalWeb)).status).toBe(403);
  });

  // SRS 20.32, 20.33 (client 2026-10-14).
  it('shows the principal the Student Overview and the Teacher Overview, read-only', async () => {
    const guardianMobile = mobile();
    const diya = await f.ward('Diya', guardianMobile);
    const meena = await f.payer('Meena', 0);
    const classes = (await get('/console/classes')).body.items as {
      id: string;
      name: string;
      sections: { id: string; name: string }[];
    }[];
    const g6 = classes.find((c) => c.name === 'Grade 6')!;
    const sectionA = g6.sections[0]!;
    const assigned = await post(
      '/console/teacher-assignments',
      { kind: 'CLASS_TEACHER', teacherId: meena.id, sectionIds: [sectionA.id] },
      con,
    );
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);

    // 20.32: every student, with the class and section, admission number and primary contact.
    const students = await get('/principal/student-overview', principalWeb);
    expect(students.status, JSON.stringify(students.body)).toBe(200);
    const s = students.body.items.find((x: { id: string }) => x.id === diya);
    expect(s).toMatchObject({
      class: 'Grade 6',
      section: sectionA.name,
      status: 'ACTIVE',
      contact: { relation: 'FATHER', mobile: guardianMobile },
    });
    expect(s.name.toLowerCase()).toBe('diya rao');
    expect(s.contact.name.toLowerCase()).toBe('guardian rao');
    expect(s.admissionNo).toMatch(/^ADM\//);
    expect(s.memberNo).toMatch(/-\d{5}$/);

    // The student in full (client 2026-10-14): personal details, transport, fees and status.
    const diyaRow = await f.profileRow(diya);
    const yr = await f.t.db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', f.school.rowId)
      .where('is_current', '=', 1)
      .executeTakeFirstOrThrow();
    const at = new Date();
    for (const [seq, label, amount, paid, status] of [
      [1, 'Term 1', 10_000, 10_000, 'PAID'],
      [2, 'Term 2', 15_000, 0, 'DUE'],
    ] as const) {
      await f.t.db
        .insertInto('fee_records')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: f.school.rowId,
          year_id: String(yr.id),
          student_profile_id: String(diyaRow.id),
          source: 'MANUAL',
          instalment_seq: seq,
          label,
          due_date: '2099-0' + seq + '-10',
          amount_paise: amount,
          paid_paise: paid,
          status,
          created_at: at,
          updated_at: at,
        })
        .execute();
    }
    const stop = await f.t.db
      .insertInto('transport_stops')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        name: 'Gopala Circle',
        landmark: 'Near the bus shelter',
        created_at: at,
        updated_at: at,
      })
      .executeTakeFirstOrThrow();
    const route = await f.t.db
      .insertInto('transport_routes')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        code: 'R-07',
        name: 'Gopala – School',
        created_at: at,
        updated_at: at,
      })
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('transport_route_stops')
      .values({
        route_id: String(route.insertId),
        seq: 1,
        stop_id: String(stop.insertId),
        arrival: '07:40:00',
        departure: '16:10:00',
        distance_km: '4.2',
      })
      .execute();
    await f.t.db
      .insertInto('transport_allocations')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        year_id: String(yr.id),
        profile_id: String(diyaRow.id),
        route_id: String(route.insertId),
        stop_id: String(stop.insertId),
        effective_from: '2026-06-01',
        effective_to: '2099-03-31',
        active: 1,
        created_at: at,
      })
      .execute();
    const full = await get(`/principal/student-overview/${diya}`, principalWeb);
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body.student).toMatchObject({
      gender: 'MALE',
      dateOfBirth: '2015-06-01',
      class: 'Grade 6',
      section: sectionA.name,
      classTeacher: expect.stringMatching(/meena/i),
    });
    expect(full.body.family.guardians).toEqual([
      expect.objectContaining({ relation: 'FATHER', mobile: guardianMobile, primary: true }),
    ]);
    expect(full.body.transport.allocation).toMatchObject({
      route: { code: 'R-07' },
      stop: { name: 'Gopala Circle', landmark: 'Near the bus shelter' },
      pickUp: '07:40',
      drop: '16:10',
    });
    // The same on the student's profile in the console (IDN-045; client 2026-10-15); not for staff.
    const member = await get(`/console/members/${diya}`);
    expect(member.status, JSON.stringify(member.body)).toBe(200);
    expect(member.body.transport).toEqual({
      allocation: {
        route: { code: 'R-07', name: 'Gopala – School', type: expect.any(String) },
        stop: { name: 'Gopala Circle', landmark: 'Near the bus shelter' },
        pickUp: '07:40',
        drop: '16:10',
        from: '2026-06-01',
        to: '2099-03-31',
      },
      trips: [],
    });
    expect(full.body.fees.summary).toMatchObject({
      annual: { amount: '250.00' },
      paid: { amount: '100.00' },
      outstanding: { amount: '150.00' },
      paidPercent: 40,
    });
    expect(full.body.fees.next).toMatchObject({ label: 'Term 2', status: 'DUE' });
    expect(full.body.fees.records.map((r: { status: string }) => r.status)).toEqual([
      'PAID',
      'DUE',
    ]);
    expect(full.body.attendance).toMatchObject({ days: 0, percentage: null });
    expect((await get(`/principal/student-overview/${meena.id}`, principalWeb)).status).toBe(404);
    expect((await get(`/principal/student-overview/${diya}`, canteenWeb)).status).toBe(403);

    // 20.33: each teacher of the mapping once, with the first assignment's class and the roles.
    const teachers = await get('/principal/teacher-overview', principalWeb);
    expect(teachers.status, JSON.stringify(teachers.body)).toBe(200);
    expect(teachers.body.classes.map((c: { name: string }) => c.name)).toContain('Grade 6');
    expect(teachers.body.items.find((x: { id: string }) => x.id === meena.id)).toMatchObject({
      primaryClass: { class: 'Grade 6', section: sectionA.name },
      roles: ['CLASS_TEACHER'],
      assignments: 1,
      classIds: [g6.id],
    });
    const d = await get(`/principal/teacher-overview/${meena.id}`, principalWeb);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({
      mobile: meena.mobile,
      counts: { classes: 1, sections: 1, subjects: 0 },
      assignments: [
        { kind: 'CLASS_TEACHER', class: 'Grade 6', section: sectionA.name, subject: null },
      ],
    });
    // With the rest (client 2026-10-14): personal details, the class they lead, timetable,
    // attendance, leave balances, homework, exams, transport and the wallet.
    expect(d.body).toMatchObject({
      memberNo: expect.stringMatching(/-\d{5}$/),
      status: 'ACTIVE',
      campusOneAccount: true,
      consoleRoles: [],
      coordinatorOf: [],
      timetable: { periodsAWeek: 0, lessons: [] },
      today: { status: null, onLeave: false },
      attendance: { days: 0, percentage: null },
      homework: { set: 0, open: 0, toReview: 0 },
      exams: { total: 0, marksEntered: 0, marksDue: 0, upcoming: [] },
      transport: null,
    });
    expect(d.body.classTeacherOf).toEqual([
      { class: 'Grade 6', section: sectionA.name, students: expect.any(Number) },
    ]);
    expect(d.body.classTeacherOf[0].students).toBeGreaterThanOrEqual(1);
    expect(d.body.leave.balances.map((b: { type: string }) => b.type)).toEqual([
      'CASUAL',
      'MEDICAL',
      'EARNED',
    ]);
    expect(d.body.leave.balances[0]).toMatchObject({
      used: 0,
      left: d.body.leave.balances[0].total,
    });
    // Someone with no assignment: an empty list, not an error; another school's id: not found.
    expect(
      (await get(`/principal/teacher-overview/${principalId}`, principalWeb)).body,
    ).toMatchObject({ assignments: [], counts: { classes: 0, sections: 0, subjects: 0 } });
    expect((await get(`/principal/teacher-overview/${randomUUID()}`, principalWeb)).status).toBe(
      404,
    );
    // Without the principal's grant, shut.
    expect((await get('/principal/student-overview', canteenWeb)).status).toBe(403);
    expect((await get('/principal/teacher-overview', canteenWeb)).status).toBe(403);
  });

  it('opens a merchant’s counter on the web: home, a dynamic QR request, collections, settlements and the wallet', async () => {
    const s = (await get('/console/session', canteenWeb)).body;
    expect(s.subTasks).toEqual(
      expect.arrayContaining(['task.business', 'business.view', 'business.collect']),
    );
    expect(s.subTasks).not.toContain('business.assets');
    const home = await get('/merchant/home', canteenWeb);
    expect(home.status, JSON.stringify(home.body)).toBe(200);
    expect(home.body.merchant).toMatchObject({ displayName: 'Campus Canteen' });
    // Dynamic QR on, then a request for ₹45 from the web, and its status.
    const d = await get(`/console/merchants/${canteen.id}`);
    await request(f.app)
      .put(`/api/v1/console/merchants/${canteen.id}/channels`)
      .set(con)
      .set('If-Match', `"v${d.body.version}"`)
      .send({ dynamicQr: true, nfc: false });
    const req = await post(
      '/merchant/payment-requests',
      { kind: 'DYNAMIC_QR', amount: inr('45.00') },
      canteenWeb,
    );
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body.svg).toMatch(/^<svg/);
    const st = await get(`/merchant/payment-requests/${req.body.requestId}`, canteenWeb);
    expect(st.body).toMatchObject({ status: 'PENDING', amount: inr('45.00') });
    const cancel = await post(
      `/merchant/payment-requests/${req.body.requestId}/cancellation`,
      {},
      canteenWeb,
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await get('/merchant/qr-codes', canteenWeb)).body.items.length).toBe(1);
    expect((await get('/merchant/collections', canteenWeb)).status).toBe(200);
    expect((await get('/merchant/settlements', canteenWeb)).status).toBe(200);
    expect((await get('/me/wallets', canteenWeb)).status).toBe(200);
    expect((await get('/me/notifications', canteenWeb)).status).toBe(200);
    // A regular merchant has no vendor assets on the web; nor the principal's desk, nor messages.
    expect((await get('/merchant/assets', canteenWeb)).status).toBe(403);
    expect((await get('/principal/overview', canteenWeb)).status).toBe(403);
    expect((await get('/me/conversations', canteenWeb)).status).toBe(403);
  });

  it('opens a vendor merchant’s counter with its approved assets', async () => {
    const s = (await get('/console/session', suppliesWeb)).body;
    expect(s.subTasks).toEqual(expect.arrayContaining(['task.business', 'business.assets']));
    expect((await get('/merchant/home', suppliesWeb)).body.merchant).toMatchObject({
      displayName: 'Lab Supplies Co',
      subType: 'VENDOR',
    });
    const assets = await get('/merchant/assets', suppliesWeb);
    expect(assets.status, JSON.stringify(assets.body)).toBe(200);
    expect(assets.body.items).toEqual([]);
    // The administrator's console session holds no counter grant.
    expect((await get('/merchant/home', { ...con, 'X-CampusOne-Surface': 'console' })).status).toBe(
      403,
    );
  });
});

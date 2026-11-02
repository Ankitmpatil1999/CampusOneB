/**
 * Console reporting on a real MySQL (Phase 8.5; SRS 24; FR-RPT-01/02; CR-13, CR-17; RPT-001…004):
 * - the home figures of the administrator's role;
 * - the catalogue by area, every report runs with its columns (year in context or a date range);
 * - an unknown report answers 404; a range longer than a year is refused;
 * - exports carry every row with the report's columns.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth } from './school';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!adminUrl)('console reporting on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth = con) =>
    request(f.app).get(`/api/v1${path}`).set(auth).set('X-CampusOne-Surface', 'console');

  beforeAll(async () => {
    f = await schoolFixture('Reports School');
    con = f.school.con;
    await f.student('Asha', 50_000);
    await f.student('Bala', 0);
    await f.payer('Ravi', 10_000);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('shows the administrator’s home figures', async () => {
    const r = await get('/console/home');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.variant).toBe('admin');
    expect(r.body.kpis.members.active).toBeGreaterThanOrEqual(3);
    expect(r.body.kpis.collectionsToday).toMatchObject({
      count: expect.any(Number),
      amount: { currency: 'INR' },
    });
    expect(r.body.kpis).toHaveProperty('attendanceToday.students');
    expect(r.body.kpis.pendingApprovals).toEqual(expect.any(Number));
  });

  it('shows each role its own figures', async () => {
    const admin = await f.t.db
      .selectFrom('profile_roles as pr')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .select(['pr.profile_id', 'pr.role_id', 'pr.institution_id'])
      .where('pr.institution_id', '=', f.school.rowId)
      .where('r.code', '=', 'INSTITUTION_ADMIN')
      .executeTakeFirstOrThrow();
    const expected: Record<string, string[]> = {
      MANAGEMENT: ['members', 'collectionsThisMonth', 'feeCollectionRate', 'attendanceToday'],
      ACCOUNTANT: ['collectedThisYear', 'dueAhead', 'overdue', 'consentPending'],
      COUNSELLOR: ['waitingForReview', 'admitted', 'midTermApplications'],
      ACADEMIC_COORDINATOR: ['teacherLeaveToReview', 'attendanceToday', 'exams', 'periodsAWeek'],
      TRANSPORT_ADMIN: ['tripsToday', 'passengersAllocated', 'vehicles', 'cancelledThisWeek'],
      GRIEVANCE_OFFICER: ['open', 'escalated', 'awaitingChecker', 'resolvedOrClosed'],
      FRONT_DESK: ['gateCheckInsToday', 'attendanceToday', 'readers', 'locationCheckInsToday'],
    };
    try {
      for (const [code, keys] of Object.entries(expected)) {
        const role = await f.t.db
          .selectFrom('roles')
          .select('id')
          .where('code', '=', code)
          .executeTakeFirstOrThrow();
        await f.t.db
          .deleteFrom('profile_roles')
          .where('profile_id', '=', admin.profile_id)
          .execute();
        await f.t.db
          .insertInto('profile_roles')
          .values({
            institution_id: admin.institution_id,
            profile_id: admin.profile_id,
            role_id: String(role.id),
          })
          .execute();
        const r = await get('/console/home');
        expect(r.status, `${code} ${JSON.stringify(r.body)}`).toBe(200);
        expect(Object.keys(r.body.kpis).sort(), code).toEqual([...keys].sort());
      }
    } finally {
      await f.t.db.deleteFrom('profile_roles').where('profile_id', '=', admin.profile_id).execute();
      await f.t.db
        .insertInto('profile_roles')
        .values({
          institution_id: admin.institution_id,
          profile_id: admin.profile_id,
          role_id: admin.role_id,
        })
        .execute();
    }
  });

  it('lists the catalogue and runs every report', async () => {
    const cat = await get('/console/reports');
    expect(cat.status, JSON.stringify(cat.body)).toBe(200);
    expect(cat.body.areas).toEqual(
      expect.arrayContaining(['People & wallets', 'Fees', 'Academics', 'Communication']),
    );
    const reports = cat.body.reports as { id: string; columns: { key: string }[] }[];
    expect(reports.length).toBeGreaterThanOrEqual(20);
    const failures: string[] = [];
    for (const rep of reports) {
      const r = await get(`/console/reports/${rep.id}`);
      if (r.status !== 200) failures.push(`${rep.id} → ${r.status} ${JSON.stringify(r.body)}`);
      else if (r.body.columns.length !== rep.columns.length) failures.push(`${rep.id} columns`);
    }
    expect(failures).toEqual([]);
    const users = await get('/console/reports/user-summary');
    expect(users.body.rows.map((x: { name: string }) => x.name)).toEqual(
      expect.arrayContaining(['Asha Rao', 'Bala Rao']),
    );
    const asha = users.body.rows.find((x: { name: string }) => x.name === 'Asha Rao');
    expect(asha.balance).toEqual({ amount: '500.00', currency: 'INR' });
    // Coded columns read with the register's label, never the stored code.
    expect(asha.status).toBe('Active');
    expect((await get('/console/reports/no-such-report')).body.code).toBe('RPT.REPORT_NOT_FOUND');
    expect(
      (await get('/console/reports/daily-attendance?from=2025-01-01&to=2026-06-30')).body.errors[0]
        .code,
    ).toBe('RPT.PARAM_INVALID');
  });

  it('exports every row with the report’s columns', async () => {
    for (const [id, header] of [
      ['user-summary', 'Name,User type,Admission / employee no.'],
      ['institution-overview', 'User type,Category,Active'],
    ] as const) {
      const x = await post(`/console/reports/${id}/exports`, con, {});
      expect(x.status, JSON.stringify(x.body)).toBe(202);
      let e = await get(`/exports/${x.body.exportId}`);
      for (let i = 0; i < 20 && e.body.status !== 'READY'; i++) {
        await wait(100);
        e = await get(`/exports/${x.body.exportId}`);
      }
      expect(e.body, JSON.stringify(e.body)).toMatchObject({ status: 'READY' });
      expect(e.body.file.name).toMatch(new RegExp(`^${id}_.*\\.csv$`));
      const csv = (await request(f.app).get(e.body.file.url).buffer(true)).text;
      expect(csv).toContain(header);
      if (id === 'user-summary') {
        expect(csv).toContain(',Active');
        expect(csv).not.toContain(',ACTIVE');
      }
      expect(csv.trim().split('\r\n').length - 1).toBe(e.body.rows);
    }
  });
});

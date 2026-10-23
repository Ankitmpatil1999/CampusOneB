/**
 * Payroll from attendance on a real MySQL (client 2026-10-22; ATT-032): Accounts reads each staff
 * member's month — an absent day without leave is loss of pay, approved leave is paid even on a day
 * marked Absent, a half day costs half, days with no record are listed to check; students aren't on
 * it; a role without attendance.view is refused.
 */
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('payroll from attendance on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let accountant: Auth;
  let counsellor: Auth;
  let raju: Payer;

  /** A staff member of the school with one console role. */
  async function staff(roleCode: string, name: string): Promise<Auth> {
    const a = await f.account(name);
    const type = await f.t.db
      .selectFrom('user_types')
      .select('id')
      .where('public_id', '=', uuidToBin(f.teacherTypeId))
      .executeTakeFirstOrThrow();
    const prof = await f.t.db
      .insertInto('member_profiles')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        account_id: a.id,
        user_type_id: String(type.id),
        first_name: name,
        last_name: null,
        employee_no: null,
        admission_no: null,
      })
      .executeTakeFirstOrThrow();
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('profile_roles')
      .values({
        institution_id: f.school.rowId,
        profile_id: String(prof.insertId),
        role_id: String(role.id),
      })
      .execute();
    return f.signedIn('console', a.email);
  }

  /** The school's 2025-26 year, for the leave request. */
  async function year2025() {
    const y = await f.t.db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', f.school.rowId)
      .where('starts_on', '<=', '2025-09-01')
      .where('ends_on', '>=', '2025-09-30')
      .executeTakeFirst();
    if (y) return String(y.id);
    const ins = await f.t.db
      .insertInto('academic_years')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        label: '2025-26',
        starts_on: '2025-06-01',
        ends_on: '2026-03-31',
        status: 'CLOSED',
        is_current: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    return String(ins.insertId);
  }

  beforeAll(async () => {
    f = await schoolFixture('Payroll Vidya Mandir');
    accountant = await staff('ACCOUNTANT', 'LATHA');
    counsellor = await staff('COUNSELLOR', 'RAMU');
    raju = await f.payer('Raju', 0);
    await f.student('Asha');
    await f.t.db
      .updateTable('member_profiles')
      .set({ employee_no: 'EMP-7', joined_on: '2025-06-01' })
      .where('id', '=', raju.rowId)
      .execute();
    // September 2025: Monday the 1st; Sundays the 7th, 14th, 21st and 28th — 26 school days.
    const mark = (date: string, status: 'PRESENT' | 'HALF_DAY' | 'ABSENT') =>
      f.t.db
        .insertInto('attendance_days')
        .values({
          institution_id: f.school.rowId,
          year_id: null,
          profile_id: raju.rowId,
          section_id: null,
          att_date: date,
          checkin_status: status === 'HALF_DAY' ? 'PRESENT' : status,
          status,
          method: status === 'ABSENT' ? null : 'NFC',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    await mark('2025-09-01', 'PRESENT');
    await mark('2025-09-02', 'ABSENT'); // no leave: loss of pay
    await mark('2025-09-03', 'ABSENT'); // marked by auto-absent, but on approved leave
    await mark('2025-09-04', 'HALF_DAY');
    await f.t.db
      .insertInto('staff_leaves')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        year_id: await year2025(),
        profile_id: raju.rowId,
        leave_type: 'CASUAL',
        from_date: '2025-09-03',
        to_date: '2025-09-03',
        days: 1,
        reason: 'Family function',
        final_status: 'APPROVED',
        created_at: new Date(),
      })
      .execute();
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  const payroll = (auth: Auth, q = 'month=2025-09') =>
    request(f.app).get(`/api/v1/console/attendance/payroll?${q}`).set(auth);

  it('gives Accounts each staff member’s month with loss of pay and the days to check', async () => {
    const r = await payroll(accountant);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      month: '2025-09',
      from: '2025-09-01',
      to: '2025-09-30',
      complete: true,
      days: 30,
      sundays: 4,
      workingDays: 26,
    });
    const names = r.body.items.map((i: { member: { name: string } }) => i.member.name);
    expect(names.some((n: string) => n.startsWith('Asha'))).toBe(false);
    const row = r.body.items.find((i: { member: { id: string } }) => i.member.id === raju.id);
    expect(row).toMatchObject({
      member: { employeeNo: 'EMP-7', teaching: true, joinedOn: '2025-06-01', leftOn: null },
      workingDays: 26,
      present: 1,
      absent: 1,
      paidLeave: 1,
      halfDay: 1,
      notMarked: 22,
      leave: { casual: 1, medical: 0, earned: 0 },
      lopDays: 1.5,
      payableDays: 28.5,
    });
    expect(row.exceptions.slice(0, 3)).toEqual([
      { date: '2025-09-02', kind: 'ABSENT', leaveType: null },
      { date: '2025-09-03', kind: 'LEAVE', leaveType: 'CASUAL' },
      { date: '2025-09-04', kind: 'HALF_DAY', leaveType: null },
    ]);
  });

  it('filters by staff type and refuses a bad month or a role without attendance', async () => {
    const others = await payroll(accountant, 'month=2025-09&type=STAFF');
    expect(others.status).toBe(200);
    expect(others.body.items.some((i: { member: { id: string } }) => i.member.id === raju.id)).toBe(
      false,
    );
    expect((await payroll(accountant, 'month=2025-13')).status).toBe(422);
    expect((await payroll(counsellor)).status).toBe(403);
  });
});

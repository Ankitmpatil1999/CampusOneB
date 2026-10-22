/**
 * Roles & tasks and scheduled processing on a real MySQL (IDN-063…069, IDN-039, IDN-081, GOV-001…004;
 * prototype o.roles / o.jobs): reads need the Platform task, changes need roles.edit and a reason;
 * the prototype's guards (last role administrator, own role, task before sub-task, reserved
 * sub-tasks, institution accounts); the change record; releasing a sign-in lock; the job catalogue.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, insertInstitution, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';

describe.skipIf(!adminUrl)('roles and jobs on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let hash: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    hash = await hashSecret(PASSWORD);
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  const roleId = async (code: string) =>
    String(
      (
        await t.db
          .selectFrom('roles')
          .select('id')
          .where('code', '=', code)
          .executeTakeFirstOrThrow()
      ).id,
    );

  async function account(first = 'ARJUN') {
    const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@ringpe.example`;
    const p = newPublicIdPair();
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: p.bin,
        mobile: `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
        email,
        first_name: first,
        last_name: 'MEHTA',
      })
      .executeTakeFirstOrThrow();
    const id = String(r.insertId);
    await t.db
      .insertInto('account_credentials')
      .values({ account_id: id, kind: 'PASSWORD', hash })
      .execute();
    return { id, publicId: p.id, email };
  }

  async function operator(role = 'PLATFORM_ADMIN', first = 'ARJUN') {
    const a = await account(first);
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: a.id, role_id: await roleId(role) })
      .execute();
    return a;
  }

  /** Signs an operator in (password, then the code) and returns the cookies and CSRF header. */
  async function signedIn(email: string) {
    const step1 = await request(app)
      .post('/api/v1/ops/auth/signin')
      .send({ email, password: PASSWORD });
    expect(step1.status).toBe(202);
    const r = await request(app)
      .post('/api/v1/ops/auth/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(r.status).toBe(200);
    const cookies = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string };
  }

  it('shows the catalogue, roles and accounts to the Platform task only', async () => {
    const admin = await signedIn((await operator()).email);
    const tasks = await request(app).get('/api/v1/ops/tasks?scope=OPERATOR').set(admin);
    expect(tasks.status).toBe(200);
    expect(tasks.body.items.map((x: { code: string }) => x.code)).toEqual([
      'home',
      'tenants',
      'settle',
      'recon',
      'jobs',
      'crossinst',
      'access',
      'logs',
      'support',
      'platform',
    ]);
    const tenants = tasks.body.items.find((x: { code: string }) => x.code === 'tenants');
    expect(tenants.subTasks[0]).toEqual({
      code: 'inst.register',
      labelKey: 'subtask.operator.inst.register',
      name: 'Register institutions',
    });
    const roles = await request(app).get('/api/v1/ops/roles?scope=OPERATOR').set(admin);
    const pa = roles.body.items.find((r: { code: string }) => r.code === 'PLATFORM_ADMIN');
    expect(pa.tasks).toEqual(expect.arrayContaining(['home', 'tenants', 'platform', 'jobs']));
    expect(pa.subTasks).toContain('roles.edit');
    expect(pa.holderCount).toBeGreaterThanOrEqual(1);
    const inst = await request(app).get('/api/v1/ops/roles?scope=INSTITUTION').set(admin);
    expect(inst.body.items.map((r: { name: string }) => r.name)).toContain(
      'Institution Administrator',
    );
    const mgmt = inst.body.items.find((r: { code: string }) => r.code === 'MANAGEMENT');
    expect(mgmt.readOnly).toBe(true);
    expect(mgmt.subTasks.every((s: string) => s.endsWith('.view'))).toBe(true);

    const maker = await signedIn((await operator('SETTLEMENT_MAKER', 'PRIYA')).email);
    expect((await request(app).get('/api/v1/ops/roles').set(maker)).status).toBe(403);
    // The maker's session carries its tasks and sub-tasks.
    const session = await request(app).get('/api/v1/ops/session').set(maker);
    expect([...session.body.subTasks].sort()).toEqual([
      'home.view',
      'settle.stage1',
      'settle.view',
      'task.home',
      'task.settle',
    ]);
  });

  it('creates an operator role, assigns a task, grants and revokes with reasons, recorded', async () => {
    const admin = await signedIn((await operator()).email);
    const name = `Grievance Checker ${randomInt(0, 1e6)}`;
    const create = (body: object) =>
      request(app)
        .post('/api/v1/ops/roles')
        .set(admin)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const created = await create({ name, description: 'Checks grievance resolutions' });
    expect(created.status).toBe(201);
    expect(
      (await create({ name: name.toUpperCase(), description: 'Same name again' })).body.code,
    ).toBe('IDN.ROLE_NAME_TAKEN');
    const id = created.body.roleId as string;
    const change = (body: object, version: number) =>
      request(app)
        .patch(`/api/v1/ops/roles/${id}`)
        .set(admin)
        .set('If-Match', `"v${version}"`)
        .send(body);

    expect(
      (await change({ action: 'GRANT', subTask: 'support.calls', reason: 'Calls' }, 1)).body.code,
    ).toBe('IDN.TASK_NOT_ASSIGNED');
    expect((await change({ action: 'ASSIGN_TASK', task: 'support' }, 1)).status).toBe(422);
    const assigned = await change(
      { action: 'ASSIGN_TASK', task: 'support', reason: 'Takes calls' },
      1,
    );
    expect(assigned.status).toBe(200);
    expect(assigned.headers['etag']).toBe('"v2"');
    expect(
      (await change({ action: 'GRANT', subTask: 'support.calls', reason: 'Logs calls' }, 1)).status,
    ).toBe(412);
    expect(
      (await change({ action: 'GRANT', subTask: 'support.calls', reason: 'Logs calls' }, 2)).status,
    ).toBe(200);
    await change({ action: 'ASSIGN_TASK', task: 'crossinst', reason: 'Reads aggregates' }, 3);
    const drill = await change({ action: 'GRANT', subTask: 'xi.drill', reason: 'Wants detail' }, 4);
    expect(drill.body).toMatchObject({
      code: 'IDN.SUBTASK_RESERVED',
      detail: 'Only the Platform Administrator role may hold this sub-task.',
    });
    expect(
      (await change({ action: 'REVOKE', subTask: 'support.calls', reason: 'Not needed' }, 4))
        .status,
    ).toBe(200);
    const roles = await request(app).get('/api/v1/ops/roles?scope=OPERATOR').set(admin);
    const mine = roles.body.items.find((r: { id: string }) => r.id === id);
    expect(mine).toMatchObject({
      tasks: expect.arrayContaining(['home', 'support', 'crossinst']),
      subTasks: ['home.view'],
      version: 5,
    });
    const log = await request(app).get('/api/v1/ops/role-changes').set(admin);
    expect(log.body.items.slice(0, 5).map((x: { change: string }) => x.change)).toEqual([
      `Removed “Log calls against tickets” from ${name}`,
      `Assigned the Cross-institution report task to ${name}`,
      `Granted “Log calls against tickets” to ${name}`,
      `Assigned the Support desk task to ${name}`,
      `Created the ${name} role`,
    ]);
    expect(log.body.items[0]).toMatchObject({ by: 'Arjun Mehta', reason: 'Not needed' });
  });

  it('keeps one role administrator and refuses changes to institution defaults', async () => {
    const admin = await signedIn((await operator()).email);
    const roles = await request(app).get('/api/v1/ops/roles').set(admin);
    const pa = roles.body.items.find((r: { code: string }) => r.code === 'PLATFORM_ADMIN');
    const own = await request(app)
      .patch(`/api/v1/ops/roles/${pa.id}`)
      .set(admin)
      .set('If-Match', `"v${pa.version}"`)
      .send({ action: 'DISABLE', reason: 'Testing the guard' });
    expect(own.body.code).toBe('IDN.OWN_ROLE_DISABLE');
    const last = await request(app)
      .patch(`/api/v1/ops/roles/${pa.id}`)
      .set(admin)
      .set('If-Match', `"v${pa.version}"`)
      .send({ action: 'REVOKE', subTask: 'roles.edit', reason: 'Testing the guard' });
    expect(last.body.code).toBe('IDN.LAST_ROLE_ADMIN');
    const instRole = roles.body.items.find((r: { code: string }) => r.code === 'ACCOUNTANT');
    const refused = await request(app)
      .patch(`/api/v1/ops/roles/${instRole.id}`)
      .set(admin)
      .set('If-Match', `"v${instRole.version}"`)
      .send({ action: 'DISABLE', reason: 'Testing the guard' });
    expect(refused.body.code).toBe('IDN.ROLE_NOT_EDITABLE');
  });

  it('assigns roles to RingPe accounts only, changes them and disables accounts', async () => {
    const admin = await signedIn((await operator()).email);
    const roles = await request(app).get('/api/v1/ops/roles?scope=OPERATOR').set(admin);
    const role = (code: string) =>
      roles.body.items.find((r: { code: string }) => r.code === code).id;
    const assign = (email: string, code: string) =>
      request(app)
        .post('/api/v1/ops/accounts')
        .set(admin)
        .set('Idempotency-Key', randomUUID())
        .send({ email, roleId: role(code), reason: 'Joins the settlement desk' });

    expect((await assign('nobody@ringpe.example', 'SETTLEMENT_CHECKER')).body.code).toBe(
      'IDN.ACCOUNT_EMAIL_UNKNOWN',
    );
    // An institution account never holds an operator role.
    const school = await insertInstitution(t.db);
    const staff = await account('PRAKASH');
    const type = await t.db
      .insertInto('user_types')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: school.id,
        name: 'Staff',
        category: 'STAFF',
      })
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('member_profiles')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: school.id,
        account_id: staff.id,
        user_type_id: String(type.insertId),
        first_name: 'PRAKASH',
      })
      .execute();
    const inst = await assign(staff.email, 'SETTLEMENT_CHECKER');
    expect(inst.body.code).toBe('IDN.ACCOUNT_IS_INSTITUTION');
    expect(inst.body.detail).toContain('Test School');

    const rahul = await account('RAHUL');
    const created = await assign(rahul.email, 'SETTLEMENT_CHECKER');
    expect(created.status).toBe(201);
    const rahulSession = await signedIn(rahul.email);
    expect((await request(app).get('/api/v1/ops/session').set(rahulSession)).body.role.name).toBe(
      'Settlement Checker',
    );
    const changed = await request(app)
      .patch(`/api/v1/ops/accounts/${created.body.id}`)
      .set(admin)
      .set('If-Match', '"v1"')
      .send({ roleId: role('RECON_OFFICER'), reason: 'Moves to reconciliation' });
    expect(changed.status).toBe(200);
    // Taking a permission away ends the holder's back-office session at once.
    expect((await request(app).get('/api/v1/ops/session').set(rahulSession)).status).toBe(401);
    const disabled = await request(app)
      .patch(`/api/v1/ops/accounts/${created.body.id}`)
      .set(admin)
      .set('If-Match', '"v2"')
      .send({ status: 'INACTIVE', reason: 'Left the settlement desk' });
    expect(disabled.status).toBe(200);
    const accounts = await request(app).get('/api/v1/ops/accounts').set(admin);
    expect(accounts.body.items.find((a: { id: string }) => a.id === created.body.id)).toMatchObject(
      {
        name: 'Rahul Mehta',
        role: { name: 'Reconciliation Officer' },
        status: 'INACTIVE',
        statusNote: 'Left the settlement desk',
      },
    );
    // A disabled operator cannot sign in (the one 6.4 refusal).
    const again = await request(app)
      .post('/api/v1/ops/auth/signin')
      .send({ email: rahul.email, password: PASSWORD });
    expect(again.body.code).toBe('IDN.CONSOLE_SIGNIN_REFUSED');
  });

  it('releases a locked staff account', async () => {
    const admin = await signedIn((await operator()).email);
    const locked = await operator('SUPPORT_OFFICER', 'JOSEPH');
    await t.db
      .updateTable('platform_accounts')
      .set({ signin_lock: 'LOCKED', abandoned_code_attempts: 5 })
      .where('id', '=', locked.id)
      .execute();
    expect(
      (
        await request(app)
          .post('/api/v1/ops/auth/signin')
          .send({ email: locked.email, password: PASSWORD })
      ).status,
    ).toBe(423);
    const accounts = await request(app).get('/api/v1/ops/accounts').set(admin);
    const row = accounts.body.items.find((a: { email: string }) => a.email === locked.email);
    expect(row.locked).toBe(true);
    const released = await request(app)
      .post(`/api/v1/ops/accounts/${row.accountId}/unlock`)
      .set(admin)
      .send({ reason: 'Confirmed by phone' });
    expect(released.status).toBe(204);
    expect(
      (
        await request(app)
          .post('/api/v1/ops/auth/signin')
          .send({ email: locked.email, password: PASSWORD })
      ).status,
    ).toBe(202);
  });

  it('lists the scheduled processes and refuses a run before its module exists', async () => {
    const admin = await signedIn((await operator()).email);
    const jobs = await request(app).get('/api/v1/ops/jobs').set(admin);
    expect(jobs.status).toBe(200);
    expect(jobs.body.items).toHaveLength(14);
    expect(jobs.body.items.find((j: { id: string }) => j.id === 'fee-reminders')).toMatchObject({
      time: '09:00',
      money: false,
      available: true,
    });
    expect(jobs.body.items.at(-3)).toMatchObject({ id: 'subscription-billing', available: true });
    expect(jobs.body.items.at(-2)).toMatchObject({
      id: 'held-credit-release',
      available: true,
      money: true,
    });
    expect(jobs.body.items.at(-1)).toMatchObject({ id: 'accounting-vouchers', money: false });
    expect(jobs.body.items[0]).toMatchObject({
      id: 'settlement-run',
      name: 'Merchant settlement run',
      time: '23:30',
      money: true,
      phase: 6,
      available: true,
      lastRun: null,
    });
    const run = await request(app)
      .post('/api/v1/ops/jobs/wallet-rollover/runs')
      .set(admin)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Re-run after a failure' });
    expect(run.status).toBe(409);
    expect(run.body.detail).toBe(
      "This process arrives with its module in Phase 3; it can't run yet.",
    );
    expect(
      (await request(app).get('/api/v1/ops/jobs/wallet-rollover/runs').set(admin)).body,
    ).toEqual({
      items: [],
    });
  });
});

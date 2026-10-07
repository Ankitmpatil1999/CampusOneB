/**
 * Institutions on a real MySQL (INS-001…013, INS-035, INS-036, SAS-027; SRS 7.2–7.5; prototype
 * o.institutions, o.features, c.institution): atomic registration with its defaults and
 * identifier; the checklist gate on activation; the bank arrangement; feature locks by plan and
 * dependency; lifecycle changes recorded, e-mailed and ending sessions; the console's own
 * institution only; public branding.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';

describe.skipIf(!adminUrl)('institutions on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let hash: string;
  let ops: Record<string, string>;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    hash = await hashSecret(PASSWORD);
    ops = await signedIn('ops', (await operator()).email);
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function account(first = 'PRAKASH') {
    const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@school.example.in`;
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
        email,
        first_name: first,
        last_name: 'SHETTY',
      })
      .executeTakeFirstOrThrow();
    const id = String(r.insertId);
    await t.db
      .insertInto('account_credentials')
      .values({ account_id: id, kind: 'PASSWORD', hash })
      .execute();
    return { id, email };
  }

  async function operator(role = 'PLATFORM_ADMIN') {
    const a = await account('ARJUN');
    const roleRow = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', role)
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: a.id, role_id: String(roleRow.id) })
      .execute();
    return a;
  }

  async function signedIn(surface: 'ops' | 'console' | 'portal', email: string) {
    const base = {
      ops: '/api/v1/ops/auth',
      console: '/api/v1/auth/console',
      portal: '/api/v1/portal/auth',
    }[surface];
    const step1 = await request(app).post(`${base}/signin`).send({ email, password: PASSWORD });
    expect(step1.status).toBe(202);
    const r = await request(app)
      .post(`${base}/otp/verify`)
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(r.status).toBe(200);
    const cookies = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string };
  }

  const plans = async () => (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;

  async function register(over: Record<string, unknown> = {}) {
    const admin = await account();
    const tag = randomInt(0, 1e9);
    const body = {
      name: `Hosanagara Public School (English Medium) & PU ${tag}`,
      address: `Main Road ${tag}, Hosanagara, Karnataka 577418`,
      city: 'Hosanagara',
      board: 'CBSE',
      primaryContact: {
        name: 'Lakshmi Rao',
        email: 'Principal@HPS.example.in',
        mobile: '9845012345',
      },
      adminEmail: admin.email.toUpperCase(),
      ...over,
    };
    const r = await request(app)
      .post('/api/v1/ops/institutions')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send(body);
    return { r, admin, body };
  }

  const detail = (id: string) => request(app).get(`/api/v1/ops/institutions/${id}`).set(ops);

  /** ins.admin.passwordShownOnce: 1 makes the account with a temporary password, 0 waits for it. */
  async function passwordShown(value: 0 | 1) {
    const s = (await request(app).get('/api/v1/ops/settings').set(ops)).body.items.find(
      (x: { key: string }) => x.key === 'ins.admin.passwordShownOnce',
    );
    const r = await request(app)
      .put('/api/v1/ops/settings/ins.admin.passwordShownOnce')
      .set(ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value, reason: 'Testing the administrator account paths' });
    expect(r.status).toBe(200);
  }

  const newMobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

  it('makes the administrator account with a temporary password shown once (client 2026-10-07)', async () => {
    const email = `suma.${randomInt(0, 1e9)}@hps.example.in`;
    const mobile = newMobile();
    const key = randomUUID();
    const tag = randomInt(0, 1e9);
    const body = {
      name: `Kodachadri Vidya Mandira ${tag}`,
      address: `Temple Road ${tag}, Kollur, Karnataka 576220`,
      city: 'Kollur',
      primaryContact: { name: 'Suma Bhat', email, mobile },
      adminEmail: email,
    };
    const send = () =>
      request(app).post('/api/v1/ops/institutions').set(ops).set('Idempotency-Key', key).send(body);
    const r = await send();
    expect(r.status).toBe(201);
    expect(r.body.administrator).toMatchObject({ email, pending: false, accountCreated: true });
    const password = r.body.administrator.temporaryPassword as string;
    expect(password).toMatch(/^.{10}@1$/);
    // Never stored: a replay of the same request answers without it.
    const again = await send();
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.administrator).toEqual({ email, pending: false, accountCreated: true });
    const stored = await t.db
      .selectFrom('idempotency_records')
      .select('response_body')
      .where('idempotency_key', '=', key)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.response_body)).not.toContain(password);

    const account = await t.db
      .selectFrom('platform_accounts')
      .select(['id', 'first_name', 'last_name', 'mobile'])
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({ first_name: 'SUMA', last_name: 'BHAT', mobile });
    expect((await detail(r.body.id)).body.administrator).toMatchObject({ email, pending: false });

    // The temporary password signs in to the customer site and must be changed first.
    const step1 = await request(app).post('/api/v1/portal/auth/signin').send({ email, password });
    expect(step1.status).toBe(202);
    const step2 = await request(app)
      .post('/api/v1/portal/auth/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(step2.status).toBe(200);
    expect(step2.body).toMatchObject({ passwordChangeRequired: true });
  });

  it("asks for the new administrator's name and mobile, and refuses a mobile with an account", async () => {
    const email = `office.${randomInt(0, 1e9)}@hps.example.in`;
    const none = await register({ adminEmail: email });
    expect(none.r.status).toBe(422);
    expect(none.r.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'adminMobile',
      'adminName',
    ]);
    const someone = await account('MOHAN');
    const mob = (
      await t.db
        .selectFrom('platform_accounts')
        .select('mobile')
        .where('id', '=', someone.id)
        .executeTakeFirstOrThrow()
    ).mobile;
    const taken = await register({
      adminEmail: email,
      adminName: 'Office Admin',
      adminMobile: mob,
    });
    expect(taken.r.status).toBe(409);
    expect(taken.r.body.code).toBe('INS.ADMIN_MOBILE_TAKEN');
    const ok = await register({
      adminEmail: email,
      adminName: 'Office Admin',
      adminMobile: newMobile(),
    });
    expect(ok.r.status).toBe(201);
    expect(ok.r.body.administrator.temporaryPassword).toBeTruthy();
  });

  it('registers an institution in one transaction with its defaults (INS-002)', async () => {
    const plus = (await plans()).find((p: { code: string }) => p.code === 'PL-PLUS');
    expect(plus.price).toEqual({ amount: '180000.00', currency: 'INR' });
    const mails = h.email.sent.length;
    const { r, admin, body } = await register({ planId: plus.id });
    expect(r.status).toBe(201);
    expect(r.body.identifier).toMatch(/^RPEHOSMAI\d{5}\d{4}$/);

    const d = await detail(r.body.id);
    expect(d.body).toMatchObject({
      status: 'PENDING_ACTIVATION',
      shortName: 'HPSMP',
      plan: { code: 'PL-PLUS' },
      contacts: {
        primary: { name: 'Lakshmi Rao', email: 'principal@hps.example.in', mobile: '9845012345' },
        secondary: null,
      },
      administrator: { email: admin.email },
      members: 1,
    });
    expect(d.headers['etag']).toBe(`"v${d.body.version}"`);
    const done = d.body.checklist.filter((c: { done: boolean }) => c.done);
    expect(done.map((c: { key: string }) => c.key)).toEqual(['details', 'plan', 'usertypes']);
    expect(d.body.actions).toEqual([
      { action: 'START_TRIAL', label: 'Start trial', blocked: true },
      { action: 'ACTIVATE', label: 'Activate', blocked: true },
      { action: 'CANCEL', label: 'Cancel', blocked: false },
    ]);
    expect(d.body.history.at(-1)).toMatchObject({ action: 'REGISTERED', to: 'PENDING_ACTIVATION' });

    // The default user type, department, administrator role; features off; channels by default.
    const inst = await t.db
      .selectFrom('institutions')
      .select('id')
      .where('identifier', '=', r.body.identifier)
      .executeTakeFirstOrThrow();
    const dept = await t.db
      .selectFrom('departments as d')
      .innerJoin('user_types as u', 'u.id', 'd.user_type_id')
      .select(['u.name as type', 'u.category', 'd.name'])
      .where('d.institution_id', '=', inst.id)
      .execute();
    expect(dept).toEqual([{ type: 'Staff', category: 'STAFF', name: 'Administration' }]);
    const role = await t.db
      .selectFrom('profile_roles as pr')
      .innerJoin('roles as r', 'r.id', 'pr.role_id')
      .innerJoin('member_profiles as m', 'm.id', 'pr.profile_id')
      .select(['r.code', 'm.account_id'])
      .where('pr.institution_id', '=', inst.id)
      .executeTakeFirstOrThrow();
    expect(role).toEqual({ code: 'INSTITUTION_ADMIN', account_id: admin.id });
    const f = await request(app).get(`/api/v1/ops/institutions/${r.body.id}/features`).set(ops);
    expect(f.body.features.every((x: { enabled: boolean }) => !x.enabled)).toBe(true);
    expect(
      Object.fromEntries(
        f.body.channels.map((c: { key: string; enabled: boolean }) => [c.key, c.enabled]),
      ),
    ).toEqual({ IN_APP: true, EMAIL: true, SMS: true, WHATSAPP: false });
    // Welcome e-mail with the old subject wording (MSG-ONB-73) and the identifier.
    expect(h.email.sent).toHaveLength(mails + 1);
    expect(h.email.sent.at(-1)!.text).toContain(
      `Organization Registration Successful - ${body.name}`,
    );
    expect(h.email.sent.at(-1)!.text).toContain(`Organization ID: ${r.body.identifier}`);

    // Name and address together are unique (punctuation and case ignored).
    const again = await register({
      name: body.name.toUpperCase(),
      address: `${body.address}.`,
    });
    expect(again.r.status).toBe(409);
    expect(again.r.body).toMatchObject({
      code: 'INS.NAME_ADDRESS_TAKEN',
      detail: 'Organization already registered',
    });
    // The administrator's account now belongs to an institution.
    const taken = await register({ adminEmail: admin.email });
    expect(taken.r.body).toMatchObject({ code: 'INS.ADMIN_IN_INSTITUTION' });
  });

  it('registers for an administrator without an account yet, who claims it on sign-in', async () => {
    // Client 2026-10-06: the back office may register before the administrator's RingPe account
    // exists; with the password setting off, the institution waits for the e-mail.
    await passwordShown(0);
    const email = `kavya.${randomInt(0, 1e9)}@hps.example.in`;
    const mails = h.email.sent.length;
    const { r } = await register({
      adminEmail: email.toUpperCase(),
      primaryContact: { name: 'Kavya Hegde', email, mobile: '9845012399' },
    });
    expect(r.status).toBe(201);
    expect(r.body.administrator).toEqual({ email, pending: true, accountCreated: false });
    const welcome = h.email.sent.slice(mails).find((m) => m.to === email);
    expect(welcome?.text ?? '').toContain('/portal/signup');
    expect(welcome?.text ?? '').toContain('/portal/signin');
    const d = await detail(r.body.id);
    expect(d.body.administrator).toMatchObject({ email, pending: true });

    // The same e-mail can't wait for a second institution.
    const twice = await register({ adminEmail: email });
    expect(twice.r.status).toBe(409);
    expect(twice.r.body.code).toBe('INS.ADMIN_IN_INSTITUTION');

    // The account made later with that e-mail: an unverified e-mail claims nothing.
    const pub = newPublicIdPair();
    const made = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: pub.bin,
        mobile: `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
        email,
        first_name: 'KAVYA',
        last_name: 'HEGDE',
      })
      .executeTakeFirstOrThrow();
    const accountId = String(made.insertId);
    await t.db
      .insertInto('account_credentials')
      .values({ account_id: accountId, kind: 'PASSWORD', hash })
      .execute();
    const early = await request(app)
      .post('/api/v1/portal/auth/signin')
      .send({ email, password: PASSWORD });
    expect(early.status).not.toBe(202);
    expect((await detail(r.body.id)).body.administrator).toMatchObject({ pending: true });

    // Verified, signing in links it; the customer site opens the institution while it is set up.
    await t.db
      .updateTable('platform_accounts')
      .set({ email_verified_at: new Date() })
      .where('id', '=', accountId)
      .execute();
    await signedIn('portal', email);
    const linked = await detail(r.body.id);
    expect(linked.body.administrator).toMatchObject({
      email,
      pending: false,
      name: expect.stringMatching(/kavya/i),
    });
    await passwordShown(1);
  });

  it('refuses operator administrators and bad fields with the old messages', async () => {
    const op = await operator('SUPPORT_OFFICER');
    expect((await register({ adminEmail: op.email })).r.body).toMatchObject({
      code: 'INS.ADMIN_IS_OPERATOR',
    });
    const bad = await register({
      name: 'Bad <School>',
      primaryContact: { name: 'Lakshmi', email: 'not-mail', mobile: '1234' },
    });
    expect(bad.r.status).toBe(422);
    const codes = Object.fromEntries(
      (bad.r.body.errors as { field: string; code: string }[]).map((e) => [e.field, e.code]),
    );
    expect(codes).toMatchObject({
      name: 'INS.NAME_FORMAT',
      'primaryContact.email': 'INS.PRIMARY_EMAIL_FORMAT',
      'primaryContact.mobile': 'INS.PRIMARY_PHONE_FORMAT',
    });
    // Registration needs an Idempotency-Key and the back office.
    const noKey = await request(app).post('/api/v1/ops/institutions').set(ops).send({});
    expect(noKey.status).toBe(428);
  });

  it('activates only after the required steps; features follow the plan (INS-005…008, INS-036)', async () => {
    const ess = (await plans()).find((p: { code: string }) => p.code === 'PL-ESS');
    const { r, admin } = await register({ planId: ess.id });
    const id = r.body.id as string;
    const life = (action: string, reason = 'Onboarding complete; first invoice paid') =>
      request(app)
        .post(`/api/v1/ops/institutions/${id}/lifecycle-events`)
        .set(ops)
        .set('Idempotency-Key', randomUUID())
        .send({ action, reason });

    const early = await life('ACTIVATE');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INS.CHECKLIST_INCOMPLETE');
    expect(early.body.detail).toContain('Bank corporate code and pool account');
    expect((await life('ACTIVATE', 'short')).body.code).toBe('VALIDATION.FAILED');

    // Bank arrangement: If-Match, a unique code, the bank step completes.
    let v = (await detail(id)).body.version as number;
    const code = `Q${String(randomInt(0, 999)).padStart(3, '0')}`;
    const bank = (cc: string, version: number) =>
      request(app)
        .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
        .set(ops)
        .set('If-Match', `"v${version}"`)
        .send({ corporateCode: cc, poolAccountRef: 'POOLHPS0134' });
    expect((await bank('TOOLONG', v)).body.errors[0].code).toBe('INS.CORPORATE_CODE_FORMAT');
    expect((await bank(code, v - 1)).status).toBe(412);
    expect((await bank(code, v)).status).toBe(200);

    // Features: Transport isn't in Campus Essentials; fee consent needs tuition.
    v = (await detail(id)).body.version;
    const feat = (changes: object[], version: number) =>
      request(app)
        .patch(`/api/v1/ops/institutions/${id}/features`)
        .set(ops)
        .set('If-Match', `"v${version}"`)
        .send({ changes, reason: 'Requested by the principal' });
    const transport = await feat([{ key: 'transport', enabled: true }], v);
    expect(transport.body).toMatchObject({
      code: 'INS.NOT_ENTITLED_BY_PLAN',
      detail: "Transport isn't included in Campus Essentials.",
    });
    expect((await feat([{ key: 'feeConsent', enabled: true }], v)).body.code).toBe(
      'INS.FEATURE_NEEDS',
    );
    const on = await feat(
      [
        { key: 'tuition', enabled: true },
        { key: 'feeConsent', enabled: true },
        { key: 'attendance', enabled: true },
      ],
      v,
    );
    expect(on.status).toBe(200);
    const off = await feat([{ key: 'tuition', enabled: false }], on.body.version);
    const state = Object.fromEntries(
      off.body.features.map((x: { key: string; enabled: boolean }) => [x.key, x.enabled]),
    );
    expect(state).toMatchObject({ tuition: false, feeConsent: false, attendance: true });
    expect(off.body.features.find((x: { key: string }) => x.key === 'transport').lock).toEqual({
      kind: 'PLAN',
      text: 'Not in Campus Essentials',
    });
    const log = await request(app)
      .get(`/api/v1/ops/feature-change-log?institutionId=${id}`)
      .set(ops);
    expect(log.body.items[0]).toMatchObject({
      label: 'Fee consent required',
      from: true,
      to: false,
      reason: 'Depends on Tuition-fee collection',
    });

    // The institution-owned steps are confirmed by the operator; then activation succeeds.
    for (const step of ['year', 'feeacct']) {
      const s = await request(app)
        .post(`/api/v1/ops/institutions/${id}/checklist/${step}`)
        .set(ops)
        .send({});
      expect(s.status).toBe(200);
    }
    const mails = h.email.sent.length;
    const activated = await life('ACTIVATE');
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ status: 'ACTIVE', notified: ['Lakshmi Rao'] });
    // The lifecycle notice and the first-cycle invoice (2.7).
    expect(h.email.sent).toHaveLength(mails + 2);
    expect((await life('REACTIVATE')).body).toMatchObject({
      code: 'INS.TRANSITION_INVALID',
      detail: "This change isn't possible while the institution is Active.",
    });

    // The administrator signs in to the console and sees only their own institution.
    const consoleHeaders = await signedIn('console', admin.email);
    const own = await request(app).get('/api/v1/console/institution').set(consoleHeaders);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id, corporateCode: code, plan: { code: 'PL-ESS' } });
    const saved = await request(app)
      .patch('/api/v1/console/institution')
      .set(consoleHeaders)
      .set('If-Match', `"v${own.body.version}"`)
      .send({
        pinCode: '577418',
        officeEmail: 'Office@HPS.example.in',
        consentValidityMonths: 6,
        secondaryContact: {
          name: 'Ravi Kumar',
          email: 'ravi@hps.example.in',
          mobile: '9845098450',
        },
        channels: { WHATSAPP: true },
      });
    expect(saved.body).toMatchObject({ code: 'INS.NOT_ENTITLED_BY_PLAN' });
    const ok = await request(app)
      .patch('/api/v1/console/institution')
      .set(consoleHeaders)
      .set('If-Match', `"v${own.body.version}"`)
      .send({
        pinCode: '577418',
        officeEmail: 'Office@HPS.example.in',
        consentValidityMonths: 6,
        secondaryContact: {
          name: 'Ravi Kumar',
          email: 'ravi@hps.example.in',
          mobile: '9845098450',
        },
        channels: { SMS: false },
      });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      pinCode: '577418',
      officeEmail: 'office@hps.example.in',
      consentValidityMonths: 6,
      contacts: { secondary: { name: 'Ravi Kumar', mobile: '9845098450' } },
    });
    expect(ok.body.channels.find((c: { key: string }) => c.key === 'SMS').enabled).toBe(false);
    // The Institution Administrator switches features within the plan (client 2026-10-03).
    const outside = await request(app)
      .patch('/api/v1/console/institution')
      .set(consoleHeaders)
      .set('If-Match', `"v${ok.body.version}"`)
      .send({ features: { transport: true } });
    expect(outside.body).toMatchObject({ code: 'INS.NOT_ENTITLED_BY_PLAN' });
    const switched = await request(app)
      .patch('/api/v1/console/institution')
      .set(consoleHeaders)
      .set('If-Match', `"v${ok.body.version}"`)
      .send({ features: { tuition: true, feeConsent: true, attendance: false } });
    expect(switched.status).toBe(200);
    const after = Object.fromEntries(
      switched.body.features.map((x: { key: string; enabled: boolean }) => [x.key, x.enabled]),
    );
    expect(after).toMatchObject({ tuition: true, feeConsent: true, attendance: false });
    const record = await request(app)
      .get(`/api/v1/ops/feature-change-log?institutionId=${id}`)
      .set(ops);
    expect(record.body.items[0]).toMatchObject({ reason: 'Changed by the institution' });
    // Operators' routes stay closed to a console session.
    expect((await request(app).get('/api/v1/ops/institutions').set(consoleHeaders)).status).toBe(
      401,
    );

    // Suspension ends the institution's console sessions and is recorded.
    expect((await life('SUSPEND', 'Invoice unpaid after the grace period')).status).toBe(200);
    expect((await request(app).get('/api/v1/console/institution').set(consoleHeaders)).status).toBe(
      401,
    );
    const hist = (await detail(id)).body.history;
    expect(hist[0]).toMatchObject({
      action: 'SUSPENDED',
      from: 'ACTIVE',
      to: 'SUSPENDED',
      reason: 'Invoice unpaid after the grace period',
    });
    expect(hist.some((x: { step: string | null }) => x.step === 'Academic year declared')).toBe(
      true,
    );

    // Cancellation is final; the configuration freezes.
    expect((await life('CANCEL', 'The school closed the campus')).status).toBe(200);
    v = (await detail(id)).body.version;
    expect((await feat([{ key: 'attendance', enabled: false }], v)).body.code).toBe('INS.FROZEN');
  });

  it('lists tenants and serves public branding by identifier (INS-001, INS-035)', async () => {
    const { r } = await register();
    const list = await request(app).get('/api/v1/ops/institutions').set(ops);
    const row = list.body.items.find((x: { id: string }) => x.id === r.body.id);
    expect(row).toMatchObject({
      status: 'PENDING_ACTIVATION',
      plan: null,
      members: 1,
      checklist: { done: 2, total: 9 },
    });
    const b = await request(app).get(
      `/api/v1/public/institutions/${String(r.body.identifier).toLowerCase()}/branding`,
    );
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ shortName: 'HPSMP', logoUrl: null, colors: { brand: null } });
    expect(
      (await request(app).get('/api/v1/public/institutions/RPEXXXXXX000000000/branding')).status,
    ).toBe(404);
  });
});

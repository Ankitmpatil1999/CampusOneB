/**
 * The customer portal on a real MySQL (SAS-001…025, SAS-044…050; FR-SAS-04…11, BR-01): an
 * administrator signs the institution up with their own CampusOne account, finishes the checklist,
 * goes live on a trial, signs in again, changes plan, reports a transfer, asks CampusOne to change the
 * name, exports the data and asks to cancel.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'CampusOne@2026';
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe.skipIf(!adminUrl)('customer portal on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let ops: Record<string, string>;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    const op = await account('ARJUN');
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'PLATFORM_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: op.id, role_id: String(role.id) })
      .execute();
    ops = await signedIn('/api/v1/ops/auth', op.email);
  }, 180_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function account(first: string, mob = mobile()) {
    const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@example.in`;
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: mob,
        email,
        first_name: first,
        last_name: 'RAO',
      })
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('account_credentials')
      .values({
        account_id: String(r.insertId),
        kind: 'PASSWORD',
        hash: await hashSecret(PASSWORD),
      })
      .execute();
    return { id: String(r.insertId), email, mobile: mob };
  }

  const cookiesOf = (r: request.Response) =>
    ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '')
      .join('; ');

  async function signedIn(base: string, email: string, password = PASSWORD) {
    const step1 = await request(app).post(`${base}/signin`).send({ email, password });
    expect(step1.status).toBe(202);
    const r = await request(app)
      .post(`${base}/otp/verify`)
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(r.status).toBe(200);
    return { Cookie: cookiesOf(r), 'X-CSRF-Token': r.body.csrfToken as string };
  }

  /** Signs a new institution up from the portal; returns the portal session. */
  async function signUp(admin: { mobile: string; email: string }, name: string) {
    const otp = await request(app).post('/api/v1/portal/signup/otp').send({ mobile: admin.mobile });
    expect(otp.status).toBe(202);
    const verified = await request(app)
      .post('/api/v1/portal/signup/otp/verify')
      .send({ challengeId: otp.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(verified.status).toBe(200);
    expect(verified.body.account).toMatchObject({ email: admin.email });
    const plans = (await request(app).get('/api/v1/portal/plans')).body.items;
    const body = {
      signupToken: verified.body.signupToken,
      institution: {
        name,
        address: `Sagar Road ${randomInt(0, 1e6)}, Vinoba Nagar`,
        city: 'Shivamogga',
        pinCode: '577204',
        board: 'CBSE',
        students: 720,
      },
      primaryContact: { name: 'Savitha Rao', email: admin.email, mobile: admin.mobile },
      planId: plans[0].id,
      start: 'TRIAL',
      accept: { subscription: true, dataProcessing: true, authorised: false },
    };
    const refused = await request(app).post('/api/v1/portal/signup').send(body);
    expect(refused.body.errors[0].code).toBe('SAS.TERMS_REQUIRED');
    const r = await request(app)
      .post('/api/v1/portal/signup')
      .send({ ...body, accept: { ...body.accept, authorised: true } });
    expect(r.status).toBe(201);
    expect(r.body.identifier).toMatch(/^RPE/);
    return {
      id: r.body.institutionId as string,
      session: { Cookie: cookiesOf(r), 'X-CSRF-Token': r.body.csrfToken as string },
    };
  }

  const once = () => ({ 'Idempotency-Key': randomUUID() });

  it('lists the plans publicly', async () => {
    const plans = await request(app).get('/api/v1/portal/plans');
    expect(plans.status).toBe(200);
    expect(plans.body.items.length).toBeGreaterThan(0);
    expect(plans.body.items[0]).not.toHaveProperty('institutions');
    expect(plans.body).toMatchObject({ graceDays: 14, dueDays: 15 });
  });

  /** A number without a CampusOne account: the code, then the account made here (SAS-051). */
  async function newAccount(email: string, mob = mobile()) {
    const otp = await request(app).post('/api/v1/portal/signup/otp').send({ mobile: mob });
    expect(otp.status).toBe(202);
    expect(otp.body.newAccount).toBe(true);
    const verified = await request(app)
      .post('/api/v1/portal/signup/otp/verify')
      .send({ challengeId: otp.body.challengeId, otp: codeOf(h.sms.sent.at(-1)), mobile: mob });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ newAccount: true, account: null, invited: false });
    const made = (over: Record<string, unknown> = {}) =>
      request(app)
        .post('/api/v1/portal/signup/account')
        .send({
          signupToken: verified.body.signupToken,
          firstName: 'Kavya',
          lastName: 'Hegde',
          email,
          password: PASSWORD,
          ...over,
        });
    const bad = await made({ password: 'short' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([
      expect.objectContaining({ field: 'password', code: 'VALIDATION.PASSWORD' }),
    ]);
    const r = await made();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ newAccount: false, account: { name: 'Kavya Hegde', email } });
    return { r, mobile: mob };
  }

  it('makes the CampusOne account on the customer site for a new number (SAS-051)', async () => {
    const email = `kavya.${randomInt(0, 1e9)}@example.in`;
    const { r, mobile: mob } = await newAccount(email);
    expect(r.body.invited).toBe(false);
    const row = await t.db
      .selectFrom('platform_accounts')
      .select(['first_name', 'last_name', 'email', 'email_verified_at'])
      .where('mobile', '=', mob)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ first_name: 'KAVYA', last_name: 'HEGDE', email });
    expect(row.email_verified_at).toBeNull();
    // The code must have gone to the number given.
    const [m2, m3] = [mobile(), mobile()];
    const stray = await request(app).post('/api/v1/portal/signup/otp').send({ mobile: m3 });
    const wrong = await request(app)
      .post('/api/v1/portal/signup/otp/verify')
      .send({ challengeId: stray.body.challengeId, otp: codeOf(h.sms.sent.at(-1)), mobile: m2 });
    expect(wrong.status).toBe(401);
    // A second account for the same e-mail is refused.
    const other = await request(app).post('/api/v1/portal/signup/otp').send({ mobile: m2 });
    const v = await request(app)
      .post('/api/v1/portal/signup/otp/verify')
      .send({ challengeId: other.body.challengeId, otp: codeOf(h.sms.sent.at(-1)), mobile: m2 });
    expect(v.status).toBe(200);
    const dup = await request(app).post('/api/v1/portal/signup/account').send({
      signupToken: v.body.signupToken,
      firstName: 'Kiran',
      email,
      password: PASSWORD,
    });
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toEqual([
      expect.objectContaining({ field: 'email', code: 'IDN.EMAIL_TAKEN' }),
    ]);
  });

  it('links an institution registered in the back office once the e-mail is confirmed (SAS-052/053)', async () => {
    // With the password setting off, the institution waits for the account (client 2026-10-06).
    const setting = (await request(app).get('/api/v1/ops/settings').set(ops)).body.items.find(
      (x: { key: string }) => x.key === 'ins.admin.passwordShownOnce',
    );
    const off = await request(app)
      .put('/api/v1/ops/settings/ins.admin.passwordShownOnce')
      .set(ops)
      .set('If-Match', `"v${setting.version}"`)
      .send({ value: 0, reason: 'Testing the waiting administrator' });
    expect(off.status).toBe(200);
    const email = `ravi.${randomInt(0, 1e9)}@example.in`;
    const tag = randomInt(0, 1e9);
    const reg = await request(app)
      .post('/api/v1/ops/institutions')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Tunga Vidya Kendra ${tag}`,
        address: `Station Road ${tag}, Thirthahalli, Karnataka 577432`,
        city: 'Thirthahalli',
        board: 'CBSE',
        primaryContact: { name: 'Ravi Bhat', email, mobile: '9845012388' },
        adminEmail: email,
      });
    expect(reg.status).toBe(201);
    expect(reg.body.administrator).toEqual({ email, pending: true, accountCreated: false });

    const { r } = await newAccount(email);
    expect(r.body.invited).toBe(true);
    const code = await request(app)
      .post('/api/v1/portal/signup/email-code')
      .send({ signupToken: r.body.signupToken });
    expect(code.status).toBe(202);
    const mail = h.email.sent.at(-1);
    expect(mail?.to).toBe(email);
    const wrong = await request(app)
      .post('/api/v1/portal/signup/email-code/verify')
      .send({ signupToken: 'nonsense', challengeId: code.body.challengeId, otp: '000000' });
    expect(wrong.status).toBe(401);
    const ok = await request(app)
      .post('/api/v1/portal/signup/email-code/verify')
      .send({
        signupToken: r.body.signupToken,
        challengeId: code.body.challengeId,
        otp: codeOf(mail),
      });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      emailVerified: true,
      joined: { institution: `Tunga Vidya Kendra ${tag}`, identifier: reg.body.identifier },
    });
    // The administrator now signs in to the customer site of that institution (pending activation).
    await signedIn('/api/v1/portal/auth', email);
    const d = await request(app).get(`/api/v1/ops/institutions/${reg.body.id}`).set(ops);
    expect(d.body.administrator).toMatchObject({
      email,
      pending: false,
      name: expect.stringMatching(/^kavya hegde$/i),
    });
  });

  it('signs up a second institution with the same account, never a back-office one (client 2026-10-27)', async () => {
    const admin = await account('GEETHA');
    const first = await signUp(admin, `Varada Vidyalaya ${randomInt(0, 1e6)}`);
    const second = await signUp(admin, `Malaprabha Vidyalaya ${randomInt(0, 1e6)}`);
    expect(second.id).not.toBe(first.id);
    // The portal shows the institution its session opened, not the account's first.
    const who = await request(app).get('/api/v1/portal/session').set(second.session);
    expect(who.status, JSON.stringify(who.body)).toBe(200);
    expect(who.body.institution.id).toBe(second.id);

    const op = await account('NAVYA');
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'PLATFORM_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: op.id, role_id: String(role.id) })
      .execute();
    const refused = await request(app)
      .post('/api/v1/portal/signup/otp')
      .send({ mobile: op.mobile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SAS.SIGNUP_ACCOUNT_IN_USE');
  });

  it('signs up, finishes the checklist, goes live on a trial and signs in again', async () => {
    const admin = await account('SAVITHA');
    const { id, session } = await signUp(admin, `Sharavathi Vidyalaya ${randomInt(0, 1e6)}`);

    // The same account may sign up a second institution (client 2026-10-27: BR-01 lifted).
    const again = await request(app)
      .post('/api/v1/portal/signup/otp')
      .send({ mobile: admin.mobile });
    expect(again.status).toBe(202);
    expect(again.body.newAccount).toBe(false);

    const who = await request(app).get('/api/v1/portal/session').set(session);
    expect(who.status).toBe(200);
    expect(who.body.institution).toMatchObject({ id, status: 'PENDING_ACTIVATION' });

    const step = (key: string, body: object) =>
      request(app).put(`/api/v1/portal/onboarding/steps/${key}`).set(session).send(body);
    expect((await step('bank', {})).status).toBe(404);
    const bad = await step('feeacct', {
      name: 'Fee collections',
      bank: 'Canara Bank',
      ifsc: 'NOTANIFSC',
      accountNo: '1234567890',
    });
    expect(bad.body.errors[0].code).toBe('IDN.IFSC_INVALID');
    expect(
      (
        await step('feeacct', {
          name: 'Fee collections',
          bank: 'Canara Bank',
          ifsc: 'CNRB0000123',
          accountNo: '110022003300',
        })
      ).body.steps.find((s: { key: string }) => s.key === 'feeacct'),
    ).toMatchObject({ done: true, summary: 'Fee collections · Canara Bank ••3300 · CNRB0000123' });
    await step('usertypes', {
      userTypes: [{ name: 'Student', category: 'STUDENT', departments: ['Primary'] }],
    });
    await step('year', {});
    const toggles = await step('toggles', { features: {} });
    expect(toggles.status).toBe(200);
    expect(toggles.body.canGoLive).toBe(false);
    expect(toggles.body.missing).toEqual(['Bank corporate code and pool account']);

    const early = await request(app)
      .post('/api/v1/portal/go-live')
      .set(session)
      .set(once())
      .send({ mode: 'TRIAL' });
    expect(early.body.code).toBe('INS.CHECKLIST_INCOMPLETE');

    // CampusOne sets up the bank step.
    const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body
      .version;
    const bank = await request(app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(ops)
      .set('If-Match', `"v${version}"`)
      .send({
        corporateCode: `S${String(randomInt(0, 999)).padStart(3, '0')}`,
        poolAccountRef: 'POOLSVV0001',
      });
    expect(bank.status).toBe(200);
    const live = await request(app)
      .post('/api/v1/portal/go-live')
      .set(session)
      .set(once())
      .send({ mode: 'TRIAL' });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'ACTIVE', invoice: null });
    const acct = await request(app).get('/api/v1/portal/account').set(session);
    expect(acct.body.institution).toMatchObject({ status: 'ACTIVE', signupSource: 'PORTAL' });
    expect(acct.body.onboarding.canGoLive).toBe(false);
    expect(acct.body.notices.length).toBeGreaterThan(0);

    // Signing in again: e-mail + password, then the code.
    const again2 = await signedIn('/api/v1/portal/auth', admin.email);
    expect((await request(app).get('/api/v1/portal/onboarding').set(again2)).status).toBe(200);
  });

  it('changes plan, refuses online payment, asks CampusOne to rename, exports and asks to cancel', async () => {
    const admin = await account('RAMESH');
    const { id, session } = await signUp(admin, `Tunga Vidya Kendra ${randomInt(0, 1e6)}`);

    // Before go-live the plan is simply replaced.
    const plans = (await request(app).get('/api/v1/portal/plans')).body.items;
    const other = plans[plans.length - 1];
    const changed = await request(app)
      .post('/api/v1/portal/subscription/plan-changes')
      .set(session)
      .set(once())
      .send({ planId: other.id, timing: 'NOW' });
    expect(changed.status).toBe(200);
    expect(changed.body.plan.name).toBe(other.name);

    // Invoices: none yet; online payment isn't available.
    expect((await request(app).get('/api/v1/portal/invoices').set(session)).body.items).toEqual([]);
    const gw = await request(app)
      .post(`/api/v1/portal/invoices/${randomUUID()}/payments`)
      .set(session)
      .set(once())
      .send({ method: 'GATEWAY' });
    expect(gw.body.code).toBe('SAS.GATEWAY_UNAVAILABLE');

    // Contacts the institution keeps; the name goes through CampusOne.
    const det = await request(app).get('/api/v1/portal/institution-details').set(session);
    expect(det.status).toBe(200);
    const saved = await request(app)
      .put('/api/v1/portal/institution-details/contacts')
      .set(session)
      .set('If-Match', `"v${det.body.version}"`)
      .send({
        primaryContact: { name: 'Ramesh Rao', email: admin.email, mobile: admin.mobile },
        secondaryContact: { name: 'Office', email: 'office@tvk.example.in', mobile: '9481102233' },
      });
    expect(saved.status).toBe(200);
    const newName = `Tunga Vidya Kendra Trust ${randomInt(0, 1e6)}`;
    const ask = await request(app)
      .post('/api/v1/portal/institution-details/change-requests')
      .set(session)
      .set(once())
      .send({ field: 'NAME', value: newName, reason: 'Registered as a trust school' });
    expect(ask.status).toBe(202);
    const dup = await request(app)
      .post('/api/v1/portal/institution-details/change-requests')
      .set(session)
      .set(once())
      .send({ field: 'BOARD', value: 'ICSE', reason: 'Affiliation changed' });
    expect(dup.body.code).toBe('SAS.DETAILS_CHANGE_PENDING');
    const queue = await request(app).get('/api/v1/ops/approvals').set(ops);
    const req = queue.body.items.find((x: { id: string }) => x.id === ask.body.approvalId);
    expect(req).toMatchObject({
      module: 'INSTITUTION_DETAILS',
      action: 'Change institution details',
    });
    const detail = await request(app).get(`/api/v1/ops/approvals/${req.id}`).set(ops);
    expect(detail.body.changes[0]).toMatchObject({ label: 'Name', to: newName });
    const ok = await request(app)
      .post(`/api/v1/ops/approvals/${req.id}/decision`)
      .set(ops)
      .set(once())
      .set('If-Match', `"v${detail.body.version}"`)
      .send({ decision: 'APPROVE', remarks: 'Trust registration checked' });
    expect(ok.status).toBe(200);
    const after = await request(app).get('/api/v1/portal/institution-details').set(session);
    expect(after.body.name).toBe(newName);
    expect(after.body.changeRequests[0]).toMatchObject({ status: 'APPROVED' });

    // Export: a ZIP of CSV files behind a signed link.
    const ex = await request(app)
      .post('/api/v1/portal/data-exports')
      .set(session)
      .set(once())
      .send({ classes: ['members', 'financial', 'attendance'] });
    expect(ex.status).toBe(201);
    expect(ex.body.status).toBe('READY');
    expect(ex.body.counts['members/members.csv']).toBe(1);
    const zipFile = await request(app)
      .get(ex.body.file.url)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(zipFile.status).toBe(200);
    expect((zipFile.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect(
      (await request(app).get('/api/v1/portal/data-exports').set(session)).body.items,
    ).toHaveLength(1);

    // Cancellation: asked, withdrawn, asked again, declined by CampusOne.
    const cancel = () =>
      request(app)
        .post('/api/v1/portal/cancellation-requests')
        .set(session)
        .set(once())
        .send({ when: 'ASAP', reason: 'Moving to another system' });
    const first = await cancel();
    expect(first.status).toBe(202);
    expect((await cancel()).body.code).toBe('SAS.CANCEL_PENDING');
    expect(
      (
        await request(app)
          .delete(`/api/v1/portal/cancellation-requests/${first.body.id}`)
          .set(session)
      ).status,
    ).toBe(204);
    expect((await cancel()).status).toBe(202);
    const declined = await request(app)
      .post(`/api/v1/ops/institutions/${id}/cancellation-requests/decline`)
      .set(ops)
      .send({ reason: 'Please settle the year first' });
    expect(declined.status).toBe(204);
    const state = await request(app).get('/api/v1/portal/cancellation').set(session);
    expect(state.body.request).toMatchObject({
      status: 'DECLINED',
      resolution: 'Please settle the year first',
    });
    const notices = await request(app).get('/api/v1/portal/notices').set(session);
    expect(notices.body.items.map((n: { action: string }) => n.action)).toEqual(
      expect.arrayContaining([
        'REGISTERED',
        'DATA_EXPORTED',
        'CANCELLATION_REQUESTED',
        'CANCELLATION_DECLINED',
      ]),
    );
  });

  it("never shows one institution's portal data to another", async () => {
    const a = await signUp(await account('ANITA'), `Anita School ${randomInt(0, 1e6)}`);
    const b = await signUp(await account('BHAVYA'), `Bhavya School ${randomInt(0, 1e6)}`);
    const ex = await request(app)
      .post('/api/v1/portal/data-exports')
      .set(a.session)
      .set(once())
      .send({ classes: ['members'] });
    expect(ex.status).toBe(201);
    expect(
      (await request(app).get(`/api/v1/portal/data-exports/${ex.body.id}`).set(b.session)).status,
    ).toBe(404);
    // A console session is not a portal session.
    expect((await request(app).get('/api/v1/portal/account').set(ops)).status).toBe(401);
  });
});

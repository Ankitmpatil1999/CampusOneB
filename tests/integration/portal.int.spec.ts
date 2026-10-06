/**
 * The customer portal on a real MySQL (SAS-001…025, SAS-044…050; FR-SAS-04…11, BR-01): an
 * administrator signs the institution up with their own RingPe account, finishes the checklist,
 * goes live on a trial, signs in again, changes plan, reports a transfer, asks RingPe to change the
 * name, exports the data and asks to cancel.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';
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

  it('lists the plans publicly and refuses numbers without a free account', async () => {
    const plans = await request(app).get('/api/v1/portal/plans');
    expect(plans.status).toBe(200);
    expect(plans.body.items.length).toBeGreaterThan(0);
    expect(plans.body.items[0]).not.toHaveProperty('institutions');
    expect(plans.body).toMatchObject({ graceDays: 14, dueDays: 15 });
    const none = await request(app).post('/api/v1/portal/signup/otp').send({ mobile: mobile() });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('SAS.SIGNUP_NO_ACCOUNT');
  });

  it('signs up, finishes the checklist, goes live on a trial and signs in again', async () => {
    const admin = await account('SAVITHA');
    const { id, session } = await signUp(admin, `Sharavathi Vidyalaya ${randomInt(0, 1e6)}`);

    // The same account can't sign up a second institution (BR-01).
    const again = await request(app)
      .post('/api/v1/portal/signup/otp')
      .send({ mobile: admin.mobile });
    expect(again.body.code).toBe('SAS.SIGNUP_ACCOUNT_IN_USE');

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

    // RingPe sets up the bank step.
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

  it('changes plan, refuses online payment, asks RingPe to rename, exports and asks to cancel', async () => {
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

    // Contacts the institution keeps; the name goes through RingPe.
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

    // Cancellation: asked, withdrawn, asked again, declined by RingPe.
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

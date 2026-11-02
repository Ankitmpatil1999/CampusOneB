/**
 * Subscriptions after go-live on a real MySQL (SAS-026, SAS-034…039, GOV-004; FR-SAS-05…08):
 * an upgrade now bills the rest of the cycle prorated; a lower-priced plan waits for renewal and
 * the billing run applies it; a trial changes at once; the console shows the plan, invoices and
 * requests, asks for a change and reports a bank transfer; unpaid invoices move to Grace and
 * Overdue with one reminder each; the job runs under its lock and a re-run changes nothing.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { sql } from 'kysely';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { addDays } from '../../services/billing.service';
import { istBusinessDate } from '../../utils/format';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'CampusOne@2026';

describe.skipIf(!adminUrl)('subscriptions after go-live on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let ops: Record<string, string>;
  let plans: { id: string; code: string; name: string }[];

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    ops = await signedIn('ops', (await operator()).email);
    plans = (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  const plan = (code: string) => plans.find((p) => p.code === code)!;
  const today = () => istBusinessDate(new Date());

  async function account(first: string) {
    const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@example.in`;
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
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
    return { id: String(r.insertId), email };
  }

  async function operator() {
    const a = await account('ARJUN');
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'PLATFORM_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: a.id, role_id: String(role.id) })
      .execute();
    return a;
  }

  async function signedIn(surface: 'ops' | 'console', email: string) {
    const base = surface === 'ops' ? '/api/v1/ops/auth' : '/api/v1/auth/console';
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

  /** A school on Campus Essentials (₹6,500 a month), onboarded; started with `start`. */
  async function school(start: 'ACTIVATE' | 'START_TRIAL' = 'ACTIVATE') {
    const admin = await account('LAKSHMI');
    const tag = randomInt(0, 1e9);
    const r = await request(app)
      .post('/api/v1/ops/institutions')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Sagar Public School ${tag}`,
        address: `Main Road ${tag}, Sagar`,
        city: 'Sagar',
        primaryContact: {
          name: 'Lakshmi Rao',
          email: `office.${tag}@sagar.example.in`,
          mobile: '9845012345',
        },
        adminEmail: admin.email,
        planId: plan('PL-ESS').id,
      });
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body
      .version;
    await request(app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(ops)
      .set('If-Match', `"v${version}"`)
      .send({
        corporateCode: `Y${String(randomInt(0, 999)).padStart(3, '0')}`,
        poolAccountRef: 'POOLSPS0001',
      });
    for (const step of ['toggles', 'year', 'feeacct']) {
      await request(app).post(`/api/v1/ops/institutions/${id}/checklist/${step}`).set(ops).send({});
    }
    const l = await request(app)
      .post(`/api/v1/ops/institutions/${id}/lifecycle-events`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ action: start, reason: 'Onboarding complete for the test' });
    expect(l.status).toBe(200);
    const row = await t.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirstOrThrow();
    return { id, rowId: String(row.id), admin, tag };
  }

  const change = (id: string, body: object) =>
    request(app)
      .post(`/api/v1/ops/institutions/${id}/plan-changes`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Requested by the principal', ...body });
  const detail = async (id: string) =>
    (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body;
  const invoicesOf = async (id: string) =>
    (await request(app).get(`/api/v1/ops/invoices?institutionId=${id}`).set(ops)).body.items as {
      id: string;
      trigger: string;
      status: string;
      total: { amount: string };
      amount: { amount: string };
      transfer: { utr: string } | null;
      lines: { description: string }[];
    }[];
  const run = async () => {
    const items: { status: string; note: string | null }[] = [];
    await h.services.subscriptions.billingRun({ periodKey: today(), item: (i) => items.push(i) });
    return items;
  };

  it('bills an upgrade now, prorated for the days left to renewal', async () => {
    const s = await school();
    const sub = await t.db
      .selectFrom('subscriptions')
      .select('renews_on')
      .where('institution_id', '=', s.rowId)
      .executeTakeFirstOrThrow();
    const renews = new Date(sub.renews_on!).toISOString().slice(0, 10);
    const left = Math.round((Date.parse(renews) - Date.parse(today())) / 86_400_000);

    const r = await change(s.id, { planId: plan('PL-PLUS').id, timing: 'NOW' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: 'Campus Plus', effective: 'NOW', effectiveOn: today() });
    // (₹1,80,000 − 12 × ₹6,500) × days left / 365, then 18 % GST.
    const amount = Math.round(((18_000_000 - 12 * 650_000) * left) / 365);
    const total = amount + Math.floor((amount * 1800 + 5000) / 10000);
    expect(r.body.invoice.total.amount).toBe((total / 100).toFixed(2));
    const inv = (await invoicesOf(s.id)).find((i) => i.trigger === 'PLAN_CHANGE')!;
    expect(inv.lines[0]!.description).toBe(
      `Campus Plus − Campus Essentials, ${left} days prorated`,
    );
    expect((await detail(s.id)).plan.name).toBe('Campus Plus');

    const same = await change(s.id, { planId: plan('PL-PLUS').id, timing: 'NOW' });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('SAS.PLAN_SAME');
    const short = await change(s.id, { planId: plan('PL-PRO').id, timing: 'NOW', reason: 'short' });
    expect(short.status).toBe(422);
    expect(short.body.errors[0].code).toBe('INS.REASON_TOO_SHORT');
  });

  it('schedules a lower-priced plan for renewal; the billing run applies it once', async () => {
    const s = await school();
    await change(s.id, { planId: plan('PL-PRO').id, timing: 'NOW' });
    // Transport is in Campus Pro, not in Campus Essentials.
    await t.db
      .updateTable('feature_toggles')
      .set({ enabled: 1 })
      .where('institution_id', '=', s.rowId)
      .where('feature_key', '=', 'transport')
      .execute();

    const now = await change(s.id, { planId: plan('PL-ESS').id, timing: 'NOW' });
    expect(now.status).toBe(422);
    expect(now.body.errors[0]).toMatchObject({ field: 'timing', code: 'SAS.DOWNGRADE_AT_RENEWAL' });
    const later = await change(s.id, { planId: plan('PL-ESS').id, timing: 'RENEWAL' });
    expect(later.status).toBe(200);
    expect(later.body.effective).toBe('RENEWAL');
    let d = await detail(s.id);
    expect(d.subscription.scheduledChange).toEqual({
      plan: 'Campus Essentials',
      on: d.subscription.renewsOn,
    });
    expect(d.plan.name).toBe('Campus Pro');

    // Cancel, then schedule again.
    const cancel = await request(app)
      .post(`/api/v1/ops/institutions/${s.id}/plan-changes/scheduled/cancel`)
      .set(ops)
      .send({ reason: 'The principal changed their mind' });
    expect(cancel.status).toBe(204);
    expect((await detail(s.id)).subscription.scheduledChange).toBeNull();
    await change(s.id, { planId: plan('PL-ESS').id, timing: 'RENEWAL' });

    // The renewal date arrives.
    await t.db
      .updateTable('subscriptions')
      .set({ renews_on: today() })
      .where('institution_id', '=', s.rowId)
      .execute();
    const items = await run();
    expect(items.some((i) => i.status === 'SUCCESS')).toBe(true);
    d = await detail(s.id);
    expect(d.plan.name).toBe('Campus Essentials');
    expect(d.subscription.scheduledChange).toBeNull();
    expect(d.subscription.renewsOn > today()).toBe(true);
    expect(d.history[0]).toMatchObject({ action: 'PLAN_CHANGE', to: 'Campus Essentials' });
    const transport = await t.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', s.rowId)
      .where('feature_key', '=', 'transport')
      .executeTakeFirstOrThrow();
    expect(Number(transport.enabled)).toBe(0);
    const renewal = (await invoicesOf(s.id)).filter((i) => i.trigger === 'RENEWAL');
    expect(renewal).toHaveLength(1);
    expect(renewal[0]!.amount.amount).toBe('6500.00');

    // A second run on the same day changes nothing.
    const before = (await invoicesOf(s.id)).length;
    await run();
    expect((await invoicesOf(s.id)).length).toBe(before);
    expect((await detail(s.id)).subscription.renewsOn).toBe(d.subscription.renewsOn);
  });

  it('changes a trial at once without an invoice', async () => {
    const s = await school('START_TRIAL');
    const r = await change(s.id, { planId: plan('PL-PLUS').id, timing: 'RENEWAL' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ effective: 'NOW', invoice: null });
    expect((await detail(s.id)).plan.name).toBe('Campus Plus');
    expect(await invoicesOf(s.id)).toHaveLength(0);
  });

  it('lets the institution see its plan, ask for a change and report a transfer', async () => {
    const s = await school();
    const con = await signedIn('console', s.admin.email);
    const sum = await request(app).get('/api/v1/console/subscription').set(con);
    expect(sum.status).toBe(200);
    expect(sum.body.plan.name).toBe('Campus Essentials');
    expect(sum.body.subscription.status).toBe('ACTIVE');
    expect(sum.body.modules.find((m: { module: string }) => m.module === 'Transport')).toEqual({
      module: 'Transport',
      included: false,
    });
    expect(sum.body.invoices).toHaveLength(1);
    expect(sum.body.billing).toMatchObject({ graceDays: 14, renewalBillDaysBefore: 15 });

    const ask = (body: object) =>
      request(app)
        .post('/api/v1/console/subscription/plan-change-requests')
        .set(con)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const same = await ask({ planId: plan('PL-ESS').id, timing: 'NOW' });
    expect(same.body.code).toBe('SAS.PLAN_SAME');
    const first = await ask({ planId: plan('PL-PLUS').id, timing: 'NOW', note: 'Buses from June' });
    expect(first.status).toBe(201);
    expect((await ask({ planId: plan('PL-PRO').id, timing: 'RENEWAL' })).body.code).toBe(
      'SAS.REQUEST_PENDING',
    );
    expect((await detail(s.id)).planRequests[0]).toMatchObject({
      status: 'PENDING',
      plan: { name: 'Campus Plus' },
      note: 'Buses from June',
    });

    // Another institution's console can't touch it (tenant isolation).
    const other = await school();
    const otherCon = await signedIn('console', other.admin.email);
    const foreign = await request(app)
      .delete(`/api/v1/console/subscription/plan-change-requests/${first.body.id}`)
      .set(otherCon);
    expect(foreign.status).toBe(404);

    const withdraw = () =>
      request(app)
        .delete(`/api/v1/console/subscription/plan-change-requests/${first.body.id}`)
        .set(con);
    expect((await withdraw()).status).toBe(204);
    const again = await withdraw();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SAS.REQUEST_CLOSED');

    // Declined by CampusOne, with the reason e-mailed.
    const second = await ask({ planId: plan('PL-PRO').id, timing: 'RENEWAL' });
    const decline = await request(app)
      .post(`/api/v1/ops/plan-change-requests/${second.body.id}/decline`)
      .set(ops)
      .send({ reason: 'Campus Pro is not offered in this region yet' });
    expect(decline.status).toBe(200);
    expect(h.email.sent.at(-1)!.text).toContain('Campus Pro is not offered in this region yet');

    // Applied when CampusOne changes the plan.
    const third = await ask({ planId: plan('PL-PLUS').id, timing: 'NOW' });
    await change(s.id, { planId: plan('PL-PLUS').id, timing: 'NOW' });
    const after = await request(app).get('/api/v1/console/subscription').set(con);
    expect(after.body.plan.name).toBe('Campus Plus');
    expect(after.body.requests.find((r: { id: string }) => r.id === third.body.id).status).toBe(
      'APPLIED',
    );

    // A bank transfer reported from the console, confirmed by CampusOne.
    const inv = after.body.invoices.find(
      (i: { trigger: string }) => i.trigger === 'PLAN_ACTIVATION',
    );
    const report = (body: object) =>
      request(app).post(`/api/v1/console/invoices/${inv.id}/transfer-reports`).set(con).send(body);
    const bad = await report({ utr: 'UTR 1', paidOn: today() });
    expect(bad.body.errors[0].code).toBe('SAS.UTR_FORMAT');
    const utr = `SBIN${randomInt(1e9, 1e10)}`;
    const ok = await report({ utr, paidOn: today() });
    expect(ok.status).toBe(200);
    expect(ok.body.transfer).toMatchObject({ utr, paidOn: today() });
    const foreignInvoice = await request(app)
      .post(`/api/v1/console/invoices/${inv.id}/transfer-reports`)
      .set(otherCon)
      .send({ utr, paidOn: today() });
    expect(foreignInvoice.status).toBe(404);
    const paid = await request(app)
      .post(`/api/v1/ops/invoices/${inv.id}/payments`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ utr, amount: inv.total, paidOn: today() });
    expect(paid.status).toBe(201);
    expect(paid.body.invoice).toMatchObject({ status: 'PAID', transfer: null });
  });

  it('moves an unpaid invoice to Grace, then Overdue, with one reminder each', async () => {
    const s = await school();
    const inv = (await invoicesOf(s.id))[0]!;
    const setDates = (issued: string, due: string, grace: string) =>
      t.db
        .updateTable('invoices')
        .set({ issued_on: issued, due_on: due, grace_until_on: grace })
        .where('public_id', '=', uuidToBin(inv.id))
        .execute();
    const t0 = today();
    await setDates(addDays(t0, -20), addDays(t0, -5), addDays(t0, 9));
    const mails = h.email.sent.length;
    await run();
    expect((await invoicesOf(s.id))[0]!.status).toBe('GRACE');
    expect(h.email.sent.length).toBe(mails + 1);
    expect(h.email.sent.at(-1)!.text).toContain('Reminder');
    let d = await detail(s.id);
    expect(d.subscription.status).toBe('GRACE');
    expect(d.history[0].action).toBe('GRACE_STARTED');

    await run();
    expect(h.email.sent.length).toBe(mails + 1);

    await setDates(addDays(t0, -40), addDays(t0, -25), addDays(t0, -11));
    await run();
    expect((await invoicesOf(s.id))[0]!.status).toBe('OVERDUE');
    expect(h.email.sent.length).toBe(mails + 2);
    expect(h.email.sent.at(-1)!.text).toContain('unpaid after the grace period');
    d = await detail(s.id);
    expect(d.history[0].action).toBe('GRACE_ENDED');
    expect(d.status).toBe('ACTIVE');

    // Paying ends the grace.
    const paid = await request(app)
      .post(`/api/v1/ops/invoices/${inv.id}/payments`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ utr: `HDFC${randomInt(1e9, 1e10)}`, amount: inv.total, paidOn: addDays(t0, -1) });
    expect(paid.status).toBe(201);
    expect((await detail(s.id)).subscription.status).toBe('ACTIVE');
  });

  it('runs the billing job by hand under its lock and logs the run', async () => {
    const runNow = () =>
      request(app)
        .post('/api/v1/ops/jobs/subscription-billing/runs')
        .set(ops)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Checking the billing run' });
    const r = await runNow();
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ jobId: 'subscription-billing', trigger: 'MANUAL' });
    expect(['SUCCESS', 'PARTIAL_FAILURE']).toContain(r.body.status);
    const cat = await request(app).get('/api/v1/ops/jobs').set(ops);
    const job = cat.body.items.find((j: { id: string }) => j.id === 'subscription-billing');
    expect(job).toMatchObject({ available: true, lastRun: { id: r.body.id } });

    // While another run holds the lock, a manual run is refused.
    await t.db.connection().execute(async (conn) => {
      await sql`SELECT GET_LOCK('campusone:job:subscription-billing', 0)`.execute(conn);
      try {
        const busy = await runNow();
        expect(busy.status).toBe(409);
        expect(busy.body.code).toBe('GOV.JOB_RUNNING');
      } finally {
        await sql`SELECT RELEASE_LOCK('campusone:job:subscription-billing')`.execute(conn);
      }
    });
    const future = await request(app)
      .post('/api/v1/ops/jobs/subscription-billing/runs')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'A future date', period: addDays(today(), 3) });
    expect(future.status).toBe(422);
  });
  it('keeps example invoice details until CampusOne enters its own, and prints GST invoices', async () => {
    const s = await school();
    const con = await signedIn('console', s.admin.email);
    const sum = await request(app).get('/api/v1/console/subscription').set(con);
    expect(sum.body.payee).toMatchObject({ ifsc: 'EXMP0000001', example: true });
    const inv = sum.body.invoices[0];

    const pdf = await request(app)
      .get(`/api/v1/console/invoices/${inv.id}/pdf`)
      .set(con)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`${inv.invoiceNo}.pdf`);
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('SAMPLE - example CampusOne details');

    // Another institution's console can't read it; the back office can.
    const other = await school();
    const otherCon = await signedIn('console', other.admin.email);
    expect(
      (await request(app).get(`/api/v1/console/invoices/${inv.id}/pdf`).set(otherCon)).status,
    ).toBe(404);
    expect((await request(app).get(`/api/v1/ops/invoices/${inv.id}/pdf`).set(ops)).status).toBe(
      200,
    );

    const profile = await request(app).get('/api/v1/ops/billing-profile').set(ops);
    expect(profile.body).toMatchObject({ example: true, stateCode: '29', stateName: 'Karnataka' });
    const body = {
      legalName: 'CampusOne Technologies Private Limited',
      gstin: '29ABCDE1234F1Z5',
      address: '2nd Floor, MG Road, Bengaluru, Karnataka 560001',
      sacCode: '998314',
      payee: {
        name: 'CampusOne Technologies',
        bank: 'State Bank of India',
        accountNo: '40123456789',
        ifsc: 'SBIN0001234',
      },
    };
    const bad = await request(app)
      .put('/api/v1/ops/billing-profile')
      .set(ops)
      .set('If-Match', `"v${profile.body.etag}"`)
      .send({ ...body, gstin: '29ABCDE1234F1X5', payee: { ...body.payee, ifsc: 'SBIN1234' } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { code: string }) => e.code).sort()).toEqual([
      'IDN.IFSC_INVALID',
      'SAS.GSTIN_FORMAT',
    ]);
    expect((await request(app).put('/api/v1/ops/billing-profile').set(ops).send(body)).status).toBe(
      428,
    );
    const ok = await request(app)
      .put('/api/v1/ops/billing-profile')
      .set(ops)
      .set('If-Match', `"v${profile.body.etag}"`)
      .send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ example: false, gstin: '29ABCDE1234F1Z5' });
    const stale = await request(app)
      .put('/api/v1/ops/billing-profile')
      .set(ops)
      .set('If-Match', `"v${profile.body.etag}"`)
      .send(body);
    expect(stale.status).toBe(412);
  });
});

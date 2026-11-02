/**
 * Trials and billing on a real MySQL (SAS-030…032, INS-005; FR-SAS-06…08; Q14 · M14 defaults: 30-day
 * trial, due in 15 days, 14 days of grace, GST 18 %): a trial starts the subscription; activation
 * converts it and bills the first cycle; renewal and overage invoices, one per period; a bank
 * transfer equal to the total marks an invoice paid and restores a suspended institution; Grace and
 * Overdue follow the dates.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { addDays, addMonths } from '../../services/billing.service';
import { istBusinessDate } from '../../utils/format';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'CampusOne@2026';

describe.skipIf(!adminUrl)('trials and billing on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let ops: Record<string, string>;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    ops = await operator();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

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
    const s1 = await request(app)
      .post('/api/v1/ops/auth/signin')
      .send({ email: a.email, password: PASSWORD });
    const v = await request(app)
      .post('/api/v1/ops/auth/otp/verify')
      .send({ challengeId: s1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const cookies = ([] as string[])
      .concat(v.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': v.body.csrfToken as string };
  }

  /** A school on Campus Essentials (₹6,500 / month) with every required step done. */
  async function readySchool() {
    const plans = (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;
    const ess = plans.find((p: { code: string }) => p.code === 'PL-ESS');
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
          email: 'office@sagar.example.in',
          mobile: '9845012345',
        },
        adminEmail: admin.email,
        planId: ess.id,
      });
    const id = r.body.id as string;
    const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body
      .version;
    await request(app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(ops)
      .set('If-Match', `"v${version}"`)
      .send({
        corporateCode: `Z${String(randomInt(0, 999)).padStart(3, '0')}`,
        poolAccountRef: 'POOLSPS0001',
      });
    for (const step of ['toggles', 'year', 'feeacct']) {
      await request(app).post(`/api/v1/ops/institutions/${id}/checklist/${step}`).set(ops).send({});
    }
    return id;
  }

  const life = (id: string, action: string) =>
    request(app)
      .post(`/api/v1/ops/institutions/${id}/lifecycle-events`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ action, reason: 'Recorded by the billing test' });
  const generate = (body: object) =>
    request(app)
      .post('/api/v1/ops/invoices')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const pay = (invoiceId: string, body: object) =>
    request(app)
      .post(`/api/v1/ops/invoices/${invoiceId}/payments`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  it('starts a trial, converts it with the first-cycle invoice, and bills renewal and overage', async () => {
    const id = await readySchool();
    const today = istBusinessDate(new Date());
    // The plan step is completed by choosing a plan, never by "Mark done".
    expect(
      (await request(app).post(`/api/v1/ops/institutions/${id}/checklist/plan`).set(ops).send({}))
        .status,
    ).toBe(404);

    const trial = await life(id, 'START_TRIAL');
    expect(trial.status).toBe(200);
    expect(trial.body).toMatchObject({ status: 'ACTIVE', invoice: null });
    let d = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body;
    expect(d.subscription).toMatchObject({ status: 'TRIAL', trialEndsOn: addDays(today, 30) });
    expect(d.actions.map((a: { action: string }) => a.action)).toEqual([
      'ACTIVATE',
      'SUSPEND',
      'CANCEL',
    ]);
    expect(d.history[0]).toMatchObject({ action: 'TRIAL_STARTED', to: 'ACTIVE' });
    expect((await life(id, 'START_TRIAL')).body.code).toBe('INS.TRANSITION_INVALID');

    const mails = h.email.sent.length;
    const active = await life(id, 'ACTIVATE');
    expect(active.status).toBe(200);
    expect(active.body.invoice).toMatchObject({
      total: { amount: '7670.00', currency: 'INR' },
      dueOn: addDays(today, 15),
    });
    expect(
      h.email.sent.slice(mails).some((m) => m.text.includes(active.body.invoice.invoiceNo)),
    ).toBe(true);
    d = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body;
    expect(d.subscription).toMatchObject({
      status: 'ACTIVE',
      trialEndsOn: null,
      renewsOn: addMonths(today, 1),
    });
    expect(d.history[0]).toMatchObject({ action: 'ACTIVATED', from: 'TRIAL', to: 'ACTIVE' });

    const renewal = await generate({ institutionId: id, trigger: 'RENEWAL' });
    expect(renewal.status).toBe(201);
    expect(renewal.body).toMatchObject({
      trigger: 'RENEWAL',
      status: 'DUE',
      total: { amount: '7670.00', currency: 'INR' },
      taxPercent: '18.00',
      lines: [{ description: 'Campus Essentials · monthly · renewal', quantity: 1 }],
    });
    expect((await generate({ institutionId: id, trigger: 'RENEWAL' })).body).toMatchObject({
      code: 'SAS.INVOICE_DUPLICATE',
      detail: 'An invoice for this period already exists',
    });
    const overage = await generate({ institutionId: id, trigger: 'USAGE_OVERAGE', smsOver: 1000 });
    expect(overage.body).toMatchObject({
      amount: { amount: '250.00', currency: 'INR' },
      total: { amount: '295.00', currency: 'INR' },
    });
    expect(
      (await generate({ institutionId: id, trigger: 'USAGE_OVERAGE', smsOver: 0 })).body.errors[0]
        .code,
    ).toBe('SAS.NOTHING_TO_BILL');
  });

  it('records a bank transfer, restores a suspended institution, and shows grace and overdue by date', async () => {
    const id = await readySchool();
    const today = istBusinessDate(new Date());
    const first = (await life(id, 'ACTIVATE')).body.invoice;
    expect((await life(id, 'SUSPEND')).status).toBe(200);
    expect(
      (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body.subscription.status,
    ).toBe('SUSPENDED');

    const utr = `UTR${randomInt(10_000_000, 99_999_999)}`;
    const bad = async (body: object) => {
      const r = await pay(first.id, body);
      return r.body.errors?.[0]?.code ?? r.body.code;
    };
    expect(await bad({ utr: 'short', amount: first.total, paidOn: today })).toBe('SAS.UTR_FORMAT');
    expect(await bad({ utr, amount: { amount: '100.00', currency: 'INR' }, paidOn: today })).toBe(
      'SAS.AMOUNT_MISMATCH',
    );
    expect(await bad({ utr, amount: first.total, paidOn: addDays(today, 1) })).toBe(
      'SAS.PAID_ON_FUTURE',
    );
    expect(await bad({ utr, amount: first.total, paidOn: addDays(today, -1) })).toBe(
      'SAS.PAID_ON_BEFORE_ISSUE',
    );
    const paid = await pay(first.id, {
      utr: utr.toLowerCase(),
      amount: first.total,
      paidOn: today,
    });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({
      institutionRestored: true,
      invoice: {
        status: 'PAID',
        payment: { method: 'BANK_TRANSFER', reference: utr, paidOn: today },
      },
    });
    const d = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body;
    expect(d.status).toBe('ACTIVE');
    expect(d.subscription.status).toBe('ACTIVE');
    expect(d.history[0].reason).toContain(`Invoice ${first.invoiceNo} paid`);
    expect(
      (await pay(first.id, { utr: `${utr}9`, amount: first.total, paidOn: today })).body.code,
    ).toBe('SAS.INVOICE_NOT_PAYABLE');

    // A renewal invoice whose due date and grace have passed shows Grace, then Overdue.
    const renewal = (await generate({ institutionId: id, trigger: 'RENEWAL' })).body;
    expect((await pay(renewal.id, { utr, amount: renewal.total, paidOn: today })).body.code).toBe(
      'SAS.UTR_TAKEN',
    );
    const invoiceNo = renewal.invoiceNo as string;
    const setDates = (due: string, grace: string, issued: string) =>
      t.db
        .updateTable('invoices')
        .set({ issued_on: issued, due_on: due, grace_until_on: grace })
        .where('invoice_no', '=', invoiceNo)
        .execute();
    const status = async () =>
      (
        (await request(app).get(`/api/v1/ops/invoices?institutionId=${id}`).set(ops)).body
          .items as {
          invoiceNo: string;
          status: string;
        }[]
      ).find((x) => x.invoiceNo === invoiceNo)?.status;
    await setDates(addDays(today, -1), addDays(today, 13), addDays(today, -16));
    expect(await status()).toBe('GRACE');
    await setDates(addDays(today, -15), addDays(today, -1), addDays(today, -30));
    expect(await status()).toBe('OVERDUE');
  });
});

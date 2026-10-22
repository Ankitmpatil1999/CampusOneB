/**
 * Collect Fee on a real MySQL (client 2026-10-19; FEE-046…051): the student's VAN and instalments;
 * an instalment collected in cash with a receipt; a QR code and a payment link (sent by SMS and
 * e-mail) opening the school's payment page, paid through the gateway — confirmed by the page and,
 * when the family closed it, by the gateway's webhook, once; a link of an instalment paid another way
 * is closed; and every figure (the record, the collection details) counts what was collected.
 */
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { buildHttpApp } from './http-app';
import { inr, schoolFixture, type Auth, type Payer } from './school';
import type { GatewayPayment, PaymentGateway } from '../../integrations/payment-gateway.provider';
import { uuidToBin } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('collect fee: cash, a QR code or a payment link', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let year: { id: string; label: string };
  let today: string;
  let asha: Payer;
  /** Asha's father, with an account of his own. */
  let ravi: Payer;

  const post = (path: string, body: object = {}, key = randomUUID()) =>
    request(f.app).post(path).set(con).set('Idempotency-Key', key).send(body);
  const raise = async (student: Payer, amount: string, label: string) => {
    const r = await post('/api/v1/console/fee-records', {
      studentId: student.id,
      yearId: year.id,
      label,
      dueDate: today,
      amount: inr(amount),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string };
  };
  const row = (recordId: string) =>
    f.t.db
      .selectFrom('fee_records')
      .selectAll()
      .where('public_id', '=', uuidToBin(recordId))
      .executeTakeFirstOrThrow();
  const view = () =>
    request(f.app).get(`/api/v1/console/fee-collection/students/${asha.id}/collect`).set(con);
  /** The link's request id and token. */
  const partsOf = (link: string) => {
    const u = new URL(link);
    return { id: u.pathname.split('/').at(-1)!, token: u.searchParams.get('token')! };
  };
  const page = (app: typeof f.app, id: string, token: string) =>
    request(app).get(`/api/v1/public/fee-payments/${id}`).set('X-Fee-Pay-Token', token);

  beforeAll(async () => {
    f = await schoolFixture('Collect Fee School');
    con = f.school.con;
    today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    asha = await f.student('Asha', 0);
    const ef = (await request(f.app).get('/api/v1/console/entry-fees').set(con)).body.items as {
      year: { id: string; label: string; current: boolean };
    }[];
    year = ef.find((x) => x.year.current)!.year;
    // The school sends SMS and e-mail to families.
    await f.t.db
      .insertInto('notification_channel_settings')
      .values(
        (['SMS', 'EMAIL'] as const).map((channel) => ({
          institution_id: f.school.rowId,
          channel,
          enabled: 1,
        })),
      )
      .onDuplicateKeyUpdate({ enabled: 1 })
      .execute();
    await f.t.db
      .updateTable('member_profiles')
      .set({ contact_email: 'asha.rao@example.in' })
      .where('id', '=', asha.rowId)
      .execute();
    ravi = await f.payer('Ravi', 0);
    await f.t.db
      .updateTable('member_profiles')
      .set({ contact_mobile: ravi.mobile, contact_email: 'ravi.rao@example.in' })
      .where('id', '=', ravi.rowId)
      .execute();
    await f.t.db
      .insertInto('guardianships')
      .values({
        institution_id: f.school.rowId,
        guardian_profile_id: ravi.rowId,
        ward_profile_id: asha.rowId,
        relation: 'FATHER',
        is_primary_contact: 1,
      })
      .execute();
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('collects an instalment in cash, with a receipt the record and the collection details show (FEE-046/047)', async () => {
    const term1 = await raise(asha, '12500.00', 'Term 1');
    const before = await view();
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toMatchObject({
      year: { id: year.id },
      student: { id: asha.id, name: 'Asha Rao' },
      sendTo: { mobile: expect.stringMatching(/^•+\d{4}$/), email: 'a•••@example.in' },
    });
    expect(before.body).toHaveProperty('van');
    expect(before.body.instalments).toEqual([
      expect.objectContaining({
        recordId: term1.id,
        label: 'Term 1',
        outstanding: inr('12500.00'),
        collectable: true,
      }),
    ]);

    const cash = await post(`/api/v1/console/fee-records/${term1.id}/cash`, { paidBy: 'Ramesh' });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body).toMatchObject({
      amount: inr('12500.00'),
      mode: 'CASH',
      status: 'PAID',
      receiptNo: expect.stringMatching(/^[A-Z0-9]{2,5}\/FR\/\d{4}\/\d{6}$/),
    });
    expect(await row(term1.id)).toMatchObject({
      status: 'PAID',
      paid_paise: '1250000',
      paid_reference: cash.body.receiptNo,
    });
    // The record's collections and the collection details count it.
    const detail = await request(f.app).get(`/api/v1/console/fee-records/${term1.id}`).set(con);
    expect(detail.body.collections).toEqual([
      expect.objectContaining({
        reference: cash.body.receiptNo,
        mode: 'CASH',
        paidBy: 'Ramesh',
        amount: inr('12500.00'),
      }),
    ]);
    const fc = await request(f.app).get(`/api/v1/console/fee-collection?q=Asha`).set(con);
    expect(fc.body.students[0].total.collected).toEqual(inr('12500.00'));
    // Nothing more to collect on it.
    const again = await post(`/api/v1/console/fee-records/${term1.id}/cash`, {});
    expect(again.body.code).toBe('FEE.RECORD_PAID');
    expect((await view()).body.instalments[0]).toMatchObject({
      outstanding: inr('0.00'),
      collectable: false,
    });
  });

  it('shows a QR code whose page takes the payment through the gateway, once (FEE-048…051)', async () => {
    const term2 = await raise(asha, '6000.00', 'Term 2');
    const qr = await post(`/api/v1/console/fee-records/${term2.id}/payment-requests`, {
      channel: 'QR',
    });
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    expect(qr.body).toMatchObject({ channel: 'QR', amount: inr('6000.00') });
    expect(qr.body.qrSvg).toMatch(/^<svg/);
    expect(qr.body.link).toMatch(/\/fees\/pay\/[0-9a-f-]{36}\?token=/);
    const { id, token } = partsOf(qr.body.link);

    // The page: the school, the student, the instalment, the amount.
    const p = await page(f.app, id, token);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({
      school: { name: expect.stringMatching(/^Collect Fee School/) },
      student: { name: 'Asha Rao' },
      instalment: { label: 'Term 2', dueDate: today },
      amount: inr('6000.00'),
      status: 'OPEN',
    });
    expect((await page(f.app, id, 'not-a-token')).body.code).toBe('FEE.PAY_LINK_INVALID');
    expect((await page(f.app, randomUUID(), token)).body.code).toBe('FEE.PAY_LINK_INVALID');

    // The test gateway's order and its answer.
    const order = await request(f.app)
      .post(`/api/v1/public/fee-payments/${id}/orders`)
      .set('X-Fee-Pay-Token', token)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body).toMatchObject({ amount: inr('6000.00'), gatewayOrder: { mode: 'test' } });
    const t = order.body.gatewayOrder.test as { paymentId: string; signature: string };
    const verify = (body: object) =>
      request(f.app)
        .post(`/api/v1/public/fee-payments/${id}/verify`)
        .set('X-Fee-Pay-Token', token)
        .send(body);
    expect((await verify({ gatewayPaymentId: t.paymentId, signature: 'bad' })).body.code).toBe(
      'FEE.PAYMENT_NOT_VERIFIED',
    );
    const ok = await verify({ gatewayPaymentId: t.paymentId, signature: t.signature });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'PAID',
      transactionId: t.paymentId,
      receiptNo: expect.stringMatching(/\/FR\/\d{4}\/\d{6}$/),
    });
    // The same answer again: the same receipt, not a second collection.
    const twice = await verify({ gatewayPaymentId: t.paymentId, signature: t.signature });
    expect(twice.body.receiptNo).toBe(ok.body.receiptNo);
    expect(await row(term2.id)).toMatchObject({ status: 'PAID', paid_paise: '600000' });
    const detail = await request(f.app).get(`/api/v1/console/fee-records/${term2.id}`).set(con);
    expect(detail.body.collections).toEqual([
      expect.objectContaining({ mode: 'ONLINE', transactionId: t.paymentId }),
    ]);
  });

  it('sends a payment link for a day to the student and the parents: SMS, e-mail and in the app; paid in cash meanwhile, the link closes', async () => {
    const term3 = await raise(asha, '4000.00', 'Term 3');
    const sms = f.h.sms.sent.length;
    const mail = f.h.email.sent.length;
    const link = await post(`/api/v1/console/fee-records/${term3.id}/payment-requests`, {
      channel: 'LINK',
    });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body).toMatchObject({
      channel: 'LINK',
      sentTo: {
        mobiles: [
          expect.stringMatching(new RegExp(`${asha.mobile.slice(-4)}$`)),
          expect.stringMatching(new RegExp(`${ravi.mobile.slice(-4)}$`)),
        ],
        emails: ['a•••@example.in', 'r•••@example.in'],
        inApp: 2,
      },
    });
    expect(link.body).not.toHaveProperty('qrSvg');
    // Valid for one day (client 2026-10-22).
    const hours = (Date.parse(link.body.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
    const sent = f.h.sms.sent.slice(sms);
    const text = sent.find((m) => m.to === asha.mobile)?.text ?? '';
    expect(text).toContain('Term 3');
    expect(text).toContain(link.body.link);
    expect(sent.find((m) => m.to === ravi.mobile)?.text).toBe(text);
    const mails = f.h.email.sent.slice(mail);
    expect(mails.find((m) => m.to === 'asha.rao@example.in')?.purpose).toBe('fee.payLink');
    expect(mails.find((m) => m.to === 'ravi.rao@example.in')?.purpose).toBe('fee.payLink');
    // In the app, to Asha and her father.
    const notices = await f.t.db
      .selectFrom('notifications')
      .select(['account_id', 'body'])
      .where('title_key', '=', 'NTF.FEE_PAY_LINK')
      .execute();
    expect(notices.map((n) => String(n.account_id)).sort()).toEqual(
      [asha.accountId, ravi.accountId].sort(),
    );
    expect(notices[0]!.body).toContain(link.body.link);

    // Collected at the office before the family paid: the page says so; no order.
    await post(`/api/v1/console/fee-records/${term3.id}/cash`, {});
    const { id, token } = partsOf(link.body.link);
    expect((await page(f.app, id, token)).body.status).toBe('CLOSED');
    const order = await request(f.app)
      .post(`/api/v1/public/fee-payments/${id}/orders`)
      .set('X-Fee-Pay-Token', token)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(order.body.code).toBe('FEE.RECORD_PAID');
  });

  it('takes Pay now at the desk through the gateway, without a link, once (FEE-052/053)', async () => {
    const term5 = await raise(asha, '3200.00', 'Term 5');
    const sms = f.h.sms.sent.length;
    const mail = f.h.email.sent.length;
    const order = await post(`/api/v1/console/fee-records/${term5.id}/orders`);
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body).toMatchObject({
      requestId: expect.any(String),
      amount: inr('3200.00'),
      gatewayOrder: { mode: 'test' },
    });
    expect(order.body).not.toHaveProperty('link');
    // Nothing is sent to the family.
    expect(f.h.sms.sent.length).toBe(sms);
    expect(f.h.email.sent.length).toBe(mail);
    const t = order.body.gatewayOrder.test as { paymentId: string; signature: string };
    const verify = (body: object, requestId = order.body.requestId as string) =>
      request(f.app)
        .post(`/api/v1/console/fee-records/${term5.id}/orders/${requestId}/verify`)
        .set(con)
        .send(body);
    expect((await verify({ gatewayPaymentId: t.paymentId, signature: 'bad' })).body.code).toBe(
      'FEE.PAYMENT_NOT_VERIFIED',
    );
    expect(
      (await verify({ gatewayPaymentId: t.paymentId, signature: t.signature }, randomUUID()))
        .status,
    ).toBe(404);
    const ok = await verify({ gatewayPaymentId: t.paymentId, signature: t.signature });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'PAID',
      mode: 'ONLINE',
      recordId: term5.id,
      transactionId: t.paymentId,
      receiptNo: expect.stringMatching(/\/FR\/\d{4}\/\d{6}$/),
    });
    const twice = await verify({ gatewayPaymentId: t.paymentId, signature: t.signature });
    expect(twice.body.receiptNo).toBe(ok.body.receiptNo);
    expect(await row(term5.id)).toMatchObject({ status: 'PAID', paid_paise: '320000' });
    // The desk's collection, kept with the request (channel DESK).
    const c = await f.t.db
      .selectFrom('fee_collections')
      .select(['source', 'mode', 'collected_by'])
      .where('receipt_no', '=', ok.body.receiptNo)
      .executeTakeFirstOrThrow();
    expect(c).toMatchObject({ source: 'CONSOLE', mode: 'ONLINE' });
    expect(c.collected_by).not.toBeNull();
    const req = await f.t.db
      .selectFrom('fee_payment_requests')
      .select(['channel', 'status', 'sent_mobile', 'sent_email'])
      .where('public_id', '=', uuidToBin(order.body.requestId))
      .executeTakeFirstOrThrow();
    expect(req).toEqual({ channel: 'DESK', status: 'PAID', sent_mobile: null, sent_email: null });
    // Paid: no second order.
    expect((await post(`/api/v1/console/fee-records/${term5.id}/orders`)).body.code).toBe(
      'FEE.RECORD_PAID',
    );
  });

  it('takes a live payment the family left the page on: the gateway’s webhook collects it (SAS-033)', async () => {
    const KEY_SECRET = 'rzp-key-secret';
    const HOOK_SECRET = 'rzp-hook-secret';
    const held = new Map<string, GatewayPayment>();
    const gateway: PaymentGateway = {
      mode: 'live',
      async createOrder({ amountPaise }) {
        return {
          orderId: `order_FEE${randomUUID().slice(0, 6)}`,
          amountPaise,
          checkout: { keyId: 'rzp_test_FAKE' },
        };
      },
      verify: ({ orderId, paymentId, signature }) =>
        signature ===
        createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex'),
      async fetchPayment(id) {
        const p = held.get(id);
        if (!p) throw new Error('unknown payment');
        return p;
      },
      verifyWebhook: (raw, sig) =>
        sig === createHmac('sha256', HOOK_SECRET).update(raw).digest('hex'),
    };
    // RingPe's own gateway in live mode serves a school without one of its own.
    const live = await buildHttpApp(f.t, { overrides: { gateway }, security: f.h.security });
    const term4 = await raise(asha, '2500.00', 'Term 4');
    const qr = await request(live.app)
      .post(`/api/v1/console/fee-records/${term4.id}/payment-requests`)
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ channel: 'QR' });
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    const { id, token } = partsOf(qr.body.link);
    const order = await request(live.app)
      .post(`/api/v1/public/fee-payments/${id}/orders`)
      .set('X-Fee-Pay-Token', token)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.gatewayOrder).toMatchObject({
      mode: 'live',
      checkout: { keyId: 'rzp_test_FAKE' },
    });
    const event = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_FEEHOOK',
            order_id: order.body.gatewayOrder.orderId,
            amount: 250000,
            status: 'captured',
          },
        },
      },
    });
    const hook = await request(live.app)
      .post('/api/v1/partners/gateway/webhooks')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', createHmac('sha256', HOOK_SECRET).update(event).digest('hex'))
      .set('X-Razorpay-Event-Id', `evt_${randomUUID()}`)
      .send(event);
    expect(hook.status, JSON.stringify(hook.body)).toBe(200);
    expect(hook.body).toEqual({ ok: true, outcome: 'PAID' });
    expect(await row(term4.id)).toMatchObject({ status: 'PAID', paid_paise: '250000' });
    const p = await page(live.app, id, token);
    expect(p.body).toMatchObject({ status: 'PAID', transactionId: 'pay_FEEHOOK' });

    // Pay now at the desk, the console closed before the checkout's answer: the webhook collects
    // it as the desk's collection.
    const term6 = await raise(asha, '1800.00', 'Term 6');
    const desk = await request(live.app)
      .post(`/api/v1/console/fee-records/${term6.id}/orders`)
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(desk.status, JSON.stringify(desk.body)).toBe(201);
    expect(desk.body.gatewayOrder).toMatchObject({
      mode: 'live',
      checkout: { keyId: 'rzp_test_FAKE', name: expect.stringMatching(/^Collect Fee School/) },
    });
    const deskEvent = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_DESKHOOK',
            order_id: desk.body.gatewayOrder.orderId,
            amount: 180000,
            status: 'captured',
          },
        },
      },
    });
    const deskHook = await request(live.app)
      .post('/api/v1/partners/gateway/webhooks')
      .set('Content-Type', 'application/json')
      .set(
        'X-Razorpay-Signature',
        createHmac('sha256', HOOK_SECRET).update(deskEvent).digest('hex'),
      )
      .set('X-Razorpay-Event-Id', `evt_${randomUUID()}`)
      .send(deskEvent);
    expect(deskHook.body).toEqual({ ok: true, outcome: 'PAID' });
    expect(await row(term6.id)).toMatchObject({ status: 'PAID', paid_paise: '180000' });
    expect(
      await f.t.db
        .selectFrom('fee_collections')
        .select(['source', 'gateway_payment_id'])
        .where('gateway_payment_id', '=', 'pay_DESKHOOK')
        .executeTakeFirstOrThrow(),
    ).toEqual({ source: 'CONSOLE', gateway_payment_id: 'pay_DESKHOOK' });
  });
});

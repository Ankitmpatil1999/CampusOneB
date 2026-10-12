/**
 * Razorpay gateway (client 2026-10-09): the requests it sends and the signatures it accepts, with
 * Razorpay's answers simulated (no network).
 */
import { createHmac } from 'node:crypto';
import { createRazorpayGateway, GatewayError } from '../integrations/razorpay.gateway';
import { createPaymentGateway } from '../integrations/payment-gateway.provider';

const KEY = { keyId: 'rzp_test_KEY', keySecret: 'secret-1', webhookSecret: 'hook-1' };

function fakeHttp(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.replace('https://api.razorpay.com/v1', '')}`;
    const a = answers[key];
    if (!a) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { http, calls };
}

describe('Razorpay gateway', () => {
  it('creates an order in paise with Basic auth and gives the page the public key only', async () => {
    const { http, calls } = fakeHttp({
      'POST /orders': { body: { id: 'order_ABC', amount: 50000, currency: 'INR' } },
    });
    const g = createRazorpayGateway(KEY, http);
    const o = await g.createOrder({
      amountPaise: 50000,
      receipt: 'TVPS/ADM/2026/0001-and-a-very-long-tail-beyond-forty',
      notes: { applicationNo: 'TVPS/ADM/2026/0001' },
    });
    expect(o).toEqual({
      orderId: 'order_ABC',
      amountPaise: 50000,
      checkout: { keyId: 'rzp_test_KEY' },
    });
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toEqual({
      amount: 50000,
      currency: 'INR',
      receipt: 'TVPS/ADM/2026/0001-and-a-very-long-tail-beyond-forty'.slice(0, 40),
      notes: { applicationNo: 'TVPS/ADM/2026/0001' },
    });
    const auth = (calls[0]!.init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe(`Basic ${Buffer.from('rzp_test_KEY:secret-1').toString('base64')}`);
    expect(JSON.stringify(o)).not.toContain('secret-1');
  });

  it("accepts only Checkout's signature of order|payment with the key secret", () => {
    const g = createRazorpayGateway(KEY, fakeHttp({}).http);
    const good = createHmac('sha256', 'secret-1').update('order_ABC|pay_XYZ').digest('hex');
    expect(g.verify({ orderId: 'order_ABC', paymentId: 'pay_XYZ', signature: good })).toBe(true);
    expect(g.verify({ orderId: 'order_ABC', paymentId: 'pay_OTHER', signature: good })).toBe(false);
    expect(g.verify({ orderId: 'order_ABC', paymentId: 'pay_XYZ', signature: 'nope' })).toBe(false);
  });

  it('fetches and captures a payment, and passes on what Razorpay refused', async () => {
    const { http } = fakeHttp({
      'GET /payments/pay_XYZ': {
        body: {
          id: 'pay_XYZ',
          order_id: 'order_ABC',
          amount: 50000,
          status: 'authorized',
          method: 'upi',
        },
      },
      'POST /payments/pay_XYZ/capture': {
        body: {
          id: 'pay_XYZ',
          order_id: 'order_ABC',
          amount: 50000,
          status: 'captured',
          method: 'upi',
        },
      },
      'GET /payments/pay_BAD': {
        status: 400,
        body: { error: { description: 'The id provided does not exist' } },
      },
    });
    const g = createRazorpayGateway(KEY, http);
    expect(await g.fetchPayment!('pay_XYZ')).toMatchObject({
      orderId: 'order_ABC',
      status: 'authorized',
    });
    expect(await g.capturePayment!('pay_XYZ', 50000)).toMatchObject({ status: 'captured' });
    await expect(g.fetchPayment!('pay_BAD')).rejects.toThrow(GatewayError);
    await expect(g.fetchPayment!('../orders')).rejects.toThrow(/Bad payment id/);
  });

  it('checks the webhook signature over the raw body with the webhook secret', () => {
    const g = createRazorpayGateway(KEY, fakeHttp({}).http);
    const raw = Buffer.from('{"event":"payment.captured"}');
    const sig = createHmac('sha256', 'hook-1').update(raw).digest('hex');
    expect(g.verifyWebhook!(raw, sig)).toBe(true);
    expect(g.verifyWebhook!(Buffer.from('{"event":"x"}'), sig)).toBe(false);
    const noSecret = createRazorpayGateway({ ...KEY, webhookSecret: null }, fakeHttp({}).http);
    expect(noSecret.verifyWebhook!(raw, sig)).toBe(false);
  });

  it('is chosen for live mode with keys; without keys live answers "not configured"', async () => {
    expect(createPaymentGateway('live', Buffer.alloc(32), KEY).fetchPayment).toBeDefined();
    const none = createPaymentGateway('live', Buffer.alloc(32), null);
    expect(await none.createOrder({ amountPaise: 100, receipt: 'x' })).toBeNull();
    expect(createPaymentGateway('test', Buffer.alloc(32), KEY).mode).toBe('test');
  });
});

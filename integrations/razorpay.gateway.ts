/**
 * Razorpay, the online payment gateway (client 2026-10-09, Q17; test keys for development). The
 * family pays in Razorpay Checkout on the page; the server never trusts the page alone:
 *
 * 1. `createOrder`: POST /v1/orders (amount in paise, INR, receipt, notes) — the page opens
 *    Checkout with the public key id and this order id.
 * 2. `verify`: Checkout's signature is HMAC-SHA256("order_id|payment_id", key secret), compared in
 *    constant time.
 * 3. `fetchPayment`: GET /v1/payments/{id} — the order, amount and status are checked before the
 *    fee is marked paid; an authorised payment is captured (`capturePayment`).
 * 4. `verifyWebhook`: X-Razorpay-Signature is HMAC-SHA256(raw body, webhook secret).
 *
 * Secrets never leave the server and are never logged; errors carry Razorpay's description only.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GatewayPayment, PaymentGateway } from './payment-gateway.provider';

export interface RazorpayConfig {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string | null;
}

const API = 'https://api.razorpay.com/v1';

/** A Razorpay answer other than success (status and Razorpay's description, never secrets). */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

function sameHex(want: string, got: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  const a = Buffer.from(want, 'hex');
  const b = Buffer.from(got.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRazorpayGateway(
  c: RazorpayConfig,
  http: typeof fetch = fetch,
): PaymentGateway {
  const auth = `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64')}`;
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> => {
    let r: Response;
    try {
      r = await http(`${API}${path}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new GatewayError(0, `Razorpay could not be reached (${(e as Error).name})`);
    }
    const json = (await r.json().catch(() => ({}))) as {
      error?: { description?: string };
    } & Record<string, unknown>;
    if (!r.ok) {
      throw new GatewayError(r.status, json.error?.description ?? `Razorpay answered ${r.status}`);
    }
    return json as T;
  };
  const sign = (secret: string, data: string | Buffer) =>
    createHmac('sha256', secret).update(data).digest('hex');
  const toPayment = (p: Record<string, unknown>): GatewayPayment => ({
    id: String(p['id']),
    orderId: typeof p['order_id'] === 'string' ? p['order_id'] : null,
    amountPaise: Number(p['amount']),
    status: String(p['status']),
    method: typeof p['method'] === 'string' ? p['method'] : null,
  });

  return {
    mode: 'live',
    async createOrder({ amountPaise, receipt, notes }) {
      const o = await call<{ id: string; amount: number }>('POST', '/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt: receipt.slice(0, 40),
        ...(notes ? { notes } : {}),
      });
      return { orderId: o.id, amountPaise: Number(o.amount), checkout: { keyId: c.keyId } };
    },
    verify({ orderId, paymentId, signature }) {
      return sameHex(sign(c.keySecret, `${orderId}|${paymentId}`), signature);
    },
    async fetchPayment(paymentId) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(paymentId)) throw new GatewayError(400, 'Bad payment id');
      return toPayment(await call<Record<string, unknown>>('GET', `/payments/${paymentId}`));
    },
    async capturePayment(paymentId, amountPaise) {
      return toPayment(
        await call<Record<string, unknown>>('POST', `/payments/${paymentId}/capture`, {
          amount: amountPaise,
          currency: 'INR',
        }),
      );
    },
    async checkCredentials() {
      try {
        await call('GET', '/orders?count=1');
        return { ok: true, note: 'Razorpay accepted the keys' };
      } catch (e) {
        const g = e as GatewayError;
        return {
          ok: false,
          note:
            g.status === 401
              ? 'Razorpay refused the key id or secret'
              : g.message.slice(0, 200),
        };
      }
    },
    verifyWebhook(rawBody, signature) {
      return !!c.webhookSecret && sameHex(sign(c.webhookSecret, rawBody), signature);
    },
  };
}

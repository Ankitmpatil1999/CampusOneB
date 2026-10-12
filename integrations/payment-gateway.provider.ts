/**
 * The online payment gateway for application and admission fees (SRS 19.2, 19.8; FR-INT-03; Q17,
 * answered 2026-10-09: Razorpay).
 *
 * test: STUB — an order is created at once and the checkout page shows test buttons. The order
 * answer carries the signature a successful test payment would have (like OTP_TEST_SHOW_CODE), so the
 * page can complete it; any other signature is a failed payment. Production refuses this mode
 * (PAYMENT_GATEWAY_MODE).
 * live: Razorpay (`razorpay.gateway.ts`) with RAZORPAY_KEY_ID / RAZORPAY_SECRET — Razorpay's test
 * keys (rzp_test_…) in development, live keys in production. Without keys, creating an order
 * answers "not available" and the family pays at the accounts desk (cash works).
 *
 * Verification is always on the server: the signature is an HMAC of "order|payment" with the
 * gateway secret, compared in constant time; in live mode the payment is also fetched from the
 * gateway and its order, amount and status checked.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRazorpayGateway, type RazorpayConfig } from './razorpay.gateway';

export interface GatewayOrder {
  readonly orderId: string;
  readonly amountPaise: number;
  /** Test mode only: the payment id and signature a successful test payment returns. */
  readonly test?: { readonly paymentId: string; readonly signature: string };
  /** Live: the public key id the page opens the gateway's checkout with. */
  readonly checkout?: { readonly keyId: string };
}

/** A payment as the gateway holds it. */
export interface GatewayPayment {
  readonly id: string;
  readonly orderId: string | null;
  readonly amountPaise: number;
  /** created | authorized | captured | refunded | failed */
  readonly status: string;
  readonly method: string | null;
}

export interface PaymentGateway {
  readonly mode: 'test' | 'live';
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder | null>;
  verify(input: { orderId: string; paymentId: string; signature: string }): boolean;
  /** Live: the payment as the gateway holds it, checked before the fee is marked paid. */
  fetchPayment?(paymentId: string): Promise<GatewayPayment>;
  /** Live: captures an authorised payment for its full amount. */
  capturePayment?(paymentId: string, amountPaise: number): Promise<GatewayPayment>;
  /** Live: a webhook's signature over its raw body. */
  verifyWebhook?(rawBody: Buffer, signature: string): boolean;
  /** Live: whether the keys are accepted (a read-only call; nothing is created). */
  checkCredentials?(): Promise<{ readonly ok: boolean; readonly note: string }>;
}

export function createPaymentGateway(
  mode: 'test' | 'live',
  secret: Buffer,
  razorpay: RazorpayConfig | null = null,
): PaymentGateway {
  if (mode === 'live' && razorpay) return createRazorpayGateway(razorpay);
  const sign = (orderId: string, paymentId: string) =>
    createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return {
    mode,
    async createOrder({ amountPaise }) {
      if (mode === 'live') return null;
      const orderId = `order_test_${randomBytes(8).toString('hex')}`;
      const paymentId = `pay_test_${randomBytes(8).toString('hex')}`;
      return { orderId, amountPaise, test: { paymentId, signature: sign(orderId, paymentId) } };
    },
    verify({ orderId, paymentId, signature }) {
      if (mode === 'live') return false;
      const want = Buffer.from(sign(orderId, paymentId), 'hex');
      const got = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : null;
      return !!got && got.length === want.length && timingSafeEqual(want, got);
    },
  };
}

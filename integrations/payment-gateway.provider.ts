/**
 * The online payment gateway for application and admission fees (SRS 19.2, 19.8; FR-INT-03; Q17
 * open). The gateway is not chosen yet, so:
 *
 * test: STUB — an order is created at once and the checkout page shows test buttons. The order
 * answer carries the signature a successful test payment would have (like OTP_TEST_SHOW_CODE), so the
 * page can complete it; any other signature is a failed payment. Production refuses this mode
 * (PAYMENT_GATEWAY_MODE).
 * live: not built until the gateway is chosen — creating an order answers "not available", and the
 * family pays at the accounts desk (cash works now).
 *
 * Verification is always on the server: the signature is an HMAC of "order|payment" with the
 * gateway secret (the common gateway scheme), compared in constant time, and the amount is checked
 * against the order.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface GatewayOrder {
  readonly orderId: string;
  readonly amountPaise: number;
  /** Test mode only: the payment id and signature a successful test payment returns. */
  readonly test?: { readonly paymentId: string; readonly signature: string };
}

export interface PaymentGateway {
  readonly mode: 'test' | 'live';
  createOrder(input: { amountPaise: number; receipt: string }): Promise<GatewayOrder | null>;
  verify(input: { orderId: string; paymentId: string; signature: string }): boolean;
}

export function createPaymentGateway(mode: 'test' | 'live', secret: Buffer): PaymentGateway {
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

/**
 * Paying a school through a payment gateway (client 2026-10-09, 2026-10-19): the admission fees and,
 * from a payment link or QR code, a fee instalment. One choice of gateway and one check of what the
 * gateway reports, for both.
 *
 * - The school's own default gateway takes the payment; without one, RingPe's gateway when the
 *   platform allows it (pg.platformFallback); in test mode always the test gateway.
 * - A payment keeps the gateway it was taken with: its signature, capture and webhook are that
 *   gateway's.
 * - Live, the payment is fetched from the gateway before anything is marked paid: it must belong to
 *   the order, be for the whole amount and be captured (an authorised one is captured here).
 */
import type { GatewayPayment, PaymentGateway } from '../integrations/payment-gateway.provider';
import type { MessageKey } from '../config/registers';
import { CustomAPIError } from '../utils/CustomAPIError';
import type { PaymentGatewaysService } from './payment-gateways.service';

export interface GatewayDeps {
  /** RingPe's own gateway (PAYMENT_GATEWAY_MODE), or the test checkout. */
  readonly gateway: PaymentGateway;
  /** Each school's own gateways. */
  readonly gateways?: PaymentGatewaysService | undefined;
  /** pg.platformFallback: 1 lets a school without a gateway use RingPe's. */
  readonly platformFallback: () => Promise<number>;
}

/** The gateway a new payment of the school is taken with; `gatewayId` null is RingPe's own. */
export async function chooseGateway(
  deps: GatewayDeps,
  institutionId: string,
  notConfigured: MessageKey,
): Promise<{ gatewayId: string | null; gateway: PaymentGateway }> {
  if (deps.gateway.mode === 'test') return { gatewayId: null, gateway: deps.gateway };
  const own = await deps.gateways?.defaultFor(institutionId);
  if (own) return { gatewayId: own.id, gateway: own.gateway };
  if ((await deps.platformFallback()) === 1) return { gatewayId: null, gateway: deps.gateway };
  throw new CustomAPIError(503, notConfigured);
}

/** The gateway a payment was taken with. */
export async function gatewayById(
  deps: GatewayDeps,
  gatewayId: string | null,
): Promise<PaymentGateway> {
  if (gatewayId === null) return deps.gateway;
  const g = await deps.gateways?.byId(gatewayId);
  if (!g) throw new CustomAPIError(503, 'GEN.UNAVAILABLE');
  return g;
}

/**
 * What is wrong with the payment as the gateway holds it, or null when it is this order's, for the
 * whole amount, and captured. A gateway that cannot be asked (test) is taken at its signature.
 */
export async function gatewayProblem(
  g: PaymentGateway,
  order: { readonly orderId: string | null; readonly amountPaise: number },
  paymentId: string,
): Promise<string | null> {
  if (!g.fetchPayment) return null;
  let p: GatewayPayment;
  try {
    p = await g.fetchPayment(paymentId);
    if (p.status === 'authorized' && g.capturePayment && p.orderId === order.orderId) {
      p = await g.capturePayment(paymentId, order.amountPaise);
    }
  } catch {
    // Not reached or not answered: nothing is marked; the payer checks again.
    throw new CustomAPIError(503, 'GEN.UNAVAILABLE');
  }
  if (p.orderId !== order.orderId) return 'The payment belongs to another order';
  if (p.amountPaise !== order.amountPaise) return 'The amount paid differs from the fee';
  if (p.status !== 'captured') return `The gateway reports the payment as ${p.status}`;
  return null;
}

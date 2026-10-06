/**
 * Payment statuses (27.2; docs/01c; SRS 9.2–9.6, 9.11).
 *
 * - The engine record is written `pending` after the pre-checks, then `success` or `failure`
 *   (RNG-PAY-123…126). RC-14: static-QR payments are engine payments (one register).
 * - A payment request (dynamic QR, NFC) is PENDING until a payment settles or refuses it. Expiry is
 *   derived from the expiry time and never stored (27.2 "Reduce"). CANCELLED is RC-28: the merchant
 *   withdraws a pending request (PAY-011; client standing approval 2026-10-03).
 * - A merchant QR code is Active or Inactive (OI-PAY-01, OQ-17 as the catalogue builds them: an
 *   Inactive code refuses payments; a re-issue deactivates the old code with a reason).
 */
import { NEW, type StatusDomain } from './types';

export type PaymentAttemptStatusCode = 'PENDING' | 'SUCCESS' | 'FAILURE';
export type PaymentRequestStatusCode = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type MerchantQrStatusCode = 'ACTIVE' | 'INACTIVE';

export const PAYMENT_ATTEMPT: StatusDomain<PaymentAttemptStatusCode> = {
  domain: 'payment_attempt',
  srsDomain: 'Payment (engine record)',
  rc: 'RC-14',
  values: [
    {
      code: 'PENDING',
      registerValue: 'pending',
      labelKey: 'status.payment_attempt.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'SUCCESS',
      registerValue: 'success',
      labelKey: 'status.payment_attempt.success',
      label: 'Success',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILURE',
      registerValue: 'failure',
      labelKey: 'status.payment_attempt.failure',
      label: 'Failed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'the engine passes the pre-checks (P1–P8)' },
    {
      from: 'PENDING',
      to: 'SUCCESS',
      operation: 'every validation passes and the ledger pair is posted (RNG-PAY-125)',
    },
    {
      from: 'PENDING',
      to: 'FAILURE',
      operation: 'a validation (V1–V13) refuses; remarks = the reason (RNG-PAY-124)',
    },
  ],
};

export const PAYMENT_REQUEST: StatusDomain<PaymentRequestStatusCode> = {
  domain: 'payment_request',
  srsDomain: 'Payment request (dynamic QR / POS QR / POS NFC / NFC)',
  rc: 'RC-28',
  values: [
    {
      code: 'PENDING',
      registerValue: 'PENDING',
      labelKey: 'status.payment_request.pending',
      label: 'Waiting for payment',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'SUCCESS',
      registerValue: 'SUCCESS',
      labelKey: 'status.payment_request.success',
      label: 'Paid',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: 'FAILED',
      labelKey: 'status.payment_request.failed',
      label: 'Payment refused',
      tone: 'bad',
      terminal: true,
    },
    {
      code: 'CANCELLED',
      registerValue: null,
      labelKey: 'status.payment_request.cancelled',
      label: 'Cancelled',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'the merchant creates a dynamic QR or NFC request' },
    { from: 'PENDING', to: 'SUCCESS', operation: 'a payment against the request succeeds' },
    { from: 'PENDING', to: 'FAILED', operation: 'a payment against the request is refused' },
    { from: 'PENDING', to: 'CANCELLED', operation: 'the merchant cancels it (RC-28)' },
  ],
};

export const MERCHANT_QR: StatusDomain<MerchantQrStatusCode> = {
  domain: 'merchant_qr',
  srsDomain: 'Merchant QR flag (payment / allowance / coupon)',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.merchant_qr.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '-1',
      labelKey: 'status.merchant_qr.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'the console generates the code (PAY-022)' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'deactivated with a reason, or replaced by a re-issue (PAY-022/023)',
    },
    { from: 'INACTIVE', to: 'ACTIVE', operation: 'activated again (PAY-023)' },
  ],
};

export const PAYMENT_DOMAINS = [PAYMENT_ATTEMPT, PAYMENT_REQUEST, MERCHANT_QR] as const;

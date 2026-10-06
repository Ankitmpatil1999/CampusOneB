/**
 * The canteen point of sale (SRS 12.8–12.10; 27.2 "POS NFC tag": 1 Active / 0 Inactive, "Order":
 * CREATED / CONFIRMED / CANCELLED with payment PENDING / PAID / FAILED). An order carries one status:
 * CONFIRMED + PAID is PAID here, and a failed collection leaves it CREATED with the reason (the order
 * can still be collected), so FAILED is not carried. Offline captures are new (OI-MER-12).
 */
import { NEW, type StatusDomain } from './types';

export const POS_OPERATOR_TAG: StatusDomain<'ACTIVE' | 'INACTIVE'> = {
  domain: 'pos_operator_tag',
  srsDomain: 'POS NFC tag',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.pos_operator_tag.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.pos_operator_tag.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'registered on the POS terminal (MER-011)' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 're-issued with a reason; the new tag starts Active (MER-022, RNG-MER-079)',
    },
  ],
};

export const POS_ORDER: StatusDomain<'CREATED' | 'PAID' | 'CANCELLED'> = {
  domain: 'pos_order',
  srsDomain: 'Order',
  rc: 'RC-30',
  values: [
    {
      code: 'CREATED',
      registerValue: 'CREATED',
      labelKey: 'status.pos_order.created',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'PAID',
      registerValue: 'CONFIRMED',
      labelKey: 'status.pos_order.paid',
      label: 'Paid',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'CANCELLED',
      registerValue: 'CANCELLED',
      labelKey: 'status.pos_order.cancelled',
      label: 'Cancelled',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'CREATED', operation: 'created on the counter, or by an offline capture' },
    {
      from: 'CREATED',
      to: 'PAID',
      operation: 'collected through the payment engine (P3) or covered by a coupon (MER-008/009)',
    },
    { from: 'CREATED', to: 'CANCELLED', operation: 'cancelled on the counter (MER-007)' },
  ],
};

export const POS_CAPTURE: StatusDomain<'PROCESSING' | 'ACCEPTED' | 'REFUSED'> = {
  domain: 'pos_capture',
  srsDomain: null,
  rc: 'RC-30',
  values: [
    {
      code: 'PROCESSING',
      registerValue: null,
      labelKey: 'status.pos_capture.processing',
      label: 'Sending',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'ACCEPTED',
      registerValue: null,
      labelKey: 'status.pos_capture.accepted',
      label: 'Posted',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'REFUSED',
      registerValue: null,
      labelKey: 'status.pos_capture.refused',
      label: 'Failed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PROCESSING', operation: 'received in an offline batch (MER-009/016)' },
    { from: 'PROCESSING', to: 'ACCEPTED', operation: 'posted once through the payment engine' },
    {
      from: 'PROCESSING',
      to: 'REFUSED',
      operation: 'refused by a check (Q14 M8: never overdrawn)',
    },
  ],
};

export const POS_DOMAINS = [POS_OPERATOR_TAG, POS_ORDER, POS_CAPTURE] as const;

/**
 * Meal coupons (27.2, SRS 11; CR-15). A coupon is ACTIVE until it is redeemed (USED) or its valid date
 * has passed (EXPIRED); a future coupon cancelled by the institution also ends EXPIRED, with
 * `ended_reason` CANCELLED (OI-CPN-03; "Cancelled" is not a registered value). A coupon type is Active
 * or Inactive and never deleted (RC-16, RNG-CPN-083). A redemption is REDEEMED (27.2 coupon
 * transaction).
 */
import { NEW, type StatusDomain } from './types';

export const COUPON: StatusDomain<'ACTIVE' | 'USED' | 'EXPIRED'> = {
  domain: 'coupon',
  srsDomain: 'Meal coupon',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: 'ACTIVE',
      labelKey: 'status.coupon.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'USED',
      registerValue: 'USED',
      labelKey: 'status.coupon.used',
      label: 'Used',
      tone: 'info',
      terminal: true,
    },
    {
      code: 'EXPIRED',
      registerValue: 'EXPIRED',
      labelKey: 'status.coupon.expired',
      label: 'Expired',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'issued: one per student, type and day (CPN-008)' },
    {
      from: 'ACTIVE',
      to: 'USED',
      operation:
        'redeemed on its date, in its window, at a merchant that accepts the type (CPN-002, CPN-014)',
    },
    {
      from: 'ACTIVE',
      to: 'EXPIRED',
      operation:
        'the 00:00 job after its date (lapsed), or cancelled before its date (CPN-012, ended_reason CANCELLED)',
    },
  ],
};

export const COUPON_TYPE: StatusDomain<'ACTIVE' | 'INACTIVE'> = {
  domain: 'coupon_type',
  srsDomain: 'Coupon type (new, CR-15)',
  rc: 'RC-16',
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.coupon_type.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.coupon_type.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'defined (CPN-004)' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'deactivated (CPN-005): no longer issued; issued coupons stay usable',
    },
    { from: 'INACTIVE', to: 'ACTIVE', operation: 'activated (CPN-005)' },
  ],
};

export const COUPON_REDEMPTION: StatusDomain<'REDEEMED'> = {
  domain: 'coupon_redemption',
  srsDomain: 'Coupon transaction',
  rc: null,
  values: [
    {
      code: 'REDEEMED',
      registerValue: 'REDEEMED',
      labelKey: 'status.coupon_redemption.redeemed',
      label: 'Redeemed',
      tone: 'ok',
      terminal: true,
    },
  ],
  transitions: [{ from: NEW, to: 'REDEEMED', operation: 'a coupon redeemed (11.6)' }],
};

export const COUPON_DOMAINS = [COUPON, COUPON_TYPE, COUPON_REDEMPTION] as const;

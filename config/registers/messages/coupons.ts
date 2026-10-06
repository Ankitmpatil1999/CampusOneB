/**
 * Meal coupon messages (SRS 11, CR-15, ATT 21.20.1; 27.5 MSG-CPN-*). The 27.5 wording is kept where a
 * member or an administrator reads it (class K); a technical text is reworded (class R); the rules
 * CR-15 adds have no wording in the SRS (OI-CPN-13, OI-ATT-29), so theirs is new (class N) — client
 * standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

const k = (key: string, register: string, text: string, http: number, refs: readonly string[]) =>
  ({
    key,
    register,
    srsText: text,
    class: 'K',
    type: 'error',
    http,
    en: text,
    approval: 'register',
    batch: 4,
    refs,
  }) as const;

const n = (
  key: string,
  http: number,
  en: string,
  refs: readonly string[],
  placeholders?: readonly string[],
) =>
  ({
    key,
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http,
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'approved',
    batch: 4,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const COUPON_MESSAGES = [
  // --- issuing (11.2, CR-15) ----------------------------------------------------------------------
  k('CPN.DATES_NOT_FUTURE', 'MSG-CPN-09', 'Start date and end date must be future dates.', 422, [
    '11.2',
    'RNG-CPN-009',
  ]),
  k('CPN.NO_DAYS', 'MSG-CPN-10', 'No valid days available for coupon issuance.', 422, [
    '11.2',
    'RNG-CPN-008',
  ]),
  k('CPN.NO_STUDENTS', 'MSG-CPN-11', 'No valid students found.', 422, ['11.2', 'RNG-CPN-010']),
  k('CPN.ISSUE_LIMIT', 'MSG-CPN-13', 'Coupon issuance limit exceeded for some students.', 422, [
    '11.2',
    'RNG-CPN-012',
    'BR-43',
  ]),
  n(
    'CPN.HOLD_MAX',
    409,
    'A student may hold at most {max} {type} coupons at a time.',
    ['CR-15', 'RNG-CPN-077', 'OI-CPN-13'],
    ['max', 'type'],
  ),
  n('CPN.FEATURE_OFF', 409, 'Meal coupons are turned off for this institution.', [
    '11.2',
    'FR-INS-04',
    'OI-CPN-01',
  ]),
  n(
    'CPN.TYPE_NOT_ISSUABLE',
    409,
    "{type} coupons can't be issued for these dates.",
    ['CR-15', 'RNG-CPN-078'],
    ['type'],
  ),
  // --- types and slots (CR-15) --------------------------------------------------------------------
  n('CPN.TYPE_NAME_TAKEN', 409, 'A coupon type with this name already exists.', [
    'CR-15',
    'RNG-CPN-072',
  ]),
  n('CPN.TYPE_INACTIVE', 409, 'This coupon type is inactive, so it can’t be issued.', [
    'CR-15',
    'RNG-CPN-083',
  ]),
  n(
    'CPN.VALUE_TYPES_OFF',
    409,
    'Coupons that carry a money value aren’t available yet. Set the value to ₹0.',
    ['CR-15', 'OI-CPN-10', 'Q14 M5'],
  ),
  n('CPN.WINDOW_INVALID', 422, 'The end time must be after the start time.', [
    'CR-15',
    'RNG-CPN-075',
  ]),
  n('CPN.SLOT_NAME_TAKEN', 409, 'Two slots can’t have the same name.', ['OI-CPN-12']),
  n(
    'CPN.SLOT_IN_USE',
    409,
    'The {slot} slot is used by a coupon type. Move that type to another slot first.',
    ['OI-CPN-12'],
    ['slot'],
  ),
  // --- redeeming (11.6, 21.20.1) ------------------------------------------------------------------
  k('CPN.NOT_REGULAR_MERCHANT', 'MSG-CPN-35', 'Only regular merchants can redeem coupons.', 409, [
    '11.6',
    'RNG-CPN-051',
    'BR-42',
  ]),
  k('CPN.NONE_ACTIVE', 'MSG-CPN-36', 'No valid coupon found for today', 409, [
    '11.6',
    'RNG-CPN-051',
    'RNG-CPN-059',
  ]),
  {
    key: 'CPN.OUTSIDE_WINDOW',
    register: 'MSG-CPN-39',
    srsText: 'Coupon for <MEAL> can only be redeemed between <start>:00 and <end>:00.',
    class: 'R',
    type: 'error',
    http: 409,
    en: 'Coupon for {type} can only be redeemed between {start} and {end}.',
    placeholders: ['type', 'start', 'end'],
    approval: 'approved',
    batch: 4,
    refs: ['11.6', 'RNG-CPN-052', 'RNG-CPN-075', 'client standing approval 2026-10-03'],
  },
  n(
    'CPN.TYPE_NOT_ACCEPTED',
    409,
    "{merchant} doesn't accept {type} coupons.",
    ['CR-15', 'RNG-CPN-076', 'OI-CPN-13'],
    ['merchant', 'type'],
  ),
  n(
    'CPN.REDEEM_MAX',
    409,
    "You've used the most {type} coupons allowed ({max} a {period}).",
    ['CR-15', 'RNG-CPN-077', 'OI-CPN-11'],
    ['type', 'max', 'period'],
  ),
  n('CPN.TAP_LAPSED', 409, 'This tap has lapsed. Ask the student to tap the card again.', [
    '21.20.1',
    'OI-ATT-29',
  ]),
] as const satisfies readonly MessageDefinition[];

export type CouponMessageKey = (typeof COUPON_MESSAGES)[number]['key'];

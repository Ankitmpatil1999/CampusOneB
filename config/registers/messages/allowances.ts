/**
 * Allowance messages (SRS 10, 27.5 MSG-ALW-*; docs/01 §4.3). The 27.5 wording is kept where a member
 * or an administrator reads it (class K); technical texts are reworded (class R); texts the SRS
 * doesn't have are new (class N) — client standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

const k = (
  key: string,
  register: string,
  text: string,
  http: number,
  refs: readonly string[],
  placeholders?: readonly string[],
) =>
  ({
    key,
    register,
    srsText: text,
    class: 'K',
    type: 'error',
    http,
    en: text,
    ...(placeholders ? { placeholders } : {}),
    approval: 'register',
    batch: 4,
    refs,
  }) as const;

const r = (
  key: string,
  register: string,
  srsText: string,
  http: number,
  en: string,
  refs: readonly string[],
  placeholders?: readonly string[],
) =>
  ({
    key,
    register,
    srsText,
    class: 'R',
    type: 'error',
    http,
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'approved',
    batch: 4,
    refs: [...refs, 'client standing approval 2026-10-03'],
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

export const ALLOWANCE_MESSAGES = [
  // --- issuing (10.2) ---------------------------------------------------------------------------
  k(
    'ALW.START_NOT_FUTURE',
    'MSG-ALW-21',
    'The start date must be a future date. Please select a date later than today',
    422,
    ['10.2', 'RNG-ALW-009'],
  ),
  k(
    'ALW.START_NOT_FIRST',
    'MSG-ALW-22',
    'The start date must be the first day of the month. Please enter a valid start date accordingly.',
    422,
    ['10.2', 'RNG-ALW-009', 'BR-40'],
  ),
  n('ALW.EXPIRY_BEFORE_START', 422, 'The expiry date must be after the start date.', [
    '10.2',
    'OI-ALW-03',
  ]),
  k(
    'ALW.AMOUNT_RANGE',
    'MSG-ALW-73',
    'The amount should not exceed 99999999.99 or be lower than 0.01. Please enter a valid amount.',
    422,
    ['10.7', '27.4 §10'],
  ),
  k('ALW.DUPLICATE', 'MSG-ALW-26', 'User allowance already exists.', 409, [
    '10.2',
    'BR-40',
    'RNG-ALW-012',
  ]),
  n('ALW.NOT_STUDENT', 422, 'Allowances are issued to active students only.', [
    '10.2',
    'OI-ALW-02',
  ]),
  k(
    'ALW.NO_WALLET',
    'MSG-ALW-24',
    'No allowance wallet was found for the specified User. Please ensure the User is correct and try again.',
    409,
    ['10.2', 'RNG-ALW-014'],
  ),
  n('ALW.FEATURE_OFF', 409, 'Allowances are turned off for this institution.', [
    '10.2',
    'FR-INS-04',
    'OI-ALW-01',
  ]),
  n(
    'ALW.TRANSITION_INVALID',
    409,
    "Only an allowance that hasn't been credited yet can be cancelled.",
    ['10.2', 'OQ-08'],
  ),
  // --- paying (10.7, through the payment engine) --------------------------------------------------
  r(
    'ALW.MERCHANT_NOT_ACCEPTING',
    'MSG-ALW-76',
    'Your merchant does not have permission for allowance payment.',
    409,
    "{merchant} doesn't accept allowance payments.",
    ['10.7', 'RNG-ALW-068', 'MSG-ALW-77', 'MSG-ALW-78', 'MSG-ALW-79'],
    ['merchant'],
  ),
  r(
    'ALW.WALLET_INACTIVE',
    'MSG-ALW-80',
    'Your user allowance wallet is inactive. Please contact support for assistance.',
    409,
    "Your allowance wallet isn't active yet. The school credits it on the allowance's start date.",
    ['10.7', 'RNG-ALW-070', 'RC-02'],
  ),
  k(
    'ALW.INSUFFICIENT_BALANCE',
    'MSG-ALW-81',
    'Your allowance wallet balance is insufficient.',
    409,
    ['10.7', 'RNG-ALW-070'],
  ),
  k('ALW.DAILY_COUNT', 'MSG-ALW-82', "Today's daily transaction limit exceeded.", 409, [
    '10.7',
    'RNG-ALW-070',
    'BR-42',
  ]),
  k(
    'ALW.DAILY_AMOUNT',
    'MSG-ALW-83',
    "Transaction exceeds today's limit of {limit}.",
    409,
    ['10.7', 'RNG-ALW-070', 'OI-ALW-10', 'OQ-09'],
    ['limit'],
  ),
  // --- notifications (10.6) -----------------------------------------------------------------------
  {
    ...n(
      'NTF.ALLOWANCE_CREDITED',
      200,
      "{amount} allowance credited to {name}'s allowance wallet",
      ['10.6', 'RNG-ALW-058'],
      ['amount', 'name'],
    ),
    type: 'info',
  },
  {
    ...n(
      'NTF.ALLOWANCE_EXPIRED',
      200,
      "{name}'s allowance ended today; {amount} unspent lapsed",
      ['10.6', 'RNG-ALW-057', 'FR-ALW-07'],
      ['name', 'amount'],
    ),
    type: 'info',
  },
] as const satisfies readonly MessageDefinition[];

export type AllowanceMessageKey = (typeof ALLOWANCE_MESSAGES)[number]['key'];

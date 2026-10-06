/**
 * Event and entry-pass messages (SRS 13.7–13.10, 9.7–9.9; 27.5 MSG-PAY-*, MSG-FEE-*). The 27.5
 * wording is kept where a member, a checker or an administrator reads it (class K); technical texts
 * are reworded (class R); texts the SRS doesn't have are new (class N) — client standing approval
 * 2026-10-03.
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

export const EVENT_MESSAGES = [
  // --- events (13.7–13.10) ------------------------------------------------------------------------
  k(
    'FEE.EVENT_ALREADY_PAID',
    'MSG-PAY-260',
    'You have already paid for this event. Payment is not allowed again.',
    409,
    ['13.10', 'RNG-FEE-094'],
  ),
  r(
    'FEE.EVENT_DATES_INVALID',
    'MSG-FEE-145',
    'Invalid event dates',
    422,
    'The end date can’t be before the start date.',
    ['13.7', 'OI-FEE-13'],
  ),
  n(
    'FEE.NO_FEE_ACCOUNT',
    409,
    'Designate the institution’s fee account first (Merchants & QR), so event payments have a payee.',
    ['13.7', 'MER 12.7', 'RNG-FEE-067'],
  ),
  n(
    'FEE.EVENT_HAS_PAYMENTS',
    409,
    'Members have paid for this event, so its heads and start date can’t change. Create a new event instead.',
    ['13.8', 'FEE-030'],
  ),
  n('FEE.EVENT_NOT_FOR_YOU', 409, 'This event isn’t open to your class.', ['13.10', 'FEE-032']),
  n('FEE.EVENTS_OFF', 409, 'Events are turned off for this institution.', ['13.7', 'FR-INS-04']),
  n(
    'FEE.EVENT_ENDED',
    409,
    'This event has ended, so it can’t be switched on again. Create a new event instead.',
    ['13.8', 'OI-FEE-14'],
  ),
  // --- entry passes (9.7–9.9) ---------------------------------------------------------------------
  r(
    'PAY.PASS_DATE_NOT_FUTURE',
    'MSG-PAY-168',
    'valid_date must be a future date (not today)',
    422,
    'The pass date must be after today.',
    ['9.7', 'RNG-PAY-078'],
  ),
  r(
    'PAY.PASS_HOLDER_TYPE',
    'MSG-PAY-171',
    'You are not authorized to generate Special QRs to users of this type',
    422,
    'Passes are issued to students and visitors only.',
    ['9.7', 'RNG-PAY-079'],
  ),
  r(
    'PAY.PASS_NO_DEVICE',
    'MSG-PAY-170',
    'UserDevice not found, User must register device first.',
    422,
    'This member hasn’t registered a phone yet, so a pass can’t be bound to it.',
    ['9.7', 'RNG-PAY-079'],
  ),
  r(
    'PAY.PASS_DUPLICATE',
    'MSG-PAY-172',
    'A Special QR for this user already exists for the selected date and registered device.',
    409,
    'This member already has a pass for that day.',
    ['9.7', 'RNG-PAY-080'],
  ),
  k('PAY.PASS_NOT_TODAY', 'MSG-PAY-199', 'QR is not valid yet', 409, ['9.9', 'RNG-PAY-100']),
  k('PAY.PASS_EXPIRED', 'MSG-PAY-200', 'QR has expired', 409, ['9.9', 'RNG-PAY-100']),
  k('PAY.PASS_USED', 'MSG-PAY-201', 'QR usage limit already reached', 409, ['9.9', 'RNG-PAY-100']),
  r(
    'PAY.PASS_DEVICE_MISMATCH',
    'MSG-PAY-189',
    'Unauthorized device',
    409,
    'Open this pass on the phone it was issued to.',
    ['9.9', 'RNG-PAY-099'],
  ),
  r(
    'PAY.PASS_NOT_AUTHORISED',
    'MSG-PAY-209',
    'QR is not Authorized for use (Status: <status>)',
    409,
    'This pass isn’t authorised. Ask the holder to open it and tap Authorise.',
    ['9.9', 'RNG-PAY-101'],
  ),
  k('PAY.PASS_SCAN_LIMIT', 'MSG-PAY-211', 'QR usage limit exceeded', 409, ['9.9', 'RNG-PAY-101']),
  k('PAY.PASS_OWN', 'MSG-PAY-204', 'You cannot scan your own QR code.', 409, [
    '9.9',
    'RNG-PAY-101',
  ]),
  k('PAY.PASS_SAME_DEVICE', 'MSG-PAY-212', 'QR is not valid for this device', 409, [
    '9.9',
    'RNG-PAY-101',
  ]),
  k('PAY.PASS_CHECKER', 'MSG-PAY-207', 'You are not authorized to scan this QR', 403, [
    '9.9',
    'RNG-PAY-101',
  ]),
  n('PAY.PASS_CANCELLED', 409, 'This pass was cancelled by the school.', ['OI-PAY-10', 'RC-15']),
  n('PAY.PASS_NOT_LIVE', 409, 'Only an active or authorised pass can be cancelled.', [
    'OI-PAY-10',
    'PAY-028',
  ]),
] as const satisfies readonly MessageDefinition[];

export type EventMessageKey = (typeof EVENT_MESSAGES)[number]['key'];

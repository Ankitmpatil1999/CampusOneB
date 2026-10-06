/**
 * Terminal and campus-card messages (CR-10, SRS 6.38.8, 9.5, 21.2–21.4). Terminals are new (CR-10):
 * their texts are class N. Card texts keep the 27.5 wording where one exists (class K) or reword a
 * technical one (class R) — client standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

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

export const TERMINAL_MESSAGES = [
  n(
    'TRM.PAIRING_CODE_INVALID',
    401,
    "This pairing code isn't valid. Ask the school office for a new one.",
    ['CR-10', 'IDN-040'],
  ),
  n(
    'TRM.PAIRING_CODE_EXPIRED',
    401,
    'This pairing code has expired. Ask the school office for a new one.',
    ['CR-10', 'IDN-040'],
  ),
  n(
    'TRM.DEVICE_MISMATCH',
    401,
    "This device isn't the one paired with the terminal. Pair it again.",
    ['IDN-041', 'OI-IDN-07'],
  ),
  n('TRM.SIGNATURE_INVALID', 401, "The terminal's signature isn't valid.", ['IDN-041']),
  n(
    'TRM.TERMINAL_DISABLED',
    403,
    'This terminal is disabled. Ask the school office to enable it.',
    ['INS-034'],
  ),
  n('TRM.WRONG_PURPOSE', 403, "This terminal isn't set up for this.", ['RC-16']),
  n(
    'TRM.INSTITUTION_NOT_ACTIVE',
    403,
    "{institution} isn't active, so its terminals can't sign in.",
    ['IDN-041', 'OI-IDN-31'],
    ['institution'],
  ),
  {
    key: 'ATT.CARD_ACTIVE_EXISTS',
    register: 'MSG-ATT-04',
    srsText: 'User already has an active NFC tag. Valid reason required for re-issue.',
    class: 'R',
    type: 'error',
    http: 409,
    en: '{name} already has an active card. Re-issue it in the console with a reason first.',
    placeholders: ['name'],
    approval: 'approved',
    batch: 4,
    refs: ['21.2', 'OI-ATT-02', 'client standing approval 2026-10-03'],
  },
  {
    key: 'ATT.CARD_NOT_ACTIVE',
    register: 'MSG-PAY-099',
    srsText: 'Invalid NFC card',
    class: 'K',
    type: 'error',
    http: 409,
    en: 'Invalid NFC card',
    approval: 'register',
    batch: 4,
    refs: ['21.7', '9.5', 'MSG-PAY-094', 'MSG-PAY-110'],
  },
  n('ATT.CARD_ALREADY_BLOCKED', 409, 'This card is already blocked.', ['21.4', 'ATT-025']),
  n(
    'ATT.CARD_WRITE_REQUIRED',
    409,
    'A re-issue for this member is not authorised. Re-issue the card in the console first.',
    ['21.2', 'ATT-007'],
  ),
  {
    key: 'PAY.NONCE_REPLAY',
    register: 'MSG-PAY-114',
    srsText: 'Reused NONCE — possible replay',
    class: 'R',
    type: 'error',
    http: 409,
    en: 'This nonce has already been used. The tap was refused as a replay attempt.',
    approval: 'approved',
    batch: 4,
    refs: ['9.5', 'BR-15', 'prototype message 43', 'client standing approval 2026-10-03'],
  },
  {
    ...n('NTF.CARD_BLOCKED', 200, "{name}'s campus card is blocked", ['21.4', 'ATT-006'], ['name']),
    type: 'info',
  },
  {
    ...n(
      'NTF.CARD_ACTIVE',
      200,
      "{name}'s campus card is active again",
      ['21.4', 'ATT-006'],
      ['name'],
    ),
    type: 'info',
  },
  {
    key: 'INS.ASSET_GROUP_TAKEN',
    register: 'MSG-ONB-136',
    srsText: 'Asset group with same name and description already exists',
    class: 'R',
    type: 'error',
    http: 409,
    en: 'An asset group with this name already exists.',
    approval: 'approved',
    batch: 4,
    refs: ['7.6', 'OI-ONB-10', 'client standing approval 2026-10-03'],
  },
  n('INS.ASSET_TAKEN', 409, 'An asset with this name already exists in the group.', [
    '7.6',
    'MSG-ONB-120',
  ]),
  {
    key: 'MER.NOT_VENDOR',
    register: 'MSG-ONB-158',
    srsText: 'Invalid Merchant, not a vendor',
    class: 'R',
    type: 'error',
    http: 409,
    en: 'Only vendor merchants are linked to asset groups.',
    approval: 'approved',
    batch: 4,
    refs: ['7.7', 'client standing approval 2026-10-03'],
  },
] as const satisfies readonly MessageDefinition[];

export type TerminalMessageKey = (typeof TERMINAL_MESSAGES)[number]['key'];

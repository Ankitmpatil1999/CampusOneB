/**
 * Canteen point-of-sale messages (SRS 12.8–12.10, 9.10, 6.34; 27.5 MSG-MER-*). The legacy texts are
 * technical ("Invalid menu_item_id found"), so they are reworded with the prototype's counter wording
 * (class R); texts the SRS doesn't have are new (class N) — client standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

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

export const POS_MESSAGES = [
  // --- operators (6.34, 12.9) ---------------------------------------------------------------------
  r(
    'TRM.OPERATOR_INVALID',
    'MSG-MER-97',
    'No user found for the provided NFC token',
    401,
    'This tag isn’t registered to an active operator at this counter.',
    ['IDN-042', '6.34', 'RNG-MER-090'],
  ),
  n('TRM.OPERATOR_REQUIRED', 401, 'An operator must sign in with their tag first.', [
    'IDN-042',
    'OI-IDN-31',
  ]),
  r(
    'MER.TAG_ACTIVE_EXISTS',
    'MSG-MER-77',
    'User already has an active NFC tag. Valid reason required for re-issue.',
    409,
    'This mobile already has an active tag ({tag}, {name}). Re-issue that tag with a reason instead.',
    ['12.9', 'RNG-MER-079', 'prototype t.pos'],
    ['tag', 'name'],
  ),
  n('MER.TAG_NOT_ACTIVE', 409, 'Only an active tag can be re-issued.', ['12.9', 'MER-022']),
  // --- outlet and menu (12.8) ---------------------------------------------------------------------
  n(
    'MER.NO_OUTLET',
    409,
    'This counter isn’t linked to a canteen merchant. Ask the school office to link it.',
    ['12.8', 'OI-MER-10', 'RNG-MER-066'],
  ),
  n('MER.OUTLET_HOURS', 422, 'Closing time must be after opening time.', [
    '12.8',
    'prototype t.pos',
  ]),
  n('MER.CATEGORY_TAKEN', 409, '{name} already exists.', ['12.8', 'OI-MER-10'], ['name']),
  n('MER.CATEGORY_UNKNOWN', 422, 'Choose one of this outlet’s categories.', ['12.8', 'OI-MER-10']),
  r(
    'MER.ITEM_TAKEN',
    'MSG-MER-51',
    'Menu item name already exists: <name>',
    409,
    '{name} is already on the menu.',
    ['12.8', 'RNG-MER-067', 'prototype t.pos'],
    ['name'],
  ),
  // --- orders (12.8, 9.10) ------------------------------------------------------------------------
  r(
    'MER.ITEM_UNKNOWN',
    'MSG-MER-61',
    'Invalid menu_item_id found',
    409,
    'An item on this order isn’t on this counter’s menu.',
    ['12.8', 'RNG-MER-071', 'OI-MER-10'],
  ),
  n('MER.ITEM_UNAVAILABLE', 409, '{name} isn’t available today.', ['12.8', 'MER-006'], ['name']),
  // --- offline captures (12.10) -------------------------------------------------------------------
  n(
    'MER.CAPTURE_AMOUNT_MISMATCH',
    409,
    'The amount captured ({captured}) isn’t the order total ({total}). Collect the order again.',
    ['12.10', 'OI-MER-12', 'RNG-MER-069'],
    ['captured', 'total'],
  ),
  n(
    'MER.CAPTURE_TOO_OLD',
    409,
    'This capture is older than {hours} hours, so it can’t be posted. Collect the order again.',
    ['12.10', 'Q14 M8'],
    ['hours'],
  ),
  n('MER.CAPTURE_TIME_INVALID', 422, 'The capture time is in the future.', ['12.10']),
  r(
    'MER.CAPTURE_SIGNATURE',
    'MSG-MER-98',
    'Invalid NFC token',
    401,
    'The counter’s signature on this capture isn’t valid.',
    ['12.10', 'RNG-MER-090'],
  ),
  n('MER.BATCH_TOO_LARGE', 422, 'Send at most {max} captures in one batch.', ['12.10'], ['max']),
  n('MER.POS_TERMINAL_UNKNOWN', 404, 'This terminal isn’t a POS counter of your institution.', [
    '9.10',
    'RNG-PAY-110',
    'MER-014',
  ]),
  {
    key: 'MER.CAPTURE_SYNCED',
    register: 'MSG-MER-96',
    srsText: 'Transaction already synced',
    class: 'K',
    type: 'info',
    en: 'Transaction already synced',
    approval: 'register',
    batch: 4,
    refs: ['12.10', 'RNG-MER-089'],
  },
] as const satisfies readonly MessageDefinition[];

export type PosMessageKey = (typeof POS_MESSAGES)[number]['key'];

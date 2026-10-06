/**
 * Settlement messages (SRS 14; 27.5 MSG-STL-*). The legacy texts are kept where one fits (class K);
 * a technical one is reworded (class R); the payout and its ledger posting are new (class N).
 * Client standing approval 2026-10-03.
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
    batch: 6,
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
    batch: 6,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const SETTLEMENT_MESSAGES = [
  k('STL.NOT_FOUND', 'MSG-STL-15', 'Settlement not found', 404, ['14.3']),
  k('STL.NOT_PENDING', 'MSG-STL-16', 'Settlement not in pending state', 409, ['14.3']),
  k('STL.REMARKS', 'MSG-STL-13', 'Remarks are required.', 422, ['14.3', 'OI-STL-09']),
  k('STL.NOT_STAGE1', 'MSG-STL-35', 'Settlement not in stage 1 approval state.', 409, ['14.4']),
  k(
    'STL.SAME_APPROVER',
    'MSG-STL-36',
    'Same user cannot perform both stage 1 and final approval.',
    409,
    ['14.4', 'RNG-GOV-005'],
  ),
  k('STL.CANNOT_REJECT', 'MSG-STL-43', 'Cannot reject approved or already failed settlement', 409, [
    '14.4',
  ]),
  k(
    'STL.REJECTER_APPROVED',
    'MSG-STL-44',
    'You cannot reject a settlement you have previously approved.',
    409,
    ['14.4'],
  ),
  {
    key: 'STL.NOT_APPROVED',
    register: 'MSG-STL-51',
    srsText: 'Settlement id=<id> is not approved. Current status=<status>',
    class: 'R',
    type: 'error',
    http: 409,
    en: 'This settlement isn’t approved yet, so a payout can’t be recorded.',
    approval: 'approved',
    batch: 6,
    refs: ['14.6', 'client standing approval 2026-10-03'],
  },
  n('STL.UTR_FORMAT', 422, 'Enter the bank’s UTR: 16 to 22 capital letters and digits.', [
    '14.6',
    'OI-STL-07',
  ]),
  n(
    'STL.UTR_SET',
    409,
    'A payout is already recorded for this settlement (UTR {utr}).',
    ['14.6', 'RNG-STL-052'],
    ['utr'],
  ),
  n('STL.UTR_TAKEN', 409, 'This UTR is already recorded on another settlement.', [
    '14.6',
    'OI-STL-07',
  ]),
  n(
    'STL.PAYOUT_AMOUNT',
    422,
    'The payout amount must be the settlement’s net amount to be paid, {amount}.',
    ['14.6', 'OI-STL-07'],
    ['amount'],
  ),
  n(
    'STL.MERCHANT_BALANCE',
    409,
    '{merchant}’s wallet holds less than its settled amount, so the payout can’t be posted. Check the wallet before recording the payout.',
    ['14.6', 'docs/03 §10.2'],
    ['merchant'],
  ),
] as const satisfies readonly MessageDefinition[];

export type SettlementMessageKey = (typeof SETTLEMENT_MESSAGES)[number]['key'];

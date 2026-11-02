/**
 * Reconciliation messages (SRS 15; 27.5 MSG-REC-*). The legacy texts are kept where one fits (class
 * K); a text that no longer describes what happens is reworded (class R): uploads are now all or
 * nothing, and the refund notice is about the campus wallet, not a biller. Statement matching,
 * mismatches, the refund and chargeback states and their ledger postings are new (class N).
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
    // The register writes placeholders as <n>.
    srsText: text.replace(/\{(\w+)\}/g, '<$1>'),
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

export const RECON_MESSAGES = [
  // --- statement uploads (REC-001) ---------------------------------------------------------------------
  k(
    'REC.ROW_NULL',
    'MSG-REC-40',
    'Row {n} has null data and will not be inserted.',
    422,
    ['15.6.4'],
    ['n'],
  ),
  k(
    'REC.ROW_DATE',
    'MSG-REC-39',
    'Row {n} has an invalid date format: {value}',
    422,
    ['15.6.4'],
    ['n', 'value'],
  ),
  {
    key: 'REC.FILE_REJECTED',
    register: 'MSG-REC-41',
    srsText: 'Some rows were not inserted due to null data.',
    class: 'R',
    type: 'error',
    http: 422,
    en: 'Nothing was uploaded: correct the rows listed and upload the file again.',
    approval: 'approved',
    batch: 6,
    refs: ['15.6.4', 'OI-REC-07', 'client standing approval 2026-10-03'],
  },
  {
    key: 'REC.UPLOADED',
    register: 'MSG-REC-42',
    srsText: 'File uploaded and data inserted successfully.',
    class: 'K',
    type: 'success',
    en: 'File uploaded and data inserted successfully.',
    approval: 'register',
    batch: 6,
    refs: ['15.6.4'],
  },
  n(
    'REC.FILE_DUPLICATE',
    409,
    'This file was already uploaded on {date}.',
    ['FR-REC-02', 'OI-REC-07'],
    ['date'],
  ),
  n(
    'REC.ROW_SEEN',
    422,
    'Row {n}: {key} is already in an earlier statement.',
    ['FR-REC-02', 'OI-REC-07'],
    ['n', 'key'],
  ),
  n(
    'REC.ROW_REPEATED',
    422,
    'Row {n}: {key} appears more than once in this file.',
    ['FR-REC-02', 'OI-REC-07'],
    ['n', 'key'],
  ),
  n(
    'REC.ROW_AMOUNT',
    422,
    'Row {n}: enter the amount in rupees, like 1250.00.',
    ['15.6.4', 'OI-REC-07'],
    ['n'],
  ),
  n(
    'REC.ROW_FORMAT',
    422,
    'Row {n}: {column} isn’t in the expected format.',
    ['15.6.4'],
    ['n', 'column'],
  ),
  // --- mismatches (REC-003 / REC-004) ------------------------------------------------------------------
  n('REC.MISMATCH_NOT_FOUND', 404, 'Mismatch not found.', ['FR-REC-03']),
  n(
    'REC.TRANSITION_INVALID',
    409,
    'This can’t be done while the record is {status}.',
    ['RNG-GOV-009', 'OI-REC-06'],
    ['status'],
  ),
  n('REC.REMARKS', 422, 'Enter remarks of 3 to 500 characters.', ['OI-REC-06']),
  n(
    'REC.REFERENCE_REQUIRED',
    422,
    'Enter the reference of the transaction to refund or charge back.',
    ['FR-REC-03'],
  ),
  // --- refunds (REC-008 / REC-009 / REC-018) -----------------------------------------------------------
  k('REC.TXN_UNKNOWN', 'MSG-REC-61', 'Invalid Transaction Id !!!', 404, ['15.6.4']),
  n('REC.REFUND_NOT_FOUND', 404, 'Refund not found.', ['OI-REC-06']),
  n(
    'REC.NOT_REFUNDABLE',
    409,
    'Only a payment or a transfer between two campus wallets can be refunded.',
    ['OI-REC-06', 'FR-REC-03'],
  ),
  n(
    'REC.REFUND_EXISTS',
    409,
    'A refund for this transaction is already {status}.',
    ['RNG-REC-051', 'OI-REC-06'],
    ['status'],
  ),
  n(
    'REC.AMOUNT_ABOVE',
    422,
    'The amount can’t be more than the transaction’s {amount}.',
    ['OI-REC-06'],
    ['amount'],
  ),
  n(
    'REC.ALREADY_RETURNED',
    409,
    'This transaction’s money has already gone back through a reversal or a chargeback.',
    ['RNG-GOV-014', 'OI-REC-06'],
  ),
  n(
    'REC.SAME_OFFICER',
    409,
    'The officer who requested this refund can’t decide it. Ask another officer.',
    ['RNG-GOV-005', 'OI-GRV-11'],
  ),
  n(
    'REC.REFUND_BALANCE',
    409,
    '{name}’s wallet holds less than the refund of {amount}, so it can’t be processed now.',
    ['docs/03 §10.2', 'Q14 M3'],
    ['name', 'amount'],
  ),
  n('REC.WALLET_CLOSED', 409, 'The wallet the money would go back to is closed.', ['OI-REC-06']),
  // --- chargebacks (REC-005 / REC-006 / REC-007 / REC-019) ---------------------------------------------
  k('REC.CHARGEBACK_EXISTS', 'MSG-REC-48', 'Charge Back Transaction ID already Raised.', 409, [
    '15.6.4',
    'RNG-REC-050',
  ]),
  n('REC.CHARGEBACK_NOT_FOUND', 404, 'Chargeback not found.', ['OI-REC-06']),
  n('REC.REASON_CODE', 422, 'Enter the reason code: 1 to 20 letters, digits or dashes.', [
    '15.6.4',
    'OQ-16',
  ]),
  n('REC.OUTCOME_ACCEPTED', 422, 'An accepted chargeback can only be completed as reversed.', [
    'OI-REC-06',
  ]),
  n(
    'REC.CHARGEBACK_BALANCE',
    409,
    '{name}’s wallet holds less than the chargeback of {amount}, so it can’t be completed now.',
    ['docs/03 §10.2', 'Q14 M3'],
    ['name', 'amount'],
  ),
  // --- the customer notice (only on Processed, OI-REC-06) ----------------------------------------------
  {
    key: 'NTF.REFUND_PROCESSED',
    register: 'MSG-REC-63',
    srsText: 'Refund Successfully Processed on CampusOne for <reference> - Biller: <biller>',
    class: 'R',
    type: 'info',
    en: 'Refund Successfully Processed on CampusOne for {reference}: {amount} back in the wallet',
    placeholders: ['reference', 'amount'],
    approval: 'approved',
    batch: 6,
    refs: ['15.6.4', 'RNG-REC-052', 'OI-REC-06', 'client standing approval 2026-10-03'],
  },
] as const satisfies readonly MessageDefinition[];

export type ReconMessageKey = (typeof RECON_MESSAGES)[number]['key'];

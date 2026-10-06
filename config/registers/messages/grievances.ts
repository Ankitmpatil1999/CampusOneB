/**
 * Grievance messages (SRS 16; 27.5 MSG-GRV-*). The legacy texts are kept where one fits (class K);
 * one that names a database column is reworded (class R); the party check, the text rules, the
 * Priority-1 refund, fraud reports, call logs and the support desk's recorded look-ups are new
 * (class N). Client standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

const k = (
  key: string,
  register: string,
  text: string,
  http: number,
  refs: readonly string[],
  type: 'error' | 'success' = 'error',
) =>
  ({
    key,
    register,
    srsText: text,
    class: 'K',
    type,
    http,
    en: text,
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
  type: 'error' | 'info' = 'error',
) =>
  ({
    key,
    register: null,
    srsText: null,
    class: 'N',
    type,
    http,
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'approved',
    batch: 6,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const GRIEVANCE_MESSAGES = [
  // --- raising (GRV-001…005) ---------------------------------------------------------------------------
  k(
    'GRV.TICKET_OPEN_EXISTS',
    'MSG-GRV-12',
    'You have already raised a ticket for this transaction that is not closed. Please check in View Tickets.',
    409,
    ['16.2', 'RNG-GRV-008'],
  ),
  k('GRV.TXN_NOT_FOUND', 'MSG-GRV-13', 'Transaction details not found', 404, ['16.2']),
  k(
    'GRV.RAISED',
    'MSG-GRV-02',
    'Ticket and grievance raised successfully',
    201,
    ['16.2'],
    'success',
  ),
  k(
    'GRV.FEEDBACK_RECEIVED',
    'MSG-GRV-60',
    'Feedback received successfully',
    201,
    ['16.5'],
    'success',
  ),
  n('GRV.NOT_A_PARTY', 403, 'You can raise a ticket only for a transaction of your own wallet.', [
    '16.2',
    'OI-GRV-02',
  ]),
  n('GRV.CATEGORY', 422, 'Choose what went wrong.', ['16.2', 'prototype m.tickets']),
  n(
    'GRV.ISSUE_FORMAT',
    422,
    'Write {min} to {max} characters. The symbols < > { } \\ and ` can’t be used.',
    ['16.2', 'OI-GRV-02'],
    ['min', 'max'],
  ),
  n('GRV.ATTACHMENT', 422, 'Attach a screenshot you uploaded (PDF, PNG or JPEG, 2 MB).', [
    '16.5',
    '16.6',
  ]),
  // --- the console (GRV-006…010) -----------------------------------------------------------------------
  {
    key: 'GRV.TICKET_NOT_FOUND',
    register: 'MSG-GRV-87',
    srsText: 'Invalid ticket_id !!!',
    class: 'R',
    type: 'error',
    http: 404,
    en: 'Ticket not found.',
    approval: 'approved',
    batch: 6,
    refs: ['16.8', 'client standing approval 2026-10-03'],
  },
  k('GRV.STATUS_REQUIRED', 'MSG-GRV-79', 'Please select a ticket status.', 422, ['16.8']),
  k('GRV.REASON_REQUIRED', 'MSG-GRV-80', 'Please select a resolution reason.', 422, [
    '16.8',
    'OI-GRV-10',
  ]),
  k('GRV.OTHER_COMMENT', 'MSG-GRV-81', "Please provide comments for 'Other' reason.", 422, [
    '16.8',
  ]),
  k(
    'GRV.SENT_FOR_APPROVAL',
    'MSG-GRV-83',
    'Ticket requires checker approval and is submitted for review.',
    202,
    ['16.8', 'MKR 17.2'],
    'success',
  ),
  k(
    'GRV.UPDATED',
    'MSG-GRV-84',
    'Ticket Status Changed Successfully !!!',
    200,
    ['16.8'],
    'success',
  ),
  n('GRV.CLOSED_READ_ONLY', 409, 'This ticket is closed and read-only.', ['16.8', 'OI-GRV-10']),
  n(
    'GRV.UPDATE_PENDING',
    409,
    'An update to this ticket is waiting for checker approval. It can’t be changed until that is decided.',
    ['16.8', 'RC-20'],
  ),
  n(
    'GRV.TRANSITION_INVALID',
    409,
    'A ticket can’t go from {from} to {to}.',
    ['RC-20', 'OI-GRV-04'],
    ['from', 'to'],
  ),
  n('GRV.COMMENT', 422, 'Add a comment for the history (5 to 400 characters).', [
    '16.8',
    'OI-GRV-10',
  ]),
  n(
    'GRV.NOTHING_CHANGED',
    422,
    'Nothing has changed — change the status, priority or resolution, or log a call instead.',
    ['16.8', 'prototype c.grievances'],
  ),
  n(
    'GRV.REFUND_PRIORITY',
    422,
    'A refund needs Priority 1, so that a checker approves it before money moves.',
    ['Q14 M16', 'OI-GRV-11'],
  ),
  n('GRV.REFUND_NOT_POSSIBLE', 409, 'This ticket’s transaction can’t be refunded.', [
    'Q14 M16',
    'OI-GRV-11',
  ]),
  n('GRV.NOT_RESOLVED', 409, 'Only a resolved ticket can be closed here.', ['16.3', 'RC-20']),
  // --- calls and the support desk (GRV-009…013) --------------------------------------------------------
  n('GRV.CALL_CALLER', 422, 'Who called? Enter a name of 2 to 100 characters.', ['16.9']),
  n('GRV.CALL_MINUTES', 422, 'Enter 1 to 180 minutes.', ['16.9']),
  n('GRV.CALL_NOTES', 422, 'Add notes of 5 to 400 characters.', ['16.9']),
  n(
    'GRV.LOOKUP_REASON',
    422,
    'Say why you are looking this up (3 to 200 characters). It is recorded.',
    ['FR-GRV-04', 'RNG-GOV-008'],
  ),
  n('GRV.LOOKUP_CRITERIA', 422, 'Enter a ticket number or a mobile number.', ['FR-GRV-04']),
  // --- the member is told (OI-GRV-05) ------------------------------------------------------------------
  n(
    'NTF.TICKET_UPDATED',
    200,
    'Update on ticket {ticketNo}: {status}',
    ['16.3', 'OI-GRV-05'],
    ['ticketNo', 'status'],
    'info',
  ),
] as const satisfies readonly MessageDefinition[];

export type GrievanceMessageKey = (typeof GRIEVANCE_MESSAGES)[number]['key'];

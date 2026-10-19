/**
 * Fee structure messages (SRS 13.2, 13.19 CR-11). CR-11 leaves the wording to design time
 * (OI-FEE-30), so these are new (class N) and follow the prototype's c.fees wording; the 27.5 texts
 * of entry fees are kept where one exists (class K) — client standing approval 2026-10-03.
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
    batch: 5,
    refs: [...refs, 'OI-FEE-30', 'client standing approval 2026-10-03'],
  }) as const;

export const FEE_MESSAGES = [
  n('FEE.HEAD_TAKEN', 409, '{name} already exists.', ['13.19.1', 'OI-FEE-25'], ['name']),
  n(
    'FEE.STRUCTURE_NAME_TAKEN',
    409,
    'A structure called “{name}” already exists for {year}.',
    ['13.19.1', 'RNG-FEE-158'],
    ['name', 'year'],
  ),
  n(
    'FEE.CLASS_TAKEN',
    409,
    '{class} already has {structure} for {year}. A class can have one structure a year.',
    ['13.19.1', 'RNG-FEE-158'],
    ['class', 'structure', 'year'],
  ),
  n(
    'FEE.TOTAL_MISMATCH',
    422,
    'The total sent ({sent}) isn’t the total of the heads ({total}). Nothing was saved.',
    ['13.19.1', 'RNG-FEE-165'],
    ['sent', 'total'],
  ),
  n(
    'FEE.SHARES_NOT_100',
    422,
    'Instalment shares add up to {total}%. They must add up to exactly 100%.',
    ['13.19.1', 'RNG-FEE-164'],
    ['total'],
  ),
  n(
    'FEE.INSTALMENTS_MAX',
    422,
    'A structure can have at most {max} instalments.',
    ['13.19.1', 'OI-FEE-26'],
    ['max'],
  ),
  n(
    'FEE.DUE_OUTSIDE_YEAR',
    422,
    '{label}’s due date must fall inside {year} ({from} – {to}).',
    ['13.19.1', 'RNG-FEE-160'],
    ['label', 'year', 'from', 'to'],
  ),
  n(
    'FEE.DUE_ORDER',
    422,
    '{label} must be due after {previous}.',
    ['13.19.1', 'RNG-FEE-160'],
    ['label', 'previous'],
  ),
  n(
    'FEE.FINE_TOO_HIGH',
    422,
    'The late fine can’t be more than the smallest instalment ({max}).',
    ['13.19.1', 'BR-30', 'OI-FEE-28'],
    ['max'],
  ),
  n(
    'FEE.HEAD_REPEATED',
    422,
    '{name} is listed more than once. Use each head once.',
    ['13.19.1', 'RNG-FEE-159'],
    ['name'],
  ),
  n('FEE.HEAD_UNKNOWN', 422, 'Choose a fee head from the institution’s list.', [
    '13.19.1',
    'OI-FEE-25',
  ]),
  n('FEE.STRUCTURE_LOCKED', 409, 'Waiting for approval — it can’t be changed now.', [
    '13.19.1',
    'RNG-FEE-161',
  ]),
  n('FEE.ALREADY_PENDING', 409, 'This structure is already waiting for a checker.', [
    '13.19.1',
    'RNG-FEE-176',
  ]),
  n('FEE.NOTHING_TO_SUBMIT', 409, 'There is no draft of this structure to submit.', ['13.19.1']),
  n('FEE.STRUCTURE_NOT_APPROVED', 409, 'Approve the structure before assigning it.', [
    '13.19.1',
    'RNG-FEE-167',
  ]),
  n(
    'FEE.YEAR_CLOSED',
    409,
    '{year} is closed, so its fees can’t change.',
    ['13.19.1', 'RC-22'],
    ['year'],
  ),
  // --- fee records and collection (13.3, 13.5, 13.15) ----------------------------------------------
  n('FEE.RECORD_PAID', 409, 'This fee is already paid or cancelled, or its amount has changed.', [
    '13.15',
    'RNG-PAY-123',
  ]),
  n(
    'FEE.DUPLICATE_RECORD',
    409,
    '{student} already has instalment {instalment} for {year}.',
    ['13.3', 'OI-FEE-04'],
    ['student', 'instalment', 'year'],
  ),
  n(
    'FEE.CONSENT_REQUIRED',
    409,
    'The family hasn’t agreed to wallet collection yet, so the fee can’t be collected from the wallet.',
    ['13.5', 'OI-FEE-11'],
  ),
  n('FEE.FINANCED', 409, 'This fee is paid through the financing partner, not from the wallet.', [
    '13.12',
    'OI-FEE-17',
  ]),
  n('FEE.TUITION_OFF', 409, 'Tuition collection is turned off for this institution.', [
    '13.3',
    'OI-FEE-22',
  ]),
  n('FEE.CHANGE_PENDING', 409, 'A change to this fee is already waiting for a checker.', [
    '13.3',
    'FR-FEE-07',
  ]),
  n('FEE.NOT_A_STUDENT', 422, 'Choose a student of this institution.', ['13.3', 'OI-FEE-03']),
  // --- consent and fee financing (13.5, 13.11–13.12) --------------------------------------------------
  n(
    'FEE.CONSENT_TEMPLATE_STALE',
    409,
    'The consent text has changed. Read the new text and accept it again.',
    ['13.5', 'OI-FEE-11'],
  ),
  n(
    'FEE.FINANCING_NOT_ELIGIBLE',
    422,
    'Only unpaid fees of the current academic year can be financed.',
    ['13.12', 'OI-FEE-17'],
  ),
  n(
    'FEE.FINANCING_EXISTS',
    409,
    '{student} is already registered with the financing partner ({status}).',
    ['13.12', 'OI-FEE-17'],
    ['student', 'status'],
  ),
  n(
    'FEE.FINANCING_BY_SCHOOL',
    409,
    'Your school registers students for fee financing. Please ask the accounts office.',
    ['13.12', 'OI-FEE-17', 'OQ-03'],
  ),
  n('FEE.FINANCING_DECIDED', 409, 'The partner has already decided this registration.', [
    '13.12',
    'OI-INT-02',
  ]),
  // --- fee sheet uploads (13.3, FR-FEE-03; prototype c.feerecords wording) -------------------------
  n('FEE.UPLOAD_NO_STUDENT', 422, 'No student with this admission number', ['13.3', 'FR-FEE-03']),
  n(
    'FEE.UPLOAD_REPEATED',
    422,
    'Admission number appears {n} times in this file',
    ['13.3', 'OI-FEE-04'],
    ['n'],
  ),
  n('FEE.UPLOAD_SAME_DAY', 409, 'Already uploaded today with the same total and instalments', [
    '13.3',
    'OI-FEE-04',
  ]),
  // Notices to the student and parents (client 2026-10-16: as the earlier application's
  // TUTION_FEE_ASSIGNED and FEE_ALERT, in the app and by e-mail).
  {
    key: 'NTF.FEE_ASSIGNED',
    register: null,
    srsText: null,
    class: 'N',
    type: 'info',
    en: 'Fee of {amount} assigned to {name} for {year}',
    placeholders: ['amount', 'name', 'year'],
    approval: 'approved',
    batch: 10,
    refs: ['13.4', 'client 2026-10-16'],
  },
  {
    key: 'NTF.FEE_DUE',
    register: null,
    srsText: null,
    class: 'N',
    type: 'info',
    en: '{label} of {amount} for {name} is due on {date}',
    placeholders: ['label', 'amount', 'name', 'date'],
    approval: 'approved',
    batch: 10,
    refs: ['13.4', 'client 2026-10-16'],
  },
] as const satisfies readonly MessageDefinition[];

export type FeeMessageKey = (typeof FEE_MESSAGES)[number]['key'];

/**
 * Admission messages (SRS 19.2–19.12, 7.8; CR-14). The 27.5 texts are kept where one fits (class
 * K); a legacy text that names Aadhaar, Razorpay, "CUG" or "organization", or that is wrong for a
 * mid-term joiner, is reworded (class R); texts for what the legacy never had — links, mid-term,
 * references, the gateway's test mode — are new (class N) and follow the prototype's p.* and
 * c.applications wording. Client standing approval 2026-10-03.
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
    // The register writes placeholders as <n>; the text fills {n}.
    en: text.replace(/<(w+)>/g, '{$1}'),
    ...(placeholders ? { placeholders } : {}),
    approval: 'register',
    batch: 5,
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
    batch: 5,
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
    batch: 5,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const ADMISSION_MESSAGES = [
  // --- links (7.8) -----------------------------------------------------------------------------------
  r(
    'ADM.LINK_INVALID',
    'MSG-ONB-180',
    'Admission QR code not found',
    404,
    'This admission link isn’t valid any more. Ask the school for its current link or QR code.',
    ['7.8', 'OI-ONB-12'],
  ),
  n(
    'ADM.LINK_EXPIRED',
    410,
    'This admission link has expired. Ask the school for its current link or QR code.',
    ['7.8', 'OI-ONB-12'],
  ),
  // --- the form (19.2, 19.3) ---------------------------------------------------------------------------
  k('ADM.NOT_FOUND', 'MSG-ADM-191', 'Admission application not found', 404, ['19.2', '19.4']),
  r(
    'ADM.YEAR_NOT_OPEN',
    'MSG-ADM-194',
    'Selected academic year is not available for this organization',
    422,
    'The selected academic year isn’t open for admissions.',
    ['19.2', 'FR-ADM-02'],
  ),
  k('ADM.CLASS_INVALID', 'MSG-ADM-009', 'Please select a valid admission standard', 422, ['19.2']),
  r(
    'ADM.ID_INVALID',
    'MSG-ADM-001',
    'Enter a valid 12-digit Aadhaar number',
    422,
    'Enter a valid 12-digit Aadhaar number.',
    ['19.2', 'client 2026-10-12'],
  ),
  k(
    'ADM.MOBILE_INVALID',
    'MSG-ADM-132',
    'Mobile number must contain 10 digits and start with 6, 7, 8 or 9',
    422,
    ['19.2'],
  ),
  r(
    'ADM.RESUME_NEEDS',
    'MSG-ADM-130',
    'Aadhaar number or mobile number is required',
    422,
    "Enter the primary contact's mobile number from the application.",
    ['19.2', 'Q16 e', 'client 2026-10-12'],
  ),
  r(
    'ADM.AGE_TOO_LOW',
    'MSG-ADM-030',
    'Age must be at least <n> years for <standard> as of 01-Jun-<year>',
    422,
    'Age must be at least {n} years for {standard} as of {date}.',
    ['19.2', 'BR-50', 'OI-ADM-23'],
    ['n', 'standard', 'date'],
  ),
  k(
    'ADM.AGE_TOO_HIGH',
    'MSG-ADM-031',
    'Age is too high for <standard> (maximum is <n> years)',
    422,
    ['19.2', 'BR-50'],
    ['standard', 'n'],
  ),
  n(
    'ADM.JOINING_DATE',
    422,
    'For this academic year, choose a joining date from today to {to}.',
    ['19.12.1', 'CR-14', 'OI-ADM-23'],
    ['to'],
  ),
  n(
    'ADM.DUPLICATE',
    409,
    'An application for this child already exists for {year}. Resume it instead of starting a new one.',
    ['19.2', 'OI-ADM-02'],
    ['year'],
  ),
  n('ADM.NOT_DRAFT', 409, 'This application has been submitted, so it can’t be changed here.', [
    '19.2',
    'OI-ADM-03',
  ]),
  n(
    'ADM.MOBILE_INTL_INVALID',
    422,
    'Enter the mobile number without the country code: 6 to 12 digits.',
    ['19.2', 'client 2026-10-13'],
  ),
  n('ADM.TRANSPORT_OR_HOSTEL', 422, 'Choose school transport or the hostel, not both.', [
    '19.2',
    'client 2026-10-13',
  ]),
  n(
    'ADM.SAME_MOBILE',
    422,
    'This is the {person}’s mobile number. The father, the mother and the guardian each need their own.',
    ['19.2', 'client 2026-10-14'],
    ['person'],
  ),
  n(
    'ADM.SAME_AADHAAR',
    422,
    'This is the {person}’s Aadhaar number. The father, the mother and the guardian each have their own.',
    ['19.2', 'client 2026-10-14'],
    ['person'],
  ),
  n(
    'ADM.SAME_PAN',
    422,
    'This is the {person}’s PAN. The father, the mother and the guardian each have their own.',
    ['19.2', 'client 2026-10-14'],
    ['person'],
  ),
  n('ADM.INCOME_INVALID', 422, 'Enter the annual income in rupees, in digits only.', [
    '19.2',
    'client 2026-10-14',
  ]),
  n('ADM.FORM_NOT_SUBMITTED', 409, 'The application form can be downloaded once it is submitted.', [
    '19.2',
    'client 2026-10-13',
  ]),
  n('ADM.NOT_EDITABLE', 409, 'An approved or rejected application can’t be changed.', [
    '19.3',
    '19.4',
  ]),
  k('ADM.DECLARATION', 'MSG-ADM-171', 'Declaration must be accepted', 422, ['19.2', 'FR-ADM-06']),
  n(
    'ADM.REFERENCES_REQUIRED',
    422,
    'Add at least one reference — it’s needed for a mid-term admission.',
    ['19.12.2', 'CR-14', 'OI-ADM-29'],
  ),
  n(
    'ADM.REFERENCE_LIMIT',
    422,
    'You can add up to {max} references.',
    ['19.12.2', 'CR-14', 'OI-ADM-29'],
    ['max'],
  ),
  n(
    'ADM.REFERENCE_MINIMUM',
    409,
    'A mid-term application needs at least one reference, so this one can’t be removed.',
    ['19.12.2', 'CR-14'],
  ),
  n(
    'ADM.TC_OR_UNDERTAKING_REQUIRED',
    422,
    'Attach the transfer certificate, or give an undertaking with the date you’ll produce it.',
    ['19.12.1', 'CR-14', 'OI-ADM-27'],
  ),
  n(
    'ADM.TC_DUE_DATE',
    422,
    'Choose the date you’ll hand in the transfer certificate: from today, and no later than {latest}.',
    ['19.12.1', 'OI-ADM-27', 'client 2026-10-13'],
    ['latest'],
  ),
  n(
    'ADM.TC_NOT_MID_TERM',
    409,
    'A transfer certificate is recorded only for a mid-term admission.',
    ['19.12.1', 'CR-14'],
  ),
  // --- fees and payment (19.2, 19.7–19.9) --------------------------------------------------------------
  k(
    'ADM.FEE_CONFIG_MISSING',
    'MSG-ADM-174',
    'Fee configuration not found for this academic year',
    409,
    ['19.2', 'FR-FEE-12'],
  ),
  k('ADM.FEE_REQUIRED', 'MSG-ADM-175', 'Application fee is mandatory', 409, ['19.2', 'BR-36']),
  k('ADM.FEE_ALREADY_PAID', 'MSG-ADM-332', 'Payment already completed', 409, ['19.8', 'FR-FEE-12']),
  k('ADM.REJECTED_NO_PAYMENT', 'MSG-ADM-356', 'Rejected application cannot make payment', 409, [
    '19.8',
  ]),
  n('ADM.FEE_AFTER_APPROVAL', 409, 'Only approved applications can pay the admission fee.', [
    '19.8',
    'prototype cm.adm.online',
  ]),
  k(
    'ADM.PAYMENT_NOT_VERIFIED',
    'MSG-ADM-215',
    'Payment verification failed. Please contact the admission office.',
    402,
    ['19.2', 'FR-INT-03'],
  ),
  n(
    'ADM.GATEWAY_NOT_CONFIGURED',
    503,
    'Online payment isn’t available yet. Please pay at the school’s accounts desk.',
    ['19.2', 'Q17'],
  ),
  k('ADM.RECEIPT_TAKEN', 'MSG-ADM-200', 'Duplicate data found', 409, ['19.8']),
  // --- decisions (19.4) ---------------------------------------------------------------------------------
  k('ADM.NOT_SUBMITTED', 'MSG-ADM-260', 'Only Submitted applications can be approved', 409, [
    '19.4',
    'FR-ADM-09',
  ]),
  k(
    'ADM.ALREADY_DECIDED',
    'MSG-ADM-261',
    'Application is already <status>',
    409,
    ['19.4'],
    ['status'],
  ),
  n(
    'ADM.SECTION_NOT_IN_CLASS',
    422,
    'Choose a section of {class}, the class applied for.',
    ['19.4', 'CR-09'],
    ['class'],
  ),
  n(
    'ADM.TRANSPORT_STOP_INVALID',
    422,
    'Choose a pick-up point from the list, or leave it for the school to decide.',
    ['19.2', 'client 2026-10-12'],
  ),
  n(
    'ADM.CONSENT_REQUIRED',
    422,
    'Agree that the information collected will be used to register your account in RingPe.',
    ['19.2', 'client 2026-10-12'],
  ),
  n(
    'ADM.FEES_NOT_CONFIRMED',
    409,
    'Accounts has not confirmed both fees yet: the admission number and section are assigned once the application fee and the admission fee are confirmed.',
    ['19.4', 'client 2026-10-09'],
  ),
  n('ADM.FEE_NOT_PAID', 409, 'This fee is not paid yet, so there is no receipt to confirm.', [
    '19.8',
    'client 2026-10-09',
  ]),
  n('ADM.FEE_ALREADY_CONFIRMED', 409, 'This fee’s receipt is already confirmed.', [
    '19.8',
    'client 2026-10-09',
  ]),
  n(
    'ADM.ADMISSION_FEE_NOT_YET',
    409,
    'Submit the application first: the admission fee is paid with it or after it.',
    ['19.8', 'client 2026-10-09'],
  ),
  n(
    'ADM.APPLICATION_FEE_FIRST',
    409,
    'The admission fee can’t be paid on its own while the application fee is due. Pay both together, or both later at the school’s accounts desk.',
    ['19.8', 'client 2026-10-12'],
  ),
  n(
    'ADM.PARENT_TYPE_MISSING',
    409,
    'Add a user type in the Parent category first (People › User types): approving adds the parents as members.',
    ['19.4', 'RNG-ONB-024'],
  ),
  n(
    'ADM.STATUS_NOT_FOUND',
    404,
    'No application matches these details. Check the application number on your confirmation SMS or e-mail.',
    ['19.2', 'RNG-GOV-007'],
  ),
] as const satisfies readonly MessageDefinition[];

export type AdmissionMessageKey = (typeof ADMISSION_MESSAGES)[number]['key'];

/**
 * SaaS messages (SRS 25; FR-SAS-05…09; SAS-*; prototype o.plans, c.subscription). The old system had
 * no plans or billing, so there is no 27.5 wording; the texts are the prototype's (class N, client
 * standing approval 2026-10-03).
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
    batch: 2,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const SAAS_MESSAGES = [
  n('SAS.PLAN_NAME_TAKEN', 409, 'Another plan already has this name', [
    'FR-SAS-05',
    'prototype o.plans',
  ]),
  n('SAS.MODULES_REQUIRED', 422, 'Choose at least one module', ['FR-SAS-05', 'prototype o.plans']),
  n('SAS.INVOICE_DUPLICATE', 409, 'An invoice for this period already exists', [
    'FR-SAS-07',
    'prototype o.plans',
  ]),
  n('SAS.NOTHING_TO_BILL', 422, 'Enter the SMS or WhatsApp volume above the allowance', [
    'FR-SAS-07',
    'prototype o.plans',
  ]),
  n('SAS.NO_PLAN', 409, 'Choose a plan for the institution first.', ['FR-SAS-06']),
  n('SAS.UTR_FORMAT', 422, 'Use 10–22 letters and digits, no spaces', [
    'FR-SAS-08',
    'prototype o.plans',
  ]),
  n('SAS.UTR_TAKEN', 409, 'This reference is already recorded against another invoice', [
    'FR-SAS-08',
    'prototype o.plans',
  ]),
  n(
    'SAS.AMOUNT_MISMATCH',
    422,
    'The amount must equal the invoice total of {total}. Record part-payments with the finance team.',
    ['FR-SAS-08', 'prototype o.plans'],
    ['total'],
  ),
  n('SAS.PAID_ON_FUTURE', 422, "The date can't be in the future", [
    'FR-SAS-08',
    'prototype o.plans',
  ]),
  n('SAS.PAID_ON_BEFORE_ISSUE', 422, "The payment can't be before the invoice date", [
    'FR-SAS-08',
    'prototype o.plans',
  ]),
  n(
    'SAS.INVOICE_NOT_PAYABLE',
    409,
    "This invoice is {status} and can't be paid.",
    ['FR-SAS-08', 'RC-09'],
    ['status'],
  ),
  n('SAS.PLAN_SAME', 409, "That's already the current plan.", [
    'FR-SAS-07',
    'prototype ob.inst.plan.save',
  ]),
  n(
    'SAS.DOWNGRADE_AT_RENEWAL',
    422,
    'A move to a lower-priced plan takes effect at renewal on {date}.',
    ['FR-SAS-07', 'prototype ob.inst.plan'],
    ['date'],
  ),
  n(
    'SAS.REQUEST_PENDING',
    409,
    'A plan change request is already with RingPe. Withdraw it to send another.',
    ['FR-SAS-07', 'prototype c.subscription'],
  ),
  n('SAS.GSTIN_FORMAT', 422, 'Enter the 15-character GSTIN, for example 29ABCDE1234F1Z5', [
    'FR-SAS-07',
    'docs/07 Q26',
  ]),
  n('SAS.SAC_FORMAT', 422, 'Enter the 6-digit SAC code, for example 998314', [
    'FR-SAS-07',
    'docs/07 Q26',
  ]),
  n(
    'SAS.GSTIN_STATE',
    422,
    "The GSTIN's first two digits must be the state code {code}",
    ['FR-SAS-07', 'docs/07 Q26'],
    ['code'],
  ),
  n(
    'SAS.REQUEST_CLOSED',
    409,
    'This request is already {status}.',
    ['FR-SAS-07', 'RC-09'],
    ['status'],
  ),
  // Customer portal (prototype s.*). The prototype names the other institution; the portal does
  // not, because the page is public.
  n(
    'SAS.SIGNUP_NO_ACCOUNT',
    404,
    'No RingPe account uses this number. The administrator signs up with their own RingPe account — create one in the RingPe app first; it takes two minutes.',
    ['FR-SAS-06', '4.10'],
  ),
  n(
    'SAS.SIGNUP_ACCOUNT_IN_USE',
    409,
    "This RingPe account is already part of an institution. An account can belong to only one institution, so the administrator needs an account that isn't linked to a school yet.",
    ['BR-01', 'FR-SAS-06'],
  ),
  n('SAS.SIGNUP_EXPIRED', 401, 'This sign-up has expired. Verify the mobile number again.', [
    'FR-SAS-06',
  ]),
  n(
    'SAS.TERMS_REQUIRED',
    422,
    "Accept the subscription and data-processing terms, and confirm you're authorised to register the institution.",
    ['FR-SAS-06'],
  ),
  n('SAS.STEP_BY_RINGPE', 409, 'RingPe completes this step for you.', ['FR-SAS-10']),
  n(
    'SAS.EXPORT_RUNNING',
    409,
    'An export is already being prepared. It will be ready in a few minutes.',
    ['FR-SAS-04', 'OI-SAS-05'],
  ),
  n(
    'SAS.UNPAID_INVOICES',
    409,
    'Pay the open invoices before asking to cancel: {invoices}.',
    ['FR-SAS-04', 'OQ-30'],
    ['invoices'],
  ),
  n('SAS.CANCEL_PENDING', 409, 'A cancellation request is already waiting for RingPe.', [
    'FR-SAS-04',
  ]),
  n(
    'SAS.CANCEL_DATE',
    422,
    'Choose a date from today up to {max}.',
    ['FR-SAS-04', 'OQ-30'],
    ['max'],
  ),
  n(
    'SAS.GATEWAY_UNAVAILABLE',
    409,
    "Online payment isn't available yet. Pay by bank transfer and report the reference.",
    ['FR-SAS-08', 'Q17'],
  ),
  n(
    'SAS.DETAILS_CHANGE_PENDING',
    409,
    'A change to the institution details is already waiting for RingPe.',
    ['FR-INS-03'],
  ),
] as const satisfies readonly MessageDefinition[];

export type SaasMessageKey = (typeof SAAS_MESSAGES)[number]['key'];

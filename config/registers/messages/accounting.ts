/**
 * Accounting voucher and platform fee rule messages (SRS 13.13, 14.7; FEE-034…037, STL-009). The
 * legacy page's texts are display labels, not refusals, so these are new (class N). Client standing
 * approval 2026-10-03.
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
    batch: 6,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const ACCOUNTING_MESSAGES = [
  n('ACC.VOUCHER_NOT_FOUND', 404, 'Voucher not found.', ['13.13']),
  n('ACC.NOT_FAILED', 409, 'Only a voucher that failed to transfer can be retried.', [
    '13.13',
    'OI-INT-03',
  ]),
  n('ACC.COMPANY', 422, 'Enter the accounting company’s name (2 to 100 characters).', [
    '13.13',
    'OI-INT-03',
  ]),
  n(
    'ACC.LEDGER',
    422,
    'Enter the ledger names (2 to 100 characters), different for debit and credit.',
    ['13.13', 'OI-FEE-18'],
  ),
  n('ACC.MAPPING_NEEDED', 422, 'Map at least one posting before turning transfers on.', [
    '13.13',
    'RNG-FEE-123',
  ]),
  n(
    'ACC.PACKAGE_REFUSED',
    502,
    'The accounting package refused the voucher: {reason}',
    ['FR-INT-06', 'Q14 M15'],
    ['reason'],
  ),
  n('ACC.PACKAGE_OFF', 503, 'Transfers to the accounting package are not set up yet.', [
    'OQ-04',
    'Q14 M15',
  ]),
  n(
    'STL.RULE_EFFECTIVE',
    422,
    'A new rule takes effect from tomorrow or later, and after the last version ({date}).',
    ['OI-SAS-02', 'OQ-06'],
    ['date'],
  ),
  n('STL.RULE_TYPES', 422, 'Choose which collections the fee applies to.', ['14.7', 'Q14 M1']),
] as const satisfies readonly MessageDefinition[];

export type AccountingMessageKey = (typeof ACCOUNTING_MESSAGES)[number]['key'];

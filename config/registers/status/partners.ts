/**
 * Partner API clients and bank credits (27.2; docs/01c).
 *
 * - An API client is Active (may obtain tokens) or Inactive (token issue refused, INVALID_CLIENT).
 * - A bank credit to a virtual account (RC-12; CR-08): received, then processed (posted to the
 *   wallet), failed (refused at validation), held (the wallet was suspended or inactive — posted to
 *   the institution's held-suspense account, not the wallet), and from held either processed when the
 *   suspension is lifted or returned to the remitter on an approved instruction.
 */
import { NEW, type StatusDomain } from './types';

export type ApiClientStatusCode = 'ACTIVE' | 'INACTIVE';
export type BankCreditStatusCode = 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'HELD' | 'RETURNED';

export const API_CLIENT: StatusDomain<ApiClientStatusCode> = {
  domain: 'api_client',
  srsDomain: 'API client (status)',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.api_client.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.api_client.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'a Platform Administrator creates the client (INT-002)' },
    { from: 'ACTIVE', to: 'INACTIVE', operation: 'suspended with a reason (INT-003)' },
    { from: 'INACTIVE', to: 'ACTIVE', operation: 'reactivated (INT-003)' },
  ],
};

export const BANK_CREDIT: StatusDomain<BankCreditStatusCode> = {
  domain: 'bank_credit',
  srsDomain: 'Bank notification posting',
  rc: 'RC-12',
  values: [
    {
      code: 'RECEIVED',
      registerValue: 'RECEIVED',
      labelKey: 'status.bank_credit.received',
      label: 'Received',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'PROCESSED',
      registerValue: 'PROCESSED',
      labelKey: 'status.bank_credit.processed',
      label: 'Credited',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: 'FAILED',
      labelKey: 'status.bank_credit.failed',
      label: 'Refused',
      tone: 'bad',
      terminal: true,
    },
    {
      code: 'HELD',
      registerValue: null,
      labelKey: 'status.bank_credit.held',
      label: 'Held',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'RETURNED',
      registerValue: null,
      labelKey: 'status.bank_credit.returned',
      label: 'Returned',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'RECEIVED', operation: 'the sponsor bank notifies a credit (WAL-013)' },
    {
      from: 'RECEIVED',
      to: 'PROCESSED',
      operation: 'posted to an active wallet through the ledger',
    },
    { from: 'RECEIVED', to: 'FAILED', operation: 'the account is unknown or the amount invalid' },
    { from: 'RECEIVED', to: 'HELD', operation: 'the wallet is suspended or inactive (CR-08)' },
    {
      from: 'HELD',
      to: 'PROCESSED',
      operation: 'the suspension is lifted (held-credit release job)',
    },
    {
      from: 'HELD',
      to: 'RETURNED',
      operation:
        'returned to the remitter on an approved instruction (WAL-011, BANK_CREDIT_RETURN)',
    },
  ],
};

export const PARTNER_DOMAINS = [API_CLIENT, BANK_CREDIT] as const;

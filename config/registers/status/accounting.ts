/**
 * Accounting vouchers (SRS 13.13; RC-36; Q14 M15: vouchers pushed to the institution's package with
 * retry). The legacy marked postings POSTED without sending them, its page showing "Pending
 * Transfer" or "Transferred" (OI-FEE-18); a voucher now waits as Pending Transfer, is Transferred
 * when the package accepts it, or Failed — retried by the job, or by hand (FEE-035).
 */
import { NEW, type StatusDomain } from './types';

export const VOUCHER: StatusDomain<'PENDING' | 'TRANSFERRED' | 'FAILED'> = {
  domain: 'accounting_voucher',
  srsDomain: null,
  rc: 'RC-36',
  values: [
    {
      code: 'PENDING',
      registerValue: null,
      labelKey: 'status.voucher.pending',
      label: 'Pending Transfer',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'TRANSFERRED',
      registerValue: null,
      labelKey: 'status.voucher.transferred',
      label: 'Transferred',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: null,
      labelKey: 'status.voucher.failed',
      label: 'Failed',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PENDING',
      operation: 'the job accounting-vouchers writes one voucher per mapped ledger posting',
    },
    {
      from: 'PENDING',
      to: 'TRANSFERRED',
      operation: 'the accounting package accepted it (job, or FEE-035)',
    },
    {
      from: 'PENDING',
      to: 'FAILED',
      operation: 'the package refused it or could not be reached (the error is kept)',
    },
    {
      from: 'FAILED',
      to: 'PENDING',
      operation: 'retried by the job after a pause, or by an officer (FEE-035)',
    },
  ],
};

export const ACCOUNTING_DOMAINS = [VOUCHER] as const;

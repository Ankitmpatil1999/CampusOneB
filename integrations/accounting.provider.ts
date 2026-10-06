/**
 * The institution's accounting package (SRS 13.13; FR-INT-06; OQ-04 open; Q14 M15: push vouchers to
 * the package — Tally per the legacy — with retry). The package and its interface are not chosen, so:
 *
 * test: STUB — the package is simulated. A voucher is accepted with a test reference; a voucher whose
 * debit or credit ledger is named "TEST-FAIL…" is refused, so the failure and retry path can be tried.
 * Production refuses this mode (ACCOUNTING_MODE).
 * off: nothing is sent; vouchers wait as Pending Transfer until the package is chosen.
 */
import { randomBytes } from 'node:crypto';

export interface VoucherToSend {
  readonly company: string;
  readonly reference: string;
  readonly date: string;
  readonly amountPaise: number;
  readonly debitLedger: string;
  readonly creditLedger: string;
  readonly narration: string | null;
}

export type SendResult =
  | { readonly ok: true; readonly externalRef: string }
  | { readonly ok: false; readonly reason: string };

export interface AccountingPackage {
  readonly mode: 'test' | 'off';
  /** null when the package is off (nothing was attempted). */
  send(v: VoucherToSend): Promise<SendResult | null>;
}

export function createAccountingPackage(mode: 'test' | 'off'): AccountingPackage {
  return {
    mode,
    async send(v) {
      if (mode === 'off') return null;
      if (/^TEST-FAIL/i.test(v.debitLedger) || /^TEST-FAIL/i.test(v.creditLedger)) {
        return { ok: false, reason: 'Ledger not found in the company (test package)' };
      }
      return { ok: true, externalRef: `TEST-${randomBytes(5).toString('hex').toUpperCase()}` };
    },
  };
}

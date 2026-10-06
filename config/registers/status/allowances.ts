/**
 * Allowance grants (27.2 "allowance definition", SRS 10.2, 10.6; Q14 M13 recommendation). A grant is
 * Active while in force — before its credit and while the student can spend it — and Inactive once
 * it has expired or was cancelled before its credit (`ended_reason` says which). The allowance
 * wallet's own status is RC-02 (wallet.ts).
 */
import { NEW, type StatusDomain } from './types';

type Code = 'ACTIVE' | 'INACTIVE';

export const ALLOWANCE_GRANT: StatusDomain<Code> = {
  domain: 'allowance_grant',
  srsDomain: 'Allowance definition (allowance status)',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: 'active',
      labelKey: 'status.allowance_grant.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: 'in-active',
      labelKey: 'status.allowance_grant.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'ACTIVE',
      operation: 'issued (ALW-003); credited by the 00:05 job on its start date',
    },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation:
        'expired by the 00:05 job on its expiry date (the unspent balance returns), or cancelled before its credit (ALW-004)',
    },
  ],
};

export const ALLOWANCE_DOMAINS = [ALLOWANCE_GRANT] as const;

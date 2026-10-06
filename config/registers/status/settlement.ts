/**
 * Settlement (SRS 14; 27.2/27.3 adopted as registered): pending → approval_stage_1 (maker) →
 * approved (a different checker); rejected from either to failed. The payout UTR is an attribute of
 * approved (RNG-STL-052), not a status. A failed settlement's lines are collected again by the next
 * run, once (Q14 M17).
 */
import { NEW, type StatusDomain } from './types';

export const SETTLEMENT: StatusDomain<'PENDING' | 'APPROVAL_STAGE_1' | 'APPROVED' | 'FAILED'> = {
  domain: 'settlement',
  srsDomain: 'Settlement',
  rc: null,
  values: [
    {
      code: 'PENDING',
      registerValue: 'pending',
      labelKey: 'status.settlement.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'APPROVAL_STAGE_1',
      registerValue: 'approval_stage_1',
      labelKey: 'status.settlement.approval_stage_1',
      label: 'Stage-1 approved',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'APPROVED',
      registerValue: 'approved',
      labelKey: 'status.settlement.approved',
      label: 'Approved',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: 'failed',
      labelKey: 'status.settlement.failed',
      label: 'Failed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'the nightly settlement run (14.7)' },
    {
      from: 'PENDING',
      to: 'APPROVAL_STAGE_1',
      operation: 'stage-1 approval with remarks by the maker (STL-003)',
    },
    {
      from: 'APPROVAL_STAGE_1',
      to: 'APPROVED',
      operation: 'final approval with remarks by a checker other than the maker (STL-004)',
    },
    {
      from: 'PENDING',
      to: 'FAILED',
      operation: 'rejected with remarks (STL-005); its lines go to the next run once',
    },
    {
      from: 'APPROVAL_STAGE_1',
      to: 'FAILED',
      operation: 'rejected with remarks by someone who did not approve it (STL-005)',
    },
  ],
};

export const SETTLEMENT_DOMAINS = [SETTLEMENT] as const;

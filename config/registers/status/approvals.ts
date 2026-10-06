/**
 * Maker-checker registers (SRS 27.2 / 27.3 "Approval request (status)", adopted in docs/01c; RC-07
 * modules). A failed effect leaves the request PENDING with its effect error (27.3). Only the
 * Institution Administrator decides (client Q9, ADR-0015); platform-level requests (no institution)
 * are decided in the back office.
 */
import { NEW, type StatusDomain } from './types';

export type ApprovalRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export const APPROVAL_REQUEST: StatusDomain<ApprovalRequestStatus> = {
  domain: 'approval_request',
  srsDomain: 'Approval request (status)',
  rc: null,
  values: [
    {
      code: 'PENDING',
      registerValue: 'Pending',
      labelKey: 'status.approval_request.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'APPROVED',
      registerValue: 'Approved',
      labelKey: 'status.approval_request.approved',
      label: 'Approved',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'REJECTED',
      registerValue: 'Rejected',
      labelKey: 'status.approval_request.rejected',
      label: 'Rejected',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'maker raises a request (17.1)' },
    { from: 'PENDING', to: 'APPROVED', operation: 'checker approves; the effect runs (17.2)' },
    { from: 'PENDING', to: 'REJECTED', operation: 'checker rejects with remarks (17.2)' },
  ],
};

export const APPROVAL_DOMAINS = [APPROVAL_REQUEST] as const;

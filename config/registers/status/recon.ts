/**
 * Reconciliation (SRS 15.6; RC-19, RC-35). The legacy free numbers of the chargeback and refund
 * records are replaced by defined sets (OI-REC-06, adopted):
 * - refund: requested → processed (the ledger refund pair is posted; the customer is told) or
 *   rejected; the processor is never the requester;
 * - chargeback: raised → accepted or disputed → completed, with the outcome reversed (the money goes
 *   back, a ledger pair) or upheld (the dispute was won, nothing moves);
 * - mismatch (new, RC-35): open → resolved, with the resolution recorded.
 */
import { NEW, type StatusDomain } from './types';

export const REFUND: StatusDomain<'REQUESTED' | 'PROCESSED' | 'REJECTED'> = {
  domain: 'refund',
  srsDomain: 'Refund record',
  rc: 'RC-19',
  values: [
    {
      code: 'REQUESTED',
      registerValue: null,
      labelKey: 'status.refund.requested',
      label: 'Requested',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'PROCESSED',
      registerValue: null,
      labelKey: 'status.refund.processed',
      label: 'Processed',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'REJECTED',
      registerValue: null,
      labelKey: 'status.refund.rejected',
      label: 'Rejected',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'REQUESTED',
      operation:
        'a refund requested for a movement — by an officer (REC-018), a mismatch resolution (REC-004) or a grievance',
    },
    {
      from: 'REQUESTED',
      to: 'PROCESSED',
      operation:
        'processed by an officer other than the requester (REC-009): the ledger refund pair; the customer is told',
    },
    {
      from: 'REQUESTED',
      to: 'REJECTED',
      operation: 'rejected with remarks by an officer other than the requester (REC-009)',
    },
  ],
};

export const CHARGEBACK: StatusDomain<'RAISED' | 'ACCEPTED' | 'DISPUTED' | 'COMPLETED'> = {
  domain: 'chargeback',
  srsDomain: 'Chargeback transaction',
  rc: 'RC-19',
  values: [
    {
      code: 'RAISED',
      registerValue: null,
      labelKey: 'status.chargeback.raised',
      label: 'Raised',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'ACCEPTED',
      registerValue: null,
      labelKey: 'status.chargeback.accepted',
      label: 'Accepted',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'DISPUTED',
      registerValue: null,
      labelKey: 'status.chargeback.disputed',
      label: 'Disputed',
      tone: 'violet',
      terminal: false,
    },
    {
      code: 'COMPLETED',
      registerValue: null,
      labelKey: 'status.chargeback.completed',
      label: 'Completed',
      tone: 'ok',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'RAISED',
      operation: 'raised against a movement (REC-006), once per movement',
    },
    { from: 'RAISED', to: 'ACCEPTED', operation: 'accepted with remarks (REC-019)' },
    { from: 'RAISED', to: 'DISPUTED', operation: 'disputed with remarks (REC-019)' },
    {
      from: 'ACCEPTED',
      to: 'COMPLETED',
      operation: 'completed as reversed (REC-007): the ledger chargeback pair',
    },
    {
      from: 'DISPUTED',
      to: 'COMPLETED',
      operation:
        'completed (REC-007): reversed (the dispute was lost, the ledger pair) or upheld (nothing moves)',
    },
  ],
};

export const RECON_MISMATCH: StatusDomain<'OPEN' | 'RESOLVED'> = {
  domain: 'recon_mismatch',
  srsDomain: null,
  rc: 'RC-35',
  values: [
    {
      code: 'OPEN',
      registerValue: null,
      labelKey: 'status.reconMismatch.open',
      label: 'Open',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'RESOLVED',
      registerValue: null,
      labelKey: 'status.reconMismatch.resolved',
      label: 'Resolved',
      tone: 'ok',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'OPEN',
      operation: 'a statement upload finds a difference (REC-001)',
    },
    {
      from: 'OPEN',
      to: 'RESOLVED',
      operation:
        'resolved with remarks (REC-004: explained, refund, chargeback, adjusted), or found in a later statement',
    },
  ],
};

export const RECON_DOMAINS = [REFUND, CHARGEBACK, RECON_MISMATCH] as const;

/**
 * Grievances (SRS 16; RC-20, OI-GRV-04/10). A ticket is Open, Escalated to Vendor, Escalated
 * Internally, Resolved or Closed; "(any text)" is gone. Every change needs a comment, Closed is
 * read-only, and a Priority-1 change waits as an approval request — not as a ticket status. The
 * member may close a Resolved ticket. Channel app · web · phone.
 */
import { NEW, type StatusDomain } from './types';

export const TICKET: StatusDomain<
  'OPEN' | 'ESCALATED_VENDOR' | 'ESCALATED_INTERNAL' | 'RESOLVED' | 'CLOSED'
> = {
  domain: 'ticket',
  srsDomain: 'Ticket',
  rc: 'RC-20',
  values: [
    {
      code: 'OPEN',
      registerValue: 'Open',
      labelKey: 'status.ticket.open',
      label: 'Open',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'ESCALATED_VENDOR',
      registerValue: 'Escalated to Vendor',
      labelKey: 'status.ticket.escalated_vendor',
      label: 'Escalated to Vendor',
      tone: 'bad',
      terminal: false,
    },
    {
      code: 'ESCALATED_INTERNAL',
      registerValue: 'Escalated Internally',
      labelKey: 'status.ticket.escalated_internal',
      label: 'Escalated Internally',
      tone: 'bad',
      terminal: false,
    },
    {
      code: 'RESOLVED',
      registerValue: null,
      labelKey: 'status.ticket.resolved',
      label: 'Resolved',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'CLOSED',
      registerValue: 'Closed',
      labelKey: 'status.ticket.closed',
      label: 'Closed',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'OPEN',
      operation:
        'raised by a member from a receipt (GRV-001), feedback (GRV-004) or a fraud report (GRV-005)',
    },
    { from: 'OPEN', to: 'ESCALATED_VENDOR', operation: 'console update with a comment (GRV-008)' },
    {
      from: 'OPEN',
      to: 'ESCALATED_INTERNAL',
      operation: 'console update with a comment (GRV-008)',
    },
    {
      from: 'OPEN',
      to: 'RESOLVED',
      operation: 'console update with the resolution (GRV-008; Priority 1 on approval)',
    },
    {
      from: 'OPEN',
      to: 'CLOSED',
      operation: 'console update with the resolution (GRV-008; Priority 1 on approval)',
    },
    {
      from: 'ESCALATED_VENDOR',
      to: 'ESCALATED_INTERNAL',
      operation: 'console update with a comment (GRV-008)',
    },
    {
      from: 'ESCALATED_INTERNAL',
      to: 'ESCALATED_VENDOR',
      operation: 'console update with a comment (GRV-008)',
    },
    {
      from: 'ESCALATED_VENDOR',
      to: 'RESOLVED',
      operation: 'console update with the resolution (GRV-008)',
    },
    {
      from: 'ESCALATED_INTERNAL',
      to: 'RESOLVED',
      operation: 'console update with the resolution (GRV-008)',
    },
    {
      from: 'ESCALATED_VENDOR',
      to: 'CLOSED',
      operation: 'console update with the resolution (GRV-008)',
    },
    {
      from: 'ESCALATED_INTERNAL',
      to: 'CLOSED',
      operation: 'console update with the resolution (GRV-008)',
    },
    {
      from: 'RESOLVED',
      to: 'CLOSED',
      operation: 'closed by the member (GRV-014) or the console (GRV-008)',
    },
  ],
};

export const GRIEVANCE_DOMAINS = [TICKET] as const;

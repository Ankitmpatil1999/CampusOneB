/**
 * Paid events (27.2 "Event": 1 Active / 0 Inactive; SRS 13.7–13.8, 13.16) and entry passes (RC-15:
 * ACTIVE · AUTHORIZED · USED · EXPIRED · CANCELLED; SRS 9.7–9.9, OI-PAY-10). A pass "PENDING" is not
 * carried (RC-15).
 */
import { NEW, type StatusDomain } from './types';

export const EVENT: StatusDomain<'ACTIVE' | 'INACTIVE'> = {
  domain: 'event',
  srsDomain: 'Event',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.event.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.event.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'created (FEE-029); payable within its dates' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'switched off (FEE-030), or by the 23:50 job after its end date (OI-FEE-14)',
    },
    { from: 'INACTIVE', to: 'ACTIVE', operation: 'switched on (FEE-030)' },
  ],
};

export const ENTRY_PASS: StatusDomain<'ACTIVE' | 'AUTHORIZED' | 'USED' | 'EXPIRED' | 'CANCELLED'> =
  {
    domain: 'entry_pass',
    srsDomain: 'Entry pass (special QR)',
    rc: 'RC-15',
    values: [
      {
        code: 'ACTIVE',
        registerValue: 'ACTIVE',
        labelKey: 'status.entry_pass.active',
        label: 'Active',
        tone: 'ok',
        terminal: false,
      },
      {
        code: 'AUTHORIZED',
        registerValue: 'AUTHORIZED',
        labelKey: 'status.entry_pass.authorized',
        label: 'Authorised',
        tone: 'brand',
        terminal: false,
      },
      {
        code: 'USED',
        registerValue: 'USED',
        labelKey: 'status.entry_pass.used',
        label: 'Used',
        tone: 'info',
        terminal: true,
      },
      {
        code: 'EXPIRED',
        registerValue: 'EXPIRED',
        labelKey: 'status.entry_pass.expired',
        label: 'Expired',
        tone: 'neutral',
        terminal: true,
      },
      {
        code: 'CANCELLED',
        registerValue: 'CANCELLED',
        labelKey: 'status.entry_pass.cancelled',
        label: 'Cancelled',
        tone: 'bad',
        terminal: true,
      },
    ],
    transitions: [
      { from: NEW, to: 'ACTIVE', operation: 'issued (PAY-027)' },
      {
        from: 'ACTIVE',
        to: 'AUTHORIZED',
        operation: 'the holder authorises it on their phone (PAY-005)',
      },
      {
        from: 'AUTHORIZED',
        to: 'AUTHORIZED',
        operation: 'authorised again (a new window), or scanned with scans left (PAY-006)',
      },
      { from: 'AUTHORIZED', to: 'USED', operation: 'the last permitted scan (PAY-006)' },
      { from: 'ACTIVE', to: 'EXPIRED', operation: 'the 23:50 job after its day' },
      { from: 'AUTHORIZED', to: 'EXPIRED', operation: 'the 23:50 job after its day' },
      { from: 'ACTIVE', to: 'CANCELLED', operation: 'cancelled by the institution (PAY-028)' },
      { from: 'AUTHORIZED', to: 'CANCELLED', operation: 'cancelled by the institution (PAY-028)' },
    ],
  };

export const EVENT_DOMAINS = [EVENT, ENTRY_PASS] as const;

/**
 * Fee structures and fee records (SRS 13.19 CR-11, 13.3; OI-FEE-09 disposition B). Structure
 * versions are new with CR-11 (RC-31): Draft → Pending (with a checker) → Active → Superseded.
 * Fee records carry the stored lifecycle Due → Partially paid → Paid / Overdue (RC-32) instead of the
 * legacy processing flag; a cancelled record keeps its history.
 */
import { NEW, type StatusDomain } from './types';

export const FEE_STRUCTURE_VERSION: StatusDomain<'DRAFT' | 'PENDING' | 'ACTIVE' | 'SUPERSEDED'> = {
  domain: 'fee_structure_version',
  srsDomain: null,
  rc: 'RC-31',
  values: [
    {
      code: 'DRAFT',
      registerValue: null,
      labelKey: 'status.fee_structure_version.draft',
      label: 'Draft',
      tone: 'neutral',
      terminal: false,
    },
    {
      code: 'PENDING',
      registerValue: null,
      labelKey: 'status.fee_structure_version.pending',
      label: 'Pending approval',
      tone: 'violet',
      terminal: false,
    },
    {
      code: 'ACTIVE',
      registerValue: null,
      labelKey: 'status.fee_structure_version.active',
      label: 'Approved',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'SUPERSEDED',
      registerValue: null,
      labelKey: 'status.fee_structure_version.superseded',
      label: 'Superseded',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'DRAFT', operation: 'created or edited (FEE-004/005)' },
    { from: 'DRAFT', to: 'PENDING', operation: 'submitted for approval (FEE-006)' },
    { from: 'PENDING', to: 'DRAFT', operation: 'returned by the checker with remarks (MKR-003)' },
    {
      from: 'PENDING',
      to: 'ACTIVE',
      operation: 'approved by a checker, or applied directly by an administrator (ADR-0015)',
    },
    { from: 'ACTIVE', to: 'SUPERSEDED', operation: 'a newer version becomes active' },
  ],
};

export const FEE_RECORD: StatusDomain<'DUE' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED'> =
  {
    domain: 'fee_record',
    srsDomain: 'Fee record',
    rc: 'RC-32',
    values: [
      {
        code: 'DUE',
        registerValue: null,
        labelKey: 'status.fee_record.due',
        label: 'Due',
        tone: 'warn',
        terminal: false,
      },
      {
        code: 'PARTIALLY_PAID',
        registerValue: null,
        labelKey: 'status.fee_record.partially_paid',
        label: 'Partially paid',
        tone: 'info',
        terminal: false,
      },
      {
        code: 'PAID',
        registerValue: null,
        labelKey: 'status.fee_record.paid',
        label: 'Paid',
        tone: 'ok',
        terminal: true,
      },
      {
        code: 'OVERDUE',
        registerValue: null,
        labelKey: 'status.fee_record.overdue',
        label: 'Overdue',
        tone: 'bad',
        terminal: false,
      },
      {
        code: 'CANCELLED',
        registerValue: null,
        labelKey: 'status.fee_record.cancelled',
        label: 'Cancelled',
        tone: 'neutral',
        terminal: true,
      },
    ],
    transitions: [
      { from: NEW, to: 'DUE', operation: 'raised by an assignment, a manual entry or an upload' },
      {
        from: NEW,
        to: 'PAID',
        operation: 'uploaded as paid history: no collection, no posting (FR-FEE-03, OI-FEE-06)',
      },
      {
        from: 'OVERDUE',
        to: 'DUE',
        operation: 'an approved change moves the due date to today or later; the fine is lifted',
      },
      {
        from: 'OVERDUE',
        to: 'PARTIALLY_PAID',
        operation: 'an approved change moves the due date of a part-paid record to today or later',
      },
      { from: 'DUE', to: 'PARTIALLY_PAID', operation: 'a part collected' },
      {
        from: 'DUE',
        to: 'PAID',
        operation:
          'collected in full through the payment engine, or paid by the financing partner (FEE-026)',
      },
      {
        from: 'DUE',
        to: 'OVERDUE',
        operation: 'its due date passed unpaid (the late fine applies once)',
      },
      { from: 'PARTIALLY_PAID', to: 'PAID', operation: 'the rest collected' },
      { from: 'PARTIALLY_PAID', to: 'OVERDUE', operation: 'its due date passed with a balance' },
      { from: 'OVERDUE', to: 'PAID', operation: 'collected with the late fine' },
      { from: 'DUE', to: 'CANCELLED', operation: 'replaced by a migration or a re-assignment' },
    ],
  };

export const FEE_ASSIGNMENT: StatusDomain<'ACTIVE' | 'REPLACED'> = {
  domain: 'fee_assignment',
  srsDomain: null,
  rc: 'RC-31',
  values: [
    {
      code: 'ACTIVE',
      registerValue: null,
      labelKey: 'status.fee_assignment.active',
      label: 'Assigned',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'REPLACED',
      registerValue: null,
      labelKey: 'status.fee_assignment.replaced',
      label: 'Replaced',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'a structure version assigned to the student (FEE-007)' },
    { from: 'ACTIVE', to: 'REPLACED', operation: 'migrated or re-assigned through approval' },
  ],
};

/**
 * A student's fee-financing registration (13.11–13.12, OQ-03; RC-33). "Not registered" is the
 * absence of a live registration, so it isn't stored; a failed one may be followed by a new one.
 */
export const FEE_FINANCING: StatusDomain<'PENDING' | 'SUCCESS' | 'FAILED'> = {
  domain: 'fee_financing',
  srsDomain: 'Fee financing registration',
  rc: 'RC-33',
  values: [
    {
      code: 'PENDING',
      registerValue: null,
      labelKey: 'status.fee_financing.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'SUCCESS',
      registerValue: null,
      labelKey: 'status.fee_financing.success',
      label: 'Success',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: null,
      labelKey: 'status.fee_financing.failed',
      label: 'Failed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PENDING',
      operation: 'registered by the institution (FEE-025) or asked for by the family (FEE-042)',
    },
    { from: 'PENDING', to: 'SUCCESS', operation: 'the partner approves (FEE-026)' },
    { from: 'PENDING', to: 'FAILED', operation: 'the partner rejects, with its reason (FEE-026)' },
  ],
};

export const FEE_DOMAINS = [
  FEE_STRUCTURE_VERSION,
  FEE_RECORD,
  FEE_ASSIGNMENT,
  FEE_FINANCING,
] as const;

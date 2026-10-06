/**
 * Admissions (SRS 19; 27.2/27.3 §19; RC-21, RC-34). The application lifecycle is Draft → Submitted →
 * Approved / Rejected (RC-21: Rejected is now written by a reject action; Verified and the counsellor
 * status are not carried). Admission payments carry the reduced set PENDING · PAID · FAILED; a failed
 * online attempt reopens as PENDING with a new order (RC-34). An admission link is the 27.2 admission
 * QR record: one Active per institution, earlier ones kept as Replaced history (RC-34).
 */
import { NEW, type StatusDomain } from './types';

export const ADMISSION_APPLICATION: StatusDomain<'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'> =
  {
    domain: 'admission_application',
    srsDomain: 'Admission application (application status)',
    rc: 'RC-21',
    values: [
      {
        code: 'DRAFT',
        registerValue: 'Draft',
        labelKey: 'status.admission_application.draft',
        label: 'Draft',
        tone: 'neutral',
        terminal: false,
      },
      {
        code: 'SUBMITTED',
        registerValue: 'Submitted',
        labelKey: 'status.admission_application.submitted',
        label: 'Submitted',
        tone: 'info',
        terminal: false,
      },
      {
        code: 'APPROVED',
        registerValue: 'Approved',
        labelKey: 'status.admission_application.approved',
        label: 'Approved',
        tone: 'ok',
        terminal: true,
      },
      {
        code: 'REJECTED',
        registerValue: 'Rejected',
        labelKey: 'status.admission_application.rejected',
        label: 'Rejected',
        tone: 'bad',
        terminal: true,
      },
    ],
    transitions: [
      {
        from: NEW,
        to: 'DRAFT',
        operation: 'started on the public form (ADM-004) or by a counsellor (ADM-015)',
      },
      {
        from: NEW,
        to: 'APPROVED',
        operation: 'an existing student imported with the member created (ADM-020)',
      },
      {
        from: 'DRAFT',
        to: 'SUBMITTED',
        operation:
          'submitted with the declaration: at once when no application fee is due, or when it is paid (ADM-009/011, ADM-022)',
      },
      {
        from: 'SUBMITTED',
        to: 'APPROVED',
        operation: 'approved: member, wallets, links and enrolment created together (ADM-018)',
      },
      { from: 'SUBMITTED', to: 'REJECTED', operation: 'rejected with a reason (ADM-019)' },
    ],
  };

export const ADMISSION_PAYMENT: StatusDomain<'PENDING' | 'PAID' | 'FAILED'> = {
  domain: 'admission_payment',
  srsDomain: 'Admission payment (payment status)',
  rc: 'RC-34',
  values: [
    {
      code: 'PENDING',
      registerValue: 'PENDING',
      labelKey: 'status.admission_payment.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'PAID',
      registerValue: 'PAID',
      labelKey: 'status.admission_payment.paid',
      label: 'Paid',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: 'FAILED',
      labelKey: 'status.admission_payment.failed',
      label: 'Failed',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PENDING',
      operation:
        'the fee row created with the application or on first collection (ADM-009, ADM-022)',
    },
    {
      from: 'PENDING',
      to: 'PAID',
      operation: 'cash recorded (ADM-022) or the gateway payment verified (ADM-011)',
    },
    { from: 'PENDING', to: 'FAILED', operation: 'the gateway payment refused at verification' },
    { from: 'FAILED', to: 'PENDING', operation: 'a new order for another try (ADM-010)' },
    { from: 'FAILED', to: 'PAID', operation: 'cash recorded after a failed online try (ADM-022)' },
  ],
};

export const ADMISSION_LINK: StatusDomain<'ACTIVE' | 'REPLACED'> = {
  domain: 'admission_link',
  srsDomain: 'Admission QR record (status)',
  rc: 'RC-34',
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.admission_link.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'REPLACED',
      registerValue: null,
      labelKey: 'status.admission_link.replaced',
      label: 'Replaced',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'generated in the console (INS-028)' },
    {
      from: 'ACTIVE',
      to: 'REPLACED',
      operation: 'a new link generated: the old one stops working and stays as history (INS-028)',
    },
  ],
};

export const ADMISSION_DOMAINS = [
  ADMISSION_APPLICATION,
  ADMISSION_PAYMENT,
  ADMISSION_LINK,
] as const;

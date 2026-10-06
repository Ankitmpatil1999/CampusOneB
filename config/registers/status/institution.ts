/**
 * Institution (status) — 27.2 §7 holds `1` (Active) and `0` (Inactive, never written).
 * Register change RC-08 (FR-INS-05, RNG-SAS-014/017…019, OI-SAS-04): Pending activation · Active ·
 * Suspended · Cancelled. A trial is a subscription state (RNG-SAS-009), not an institution state.
 */
import { NEW, type StatusDomain } from './types';

export type InstitutionStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';

export const INSTITUTION: StatusDomain<InstitutionStatus> = {
  domain: 'institution',
  srsDomain: 'Institution (status)',
  rc: 'RC-08',
  values: [
    {
      code: 'PENDING_ACTIVATION',
      registerValue: null,
      labelKey: 'status.institution.pending_activation',
      label: 'Pending activation',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.institution.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'SUSPENDED',
      registerValue: null,
      labelKey: 'status.institution.suspended',
      label: 'Suspended',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'CANCELLED',
      registerValue: null,
      labelKey: 'status.institution.cancelled',
      label: 'Cancelled',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING_ACTIVATION', operation: 'operator registers the institution (7.4)' },
    {
      from: 'PENDING_ACTIVATION',
      to: 'ACTIVE',
      operation: 'activation once the onboarding checklist is complete (RNG-SAS-018)',
    },
    { from: 'ACTIVE', to: 'SUSPENDED', operation: 'grace ended unpaid, or operator suspends' },
    { from: 'SUSPENDED', to: 'ACTIVE', operation: 'invoice paid, or operator reactivates' },
    { from: 'PENDING_ACTIVATION', to: 'CANCELLED', operation: 'operator cancels with a reason' },
    { from: 'ACTIVE', to: 'CANCELLED', operation: 'operator cancels with a reason' },
    { from: 'SUSPENDED', to: 'CANCELLED', operation: 'operator cancels with a reason' },
  ],
};

export type OnboardingStepStatus = 'PENDING' | 'COMPLETE';

/** Onboarding checklist item — register change RC-10 (RNG-SAS-017/018). A stored row = Complete. */
export const ONBOARDING_STEP: StatusDomain<OnboardingStepStatus> = {
  domain: 'onboarding_step',
  srsDomain: null,
  rc: 'RC-10',
  values: [
    {
      code: 'PENDING',
      registerValue: null,
      labelKey: 'status.onboarding_step.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'COMPLETE',
      registerValue: null,
      labelKey: 'status.onboarding_step.complete',
      label: 'Complete',
      tone: 'ok',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'institution registered (every step starts pending)' },
    {
      from: 'PENDING',
      to: 'COMPLETE',
      operation: "the step's screen saves valid data, or the operator marks it done",
    },
  ],
};

export type CustomFieldStatus = 'ACTIVE' | 'INACTIVE';

/** Institution-defined field definition — register change RC-11 (CR-12, RNG-ONB-111/112). */
export const CUSTOM_FIELD: StatusDomain<CustomFieldStatus> = {
  domain: 'custom_field',
  srsDomain: null,
  rc: 'RC-11',
  values: [
    {
      code: 'ACTIVE',
      registerValue: null,
      labelKey: 'status.custom_field.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: null,
      labelKey: 'status.custom_field.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'Institution Administrator defines the field' },
    {
      from: NEW,
      to: 'INACTIVE',
      operation: 'Institution Administrator defines the field inactive',
    },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'Institution Administrator deactivates (values kept)',
    },
    {
      from: 'INACTIVE',
      to: 'ACTIVE',
      operation: 'Institution Administrator reactivates (within the limit)',
    },
  ],
};

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'GRACE' | 'SUSPENDED' | 'CANCELLED';

/**
 * Subscription — register change RC-09 (RNG-SAS-009…015; Q14 · M14 defaults). Before the trial or
 * activation starts a period, the subscription only records the chosen plan (no status).
 */
export const SUBSCRIPTION: StatusDomain<SubscriptionStatus> = {
  domain: 'subscription',
  srsDomain: null,
  rc: 'RC-09',
  values: [
    {
      code: 'TRIAL',
      registerValue: null,
      labelKey: 'status.subscription.trial',
      label: 'Trial',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'ACTIVE',
      registerValue: null,
      labelKey: 'status.subscription.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'GRACE',
      registerValue: null,
      labelKey: 'status.subscription.grace',
      label: 'Grace',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'SUSPENDED',
      registerValue: null,
      labelKey: 'status.subscription.suspended',
      label: 'Suspended',
      tone: 'bad',
      terminal: false,
    },
    {
      code: 'CANCELLED',
      registerValue: null,
      labelKey: 'status.subscription.cancelled',
      label: 'Cancelled',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'TRIAL', operation: 'operator starts the trial (onboarding complete)' },
    { from: NEW, to: 'ACTIVE', operation: 'operator activates; the first cycle is invoiced' },
    {
      from: 'TRIAL',
      to: 'ACTIVE',
      operation: 'trial converts on activation; the first cycle is invoiced',
    },
    { from: 'ACTIVE', to: 'GRACE', operation: 'renewal invoice unpaid after its due date' },
    { from: 'GRACE', to: 'ACTIVE', operation: 'invoice paid' },
    { from: 'TRIAL', to: 'SUSPENDED', operation: 'operator suspends' },
    { from: 'ACTIVE', to: 'SUSPENDED', operation: 'operator suspends, or grace ends unpaid' },
    { from: 'GRACE', to: 'SUSPENDED', operation: 'grace ends unpaid' },
    { from: 'SUSPENDED', to: 'ACTIVE', operation: 'invoice paid, or operator reactivates' },
    { from: 'TRIAL', to: 'CANCELLED', operation: 'operator cancels with a reason' },
    { from: 'ACTIVE', to: 'CANCELLED', operation: 'operator cancels with a reason' },
    { from: 'GRACE', to: 'CANCELLED', operation: 'operator cancels with a reason' },
    { from: 'SUSPENDED', to: 'CANCELLED', operation: 'operator cancels with a reason' },
  ],
};

export type InvoiceStatus = 'DRAFT' | 'DUE' | 'GRACE' | 'OVERDUE' | 'PAID' | 'VOID';

/** Invoice — register change RC-09 (FR-SAS-07/08). Grace and Overdue follow the due date. */
export const INVOICE: StatusDomain<InvoiceStatus> = {
  domain: 'invoice',
  srsDomain: null,
  rc: 'RC-09',
  values: [
    {
      code: 'DRAFT',
      registerValue: null,
      labelKey: 'status.invoice.draft',
      label: 'Draft',
      tone: 'neutral',
      terminal: false,
    },
    {
      code: 'DUE',
      registerValue: null,
      labelKey: 'status.invoice.due',
      label: 'Due',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'GRACE',
      registerValue: null,
      labelKey: 'status.invoice.grace',
      label: 'Grace',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'OVERDUE',
      registerValue: null,
      labelKey: 'status.invoice.overdue',
      label: 'Overdue',
      tone: 'bad',
      terminal: false,
    },
    {
      code: 'PAID',
      registerValue: null,
      labelKey: 'status.invoice.paid',
      label: 'Paid',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'VOID',
      registerValue: null,
      labelKey: 'status.invoice.void',
      label: 'Void',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'DUE',
      operation: 'invoice issued (activation, renewal, plan change, overage or by an operator)',
    },
    { from: NEW, to: 'DRAFT', operation: 'invoice prepared, not yet issued' },
    { from: 'DRAFT', to: 'DUE', operation: 'invoice issued' },
    { from: 'DUE', to: 'GRACE', operation: 'the due date passes unpaid' },
    { from: 'GRACE', to: 'OVERDUE', operation: 'the grace period ends unpaid' },
    { from: 'DUE', to: 'PAID', operation: 'payment received' },
    { from: 'GRACE', to: 'PAID', operation: 'payment received' },
    { from: 'OVERDUE', to: 'PAID', operation: 'payment received' },
    { from: 'DRAFT', to: 'VOID', operation: 'operator voids with a reason' },
    { from: 'DUE', to: 'VOID', operation: 'operator voids with a reason' },
  ],
};

export type PlanChangeRequestStatus = 'PENDING' | 'APPLIED' | 'DECLINED' | 'WITHDRAWN';

/** RC-09 (SaaS): an institution's request for another plan (prototype c.subscription). */
export const PLAN_CHANGE_REQUEST: StatusDomain<PlanChangeRequestStatus> = {
  domain: 'plan_change_request',
  srsDomain: null,
  rc: 'RC-09',
  values: [
    {
      code: 'PENDING',
      registerValue: null,
      labelKey: 'status.plan_change_request.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'APPLIED',
      registerValue: null,
      labelKey: 'status.plan_change_request.applied',
      label: 'Applied',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'DECLINED',
      registerValue: null,
      labelKey: 'status.plan_change_request.declined',
      label: 'Declined',
      tone: 'bad',
      terminal: true,
    },
    {
      code: 'WITHDRAWN',
      registerValue: null,
      labelKey: 'status.plan_change_request.withdrawn',
      label: 'Withdrawn',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'Institution Administrator requests a plan change' },
    {
      from: 'PENDING',
      to: 'APPLIED',
      operation: 'platform administrator changes the plan (now or at renewal)',
    },
    { from: 'PENDING', to: 'DECLINED', operation: 'platform administrator declines with a reason' },
    { from: 'PENDING', to: 'WITHDRAWN', operation: 'Institution Administrator withdraws it' },
  ],
};

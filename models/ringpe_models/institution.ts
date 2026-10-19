/** Institutions, plans, features, departments and institution-defined fields (migration 0014). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** A column with a database default: optional on insert. */
type WithDefault<T> = ColumnType<T, T | undefined, T>;
type DateOnly = ColumnType<string, string | undefined, string>;

export type InstitutionStatusCode = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';

export interface InstitutionsTable {
  id: Generated<string>;
  public_id: Buffer;
  identifier: string;
  name: string;
  short_name: string;
  board: string | null;
  /** 0024: how it signed up and how it wants to start (customer portal). */
  signup_source: WithDefault<'OPERATOR' | 'PORTAL'>;
  start_preference: 'TRIAL' | 'PAY' | null;
  students_estimate: number | null;
  terms_version: string | null;
  terms_accepted_at: Timestamp | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string | null;
  pin_code: string | null;
  office_phone: string | null;
  office_email: string | null;
  time_zone: WithDefault<string>;
  status: WithDefault<InstitutionStatusCode>;
  suspended_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  corporate_code: string | null;
  pool_account_ref: string | null;
  shadow_account_ref: string | null;
  fee_merchant_profile_id: Ref | null;
  name_address_key: string;
  row_version: Generated<number>;
  created_at: Timestamp;
  created_by: Buffer | null;
  updated_at: Timestamp;
  updated_by: Buffer | null;
}

export interface InstitutionLifecycleEventsTable {
  id: Generated<string>;
  institution_id: Ref;
  action: string;
  from_status: string | null;
  to_status: string | null;
  reason: string;
  actor_ref: Buffer | null;
  occurred_at: Timestamp;
  notified_at: Timestamp | null;
  created_at: Timestamp;
}

export interface InstitutionContactsTable {
  institution_id: Ref;
  kind: 'PRIMARY' | 'SECONDARY';
  name: string;
  email: string | null;
  mobile_enc: Buffer | null;
  mobile_last4: string | null;
  updated_at: Timestamp;
}

export interface InstitutionSettingsTable {
  institution_id: Ref;
  consent_validity_months: WithDefault<number>;
  logo_file_id: Ref | null;
  brand_color: string | null;
  updated_at: Timestamp;
}

export interface FeatureTogglesTable {
  institution_id: Ref;
  feature_key: string;
  enabled: WithDefault<number | boolean>;
  updated_at: Timestamp;
}

export interface NotificationChannelSettingsTable {
  institution_id: Ref;
  channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'WHATSAPP';
  enabled: number | boolean;
  updated_at: Timestamp;
}

export interface FeatureChangeLogTable {
  id: Generated<string>;
  institution_id: Ref;
  feature_key: string;
  from_value: number | boolean;
  to_value: number | boolean;
  reason: string | null;
  actor_ref: Buffer | null;
  changed_at: Timestamp;
}

export interface OnboardingChecklistStepsTable {
  institution_id: Ref;
  step_key: string;
  done_at: Timestamp;
  done_by: Buffer | null;
  note: string | null;
}

export interface PlansTable {
  id: Generated<number>;
  public_id: Buffer;
  code: string;
  name: string;
  description: string | null;
  current_version_id: number | null;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** The terms of a plan at one version (append-only, migration 0015). */
export interface PlanVersionsTable {
  id: Generated<number>;
  plan_id: number;
  version: number;
  cycle: 'MONTHLY' | 'ANNUAL';
  price_paise: string | number;
  trial_days: number;
  members: number;
  sms_per_month: number;
  whatsapp_per_month: number;
  storage_gb: number;
  fee_flat_paise: string | number;
  fee_threshold_paise: string | number;
  fee_percent_bp: number;
  created_at: Timestamp;
  created_by: Buffer | null;
}

export interface PlanVersionModulesTable {
  plan_version_id: number;
  module_key: string;
}

export interface SubscriptionsTable {
  institution_id: Ref;
  plan_id: number;
  plan_version_id: number;
  /** The version the next period takes (a change that waits for renewal; migration 0018). */
  scheduled_plan_version_id: number | null;
  scheduled_at: Timestamp | null;
  scheduled_by: Buffer | null;
  status: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'SUSPENDED' | 'CANCELLED' | null;
  trial_ends_on: DateOnly | null;
  current_period_start_on: DateOnly | null;
  current_period_end_on: DateOnly | null;
  renews_on: DateOnly | null;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DepartmentsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  user_type_id: Ref;
  name: string;
  created_at: Timestamp;
}

export type CfEntityCode = 'MEMBER' | 'FEE_STRUCTURE' | 'ADMISSION_APPLICATION' | 'MERCHANT';
export type CfTypeCode =
  | 'TEXT'
  | 'LONG_TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'DROPDOWN'
  | 'MULTI_SELECT'
  | 'YES_NO'
  | 'EMAIL'
  | 'PHONE';

export interface CustomFieldDefinitionsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  entity: CfEntityCode;
  label: string;
  data_type: CfTypeCode;
  is_required: WithDefault<number | boolean>;
  is_unique: WithDefault<number | boolean>;
  list_column: WithDefault<number | boolean>;
  filterable: WithDefault<number | boolean>;
  position: number;
  status: WithDefault<'ACTIVE' | 'INACTIVE'>;
  no_id_doc_ack_at: Timestamp;
  deactivated_at: Timestamp | null;
  created_by: Buffer | null;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CustomFieldOptionsTable {
  id: Generated<string>;
  institution_id: Ref;
  field_id: Ref;
  label: string;
  position: number;
  active: WithDefault<number | boolean>;
}

export interface CustomFieldValuesTable {
  id: Generated<string>;
  institution_id: Ref;
  field_id: Ref;
  entity_ref: Buffer;
  value_text: string | null;
  value_number: string | null;
  value_date: DateOnly | null;
  value_bool: number | boolean | null;
  unique_key: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Selected options of a Dropdown / Multi-select value (migration 0014). */
export interface CustomFieldValueOptionsTable {
  value_id: Ref;
  option_id: Ref;
}

export type InvoiceStatusCode = 'DRAFT' | 'DUE' | 'GRACE' | 'OVERDUE' | 'PAID' | 'VOID';
export type InvoiceTrigger =
  'PLAN_ACTIVATION' | 'RENEWAL' | 'PLAN_CHANGE' | 'USAGE_OVERAGE' | 'MANUAL';

export interface InvoicesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  invoice_no: string;
  trigger_kind: InvoiceTrigger;
  period_key: string;
  period_label: string;
  period_from_on: DateOnly | null;
  period_to_on: DateOnly | null;
  amount_paise: string | number;
  tax_bp: number;
  tax_paise: string | number;
  total_paise: string | number;
  issued_on: DateOnly;
  due_on: DateOnly;
  grace_until_on: DateOnly;
  status: WithDefault<InvoiceStatusCode>;
  /** Reminders sent by the billing run: 0 none · 1 grace started · 2 grace ended (0018). */
  reminder_stage: WithDefault<number>;
  paid_at: Timestamp | null;
  /** A bank transfer reported by the institution, waiting for confirmation (0018). */
  transfer_utr: string | null;
  transfer_paid_on: DateOnly | null;
  transfer_reported_at: Timestamp | null;
  transfer_reported_by: Buffer | null;
  row_version: Generated<number>;
  created_at: Timestamp;
  created_by: Buffer | null;
  updated_at: Timestamp;
}

/** RingPe's invoice and bank details (one row, migration 0019; example values until Q25/Q26). */
export interface PlatformBillingProfileTable {
  id: number;
  legal_name: string;
  gstin: string;
  address: string;
  state_code: string;
  sac_code: string;
  payee_name: string;
  payee_bank: string;
  payee_account_no: string;
  payee_ifsc: string;
  is_example: number | boolean;
  row_version: Generated<number>;
  updated_at: Timestamp;
  updated_by: Buffer | null;
}

export type PlanChangeRequestStatus = 'PENDING' | 'APPLIED' | 'DECLINED' | 'WITHDRAWN';

/** An institution's request for another plan (prototype c.subscription; migration 0018). */
export interface PlanChangeRequestsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  plan_id: number;
  timing: 'RENEWAL' | 'NOW';
  note: string | null;
  status: WithDefault<PlanChangeRequestStatus>;
  requested_by: Buffer;
  requested_at: Timestamp;
  resolved_by: Buffer | null;
  resolved_at: Timestamp | null;
  resolution: string | null;
  row_version: Generated<number>;
}

export interface InvoiceLinesTable {
  id: Generated<string>;
  institution_id: Ref;
  invoice_id: Ref;
  description: string;
  quantity: number;
  unit_price_paise: string | number;
  amount_paise: string | number;
}

export interface InvoicePaymentsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  invoice_id: Ref;
  method: 'BANK_TRANSFER' | 'GATEWAY';
  utr: string | null;
  amount_paise: string | number;
  paid_on: DateOnly;
  recorded_by: Buffer | null;
  created_at: Timestamp;
}

export type DataExportState = 'REQUESTED' | 'RUNNING' | 'READY' | 'EXPIRED' | 'FAILED';

/** A full data export (0024/0025; FR-SAS-04, RC-26 data_export). */
export interface DataExportsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  scope: WithDefault<'ALL'>;
  status: WithDefault<DataExportState>;
  file_id: Ref | null;
  row_counts: ColumnType<unknown, string | null, string | null>;
  requested_by: Buffer;
  requested_at: Timestamp;
  ready_at: Timestamp | null;
  expires_at: Timestamp | null;
  error_code: string | null;
  running_key: ColumnType<string | null, never, never>;
}

export type CancellationStatus = 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'WITHDRAWN';

/** A cancellation the institution asked for (0024; FR-SAS-04, OQ-30, RC-27). */
export interface CancellationRequestsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  effective_on: DateOnly;
  reason: string;
  status: WithDefault<CancellationStatus>;
  requested_by: Buffer;
  requested_at: Timestamp;
  resolved_by: Buffer | null;
  resolved_at: Timestamp | null;
  resolution: string | null;
  row_version: Generated<number>;
  open_key: ColumnType<string | null, never, never>;
}

/** A school's corporate codes, one per bank account it collects into (migration 0073). */
export interface InstitutionCorporateCodesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  bank_name: string | null;
  ifsc: string | null;
  corporate_code: string;
  pool_account_ref: string | null;
  status: WithDefault<'ACTIVE' | 'DISABLED'>;
  is_default: WithDefault<number | boolean>;
  default_key: ColumnType<string | null, never, never>;
  row_version: Generated<number>;
  created_by: Buffer | null;
  updated_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** The code a whole class's VANs use (migration 0073). */
export interface ClassCorporateCodesTable {
  class_id: Ref;
  institution_id: Ref;
  corporate_code_id: Ref;
  updated_by: Buffer | null;
  updated_at: Timestamp;
}

export interface InstitutionTables {
  institution_corporate_codes: InstitutionCorporateCodesTable;
  class_corporate_codes: ClassCorporateCodesTable;
  data_exports: DataExportsTable;
  cancellation_requests: CancellationRequestsTable;
  invoices: InvoicesTable;
  plan_change_requests: PlanChangeRequestsTable;
  platform_billing_profile: PlatformBillingProfileTable;
  invoice_lines: InvoiceLinesTable;
  invoice_payments: InvoicePaymentsTable;
  institutions: InstitutionsTable;
  institution_lifecycle_events: InstitutionLifecycleEventsTable;
  institution_contacts: InstitutionContactsTable;
  institution_settings: InstitutionSettingsTable;
  feature_toggles: FeatureTogglesTable;
  notification_channel_settings: NotificationChannelSettingsTable;
  feature_change_log: FeatureChangeLogTable;
  onboarding_checklist_steps: OnboardingChecklistStepsTable;
  plans: PlansTable;
  plan_versions: PlanVersionsTable;
  plan_version_modules: PlanVersionModulesTable;
  subscriptions: SubscriptionsTable;
  departments: DepartmentsTable;
  custom_field_definitions: CustomFieldDefinitionsTable;
  custom_field_options: CustomFieldOptionsTable;
  custom_field_values: CustomFieldValuesTable;
  custom_field_value_options: CustomFieldValueOptionsTable;
}

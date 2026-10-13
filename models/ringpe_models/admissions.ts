/** Admissions (migration 0043; SRS 7.8, 19; RC-21, RC-34). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Paise = ColumnType<string, number | string, number | string>;
type Flag = ColumnType<number, number | boolean | undefined, number | boolean>;
type NullableDate = ColumnType<Date | string | null, string | null | undefined, string | null>;
type Json<T> = ColumnType<T, string, string>;

export type ApplicationStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export type AdmissionPaymentStatus = 'PENDING' | 'PAID' | 'FAILED';
/** An application's fees together (migration 0067). */
export type AdmissionPaymentState = 'PENDING' | 'PAID' | 'CONFIRMED';
export type AdmissionFeeType = 'APPLICATION' | 'ADMISSION';
type CardSide = 'AADHAAR_FRONT' | 'AADHAAR_BACK' | 'PAN_FRONT' | 'PAN_BACK';
/**
 * With the Aadhaar and PAN cards, front and back: the student's (0071), the father's, the mother's,
 * a guardian's and the local guardian's (0072). PRIMARY_* (0071) is no longer written: 0072 moved
 * those to the person who was the primary contact.
 */
export type AdmissionDocType =
  | 'PHOTO'
  | 'BIRTH'
  | 'ADDRESS'
  | 'REPORT'
  | 'TC'
  | 'OTHER'
  | `${'STUDENT' | 'PRIMARY' | 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'LOCAL_GUARDIAN'}_${CardSide}`;

export interface AdmissionLinksTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  token: string;
  year_id: Ref | null;
  status: ColumnType<
    'ACTIVE' | 'REPLACED',
    'ACTIVE' | 'REPLACED' | undefined,
    'ACTIVE' | 'REPLACED'
  >;
  expires_at: NullableTimestamp;
  created_by: Buffer | null;
  created_at: Timestamp;
  replaced_at: NullableTimestamp;
  live_key: ColumnType<string | null, never, never>;
}

export interface AdmissionApplicationsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  application_no: string;
  source: 'PUBLIC' | 'COUNSELLOR' | 'IMPORT';
  status: ColumnType<ApplicationStatus, ApplicationStatus | undefined, ApplicationStatus>;
  year_id: Ref;
  class_id: Ref | null;
  section_id: Ref | null;
  mid_term: Flag;
  joining_date: NullableDate;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  dob: NullableDate;
  id_number_enc: Buffer | null;
  id_number_bidx: Buffer | null;
  id_number_last4: string | null;
  /** Migration 0069: the student's Aadhaar and PAN, encrypted; last four in clear. */
  student_aadhaar_enc: Buffer | null;
  student_aadhaar_bidx: Buffer | null;
  student_aadhaar_last4: string | null;
  student_pan_enc: Buffer | null;
  student_pan_last4: string | null;
  primary_name: string | null;
  primary_relation: 'FATHER' | 'MOTHER' | 'GUARDIAN' | null;
  primary_mobile: string | null;
  primary_email: string | null;
  /** Migration 0069: the primary contact's Aadhaar and PAN — no longer written (0072). */
  primary_aadhaar_enc: Buffer | null;
  primary_aadhaar_last4: string | null;
  primary_pan_enc: Buffer | null;
  primary_pan_last4: string | null;
  /** Migration 0072: each person's Aadhaar and PAN, encrypted; last four in clear. */
  father_aadhaar_enc: Buffer | null;
  father_aadhaar_last4: string | null;
  father_pan_enc: Buffer | null;
  father_pan_last4: string | null;
  mother_aadhaar_enc: Buffer | null;
  mother_aadhaar_last4: string | null;
  mother_pan_enc: Buffer | null;
  mother_pan_last4: string | null;
  guardian_aadhaar_enc: Buffer | null;
  guardian_aadhaar_last4: string | null;
  guardian_pan_enc: Buffer | null;
  guardian_pan_last4: string | null;
  local_guardian_aadhaar_enc: Buffer | null;
  local_guardian_aadhaar_last4: string | null;
  local_guardian_pan_enc: Buffer | null;
  local_guardian_pan_last4: string | null;
  data: Json<unknown>;
  step: ColumnType<number, number | undefined, number>;
  tc_mode: 'TC' | 'UNDERTAKING' | null;
  tc_number: string | null;
  tc_date: NullableDate;
  tc_due: NullableDate;
  declared_at: NullableTimestamp;
  declared_by: string | null;
  /** Migration 0069: the family agreed to their details registering a RingPe account. */
  registration_consent_at: NullableTimestamp;
  submitted_at: NullableTimestamp;
  decided_at: NullableTimestamp;
  decided_by: Buffer | null;
  rejection_reason: string | null;
  rejection_remarks: string | null;
  admission_no: string | null;
  member_profile_id: Ref | null;
  /** Migration 0067: every fee paid → PAID; every fee confirmed by Accounts (or none) → CONFIRMED. */
  payment_status: ColumnType<
    AdmissionPaymentState,
    AdmissionPaymentState | undefined,
    AdmissionPaymentState
  >;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AdmissionApplicationSeqTable {
  institution_id: Ref;
  year_number: number;
  last_no: number;
}

export interface AdmissionReferencesTable {
  id: Generated<string>;
  public_id: Buffer;
  application_id: Ref;
  name: string;
  relation: string | null;
  mobile: string;
  email: string | null;
  created_at: Timestamp;
}

export interface AdmissionDocumentsTable {
  application_id: Ref;
  doc_type: AdmissionDocType;
  file_id: Ref;
  added_at: Timestamp;
}

export interface AdmissionPaymentsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  application_id: Ref;
  fee_type: AdmissionFeeType;
  amount_paise: Paise;
  status: ColumnType<
    AdmissionPaymentStatus,
    AdmissionPaymentStatus | undefined,
    AdmissionPaymentStatus
  >;
  mode: 'ONLINE' | 'CASH' | null;
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  /** The school gateway the payment was taken with (0065); null = RingPe's own or the test checkout. */
  gateway_id: ColumnType<Ref | null, Ref | null | undefined, Ref | null>;
  link_token_hash: Buffer | null;
  receipt_no: string | null;
  paid_by: string | null;
  collected_by: Buffer | null;
  paid_at: NullableTimestamp;
  /** Migration 0067: Accounts confirmed the receipt (and who). */
  confirmed_at: NullableTimestamp;
  confirmed_by: Buffer | null;
  failure_reason: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Generated<number>;
}

export interface AdmissionImportsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  file_name: string;
  rows_total: number;
  rows_imported: number;
  rows_rejected: number;
  report: Json<unknown>;
  created_by: Buffer | null;
  created_at: Timestamp;
}

/** A school's own payment gateway account (0065, client 2026-10-09); credentials encrypted. */
export interface InstitutionPaymentGatewaysTable {
  id: Generated<Ref>;
  public_id: Buffer;
  institution_id: Ref;
  provider: string;
  label: string;
  key_id_enc: Buffer;
  key_secret_enc: Buffer;
  webhook_secret_enc: Buffer | null;
  merchant_id_enc: Buffer | null;
  key_id_hint: string;
  environment: 'TEST' | 'LIVE';
  status: Generated<'ACTIVE' | 'DISABLED'>;
  is_default: Generated<boolean | number>;
  default_key: ColumnType<Ref | null, never, never>;
  last_checked_at: Date | null;
  last_check_ok: boolean | number | null;
  last_check_note: string | null;
  row_version: Generated<number>;
  created_by: Buffer | null;
  updated_by: Buffer | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AdmissionTables {
  institution_payment_gateways: InstitutionPaymentGatewaysTable;
  admission_links: AdmissionLinksTable;
  admission_applications: AdmissionApplicationsTable;
  admission_application_seq: AdmissionApplicationSeqTable;
  admission_references: AdmissionReferencesTable;
  admission_documents: AdmissionDocumentsTable;
  admission_payments: AdmissionPaymentsTable;
  admission_imports: AdmissionImportsTable;
}

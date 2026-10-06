/** Fee heads, entry fees, fee structures, assignments and fee records (migration 0039). */
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
type DateOnly = ColumnType<Date | string, string, string>;
type Json<T> = ColumnType<T, string, string>;

export type FeeVersionState = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'SUPERSEDED';
export type FeeRecordStatus = 'DUE' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED';
export type FeeRecordSource = 'STRUCTURE' | 'MANUAL' | 'UPLOAD';

export interface FeeHeadsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  status: ColumnType<
    'ACTIVE' | 'INACTIVE',
    'ACTIVE' | 'INACTIVE' | undefined,
    'ACTIVE' | 'INACTIVE'
  >;
  sort_order: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
}

export interface EntryFeesTable {
  institution_id: Ref;
  year_id: Ref;
  application_fee_paise: Paise;
  application_mandatory: Flag;
  admission_fee_paise: Paise;
  row_version: Generated<number>;
  updated_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FeeStructuresTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  name: string;
  created_by: Buffer | null;
  created_at: Timestamp;
}

export interface FeeStructureVersionsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  structure_id: Ref;
  version_no: number;
  state: ColumnType<FeeVersionState, FeeVersionState | undefined, FeeVersionState>;
  total_paise: Paise;
  optional_paise: ColumnType<string, number | string | undefined, number | string>;
  late_fine_paise: ColumnType<string, number | string | undefined, number | string>;
  approval_id: Ref | null;
  returned_remarks: string | null;
  created_by: Buffer | null;
  created_at: Timestamp;
  submitted_by: Buffer | null;
  submitted_at: NullableTimestamp;
  activated_at: NullableTimestamp;
  superseded_at: NullableTimestamp;
  row_version: Generated<number>;
  open_key: ColumnType<string | null, never, never>;
  active_key: ColumnType<string | null, never, never>;
}

export interface FeeStructureClassesTable {
  version_id: Ref;
  class_id: Ref;
}

export interface FeeStructureHeadsTable {
  version_id: Ref;
  head_id: Ref;
  optional: Flag;
  amount_paise: Paise;
  sort_order: number;
}

export interface FeeStructureInstalmentsTable {
  version_id: Ref;
  seq: number;
  label: string;
  due_date: DateOnly;
  share_bp: number;
  amount_paise: Paise;
}

export interface FeeAssignmentsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  student_profile_id: Ref;
  structure_id: Ref;
  version_id: Ref;
  optional_heads: Json<string[]> | null;
  status: ColumnType<
    'ACTIVE' | 'REPLACED',
    'ACTIVE' | 'REPLACED' | undefined,
    'ACTIVE' | 'REPLACED'
  >;
  assigned_by: Buffer | null;
  assigned_at: Timestamp;
  live_key: ColumnType<string | null, never, never>;
}

export interface FeeRecordsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  student_profile_id: Ref;
  source: FeeRecordSource;
  assignment_id: Ref | null;
  version_id: Ref | null;
  upload_id: ColumnType<string | null, string | null | undefined, string | null>;
  instalment_seq: number;
  label: string;
  due_date: DateOnly;
  amount_paise: Paise;
  late_fine_paise: ColumnType<string, number | string | undefined, number | string>;
  fine_applied: Flag;
  paid_paise: ColumnType<string, number | string | undefined, number | string>;
  status: ColumnType<FeeRecordStatus, FeeRecordStatus | undefined, FeeRecordStatus>;
  financed: Flag;
  remarks: string | null;
  paid_at: NullableTimestamp;
  paid_reference: ColumnType<string | null, string | null | undefined, string | null>;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FeeUploadsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  file_name: string;
  status: ColumnType<
    'VALIDATED' | 'COMMITTED',
    'VALIDATED' | 'COMMITTED' | undefined,
    'VALIDATED' | 'COMMITTED'
  >;
  rows_total: number;
  rows_accepted: number;
  rows_rejected: number;
  records_planned: number;
  report: ColumnType<unknown, string, string>;
  created_by: Buffer | null;
  created_at: Timestamp;
  committed_at: NullableTimestamp;
  committed_count: number | null;
}

export interface FeeRecordHeadsTable {
  record_id: Ref;
  head_id: Ref;
  name: string;
  amount_paise: Paise;
}

export interface FeeCollectionAttemptsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  record_id: Ref;
  status: ColumnType<
    'PENDING' | 'SUCCEEDED' | 'CANCELLED',
    'PENDING' | 'SUCCEEDED' | 'CANCELLED' | undefined,
    'PENDING' | 'SUCCEEDED' | 'CANCELLED'
  >;
  tries: Generated<number>;
  last_failure_code: string | null;
  last_tried_at: NullableTimestamp;
  payment_attempt_id: Ref | null;
  created_by: Buffer | null;
  created_at: Timestamp;
  closed_at: NullableTimestamp;
  live_key: ColumnType<string | null, never, never>;
}

export interface FeeCollectionsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  record_id: Ref;
  payment_attempt_id: Ref;
  amount_paise: Paise;
  fine_paise: ColumnType<string, number | string | undefined, number | string>;
  source: 'CONSOLE' | 'JOB' | 'MEMBER';
  status: ColumnType<
    'COLLECTED' | 'SETTLED',
    'COLLECTED' | 'SETTLED' | undefined,
    'COLLECTED' | 'SETTLED'
  >;
  settlement_ref: string | null;
  collected_at: Timestamp;
}

export interface FeeConsentsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  student_profile_id: Ref;
  account_id: Ref;
  text_version: string;
  accepted_text: ColumnType<string | null, string | null | undefined, string | null>;
  agreed_at: Timestamp;
  valid_until: Timestamp;
}

export type FinancingStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface FeeFinancingRegistrationsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  student_profile_id: Ref;
  partner_ref: string;
  partner_name: string;
  status: ColumnType<FinancingStatus, FinancingStatus | undefined, FinancingStatus>;
  requested_by_type: 'STAFF' | 'MEMBER';
  requested_by: Buffer | null;
  failure_reason: string | null;
  created_at: Timestamp;
  decided_at: NullableTimestamp;
  row_version: Generated<number>;
  live_key: ColumnType<string | null, never, never>;
}

export interface FeeFinancingRecordsTable {
  registration_id: Ref;
  record_id: Ref;
}

export interface FeeTables {
  fee_collection_attempts: FeeCollectionAttemptsTable;
  fee_collections: FeeCollectionsTable;
  fee_consents: FeeConsentsTable;
  fee_heads: FeeHeadsTable;
  entry_fees: EntryFeesTable;
  fee_structures: FeeStructuresTable;
  fee_structure_versions: FeeStructureVersionsTable;
  fee_structure_classes: FeeStructureClassesTable;
  fee_structure_heads: FeeStructureHeadsTable;
  fee_structure_instalments: FeeStructureInstalmentsTable;
  fee_assignments: FeeAssignmentsTable;
  fee_records: FeeRecordsTable;
  fee_record_heads: FeeRecordHeadsTable;
  fee_uploads: FeeUploadsTable;
  fee_financing_registrations: FeeFinancingRegistrationsTable;
  fee_financing_records: FeeFinancingRecordsTable;
}

/**
 * Personal details, the maker-checker core and notifications (migrations 0010, 0011, 0022; SRS 6.11,
 * 6.38.5, 17, 23.7).
 */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export interface RefListTable {
  code: string;
  label_key: string;
  active: number;
  sort_order: number;
}

export interface RefRelationsTable extends RefListTable {
  usage_scope: string;
}

export interface AccountAddressesTable {
  account_id: Ref;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  pin_code: string;
  proof_type: string | null;
  proof_file_id: Ref;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AccountBankAccountsTable {
  account_id: Ref;
  holder_name: string;
  bank_name: string | null;
  acct_enc: Buffer;
  acct_bidx: Buffer;
  acct_last4: string;
  ifsc: string;
  change_reason: string | null;
  verified_at: NullableTimestamp;
  verification_ref: string | null;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AccountNomineesTable {
  account_id: Ref;
  name: string;
  relation_code: string;
  dob: ColumnType<Date | string | null, string | null, string | null>;
  share_pct: number;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AccountIncomeTable {
  account_id: Ref;
  occupation: string;
  band_code: string;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ApprovalRequestsTable {
  id: Generated<string>;
  public_id: Buffer;
  /** APR-0001 per institution (the platform counts separately); set by trigger. */
  request_seq: ColumnType<number, number | undefined, number>;
  seq_scope: ColumnType<string, never, never>;
  institution_id: Ref | null;
  module: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  summary: string;
  subject_type: string | null;
  subject_ref: Buffer | null;
  payload: ColumnType<unknown, string, string>;
  maker_type: string;
  maker_ref: Buffer;
  status: Generated<ApprovalStatus>;
  checker_ref: Buffer | null;
  remarks: string | null;
  decided_at: NullableTimestamp;
  effect_error_code: string | null;
  effect_error_params: ColumnType<unknown, string | null, string | null>;
  /** ADR-0015: an administrator's own request, applied without a checker. */
  applied_directly: Generated<number>;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Identity fields of an account (m.kyc). */
export type AccountPiiField = 'FULL_NAME' | 'DOB' | 'GENDER' | 'PAN' | 'ID_NUMBER';
/** Identity fields of an account or of an institution profile (CR-06). */
export type PiiField = AccountPiiField | 'ADMISSION_NO' | 'EMPLOYEE_NO';

export interface PiiCorrectionRequestsTable {
  id: Generated<string>;
  public_id: Buffer;
  account_id: Ref | null;
  profile_id: Ref | null;
  institution_id: Ref | null;
  field: PiiField;
  current_masked: string;
  proposed_enc: Buffer;
  reason: string;
  evidence_file_id: Ref;
  approval_request_id: Ref;
  open_key: ColumnType<string | null, never, never>;
  applied_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface NotificationsTable {
  id: Generated<string>;
  created_on: ColumnType<Date | string, string, string>;
  public_id: Buffer;
  institution_id: Ref | null;
  account_id: Ref;
  surface: 'CONSOLE' | 'MEMBER';
  category: string;
  title_key: string;
  params: ColumnType<unknown, string | null, string | null>;
  body: string;
  link: string | null;
  read_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface PersonalTables {
  ref_relations: RefRelationsTable;
  ref_income_bands: RefListTable;
  ref_occupations: RefListTable;
  ref_address_proof_types: RefListTable;
  account_addresses: AccountAddressesTable;
  account_bank_accounts: AccountBankAccountsTable;
  account_nominees: AccountNomineesTable;
  account_income: AccountIncomeTable;
  approval_requests: ApprovalRequestsTable;
  pii_correction_requests: PiiCorrectionRequestsTable;
  notifications: NotificationsTable;
}

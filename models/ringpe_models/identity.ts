/** Identity tables (migration 0005, docs/04 §3.2). BIGINT ids arrive as strings (ADR-0004). */
import type { ColumnType, Generated } from 'kysely';

type Id = Generated<string>;
type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export type AccountStatus = 'ACTIVE' | 'DEACTIVATED';
export type SigninLock = 'UNLOCKED' | 'LOCKED';
export type SurfaceCode = 'MEMBER' | 'CONSOLE' | 'OPS' | 'PORTAL' | 'TERMINAL';
export type OtpPurpose =
  | 'SIGNUP'
  | 'DEVICE'
  | 'CONSOLE_2FA'
  | 'OPS_2FA'
  | 'PORTAL_2FA'
  | 'RECOVERY'
  | 'TPIN_RESET'
  | 'ADMISSION_RESUME'
  | 'PORTAL_SIGNUP'
  | 'EMAIL_CHANGE';

export interface PlatformAccountsTable {
  id: Id;
  public_id: Buffer;
  mobile: string;
  email: string | null;
  email_verified_at: NullableTimestamp;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  dob: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  pan_enc: Buffer | null;
  pan_bidx: Buffer | null;
  pan_last4: string | null;
  id_doc_type: string | null;
  id_doc_enc: Buffer | null;
  id_doc_bidx: Buffer | null;
  id_doc_last4: string | null;
  kyc_level: Generated<'MIN' | 'FULL'>;
  status: Generated<AccountStatus>;
  txn_permission: Generated<number>;
  signin_lock: Generated<SigninLock>;
  failed_signins: Generated<number>;
  locked_until: NullableTimestamp;
  abandoned_code_attempts: Generated<number>;
  preferred_lang: Generated<string>;
  last_signin_at: NullableTimestamp;
  current_signin_at: NullableTimestamp;
  row_version: Generated<number>;
  created_at: Generated<Date>;
  created_by: Buffer | null;
  updated_at: Generated<Date>;
  updated_by: Buffer | null;
}

export interface AccountCredentialsTable {
  id: Id;
  account_id: Ref;
  kind: 'PASSWORD' | 'TPIN' | 'SECURITY_ANSWER';
  hash: string;
  question_code: string | null;
  failed_attempts: Generated<number>;
  locked_until: NullableTimestamp;
  previous_hash: string | null;
  must_change: Generated<number>;
  set_at: Generated<Date>;
  row_version: Generated<number>;
}

export interface SocialIdentitiesTable {
  id: Id;
  account_id: Ref;
  provider: string;
  subject_hash: Buffer;
  email: string | null;
  linked_at: Generated<Date>;
}

export interface ConsentsTable {
  id: Id;
  account_id: Ref;
  kind: 'TERMS' | 'PRIVACY' | 'DATA_PROCESSING' | 'GUARDIAN';
  version: string;
  accepted_at: Generated<Date>;
  ip: Buffer | null;
  device_id: Ref | null;
}

export interface DevicesTable {
  id: Id;
  public_id: Buffer;
  account_id: Ref;
  install_id_hash: Buffer;
  model: string | null;
  os: string | null;
  app_version: string | null;
  risk_flags: Generated<string>;
  status: Generated<'ACTIVE' | 'INACTIVE'>;
  active_key: ColumnType<string | null, never, never>;
  bound_at: Generated<Date>;
  inactivated_at: NullableTimestamp;
}

export interface SessionsTable {
  id: Id;
  public_id: Buffer;
  account_id: Ref;
  surface: SurfaceCode;
  /** A console session of the staff app, beside the web console’s (migration 0081). */
  staff_app: ColumnType<number, number | undefined, number>;
  institution_id: Ref | null;
  profile_id: Ref | null;
  device_id: Ref | null;
  ip: Buffer | null;
  ua_hash: Buffer | null;
  started_at: Generated<Date>;
  last_seen_at: Timestamp;
  absolute_expires_at: Timestamp;
  ended_at: NullableTimestamp;
  end_reason: string | null;
  active_key: ColumnType<string | null, never, never>;
}

export interface RefreshTokensTable {
  id: Id;
  session_id: Ref;
  family_id: Buffer;
  token_hash: Buffer;
  status: Generated<'ACTIVE' | 'ROTATED' | 'REVOKED'>;
  issued_at: Generated<Date>;
  expires_at: Timestamp;
  rotated_at: NullableTimestamp;
}

export interface OtpChallengesTable {
  id: Id;
  public_id: Buffer;
  account_id: Ref | null;
  purpose: OtpPurpose;
  channel: 'SMS' | 'EMAIL';
  destination_hash: Buffer;
  context_hash: Buffer | null;
  code_hash: Buffer;
  attempts: Generated<number>;
  max_attempts: number;
  resends: Generated<number>;
  max_resends: number;
  resend_after_at: Timestamp;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  abandoned_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface RefSecurityQuestionsTable {
  code: string;
  label_key: string;
  text_en: string;
  active: number;
  sort_order: number;
}

export interface ConsentDocumentsTable {
  id: Id;
  kind: 'CONSENT' | 'TERMS';
  version: string;
  title_en: string;
  body_en: string;
  is_draft: number;
  active: number;
  published_at: Generated<Date>;
}

export interface RefIdDocumentTypesTable {
  code: string;
  label_key: string;
  number_regex: string;
  active: number;
  sort_order: number;
}

export interface IdentityTables {
  platform_accounts: PlatformAccountsTable;
  account_credentials: AccountCredentialsTable;
  social_identities: SocialIdentitiesTable;
  consents: ConsentsTable;
  devices: DevicesTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  otp_challenges: OtpChallengesTable;
  ref_security_questions: RefSecurityQuestionsTable;
  consent_documents: ConsentDocumentsTable;
  ref_id_document_types: RefIdDocumentTypesTable;
}

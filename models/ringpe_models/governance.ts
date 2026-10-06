/** Governance and platform tables used from Phase 2 (migration 0004, docs/04 §9). */
import type { ColumnType, Generated } from 'kysely';

type Id = Generated<string>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | null | undefined, string | null>;

export interface AuditLogTable {
  id: Id;
  occurred_on: ColumnType<Date, string, never>;
  occurred_at: ColumnType<Date, Date | string, never>;
  institution_id: string | null;
  actor_type: 'member' | 'console' | 'operator' | 'portal' | 'terminal' | 'partner' | 'system';
  actor_ref: Buffer | null;
  action: string;
  entity_type: string;
  entity_ref: Buffer | null;
  before_state: Json;
  after_state: Json;
  reason: string | null;
  ip: Buffer | null;
  correlation_id: Buffer;
}

export interface IdempotencyRecordsTable {
  id: Id;
  scope_key: string;
  principal_ref: Buffer | null;
  idempotency_key: string;
  method: string;
  route: string;
  request_hash: string;
  status: Generated<'IN_PROGRESS' | 'COMPLETED'>;
  response_status: number | null;
  response_body: Json;
  created_at: Generated<Date>;
  expires_at: Timestamp;
}

export interface FilesTable {
  id: Id;
  public_id: Buffer;
  institution_id: string | null;
  purpose: string;
  object_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  scan_status: Generated<'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR'>;
  owner_type: string | null;
  owner_ref: Buffer | null;
  created_at: Generated<Date>;
  created_by: Buffer | null;
}

export interface LanguagesTable {
  code: string;
  name: string;
  native_name: string;
  enabled: number;
  is_default: number;
  sort_order: number;
  /** Optimistic locking (migration 0062). */
  row_version: Generated<number>;
}

/** Texts of a language (migration 0008): MACHINE drafts from the seed, HUMAN once edited. */
export interface TranslationsTable {
  lang_code: string;
  msg_key: string;
  text: string;
  source: 'MACHINE' | 'HUMAN';
  reviewed_at: Date | null;
  reviewed_by: Buffer | null;
  row_version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface PlatformSettingsTable {
  setting_key: string;
  value_json: Json;
  reason: string;
  row_version: Generated<number>;
  updated_at: Generated<Date>;
  updated_by: Buffer | null;
}

export interface PlatformSettingChangesTable {
  id: Id;
  setting_key: string;
  from_json: Json;
  to_json: Json;
  reason: string;
  changed_at: Generated<Date>;
  changed_by: Buffer | null;
}

/** CR-18 access record (append-only: an update trigger refuses changes). */
export interface CrossInstitutionAccessRecordTable {
  id: Id;
  public_id: Buffer;
  access_no: string;
  parent_access_id: string | null;
  kind: 'Comparison' | 'Drill-through' | 'Leaderboard' | 'Support lookup';
  actor_ref: Buffer;
  actor_role: string;
  selection: string;
  period_from_on: ColumnType<Date | string | null, string | null | undefined, string | null>;
  period_to_on: ColumnType<Date | string | null, string | null | undefined, string | null>;
  outcome: 'Returned' | 'Refused';
  reason: string;
  note: string | null;
  occurred_at: Timestamp;
  correlation_id: Buffer;
}

export interface CrossInstitutionAccessInstitutionsTable {
  access_id: string;
  institution_id: string;
}

export interface CrossInstitutionAccessFiguresTable {
  access_id: string;
  figure_key: string;
}

export interface GovernanceTables {
  audit_log: AuditLogTable;
  cross_institution_access_record: CrossInstitutionAccessRecordTable;
  cross_institution_access_institutions: CrossInstitutionAccessInstitutionsTable;
  cross_institution_access_figures: CrossInstitutionAccessFiguresTable;
  idempotency_records: IdempotencyRecordsTable;
  files: FilesTable;
  languages: LanguagesTable;
  translations: TranslationsTable;
  platform_settings: PlatformSettingsTable;
  platform_setting_changes: PlatformSettingChangesTable;
}

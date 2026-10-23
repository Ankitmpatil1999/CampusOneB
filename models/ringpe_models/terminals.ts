/** Readers, POS terminals and campus cards (migration 0033). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export type TerminalPurpose =
  | 'ATTENDANCE'
  | 'PERIOD_ATTENDANCE'
  | 'LOCATION'
  | 'COUPON'
  | 'BALANCE_CHECK'
  | 'CARD_ISSUE'
  | 'POS';
export type CardIssueReason =
  'NEW_REGISTRATION' | 'LOST' | 'DAMAGED' | 'STOLEN' | 'DEFECTIVE' | 'EXPIRED';

export interface TerminalsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  location: string | null;
  purpose: TerminalPurpose;
  merchant_profile_id: Ref | null;
  section_id: Ref | null;
  location_type: string | null;
  operator_tag_id: Ref | null;
  operator_since: NullableTimestamp;
  operator_until: NullableTimestamp;
  status: ColumnType<
    'ACTIVE' | 'DISABLED',
    'ACTIVE' | 'DISABLED' | undefined,
    'ACTIVE' | 'DISABLED'
  >;
  status_reason: string | null;
  device_fingerprint: string | null;
  device_secret_enc: Buffer | null;
  paired_at: NullableTimestamp;
  pairing_code_hash: Buffer | null;
  pairing_expires_at: NullableTimestamp;
  last_seen_at: NullableTimestamp;
  last_sync_at: NullableTimestamp;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TerminalChangesTable {
  id: Generated<string>;
  terminal_id: Ref;
  name: string;
  location: string | null;
  purpose: string;
  changed_by: Buffer | null;
  changed_at: Timestamp;
}

export interface TerminalNoncesTable {
  terminal_id: Ref;
  nonce: string;
  used_at: Timestamp;
}

export interface CardsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  profile_id: Ref;
  token: string;
  /** SHA-256 of the earlier application's value on the card (migration 0087), for a carried-over card. */
  legacy_token_hash: Buffer | null;
  hardware_uid: string | null;
  status: ColumnType<
    'ACTIVE' | 'INACTIVE',
    'ACTIVE' | 'INACTIVE' | undefined,
    'ACTIVE' | 'INACTIVE'
  >;
  issue_reason: CardIssueReason;
  reissue_count: Generated<number>;
  status_reason: string | null;
  blocked_at: NullableTimestamp;
  issued_by_terminal: Ref | null;
  issued_at: Timestamp;
  last_tap_at: NullableTimestamp;
  row_version: Generated<number>;
  active_key: ColumnType<string | null, never, never>;
}

export interface CardWritesTable {
  id: Generated<string>;
  institution_id: Ref;
  profile_id: Ref;
  reason: Exclude<CardIssueReason, 'NEW_REGISTRATION'>;
  code_hash: Buffer;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_by: Buffer | null;
  created_at: Timestamp;
}

export interface TerminalTables {
  terminals: TerminalsTable;
  terminal_changes: TerminalChangesTable;
  terminal_nonces: TerminalNoncesTable;
  cards: CardsTable;
  card_writes: CardWritesTable;
}

/** Paid events and entry passes (migration 0037; SRS 13.7–13.10, 9.7–9.9). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DateOnly = ColumnType<Date | string, string, string>;
type Paise = ColumnType<string, number | string, number | string>;
type Flag = ColumnType<number, number | boolean | undefined, number | boolean>;

export type EventStatus = 'ACTIVE' | 'INACTIVE';
export type PassStatus = 'ACTIVE' | 'AUTHORIZED' | 'USED' | 'EXPIRED' | 'CANCELLED';

export interface EventsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  title: string;
  description: string | null;
  start_date: DateOnly;
  end_date: DateOnly;
  total_paise: Paise;
  merchant_profile_id: Ref;
  audience_class_ids: ColumnType<unknown, string | null, string | null>;
  status: ColumnType<EventStatus, EventStatus | undefined, EventStatus>;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EventHeadsTable {
  id: Generated<string>;
  event_id: Ref;
  name: string;
  amount_paise: Paise;
  sort_order: Generated<number>;
}

export interface EntryPassesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  pass_type: string;
  purpose: string;
  description: string;
  holder_profile_id: Ref;
  device_id: Ref;
  valid_on: DateOnly;
  max_scans: ColumnType<number, number | undefined, number>;
  used_scans: ColumnType<number, number | undefined, number>;
  transfer_allowed: Flag;
  comments: string | null;
  status: ColumnType<PassStatus, PassStatus | undefined, PassStatus>;
  live_key: ColumnType<string | null, never, never>;
  token_hash: Buffer | null;
  authorised_until: Date | null;
  cancel_reason: string | null;
  ended_at: Date | null;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EntryPassScansTable {
  id: Generated<string>;
  pass_id: Ref;
  checker_profile_id: Ref;
  scanned_at: Date;
  scan_no: number;
}

export interface EventTables {
  events: EventsTable;
  event_heads: EventHeadsTable;
  entry_passes: EntryPassesTable;
  entry_pass_scans: EntryPassScansTable;
}

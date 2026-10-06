/** Grievances: tickets, their history and call logs (migration 0046; SRS 16). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type NullablePaise = ColumnType<
  string | null,
  number | string | null | undefined,
  number | string | null
>;
type Version = ColumnType<number, number | undefined, number>;

export type TicketKind = 'TRANSACTION' | 'FEEDBACK' | 'FRAUD';
export type TicketChannel = 'APP' | 'WEB' | 'PHONE';
export type TicketStatus =
  'OPEN' | 'ESCALATED_VENDOR' | 'ESCALATED_INTERNAL' | 'RESOLVED' | 'CLOSED';
export type TicketActor = 'MEMBER' | 'STAFF' | 'OPERATOR' | 'SYSTEM';

export interface TicketsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  ticket_no: string | null;
  kind: TicketKind;
  profile_id: Ref;
  account_id: Ref | null;
  ledger_txn_id: Ref | null;
  transaction_ref: string | null;
  txn_type: string | null;
  txn_amount_paise: NullablePaise;
  txn_at: NullableTimestamp;
  category: string | null;
  issue: string;
  channel: TicketChannel;
  status: ColumnType<TicketStatus, TicketStatus | undefined, TicketStatus>;
  priority: ColumnType<number, number | undefined, number>;
  reason_code: string | null;
  resolution: string | null;
  comments: string | null;
  fraud_at: NullableTimestamp;
  fraud_location: string | null;
  attachment_file_id: Ref | null;
  refund_id: Ref | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  closed_at: NullableTimestamp;
  row_version: Version;
  open_key: ColumnType<string | null, never, never>;
}

export interface TicketEventsTable {
  id: Generated<string>;
  ticket_id: Ref;
  institution_id: Ref;
  status: TicketStatus;
  priority: number;
  reason_code: string | null;
  resolution: string | null;
  comments: string | null;
  actor_type: TicketActor;
  actor_ref: Buffer | null;
  approval_id: Ref | null;
  at: Timestamp;
}

export interface CallLogsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  ticket_id: Ref | null;
  direction: 'INBOUND' | 'OUTBOUND';
  caller: string;
  minutes: number;
  summary: string;
  source: 'CONSOLE' | 'SUPPORT';
  logged_by: Buffer | null;
  logged_at: Timestamp;
}

export interface GrievanceTables {
  tickets: TicketsTable;
  ticket_events: TicketEventsTable;
  call_logs: CallLogsTable;
}

/**
 * Communication (migration 0058): announcement categories, announcements and their recipients, and the
 * communication log (CR-16).
 */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Flag = ColumnType<number, number | undefined, number>;
type Count = ColumnType<number, number | undefined, number>;

export type AnnouncementStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type AnnouncementSource = 'CONSOLE' | 'PRINCIPAL' | 'TEACHER';
export type CommKind = 'ANNOUNCEMENT' | 'DIRECT_MESSAGE' | 'NOTIFICATION' | 'OTP' | 'TRANSACTIONAL';
export type CommChannel = 'IN_APP' | 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH';
export type CommOutcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';

export interface AnnouncementCategoriesTable {
  code: string;
  label: string;
  colour: string;
  sort_order: number;
}

export interface AnnouncementsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref | null;
  seq: number;
  source: AnnouncementSource;
  section_id: Ref | null;
  title: string;
  body: string;
  category_code: string;
  important: Flag;
  ack_required: Flag;
  channels: string;
  targets: ColumnType<unknown, string, string>;
  attachment_file_id: Ref | null;
  send_at: Timestamp;
  status: ColumnType<AnnouncementStatus, AnnouncementStatus | undefined, AnnouncementStatus>;
  recipients: Count;
  sent_success: Count;
  sent_skipped: Count;
  sent_failed: Count;
  dispatched_at: NullableTimestamp;
  failure_reason: string | null;
  withdrawn_at: NullableTimestamp;
  withdraw_reason: string | null;
  created_by: Buffer | null;
  created_by_profile_id: Ref | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: ColumnType<number, number | undefined, number>;
}

export interface AnnouncementRecipientsTable {
  announcement_id: Ref;
  profile_id: Ref;
  institution_id: Ref;
  delivered_at: NullableTimestamp;
  acknowledged_at: NullableTimestamp;
  ack_channel: 'IN-APP' | 'EMAIL' | null;
}

export interface CommLogTable {
  id: Generated<string>;
  logged_on: ColumnType<Date | string, string, string>;
  at: Timestamp;
  institution_id: Ref | null;
  kind: CommKind;
  channel: CommChannel;
  recipient_profile_id: Ref | null;
  recipient_account_id: Ref | null;
  recipient_masked: string | null;
  raiser: Buffer | null;
  outcome: CommOutcome;
  reason: string | null;
  ref_type: string | null;
  ref_id: string | null;
  subject: string | null;
}

/** Migration 0060: log writes that failed, per institution (0: none) and day (RNG-COM-183). */
export interface CommLogGapsTable {
  institution_id: ColumnType<string, string | undefined, string>;
  day: ColumnType<Date | string, string, string>;
  failures: Count;
}

/** Migration 0064: a finished day's log attempts per kind, channel and outcome (report totals). */
export interface CommLogDailyTable {
  institution_id: string;
  day: ColumnType<Date | string, string, string>;
  kind: CommKind;
  channel: CommChannel;
  outcome: CommOutcome;
  n: number;
}
/** Migration 0064: the days whose totals are counted. */
export interface CommLogDailyDoneTable {
  institution_id: string;
  day: ColumnType<Date | string, string, string>;
}

/** Migration 0060: report exports (status register: data export, RC-26). */
export type ReportExportStatus = 'REQUESTED' | 'RUNNING' | 'READY' | 'EXPIRED' | 'FAILED';
export interface ReportExportsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref | null;
  report: string;
  params: ColumnType<unknown, string, string>;
  format: ColumnType<'CSV', 'CSV' | undefined, 'CSV'>;
  status: ColumnType<ReportExportStatus, ReportExportStatus | undefined, ReportExportStatus>;
  file_id: Ref | null;
  row_count: number | null;
  truncated: Flag;
  requested_by: Buffer;
  requested_at: Timestamp;
  started_at: NullableTimestamp;
  ready_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  error_code: string | null;
}

/** Migration 0059: direct messages (SRS 23.9–23.11). */
export type DirectMessageStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface ConversationsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  profile_low: Ref;
  profile_high: Ref;
  started_by: Ref;
  last_message_id: Ref | null;
  last_message_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface ConversationParticipantsTable {
  conversation_id: Ref;
  profile_id: Ref;
  institution_id: Ref;
  other_profile_id: Ref;
  archived_at: NullableTimestamp;
  last_message_at: Timestamp;
}

export interface DirectMessagesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  conversation_id: Ref;
  sender_profile_id: Ref;
  body: string;
  status: ColumnType<DirectMessageStatus, DirectMessageStatus | undefined, DirectMessageStatus>;
  created_at: Timestamp;
  delivered_at: NullableTimestamp;
  read_at: NullableTimestamp;
}

export interface CommunicationTables {
  announcement_categories: AnnouncementCategoriesTable;
  announcements: AnnouncementsTable;
  announcement_recipients: AnnouncementRecipientsTable;
  comm_log: CommLogTable;
  comm_log_gaps: CommLogGapsTable;
  comm_log_daily: CommLogDailyTable;
  comm_log_daily_done: CommLogDailyDoneTable;
  report_exports: ReportExportsTable;
  conversations: ConversationsTable;
  conversation_participants: ConversationParticipantsTable;
  direct_messages: DirectMessagesTable;
}

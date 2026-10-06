/**
 * Platform tools (migration 0057): the request log behind the log analyser and the messaging channel
 * switches.
 */
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type MessagingChannel = 'IN_APP' | 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH';

export interface RequestLogTable {
  id: Generated<string>;
  logged_on: ColumnType<Date | string, string, string>;
  at: Timestamp;
  correlation_id: string | null;
  method: string;
  route: string;
  path: string;
  status: number;
  latency_ms: number;
  surface: string | null;
  actor: Buffer | null;
  institution: Buffer | null;
  ip_prefix: string | null;
  user_agent: string | null;
  query_keys: string | null;
  problem_code: string | null;
}

export interface MessagingChannelsTable {
  channel: MessagingChannel;
  enabled: ColumnType<number, number | undefined, number>;
  template_set: ColumnType<string, string | undefined, string>;
  updated_by: Buffer | null;
  updated_at: Timestamp;
  row_version: ColumnType<number, number | undefined, number>;
}

export interface PlatformToolTables {
  request_log: RequestLogTable;
  messaging_channels: MessagingChannelsTable;
}

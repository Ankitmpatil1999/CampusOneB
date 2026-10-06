/** The transactional outbox (migration 0004, rooms added in 0032; docs/03 §9.1). */
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OutboxEventsTable {
  id: Generated<string>;
  event_id: Buffer;
  institution_id: string | null;
  aggregate_type: string;
  aggregate_ref: Buffer | null;
  event_type: string;
  payload: ColumnType<unknown, string, string>;
  rooms: ColumnType<unknown, string | null | undefined, string | null>;
  status: ColumnType<
    'PENDING' | 'DISPATCHED' | 'DEAD',
    'PENDING' | 'DISPATCHED' | 'DEAD' | undefined,
    'PENDING' | 'DISPATCHED' | 'DEAD'
  >;
  attempts: Generated<number>;
  available_at: Timestamp;
  last_error: string | null;
  correlation_id: Buffer;
  created_at: Timestamp;
  dispatched_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface OutboxTables {
  outbox_events: OutboxEventsTable;
}

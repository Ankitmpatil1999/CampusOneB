/** Allowance grants (migration 0035; SRS 10). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DateOnly = ColumnType<Date | string, string, string>;

export type AllowanceGrantStatus = 'ACTIVE' | 'INACTIVE';
export type AllowanceEndedReason = 'EXPIRED' | 'CANCELLED';

export interface AllowanceGrantsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  profile_id: Ref;
  wallet_id: Ref;
  name: string | null;
  amount_paise: ColumnType<string, number | string, number | string>;
  start_date: DateOnly;
  expiry_date: DateOnly;
  daily_count_limit: number | null;
  daily_amount_limit_paise: ColumnType<string | null, number | string | null, number | string | null>;
  status: ColumnType<
    AllowanceGrantStatus,
    AllowanceGrantStatus | undefined,
    AllowanceGrantStatus
  >;
  ended_reason: AllowanceEndedReason | null;
  credited_at: Date | null;
  credit_txn_id: Ref | null;
  expired_at: Date | null;
  expired_paise: ColumnType<string | null, number | string | null, number | string | null>;
  expiry_txn_id: Ref | null;
  cancel_reason: string | null;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AllowanceTables {
  allowance_grants: AllowanceGrantsTable;
}

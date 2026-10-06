/** Settlement and the daily wallet balances (migration 0044; SRS 14, 8.15). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Paise = ColumnType<string, number | string | undefined, number | string>;
type Flag = ColumnType<number, number | boolean | undefined, number | boolean>;
type DateOnly = ColumnType<Date | string, string, string>;

export type SettlementStatus = 'PENDING' | 'APPROVAL_STAGE_1' | 'APPROVED' | 'FAILED';

export interface SettlementsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  settlement_no: string;
  settlement_date: DateOnly;
  window_to: Timestamp;
  status: ColumnType<SettlementStatus, SettlementStatus | undefined, SettlementStatus>;
  line_count: ColumnType<number, number | undefined, number>;
  merchant_count: ColumnType<number, number | undefined, number>;
  gross_paise: Paise;
  fee_paise: Paise;
  adjustment_paise: Paise;
  net_paise: Paise;
  recollected_count: ColumnType<number, number | undefined, number>;
  files: ColumnType<unknown, string | null | undefined, string | null>;
  stage1_by: Buffer | null;
  stage1_at: NullableTimestamp;
  stage1_remarks: string | null;
  final_by: Buffer | null;
  final_at: NullableTimestamp;
  final_remarks: string | null;
  rejected_by: Buffer | null;
  rejected_at: NullableTimestamp;
  rejection_remarks: string | null;
  payout_utr: string | null;
  payout_paise: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  payout_at: NullableTimestamp;
  payout_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Generated<number>;
  live_key: ColumnType<string | null, never, never>;
}

export interface SettlementLinesTable {
  id: Generated<string>;
  public_id: Buffer;
  settlement_id: Ref;
  institution_id: Ref;
  merchant_profile_id: Ref;
  ledger_txn_id: Ref;
  posted_on: DateOnly;
  reference: string;
  txn_type: string;
  /** 1: a collection; −1: an adjustment (refund, chargeback; Q14 M3). */
  sign: ColumnType<number, number | undefined, number>;
  amount_paise: Paise;
  fee_paise: Paise;
  net_paise: Paise;
  remarks: string | null;
  txn_at: Timestamp;
  recollected: Flag;
  active: Flag;
  carried: Flag;
  payout_reference: string | null;
  live_txn: ColumnType<string | null, never, never>;
}

export interface WalletDayBalancesTable {
  wallet_id: Ref;
  business_date: DateOnly;
  institution_id: Ref;
  opening_paise: ColumnType<string, number | string, number | string>;
  closing_paise: ColumnType<string, number | string, number | string>;
  created_at: Timestamp;
}

export interface SettlementTables {
  settlements: SettlementsTable;
  settlement_lines: SettlementLinesTable;
  wallet_day_balances: WalletDayBalancesTable;
}

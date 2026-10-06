/** Reconciliation: statements, mismatches, refunds and chargebacks (migration 0045; SRS 15). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Paise = ColumnType<string, number | string, number | string>;
type NullablePaise = ColumnType<
  string | null,
  number | string | null | undefined,
  number | string | null
>;
type DateOnly = ColumnType<Date | string, string, string>;
type Version = ColumnType<number, number | undefined, number>;

export type ReconStatementKind = 'VA_CREDITS' | 'PAYOUTS' | 'GATEWAY';
export type ReconMismatchKind =
  'MISSING_ON_PLATFORM' | 'MISSING_IN_STATEMENT' | 'AMOUNT' | 'STATUS';
export type ReconMismatchStatus = 'OPEN' | 'RESOLVED';
export type ReconResolution = 'EXPLAINED' | 'REFUND' | 'CHARGEBACK' | 'ADJUSTED';
export type RefundStatus = 'REQUESTED' | 'PROCESSED' | 'REJECTED';
export type RefundSource = 'MISMATCH' | 'GRIEVANCE' | 'MANUAL';
export type ChargebackStatus = 'RAISED' | 'ACCEPTED' | 'DISPUTED' | 'COMPLETED';
export type ChargebackOutcome = 'REVERSED' | 'UPHELD';

export interface ReconStatementsTable {
  id: Generated<string>;
  public_id: Buffer;
  kind: ReconStatementKind;
  file_name: string;
  sha256: string;
  rows_total: number;
  rows_matched: number;
  rows_mismatched: number;
  period_from: ColumnType<Date | string | null, string | null | undefined, string | null>;
  period_to: ColumnType<Date | string | null, string | null | undefined, string | null>;
  uploaded_by: Buffer | null;
  uploaded_at: Timestamp;
}

export interface ReconStatementRowsTable {
  id: Generated<string>;
  statement_id: Ref;
  kind: ReconStatementKind;
  row_no: number;
  row_key: string;
  txn_date: DateOnly;
  amount_paise: Paise;
  status_text: string | null;
  raw: ColumnType<unknown, string, string>;
  institution_id: Ref | null;
  matched_type: string | null;
  matched_id: Ref | null;
}

export interface ReconMismatchesTable {
  id: Generated<string>;
  public_id: Buffer;
  statement_id: Ref;
  row_id: Ref | null;
  institution_id: Ref | null;
  kind: ReconMismatchKind;
  platform_type: string | null;
  platform_id: Ref | null;
  platform_ref: string | null;
  statement_paise: NullablePaise;
  platform_paise: NullablePaise;
  status: ColumnType<ReconMismatchStatus, ReconMismatchStatus | undefined, ReconMismatchStatus>;
  resolution: ReconResolution | null;
  remarks: string | null;
  refund_id: Ref | null;
  chargeback_id: Ref | null;
  resolved_by: Buffer | null;
  resolved_at: NullableTimestamp;
  created_at: Timestamp;
  row_version: Version;
}

export interface RefundsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  ledger_txn_id: Ref;
  original_reference: string;
  from_wallet_id: Ref;
  to_wallet_id: Ref;
  amount_paise: Paise;
  status: ColumnType<RefundStatus, RefundStatus | undefined, RefundStatus>;
  source: RefundSource;
  reason: string;
  requested_by: Buffer | null;
  requested_at: Timestamp;
  decided_by: Buffer | null;
  decided_at: NullableTimestamp;
  decision_remarks: string | null;
  refund_reference: string | null;
  row_version: Version;
  live_key: ColumnType<string | null, never, never>;
}

export interface ChargebacksTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  ledger_txn_id: Ref;
  original_reference: string;
  wallet_id: Ref;
  amount_paise: Paise;
  reason_code: string;
  status: ColumnType<ChargebackStatus, ChargebackStatus | undefined, ChargebackStatus>;
  remarks: string | null;
  raised_by: Buffer | null;
  raised_at: Timestamp;
  decided_by: Buffer | null;
  decided_at: NullableTimestamp;
  completed_by: Buffer | null;
  completed_at: NullableTimestamp;
  outcome: ChargebackOutcome | null;
  reversal_reference: string | null;
  row_version: Version;
}

export interface ReconTables {
  recon_statements: ReconStatementsTable;
  recon_statement_rows: ReconStatementRowsTable;
  recon_mismatches: ReconMismatchesTable;
  refunds: RefundsTable;
  chargebacks: ChargebacksTable;
}

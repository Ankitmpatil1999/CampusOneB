/** Accounting vouchers and the platform fee rule per plan (migration 0047; SRS 13.13, 14.7). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Paise = ColumnType<string, number | string, number | string>;
type DateOnly = ColumnType<Date | string, string, string>;
type Version = ColumnType<number, number | undefined, number>;
type Flag = ColumnType<number, number | boolean | undefined, number | boolean>;

export type AccountingEvent = 'TUITION' | 'EVENT' | 'ALLOWANCE_CREDIT' | 'REFUND';
export type VoucherStatus = 'PENDING' | 'TRANSFERRED' | 'FAILED';

export interface AccountingSettingsTable {
  institution_id: Ref;
  company_name: string;
  enabled: Flag;
  enabled_at: NullableTimestamp;
  updated_by: Buffer | null;
  updated_at: Timestamp;
  row_version: Version;
}

export interface AccountingMappingsTable {
  institution_id: Ref;
  event: AccountingEvent;
  debit_ledger: string;
  credit_ledger: string;
}

export interface AccountingVouchersTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  ledger_txn_id: Ref;
  reference: string;
  event: AccountingEvent;
  voucher_date: DateOnly;
  amount_paise: Paise;
  company_name: string;
  debit_ledger: string;
  credit_ledger: string;
  narration: string | null;
  status: ColumnType<VoucherStatus, VoucherStatus | undefined, VoucherStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  last_error: string | null;
  next_attempt_at: NullableTimestamp;
  external_ref: string | null;
  transferred_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface PlatformFeeRulesTable {
  id: Generated<string>;
  plan_id: Ref;
  version: number;
  flat_paise: Paise;
  threshold_paise: Paise;
  boundary: 'INCLUSIVE' | 'EXCLUSIVE';
  basis_points: number;
  applies_to: ColumnType<unknown, string, string>;
  effective_from: DateOnly;
  remarks: string;
  created_by: Buffer | null;
  created_at: Timestamp;
}

export interface AccountingTables {
  accounting_settings: AccountingSettingsTable;
  accounting_mappings: AccountingMappingsTable;
  accounting_vouchers: AccountingVouchersTable;
  platform_fee_rules: PlatformFeeRulesTable;
}

/** Wallets, balances, virtual accounts and the ledger (migration 0027; docs/04 §3.3). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type DateOnly = ColumnType<Date | string, string, string>;

export type WalletKind = 'CAMPUS' | 'ALLOWANCE' | 'PERSONAL' | 'MERCHANT';
export type WalletStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
export type LedgerAccountKind =
  | 'WALLET'
  | 'BANK_POOL'
  | 'PAYOUT_CLEARING'
  | 'PLATFORM_FEE'
  | 'HELD_SUSPENSE'
  | 'REFUND_CLEARING'
  | 'CHARGEBACK_CLEARING'
  | 'COUPON_REIMBURSEMENT'
  | 'ADJUSTMENT'
  | 'ALLOWANCE_FUNDING';
export type LedgerTxnType =
  | 'PAYMENT'
  | 'TRANSFER'
  | 'BANK_CREDIT'
  | 'TUITION'
  | 'ALLOWANCE_CREDIT'
  | 'ALLOWANCE_PAYMENT'
  | 'COUPON_REDEMPTION'
  | 'EVENT'
  | 'REFUND'
  | 'REVERSAL'
  | 'CHARGEBACK'
  | 'SETTLEMENT_PAYOUT'
  | 'PLATFORM_FEE'
  | 'ADJUSTMENT'
  | 'HOLD_RELEASE'
  | 'ALLOWANCE_EXPIRY';

export interface WalletNumberSequencesTable {
  kind: 'CAMPUS' | 'ALLOWANCE' | 'PERSONAL';
  next_value: ColumnType<string, string | number, string | number>;
}

export interface WalletsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref | null;
  wallet_no: string;
  kind: WalletKind;
  owner_profile_id: Ref | null;
  owner_account_id: Ref | null;
  status: ColumnType<WalletStatus, WalletStatus | undefined, WalletStatus>;
  status_reason: string | null;
  status_changed_at: NullableTimestamp;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WalletBalancesTable {
  wallet_id: Ref;
  available_paise: ColumnType<string, number | string | undefined, number | string>;
  held_paise: ColumnType<string, number | string | undefined, number | string>;
  row_version: Generated<number>;
  last_ledger_txn_id: Ref | null;
  updated_at: Timestamp;
}

export interface VirtualAccountsTable {
  id: Generated<string>;
  institution_id: Ref;
  wallet_id: Ref;
  corporate_code: string;
  va_number: string;
  status: ColumnType<
    'ACTIVE' | 'INACTIVE',
    'ACTIVE' | 'INACTIVE' | undefined,
    'ACTIVE' | 'INACTIVE'
  >;
  created_at: Timestamp;
}

export interface LedgerAccountsTable {
  id: Generated<string>;
  institution_id: Ref | null;
  kind: LedgerAccountKind;
  wallet_id: Ref | null;
  name: string;
  scope_key: ColumnType<string, never, never>;
  created_at: Timestamp;
}

export interface LedgerTransactionsTable {
  id: Generated<string>;
  posted_on: DateOnly;
  public_id: Buffer;
  institution_id: Ref | null;
  reference: string;
  type: LedgerTxnType;
  channel: string;
  amount_paise: ColumnType<string, number | string, never>;
  idempotency_key: string;
  business_ref_type: string | null;
  business_ref_id: Ref | null;
  reversal_of_txn_id: Ref | null;
  narration: string | null;
  posted_at: Timestamp;
  actor_ref: Buffer | null;
  correlation_id: Buffer;
}

export interface LedgerEntriesTable {
  id: Generated<string>;
  posted_on: DateOnly;
  institution_id: Ref | null;
  ledger_txn_id: Ref;
  account_id: Ref;
  wallet_id: Ref | null;
  direction: 'D' | 'C';
  amount_paise: ColumnType<string, number | string, never>;
  balance_after_paise: ColumnType<string | null, number | string | null, never>;
  narration: string | null;
}

export interface LedgerIdempotencyTable {
  institution_id: ColumnType<string, string | number, never>;
  idempotency_key: string;
  ledger_txn_id: Ref;
  posted_on: DateOnly;
  created_at: Timestamp;
}

export interface SpendingCapsTable {
  account_id: Ref;
  enabled: ColumnType<number, number | boolean | undefined, number | boolean>;
  daily_amount_paise: ColumnType<string | null, number | string | null, number | string | null>;
  daily_count: number | null;
  row_version: Generated<number>;
  updated_at: Timestamp;
}

export interface WalletTables {
  spending_caps: SpendingCapsTable;
  wallet_number_sequences: WalletNumberSequencesTable;
  wallets: WalletsTable;
  wallet_balances: WalletBalancesTable;
  virtual_accounts: VirtualAccountsTable;
  ledger_accounts: LedgerAccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  ledger_idempotency: LedgerIdempotencyTable;
}

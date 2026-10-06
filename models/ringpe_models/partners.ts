/** Partner API clients, their tokens, signed-call replay guard and bank credits (migration 0031). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Json<T> = ColumnType<T, string, string>;

export type ApiClientStatus = 'ACTIVE' | 'INACTIVE';
export type BankCreditStatus = 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'HELD' | 'RETURNED';
export type BankCreditMode = 'UPI' | 'IMPS' | 'NEFT' | 'RTGS' | 'OTHER';

export interface ApiClientsTable {
  id: Generated<string>;
  public_id: Buffer;
  client_id: string;
  name: string;
  partner: string;
  institution_id: string | null;
  scopes: Json<string[]>;
  ip_allowlist: Json<string[]>;
  secret_enc: Buffer;
  previous_secret_enc: Buffer | null;
  previous_valid_until: NullableTimestamp;
  secret_rotated_at: Timestamp;
  status: ColumnType<ApiClientStatus, ApiClientStatus | undefined, ApiClientStatus>;
  status_reason: string | null;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApiClientTokensTable {
  id: Generated<string>;
  public_id: Buffer;
  api_client_id: Ref;
  outcome: 'ISSUED' | 'REFUSED';
  reason: string | null;
  scopes: Json<string[] | null> | null;
  ip_bin: Buffer | null;
  issued_at: Timestamp;
  expires_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoke_reason: string | null;
}

export interface PartnerRequestsTable {
  api_client_id: Ref;
  endpoint: string;
  request_id: string;
  body_hash: Buffer;
  status_code: number | null;
  response: ColumnType<unknown, string | null | undefined, string | null>;
  received_at: Timestamp;
}

export interface BankCreditsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref | null;
  wallet_id: Ref | null;
  va_number: string;
  utr: string;
  bank_txn_id: string;
  amount_paise: ColumnType<string, number | string, number | string>;
  mode: ColumnType<BankCreditMode, BankCreditMode | undefined, BankCreditMode>;
  sender_name: string | null;
  sender_account_last4: string | null;
  sender_ifsc: string | null;
  credited_at: Timestamp;
  status: ColumnType<BankCreditStatus, BankCreditStatus | undefined, BankCreditStatus>;
  response_code: string;
  ledger_txn_id: Ref | null;
  release_txn_id: Ref | null;
  return_instruction: string | null;
  status_reason: string | null;
  api_client_id: Ref | null;
  received_at: Timestamp;
  resolved_at: NullableTimestamp;
  row_version: Generated<number>;
}

export interface PartnerTables {
  api_clients: ApiClientsTable;
  api_client_tokens: ApiClientTokensTable;
  partner_requests: PartnerRequestsTable;
  bank_credits: BankCreditsTable;
}

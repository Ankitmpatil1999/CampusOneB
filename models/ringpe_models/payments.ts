/** Merchants, QR codes, payment requests and the engine's payment record (migration 0030; docs/04 §3.4). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Flag = ColumnType<number, number | boolean | undefined, number | boolean>;
type Paise = ColumnType<string, number | string, number | string>;

export type MerchantSubType = 'REGULAR' | 'VENDOR';
export type MerchantQrKind = 'PAYMENT' | 'ALLOWANCE' | 'COUPON';
export type MerchantQrStatus = 'ACTIVE' | 'INACTIVE';
export type PaymentRequestKind = 'DYNAMIC_QR' | 'NFC';
export type PaymentInstrument = 'WALLET' | 'ALLOWANCE';
export type PaymentRequestStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type PaymentAttemptStatus = 'PENDING' | 'SUCCESS' | 'FAILURE';

export interface MerchantsTable {
  profile_id: Ref;
  institution_id: Ref;
  unique_id: string;
  display_name: string;
  sub_type: ColumnType<MerchantSubType, MerchantSubType | undefined, MerchantSubType>;
  holder_name: string | null;
  bank_name: string | null;
  acct_enc: Buffer | null;
  acct_bidx: Buffer | null;
  acct_last4: string | null;
  ifsc: string | null;
  cheque_file_id: Ref | null;
  logo_file_id: Ref | null;
  accepts_allowance: Flag;
  accepts_coupon: Flag;
  dynamic_qr_enabled: Flag;
  nfc_enabled: Flag;
  is_fee_account: Flag;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MerchantQrCodesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  merchant_profile_id: Ref;
  kind: MerchantQrKind;
  token: string;
  status: ColumnType<MerchantQrStatus, MerchantQrStatus | undefined, MerchantQrStatus>;
  status_reason: string | null;
  reissued_from_id: Ref | null;
  created_by: Buffer | null;
  created_at: Timestamp;
  status_changed_at: NullableTimestamp;
  row_version: Generated<number>;
  active_key: ColumnType<string | null, never, never>;
}

export interface PaymentRequestsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  merchant_profile_id: Ref;
  kind: PaymentRequestKind;
  instrument: ColumnType<PaymentInstrument, PaymentInstrument | undefined, PaymentInstrument>;
  order_id: Ref | null;
  terminal_id: Ref | null;
  api_client_id: Ref | null;
  amount_paise: Paise;
  token: string;
  nonce_hash: Buffer | null;
  status: ColumnType<PaymentRequestStatus, PaymentRequestStatus | undefined, PaymentRequestStatus>;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  payer_profile_id: Ref | null;
  payment_attempt_id: Ref | null;
  failure_code: string | null;
  created_by: Buffer | null;
  created_at: Timestamp;
  row_version: Generated<number>;
}

export interface PaymentAttemptsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  reference: string;
  channel: string;
  mode: number | null;
  instrument: ColumnType<PaymentInstrument, PaymentInstrument | undefined, PaymentInstrument>;
  payer_profile_id: Ref;
  payee_profile_id: Ref;
  payer_wallet_id: Ref | null;
  payee_wallet_id: Ref | null;
  amount_paise: Paise;
  status: ColumnType<PaymentAttemptStatus, PaymentAttemptStatus | undefined, PaymentAttemptStatus>;
  failed_check: string | null;
  failure_code: string | null;
  failure_params: ColumnType<unknown, string | null | undefined, string | null>;
  remarks: string | null;
  qr_code_id: Ref | null;
  request_id: Ref | null;
  event_ref: string | null;
  fee_record_id: Ref | null;
  order_ref: string | null;
  asset_ref: string | null;
  invoice_no: string | null;
  ledger_txn_id: Ref | null;
  idempotency_key: string;
  actor_ref: Buffer | null;
  attempted_at: Timestamp;
  completed_at: NullableTimestamp;
}

export interface PaymentTables {
  merchants: MerchantsTable;
  merchant_qr_codes: MerchantQrCodesTable;
  payment_requests: PaymentRequestsTable;
  payment_attempts: PaymentAttemptsTable;
}

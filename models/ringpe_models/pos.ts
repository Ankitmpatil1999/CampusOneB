/** The canteen point of sale: outlet, menu, operator tags, orders and offline captures (0038). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Paise = ColumnType<string, number | string, number | string>;
type Flag = ColumnType<number, number | boolean | undefined, number | boolean>;
type DateOnly = ColumnType<Date | string, string, string>;

export type PosTagStatus = 'ACTIVE' | 'INACTIVE';
export type PosOrderStatus = 'CREATED' | 'PAID' | 'CANCELLED';
export type PosOrderType = 'DINE_IN' | 'TAKEAWAY';
export type PosInstrument = 'WALLET' | 'ALLOWANCE' | 'COUPON';
export type PosCaptureOutcome = 'PROCESSING' | 'ACCEPTED' | 'REFUSED';
export type PosFoodType = 'VEG' | 'NON_VEG';

export interface PosOutletsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  merchant_profile_id: Ref;
  name: string;
  opens_at: string | null;
  closes_at: string | null;
  gstin: string | null;
  order_day: ColumnType<Date | string | null, string | null | undefined, string | null>;
  order_seq: Generated<number>;
  row_version: Generated<number>;
  updated_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PosCategoriesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  outlet_id: Ref;
  name: string;
  created_by: Buffer | null;
  created_at: Timestamp;
}

export interface PosItemsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  outlet_id: Ref;
  category_id: Ref;
  name: string;
  description: string | null;
  food_type: PosFoodType | null;
  price_paise: Paise;
  gst_bp: number;
  available: Flag;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PosOperatorTagsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  outlet_id: Ref;
  operator_name: string;
  mobile: string;
  token_hash: Buffer;
  token_last4: string;
  status: ColumnType<PosTagStatus, PosTagStatus | undefined, PosTagStatus>;
  reissue_count: Generated<number>;
  replaces_id: Ref | null;
  reissue_reason: string | null;
  ended_at: NullableTimestamp;
  issued_by_terminal: Ref | null;
  issued_at: Timestamp;
  live_key: ColumnType<string | null, never, never>;
}

export interface PosOrdersTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  outlet_id: Ref;
  terminal_id: Ref;
  operator_tag_id: Ref | null;
  order_no: string;
  business_date: DateOnly;
  order_type: PosOrderType;
  subtotal_paise: Paise;
  tax_paise: Paise;
  total_paise: Paise;
  status: ColumnType<PosOrderStatus, PosOrderStatus | undefined, PosOrderStatus>;
  instrument: PosInstrument | null;
  payer_profile_id: Ref | null;
  payment_attempt_id: Ref | null;
  coupon_redemption_id: Ref | null;
  last_failure_code: string | null;
  offline: Flag;
  paid_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
  cancel_reason: string | null;
  row_version: Generated<number>;
  created_at: Timestamp;
}

export interface PosOrderLinesTable {
  order_id: Ref;
  line_no: number;
  item_id: Ref;
  name: string;
  unit_price_paise: Paise;
  qty: number;
  gst_bp: number;
  net_paise: Paise;
  tax_paise: Paise;
  total_paise: Paise;
}

export interface PosOfflineBatchesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  terminal_id: Ref;
  api_client_id: Ref | null;
  captures: number;
  received_at: Timestamp;
}

export interface PosOfflineCapturesTable {
  id: Generated<string>;
  institution_id: Ref;
  terminal_id: Ref;
  batch_id: Ref;
  capture_key: string;
  order_id: Ref | null;
  card_last4: string | null;
  payer_profile_id: Ref | null;
  instrument: 'WALLET' | 'ALLOWANCE';
  amount_paise: Paise;
  captured_at: Timestamp;
  outcome: ColumnType<PosCaptureOutcome, PosCaptureOutcome | undefined, PosCaptureOutcome>;
  refusal_code: string | null;
  payment_attempt_id: Ref | null;
  processed_at: NullableTimestamp;
}

export interface PosOfflineBatchItemsTable {
  batch_id: Ref;
  capture_id: Ref;
  seq: number;
  replayed: Flag;
}

export interface PosTables {
  pos_outlets: PosOutletsTable;
  pos_categories: PosCategoriesTable;
  pos_items: PosItemsTable;
  pos_operator_tags: PosOperatorTagsTable;
  pos_orders: PosOrdersTable;
  pos_order_lines: PosOrderLinesTable;
  pos_offline_batches: PosOfflineBatchesTable;
  pos_offline_captures: PosOfflineCapturesTable;
  pos_offline_batch_items: PosOfflineBatchItemsTable;
}

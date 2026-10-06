/** Meal coupons and coupon types (migration 0036; SRS 11, CR-15). TIME columns arrive as 'HH:MM:SS'. */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DateOnly = ColumnType<Date | string, string, string>;
type Paise = ColumnType<string, number | string | undefined, number | string>;

export type CouponTypeKind = 'MEAL' | 'NUTRITION' | 'EVENT' | 'OTHER';
export type CouponPeriod = 'DAY' | 'WEEK' | 'MONTH';
export type CouponStatus = 'ACTIVE' | 'USED' | 'EXPIRED';

export interface CouponSlotsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  start_time: string;
  end_time: string;
  sort_order: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CouponTypesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  kind: CouponTypeKind;
  description: string | null;
  slot_id: Ref | null;
  window_start: string | null;
  window_end: string | null;
  value_paise: Paise;
  hold_max: number;
  redeem_max: number;
  redeem_period: ColumnType<CouponPeriod, CouponPeriod | undefined, CouponPeriod>;
  accepts_all: ColumnType<number, number | boolean | undefined, number | boolean>;
  issue_from: DateOnly | null;
  issue_to: DateOnly | null;
  status: ColumnType<
    'ACTIVE' | 'INACTIVE',
    'ACTIVE' | 'INACTIVE' | undefined,
    'ACTIVE' | 'INACTIVE'
  >;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CouponTypeMerchantsTable {
  type_id: Ref;
  merchant_profile_id: Ref;
}

export interface CouponIssuancesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  from_date: DateOnly;
  to_date: DateOnly;
  excluded_dates: ColumnType<unknown, string, string>;
  type_ids: ColumnType<unknown, string, string>;
  students: number;
  created_count: number;
  skipped_count: number;
  refused_count: number;
  issued_by: Buffer | null;
  created_at: Timestamp;
}

export interface CouponsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  profile_id: Ref;
  type_id: Ref;
  issuance_id: Ref;
  valid_on: DateOnly;
  window_start: string;
  window_end: string;
  value_paise: Paise;
  accepts_all: ColumnType<number, number | boolean, number | boolean>;
  accepts: ColumnType<unknown, string | null, string | null>;
  status: ColumnType<CouponStatus, CouponStatus | undefined, CouponStatus>;
  ended_reason: 'LAPSED' | 'CANCELLED' | null;
  cancel_reason: string | null;
  used_at: Date | null;
  ended_at: Date | null;
  created_at: Timestamp;
}

export interface CouponRedemptionsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  coupon_id: Ref;
  profile_id: Ref;
  merchant_profile_id: Ref;
  channel: 'QR' | 'READER';
  terminal_id: Ref | null;
  status: ColumnType<'REDEEMED', 'REDEEMED' | undefined, never>;
  redeemed_at: Date;
}

export interface CouponTapsTable {
  id: Generated<string>;
  institution_id: Ref;
  terminal_id: Ref;
  tap_ref: string;
  profile_id: Ref;
  expires_at: Date;
  redemption_id: Ref | null;
  created_at: Timestamp;
}

export interface CouponTables {
  coupon_slots: CouponSlotsTable;
  coupon_types: CouponTypesTable;
  coupon_type_merchants: CouponTypeMerchantsTable;
  coupon_issuances: CouponIssuancesTable;
  coupons: CouponsTable;
  coupon_redemptions: CouponRedemptionsTable;
  coupon_taps: CouponTapsTable;
}

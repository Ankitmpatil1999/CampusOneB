/** Asset groups, assets and vendor links (migration 0034). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Status = ColumnType<
  'ACTIVE' | 'INACTIVE',
  'ACTIVE' | 'INACTIVE' | undefined,
  'ACTIVE' | 'INACTIVE'
>;

export type AssetType = 'PHYSICAL' | 'DIGITAL' | 'SERVICE' | 'OTHER';

export interface AssetGroupsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  description: string | null;
  status: Status;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AssetsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  group_id: Ref;
  name: string;
  type: AssetType;
  description: string | null;
  status: Status;
  row_version: Generated<number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MerchantAssetGroupsTable {
  merchant_profile_id: Ref;
  group_id: Ref;
  linked_by: Buffer | null;
  linked_at: Timestamp;
}

export interface AssetTables {
  asset_groups: AssetGroupsTable;
  assets: AssetsTable;
  merchant_asset_groups: MerchantAssetGroupsTable;
}

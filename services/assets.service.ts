/**
 * Asset groups, assets and vendor links (SRS 7.6, 7.7, 12.6, 9.11; INS-020…026, PAY-015, MER-013;
 * prototype c.assets and the vendor section of c.merchants).
 *
 * - Groups and assets are Active or Inactive (27.2); names are unique per institution (groups) and per
 *   group (assets).
 * - A vendor merchant is linked to groups. Linking sets the vendor's groups: an inactive group is not
 *   newly linked, nor de-linked (27.2), and is reported as skipped.
 * - A vendor payment must name an Active asset of an Active group linked to that vendor; the engine
 *   checks it (P4) with `approvedAsset`.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { AssetType, Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError, PreconditionFailedError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import type { MerchantsService } from './merchants.service';

type Db = Kysely<Database> | Transaction<Database>;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** Whether `assetRef` names an Active asset of an Active group linked to the vendor (engine P4). */
export async function approvedAsset(
  db: Db,
  institutionId: string,
  vendorProfileId: string,
  assetRef: string,
): Promise<boolean> {
  if (!isUuid(assetRef)) return false;
  const r = await db
    .selectFrom('assets as a')
    .innerJoin('asset_groups as g', 'g.id', 'a.group_id')
    .innerJoin('merchant_asset_groups as mag', 'mag.group_id', 'g.id')
    .select('a.id')
    .where('a.institution_id', '=', institutionId)
    .where('a.public_id', '=', uuidToBin(assetRef))
    .where('a.status', '=', 'ACTIVE')
    .where('g.status', '=', 'ACTIVE')
    .where('mag.merchant_profile_id', '=', vendorProfileId)
    .executeTakeFirst();
  return !!r;
}

export class AssetsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly merchants: MerchantsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async own(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    return row;
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async group(institutionId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const g = await this.deps.db
      .selectFrom('asset_groups')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!g) throw new NotFoundError();
    return g;
  }

  // --- INS-020 ------------------------------------------------------------------------------------
  async groups(p: Principal, f: { status?: 'ACTIVE' | 'INACTIVE' | undefined }) {
    const inst = await this.own(p);
    let q = this.deps.db
      .selectFrom('asset_groups as g')
      .select([
        'g.public_id',
        'g.name',
        'g.description',
        'g.status',
        'g.row_version',
        (eb) =>
          eb
            .selectFrom('assets as a')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('a.group_id', '=', 'g.id')
            .as('assets'),
        (eb) =>
          eb
            .selectFrom('merchant_asset_groups as m')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('m.group_id', '=', 'g.id')
            .as('vendors'),
      ])
      .where('g.institution_id', '=', inst.id);
    if (f.status) q = q.where('g.status', '=', f.status);
    const rows = await q.orderBy('g.name').execute();
    return {
      items: rows.map((g) => ({
        id: binToUuid(g.public_id),
        name: g.name,
        description: g.description,
        status: g.status,
        assets: Number(g.assets ?? 0),
        vendors: Number(g.vendors ?? 0),
        version: g.row_version,
      })),
    };
  }

  // --- INS-021 ------------------------------------------------------------------------------------
  async createGroup(
    p: Principal,
    input: {
      name: string;
      description?: string | null | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
    },
  ) {
    const inst = await this.own(p);
    const pub = newPublicIdPair();
    try {
      await this.deps.db
        .insertInto('asset_groups')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          status: input.status ?? 'ACTIVE',
          created_by: this.by(p),
          created_at: this.now(),
          updated_at: this.now(),
        })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'INS.ASSET_GROUP_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'ASSET_GROUP_CREATED',
      entityType: 'asset_group',
      entityRef: pub.id,
      after: { name: input.name },
    });
    return { groupId: pub.id };
  }

  // --- INS-022 ------------------------------------------------------------------------------------
  async updateGroup(
    p: Principal,
    id: string,
    expected: number,
    patch: {
      name?: string | undefined;
      description?: string | null | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
    },
  ) {
    const inst = await this.own(p);
    const g = await this.group(inst.id, id);
    if (g.row_version !== expected) throw new PreconditionFailedError();
    try {
      await this.deps.db
        .updateTable('asset_groups')
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description?.trim() || null }
            : {}),
          ...(patch.status ? { status: patch.status } : {}),
          row_version: sql<number>`row_version + 1`,
          updated_at: this.now(),
        })
        .where('id', '=', g.id)
        .where('row_version', '=', expected)
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'INS.ASSET_GROUP_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'ASSET_GROUP_UPDATED',
      entityType: 'asset_group',
      entityRef: id.toLowerCase(),
      before: { name: g.name, status: g.status },
      after: { ...patch },
    });
    return (await this.groups(p, {})).items.find((x) => x.id === id.toLowerCase())!;
  }

  // --- INS-023 ------------------------------------------------------------------------------------
  async assets(
    p: Principal,
    f: { groupId?: string | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined },
  ) {
    const inst = await this.own(p);
    let q = this.deps.db
      .selectFrom('assets as a')
      .innerJoin('asset_groups as g', 'g.id', 'a.group_id')
      .select([
        'a.public_id',
        'a.name',
        'a.type',
        'a.description',
        'a.status',
        'a.row_version',
        'g.public_id as group_public_id',
        'g.name as group_name',
      ])
      .where('a.institution_id', '=', inst.id);
    if (f.groupId) {
      if (!isUuid(f.groupId)) return { items: [] };
      q = q.where('g.public_id', '=', uuidToBin(f.groupId));
    }
    if (f.status) q = q.where('a.status', '=', f.status);
    const rows = await q.orderBy('g.name').orderBy('a.name').execute();
    return {
      items: rows.map((a) => ({
        id: binToUuid(a.public_id),
        group: { id: binToUuid(a.group_public_id), name: a.group_name },
        name: a.name,
        type: a.type,
        description: a.description,
        status: a.status,
        version: a.row_version,
      })),
    };
  }

  // --- INS-024 ------------------------------------------------------------------------------------
  async createAsset(
    p: Principal,
    input: {
      groupId: string;
      name: string;
      type: AssetType;
      description?: string | null | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
    },
  ) {
    const inst = await this.own(p);
    const g = await this.group(inst.id, input.groupId);
    const pub = newPublicIdPair();
    try {
      await this.deps.db
        .insertInto('assets')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          group_id: g.id,
          name: input.name.trim(),
          type: input.type,
          description: input.description?.trim() || null,
          status: input.status ?? 'ACTIVE',
          created_by: this.by(p),
          created_at: this.now(),
          updated_at: this.now(),
        })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'INS.ASSET_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'ASSET_CREATED',
      entityType: 'asset',
      entityRef: pub.id,
      after: { name: input.name, group: input.groupId, type: input.type },
    });
    return { assetId: pub.id };
  }

  // --- INS-025 ------------------------------------------------------------------------------------
  async updateAsset(
    p: Principal,
    id: string,
    expected: number,
    patch: {
      name?: string | undefined;
      type?: AssetType | undefined;
      description?: string | null | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
    },
  ) {
    const inst = await this.own(p);
    if (!isUuid(id)) throw new NotFoundError();
    const a = await this.deps.db
      .selectFrom('assets')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!a) throw new NotFoundError();
    if (a.row_version !== expected) throw new PreconditionFailedError();
    try {
      await this.deps.db
        .updateTable('assets')
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.type ? { type: patch.type } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description?.trim() || null }
            : {}),
          ...(patch.status ? { status: patch.status } : {}),
          row_version: sql<number>`row_version + 1`,
          updated_at: this.now(),
        })
        .where('id', '=', a.id)
        .where('row_version', '=', expected)
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'INS.ASSET_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'ASSET_UPDATED',
      entityType: 'asset',
      entityRef: id.toLowerCase(),
      before: { name: a.name, status: a.status },
      after: { ...patch },
    });
    return (await this.assets(p, {})).items.find((x) => x.id === id.toLowerCase())!;
  }

  /** The vendor's linked groups. */
  private async linked(merchantProfileId: string) {
    return this.deps.db
      .selectFrom('merchant_asset_groups as m')
      .innerJoin('asset_groups as g', 'g.id', 'm.group_id')
      .select(['g.id', 'g.public_id', 'g.name', 'g.status'])
      .where('m.merchant_profile_id', '=', merchantProfileId)
      .execute();
  }

  // --- INS-037 ------------------------------------------------------------------------------------
  /** A vendor's linked asset groups (what INS-026 saves). */
  async vendorGroups(p: Principal, merchantId: string) {
    const inst = await this.own(p);
    if (!isUuid(merchantId)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as mp')
      .innerJoin('merchants as mer', 'mer.profile_id', 'mp.id')
      .select(['mp.id', 'mer.sub_type'])
      .where('mp.institution_id', '=', inst.id)
      .where('mp.public_id', '=', uuidToBin(merchantId))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    const linked = m.sub_type === 'VENDOR' ? await this.linked(String(m.id)) : [];
    return {
      linked: linked.map((g) => ({ id: binToUuid(g.public_id), name: g.name, status: g.status })),
      skipped: [],
    };
  }

  // --- INS-026 ------------------------------------------------------------------------------------
  async linkVendor(p: Principal, merchantId: string, input: { groupIds: readonly string[] }) {
    const inst = await this.own(p);
    if (!isUuid(merchantId)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as mp')
      .innerJoin('merchants as mer', 'mer.profile_id', 'mp.id')
      .select(['mp.id', 'mer.sub_type'])
      .where('mp.institution_id', '=', inst.id)
      .where('mp.public_id', '=', uuidToBin(merchantId))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    if (m.sub_type !== 'VENDOR') throw new CustomAPIError(409, 'MER.NOT_VENDOR');
    const wanted = new Set(input.groupIds.filter(isUuid).map((x) => x.toLowerCase()));
    const groups = await this.deps.db
      .selectFrom('asset_groups')
      .select(['id', 'public_id', 'status'])
      .where('institution_id', '=', inst.id)
      .execute();
    const byId = new Map(groups.map((g) => [binToUuid(g.public_id), g]));
    const current = await this.linked(String(m.id));
    const currentIds = new Set(current.map((g) => binToUuid(g.public_id)));
    const skipped: { groupId: string; reason: 'INACTIVE' | 'UNKNOWN' }[] = [];
    await this.deps.db.transaction().execute(async (trx) => {
      for (const id of wanted) {
        if (currentIds.has(id)) continue;
        const g = byId.get(id);
        if (!g) {
          skipped.push({ groupId: id, reason: 'UNKNOWN' });
          continue;
        }
        if (g.status !== 'ACTIVE') {
          skipped.push({ groupId: id, reason: 'INACTIVE' });
          continue;
        }
        await trx
          .insertInto('merchant_asset_groups')
          .values({
            merchant_profile_id: m.id,
            group_id: g.id,
            linked_by: this.by(p),
            linked_at: this.now(),
          })
          .execute();
      }
      for (const g of current) {
        const id = binToUuid(g.public_id);
        if (wanted.has(id)) continue;
        if (g.status !== 'ACTIVE') {
          skipped.push({ groupId: id, reason: 'INACTIVE' });
          continue;
        }
        await trx
          .deleteFrom('merchant_asset_groups')
          .where('merchant_profile_id', '=', m.id)
          .where('group_id', '=', g.id)
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'VENDOR_ASSET_GROUPS_SET',
        entityType: 'merchant',
        entityRef: merchantId.toLowerCase(),
        before: { groups: [...currentIds] },
        after: { groups: [...wanted], skipped },
      });
    });
    const after = await this.linked(String(m.id));
    return {
      linked: after.map((g) => ({ id: binToUuid(g.public_id), name: g.name, status: g.status })),
      skipped,
    };
  }

  // --- PAY-015 ------------------------------------------------------------------------------------
  async vendorAssets(p: Principal) {
    const { inst, m } = await this.deps.merchants.self(p);
    if (m.sub_type !== 'VENDOR') return { items: [] };
    const rows = await this.deps.db
      .selectFrom('assets as a')
      .innerJoin('asset_groups as g', 'g.id', 'a.group_id')
      .innerJoin('merchant_asset_groups as mag', 'mag.group_id', 'g.id')
      .select([
        'a.public_id',
        'a.name',
        'a.type',
        'a.description',
        'g.public_id as group_public_id',
        'g.name as group_name',
      ])
      .where('a.institution_id', '=', inst.id)
      .where('mag.merchant_profile_id', '=', m.id)
      .where('a.status', '=', 'ACTIVE')
      .where('g.status', '=', 'ACTIVE')
      .orderBy('g.name')
      .orderBy('a.name')
      .execute();
    return {
      items: rows.map((a) => ({
        id: binToUuid(a.public_id),
        name: a.name,
        type: a.type,
        description: a.description,
        group: { id: binToUuid(a.group_public_id), name: a.group_name },
      })),
    };
  }

  // --- MER-013 ------------------------------------------------------------------------------------
  async vendorInvoices(
    p: Principal,
    f: { merchantId?: string | undefined; from?: string | undefined; to?: string | undefined },
  ) {
    const inst = await this.own(p);
    let q = this.deps.db
      .selectFrom('payment_attempts as pa')
      .innerJoin('merchants as mer', 'mer.profile_id', 'pa.payee_profile_id')
      .innerJoin('member_profiles as payee', 'payee.id', 'pa.payee_profile_id')
      .innerJoin('member_profiles as payer', 'payer.id', 'pa.payer_profile_id')
      .select([
        'pa.reference',
        'pa.invoice_no',
        'pa.asset_ref',
        'pa.amount_paise',
        'pa.completed_at',
        'mer.display_name',
        'payee.public_id as merchant_public_id',
        'payer.first_name',
        'payer.last_name',
      ])
      .where('pa.institution_id', '=', inst.id)
      .where('pa.status', '=', 'SUCCESS')
      .where('pa.invoice_no', 'is not', null);
    if (f.merchantId && isUuid(f.merchantId))
      q = q.where('payee.public_id', '=', uuidToBin(f.merchantId));
    if (f.from) q = q.where('pa.completed_at', '>=', new Date(`${f.from}T00:00:00+05:30`));
    if (f.to) q = q.where('pa.completed_at', '<=', new Date(`${f.to}T23:59:59.999+05:30`));
    const rows = await q.orderBy('pa.id', 'desc').limit(500).execute();
    const assetIds = [
      ...new Set(rows.map((r) => r.asset_ref).filter((x): x is string => !!x && isUuid(x))),
    ];
    const assets = assetIds.length
      ? await this.deps.db
          .selectFrom('assets')
          .select(['public_id', 'name'])
          .where('public_id', 'in', assetIds.map(uuidToBin))
          .execute()
      : [];
    const assetName = new Map(assets.map((a) => [binToUuid(a.public_id), a.name]));
    return {
      items: rows.map((r) => ({
        reference: r.reference,
        merchant: { id: binToUuid(r.merchant_public_id), name: r.display_name },
        invoiceNo: r.invoice_no!,
        asset: r.asset_ref
          ? { id: r.asset_ref, name: assetName.get(r.asset_ref.toLowerCase()) ?? null }
          : null,
        amount: toMoneyDto(Number(r.amount_paise)),
        paidAt: iso(r.completed_at),
        payer: titleCase([r.first_name, r.last_name].filter(Boolean).join(' ')),
      })),
    };
  }
}

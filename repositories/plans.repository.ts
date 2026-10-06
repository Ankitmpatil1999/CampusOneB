/**
 * Plans (FR-SAS-05; SAS-027…029; prototype o.plans): a plan's name and description, and its terms by
 * version (price, cycle, trial, modules, allowances, platform fee). A subscription keeps its version
 * until renewal; a plan's current version applies to new subscriptions.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';

type Db = Kysely<Database> | Transaction<Database>;

export type AllowanceKey = 'MEMBERS' | 'SMS' | 'WHATSAPP' | 'STORAGE_GB';

export interface PlanTerms {
  readonly id: number;
  readonly public_id: Buffer;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly row_version: number;
  readonly version_id: number;
  readonly version: number;
  readonly cycle: 'MONTHLY' | 'ANNUAL';
  readonly price_paise: number;
  readonly trial_days: number;
  readonly modules: readonly string[];
  readonly allowances: Readonly<Record<AllowanceKey, number>>;
  readonly fee: {
    readonly flatPaise: number;
    readonly thresholdPaise: number;
    readonly percentBp: number;
  };
}

export interface VersionInput {
  readonly cycle: 'MONTHLY' | 'ANNUAL';
  readonly pricePaise: number;
  readonly trialDays: number;
  readonly modules: readonly string[];
  readonly members: number;
  readonly sms: number;
  readonly whatsapp: number;
  readonly storageGb: number;
  readonly feeFlatPaise: number;
  readonly feeThresholdPaise: number;
  readonly feePercentBp: number;
}

const VERSION_COLUMNS = [
  'v.id as version_id',
  'v.version',
  'v.cycle',
  'v.price_paise',
  'v.trial_days',
  'v.members',
  'v.sms_per_month',
  'v.whatsapp_per_month',
  'v.storage_gb',
  'v.fee_flat_paise',
  'v.fee_threshold_paise',
  'v.fee_percent_bp',
] as const;

async function withModules(
  db: Db,
  rows: readonly {
    id: number;
    public_id: Buffer;
    code: string;
    name: string;
    description: string | null;
    row_version: number;
    version_id: number;
    version: number;
    cycle: 'MONTHLY' | 'ANNUAL';
    price_paise: string | number;
    trial_days: number;
    members: number;
    sms_per_month: number;
    whatsapp_per_month: number;
    storage_gb: number;
    fee_flat_paise: string | number;
    fee_threshold_paise: string | number;
    fee_percent_bp: number;
  }[],
): Promise<PlanTerms[]> {
  if (rows.length === 0) return [];
  const modules = await db
    .selectFrom('plan_version_modules')
    .selectAll()
    .where(
      'plan_version_id',
      'in',
      rows.map((r) => r.version_id),
    )
    .execute();
  return rows.map((r) => ({
    id: r.id,
    public_id: r.public_id,
    code: r.code,
    name: r.name,
    description: r.description,
    row_version: r.row_version,
    version_id: r.version_id,
    version: r.version,
    cycle: r.cycle,
    price_paise: Number(r.price_paise),
    trial_days: r.trial_days,
    modules: modules.filter((m) => m.plan_version_id === r.version_id).map((m) => m.module_key),
    allowances: {
      MEMBERS: r.members,
      SMS: r.sms_per_month,
      WHATSAPP: r.whatsapp_per_month,
      STORAGE_GB: r.storage_gb,
    },
    fee: {
      flatPaise: Number(r.fee_flat_paise),
      thresholdPaise: Number(r.fee_threshold_paise),
      percentBp: r.fee_percent_bp,
    },
  }));
}

export const plansRepository = {
  /** Every plan with its current terms, cheapest first. */
  async plans(db: Db): Promise<PlanTerms[]> {
    const rows = await db
      .selectFrom('plans as p')
      .innerJoin('plan_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.id', 'p.public_id', 'p.code', 'p.name', 'p.description', 'p.row_version'])
      .select(VERSION_COLUMNS)
      .orderBy('v.price_paise')
      .orderBy('p.id')
      .execute();
    return withModules(db, rows);
  },

  /** A plan's terms at one version (the version a subscription is on). */
  async atVersion(db: Db, versionId: number): Promise<PlanTerms | undefined> {
    const rows = await db
      .selectFrom('plan_versions as v')
      .innerJoin('plans as p', 'p.id', 'v.plan_id')
      .select(['p.id', 'p.public_id', 'p.code', 'p.name', 'p.description', 'p.row_version'])
      .select(VERSION_COLUMNS)
      .where('v.id', '=', versionId)
      .execute();
    return (await withModules(db, rows))[0];
  },

  async byPublicId(db: Db, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('plans')
      .select([
        'id',
        'public_id',
        'code',
        'name',
        'description',
        'current_version_id',
        'row_version',
      ])
      .where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async nameTaken(db: Db, name: string, exceptId?: number) {
    let q = db
      .selectFrom('plans')
      .select('id')
      .where(sql<string>`LOWER(name)`, '=', name.toLowerCase());
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  },

  async nextCode(db: Db) {
    const r = await db
      .selectFrom('plans')
      .select((e) => e.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    return Number(r?.n ?? 0) + 1;
  },

  async insertPlan(
    db: Db,
    v: {
      publicId: Buffer;
      code: string;
      name: string;
      description: string | null;
      by: Buffer | null;
    },
  ) {
    const r = await db
      .insertInto('plans')
      .values({
        public_id: v.publicId,
        code: v.code,
        name: v.name,
        description: v.description,
        current_version_id: null,
        created_by: v.by,
      })
      .executeTakeFirstOrThrow();
    return Number(r.insertId);
  },

  /** Appends a version and makes it the plan's current terms. */
  async addVersion(db: Db, planId: number, terms: VersionInput, by: Buffer | null) {
    const last = await db
      .selectFrom('plan_versions')
      .select((e) => e.fn.max('version').as('v'))
      .where('plan_id', '=', planId)
      .executeTakeFirst();
    const version = Number(last?.v ?? 0) + 1;
    const r = await db
      .insertInto('plan_versions')
      .values({
        plan_id: planId,
        version,
        cycle: terms.cycle,
        price_paise: terms.pricePaise,
        trial_days: terms.trialDays,
        members: terms.members,
        sms_per_month: terms.sms,
        whatsapp_per_month: terms.whatsapp,
        storage_gb: terms.storageGb,
        fee_flat_paise: terms.feeFlatPaise,
        fee_threshold_paise: terms.feeThresholdPaise,
        fee_percent_bp: terms.feePercentBp,
        created_by: by,
      })
      .executeTakeFirstOrThrow();
    const versionId = Number(r.insertId);
    for (const m of terms.modules) {
      await db
        .insertInto('plan_version_modules')
        .values({ plan_version_id: versionId, module_key: m })
        .execute();
    }
    await db
      .updateTable('plans')
      .set({ current_version_id: versionId, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
      .where('id', '=', planId)
      .execute();
    return { versionId, version };
  },

  /** Name and description; optimistic (ETag). */
  async update(
    db: Db,
    planId: number,
    expected: number,
    set: { name?: string; description?: string | null },
  ) {
    const r = await db
      .updateTable('plans')
      .set({
        ...set,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', planId)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Institutions on each plan, cancelled ones excluded. */
  async institutionCounts(db: Db) {
    return db
      .selectFrom('subscriptions as s')
      .innerJoin('institutions as i', 'i.id', 's.institution_id')
      .select(['s.plan_id', (e) => e.fn.countAll<number>().as('n')])
      .where('i.status', '!=', 'CANCELLED')
      .groupBy('s.plan_id')
      .execute();
  },
};

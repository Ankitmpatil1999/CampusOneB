/**
 * Plans (FR-SAS-05; SAS-027…029; prototype o.plans; client 2026-10-03: "give a provision to change and
 * add the plans"). A plan bundles modules, usage allowances, a price and cycle, a trial and the platform
 * fee on merchant transactions. Changing the terms adds a version: institutions on the plan keep their
 * version until renewal; the new terms apply to new subscriptions and at renewal.
 */
import type { Kysely } from 'kysely';
import { MODULES } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { plansRepository as repo, type PlanTerms } from '../repositories/plans.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';

export interface PlanInput {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly cycle: 'MONTHLY' | 'ANNUAL';
  readonly pricePaise: number;
  readonly trialDays: number;
  readonly modules: readonly string[];
  readonly allowances: {
    readonly members: number;
    readonly sms: number;
    readonly whatsapp: number;
    readonly storageGb: number;
  };
  readonly platformFee: {
    readonly flatPaise: number;
    readonly upToPaise: number;
    readonly percentBp: number;
  };
}

/** The API view of a plan's terms (money as {amount, currency}). */
export function planDto(p: PlanTerms, institutions?: number) {
  return {
    id: binToUuid(p.public_id),
    code: p.code,
    name: p.name,
    description: p.description,
    version: p.version,
    cycle: p.cycle,
    price: toMoneyDto(p.price_paise),
    trialDays: p.trial_days,
    modules: [...p.modules],
    allowances: {
      members: p.allowances.MEMBERS,
      sms: p.allowances.SMS,
      whatsapp: p.allowances.WHATSAPP,
      storageGb: p.allowances.STORAGE_GB,
    },
    platformFee: {
      flat: toMoneyDto(p.fee.flatPaise),
      upTo: toMoneyDto(p.fee.thresholdPaise),
      percent: (p.fee.percentBp / 100).toFixed(2),
    },
    ...(institutions === undefined ? {} : { institutions }),
    etag: p.row_version,
  };
}

export class PlansService {
  constructor(private readonly deps: { readonly db: Kysely<Database> }) {}

  private actor(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private terms(input: PlanInput) {
    const modules = MODULES.filter((m) => input.modules.includes(m));
    if (modules.length === 0) {
      throw new ValidationError([{ field: 'modules', code: 'SAS.MODULES_REQUIRED' }]);
    }
    if (input.modules.some((m) => !(MODULES as readonly string[]).includes(m))) {
      throw new ValidationError([{ field: 'modules', code: 'VALIDATION.FORMAT' }]);
    }
    return {
      cycle: input.cycle,
      pricePaise: input.pricePaise,
      trialDays: input.trialDays,
      modules,
      members: input.allowances.members,
      sms: input.allowances.sms,
      whatsapp: input.allowances.whatsapp,
      storageGb: input.allowances.storageGb,
      feeFlatPaise: input.platformFee.flatPaise,
      feeThresholdPaise: input.platformFee.upToPaise,
      feePercentBp: input.platformFee.percentBp,
    };
  }

  // --- SAS-027 ------------------------------------------------------------------------------------
  async list() {
    const [plans, counts] = await Promise.all([
      repo.plans(this.deps.db),
      repo.institutionCounts(this.deps.db),
    ]);
    return {
      modules: [...MODULES],
      items: plans.map((p) => planDto(p, Number(counts.find((c) => c.plan_id === p.id)?.n ?? 0))),
    };
  }

  // --- SAS-028 ------------------------------------------------------------------------------------
  async create(p: Principal, input: PlanInput) {
    const name = input.name.trim();
    const terms = this.terms(input);
    const by = this.actor(p);
    const plan = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      if (await repo.nameTaken(trx, name)) throw new CustomAPIError(409, 'SAS.PLAN_NAME_TAKEN');
      const code = `PL-${String(await repo.nextCode(trx)).padStart(3, '0')}`;
      const id = await repo.insertPlan(trx, {
        publicId: plan.bin,
        code,
        name,
        description: input.description?.trim() || null,
        by,
      });
      const v = await repo.addVersion(trx, id, terms, by);
      await recordAudit(trx, {
        action: 'PLAN_CREATED',
        entityType: 'plan',
        entityRef: plan.id,
        after: { name, code, version: v.version, pricePaise: terms.pricePaise },
      });
    });
    return this.one(plan.id);
  }

  // --- SAS-029 ------------------------------------------------------------------------------------
  /** Name and description change in place; any change to the terms adds a version. */
  async change(p: Principal, publicId: string, expected: number, input: PlanInput) {
    if (!isUuid(publicId)) throw new NotFoundError();
    const name = input.name.trim();
    const terms = this.terms(input);
    const by = this.actor(p);
    const changed = await this.deps.db.transaction().execute(async (trx) => {
      const row = await repo.byPublicId(trx, uuidToBin(publicId), true);
      if (!row) throw new NotFoundError();
      if (row.row_version !== expected) throw new PreconditionFailedError();
      if (await repo.nameTaken(trx, name, row.id)) {
        throw new CustomAPIError(409, 'SAS.PLAN_NAME_TAKEN');
      }
      const before = (await repo.plans(trx)).find((x) => x.id === row.id)!;
      const description = input.description?.trim() || null;
      if (!(await repo.update(trx, row.id, expected, { name, description }))) {
        throw new PreconditionFailedError();
      }
      const same =
        before.cycle === terms.cycle &&
        before.price_paise === terms.pricePaise &&
        before.trial_days === terms.trialDays &&
        before.allowances.MEMBERS === terms.members &&
        before.allowances.SMS === terms.sms &&
        before.allowances.WHATSAPP === terms.whatsapp &&
        before.allowances.STORAGE_GB === terms.storageGb &&
        before.fee.flatPaise === terms.feeFlatPaise &&
        before.fee.thresholdPaise === terms.feeThresholdPaise &&
        before.fee.percentBp === terms.feePercentBp &&
        before.modules.length === terms.modules.length &&
        terms.modules.every((m) => before.modules.includes(m));
      const v = same ? null : await repo.addVersion(trx, row.id, terms, by);
      await recordAudit(trx, {
        action: 'PLAN_CHANGED',
        entityType: 'plan',
        entityRef: publicId,
        before: { name: before.name, version: before.version, pricePaise: before.price_paise },
        after: { name, version: v?.version ?? before.version, pricePaise: terms.pricePaise },
      });
      return {
        removed: before.modules.filter((m) => !(terms.modules as readonly string[]).includes(m)),
      };
    });
    return { ...(await this.one(publicId)), removedModules: changed.removed };
  }

  private async one(publicId: string) {
    const out = await this.list();
    const plan = out.items.find((x) => x.id === publicId);
    if (!plan) throw new NotFoundError();
    return plan;
  }
}

/**
 * Platform settings (NFR-52; client 2026-10-02: every accepted default must stay changeable).
 *
 * The limits register holds the defaults; operators may override the values marked `adjustable`,
 * within their range, with a reason. Every change is kept in `platform_setting_changes` and the
 * audit log. Reads are cached briefly; a change on this instance clears the cache at once, other
 * instances pick it up within the cache period.
 */
import type { Kysely } from 'kysely';
import { allLimits, type LimitDefinition } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { settingsRepository } from '../repositories/settings.repository';
import { recordAudit } from './audit.service';
import { CustomAPIError, NotFoundError, PreconditionFailedError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';

export type SettingValues = Readonly<Record<string, number>>;

export interface SettingView {
  readonly key: string;
  readonly value: number;
  readonly defaultValue: number;
  readonly unit: string;
  readonly scope: string;
  readonly basis: string;
  readonly srsValue: string | null;
  readonly adjustable: { readonly min: number; readonly max: number } | null;
  readonly overridden: boolean;
  readonly reason: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** Record version for If-Match (0 while the register default is in force). */
  readonly version: number;
  readonly refs: readonly string[];
}

/** Pairs that must stay consistent: [smaller, larger, allow equal]. */
const RELATIONS: readonly (readonly [string, string, boolean])[] = [
  ['idn.password.minLength', 'idn.password.maxLength', true],
  ['idn.otp.resendAfterSeconds', 'idn.otp.ttlSeconds', false],
  ['auth.access.ttlMinutes', 'auth.idle.consoleMinutes', true],
];

const numericLimits = () =>
  allLimits().filter((l): l is LimitDefinition<number> => typeof l.value === 'number');

export class SettingsService {
  private cache?: { readonly at: number; readonly values: SettingValues };
  private readonly cacheMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<Database>,
    opts: { cacheMs?: number; now?: () => Date } = {},
  ) {
    this.cacheMs = opts.cacheMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Every numeric limit with overrides applied (register key → value). */
  async values(): Promise<SettingValues> {
    const t = this.now().getTime();
    if (this.cache && t - this.cache.at < this.cacheMs) return this.cache.values;
    const out: Record<string, number> = {};
    for (const l of numericLimits()) out[l.key] = l.value;
    for (const row of await settingsRepository.all(this.db)) {
      const v = row.value_json;
      if (typeof v === 'number' && row.setting_key in out) out[row.setting_key] = v;
    }
    this.cache = { at: t, values: out };
    return out;
  }

  /** The value in force for one limit. */
  async get(limit: LimitDefinition<number>): Promise<number> {
    return (await this.values())[limit.key] ?? limit.value;
  }

  async list(): Promise<SettingView[]> {
    const rows = new Map(
      (await settingsRepository.all(this.db)).map((r) => [r.setting_key, r] as const),
    );
    return numericLimits().map((l) => {
      const row = rows.get(l.key);
      const value = typeof row?.value_json === 'number' ? row.value_json : l.value;
      return {
        key: l.key,
        value,
        defaultValue: l.value,
        unit: l.unit,
        scope: l.scope,
        basis: l.basis,
        srsValue: l.srsValue ?? null,
        adjustable: l.adjustable ?? null,
        overridden: row !== undefined,
        reason: row?.reason ?? null,
        updatedAt: row ? new Date(row.updated_at).toISOString() : null,
        updatedBy: row?.updated_by ? binToUuid(row.updated_by) : null,
        version: row?.row_version ?? 0,
        refs: l.refs,
      };
    });
  }

  /**
   * Sets a value (`null` = back to the register default). `expectedVersion` is the version the
   * operator read; someone else's change in between answers 412.
   */
  async change(
    key: string,
    value: number | null,
    reason: string,
    actor: string,
    expectedVersion: number,
  ): Promise<SettingView> {
    const limit = numericLimits().find((l) => l.key === key);
    if (!limit) throw new NotFoundError();
    const range = limit.adjustable;
    if (!range) throw new CustomAPIError(422, 'SETTINGS.NOT_ADJUSTABLE');
    if (value !== null && (!Number.isInteger(value) || value < range.min || value > range.max)) {
      throw new CustomAPIError(422, 'VALIDATION.FAILED', {
        errors: [
          {
            field: 'value',
            code: 'VALIDATION.RANGE',
            params: { min: range.min, max: range.max },
          },
        ],
      });
    }
    const next = { ...(await this.values()), [key]: value ?? limit.value };
    for (const [low, high, equal] of RELATIONS) {
      if (key !== low && key !== high) continue;
      const a = next[low];
      const b = next[high];
      if (a !== undefined && b !== undefined && (equal ? a > b : a >= b)) {
        throw new CustomAPIError(422, 'SETTINGS.INCONSISTENT', {
          params: { other: key === low ? high : low },
        });
      }
    }
    const by = isUuid(actor) ? uuidToBin(actor) : null;
    await this.db.transaction().execute(async (trx) => {
      const current = await settingsRepository.lock(trx, key);
      const currentVersion = current?.row_version ?? 0;
      if (currentVersion !== expectedVersion) throw new PreconditionFailedError();
      const from = typeof current?.value_json === 'number' ? current.value_json : null;
      if (value === null) {
        if (current && !(await settingsRepository.remove(trx, key, expectedVersion))) {
          throw new PreconditionFailedError();
        }
      } else if (current) {
        if (!(await settingsRepository.update(trx, key, value, reason, by, expectedVersion))) {
          throw new PreconditionFailedError();
        }
      } else {
        await settingsRepository.insert(trx, key, value, reason, by);
      }
      await settingsRepository.recordChange(trx, { key, from, to: value, reason, by });
      await recordAudit(trx, {
        action: 'PLATFORM_SETTING_CHANGE',
        entityType: 'platform_setting',
        before: { key, value: from ?? limit.value },
        after: { key, value: value ?? limit.value },
        reason,
      });
    });
    this.cache = undefined;
    const view = (await this.list()).find((s) => s.key === key);
    if (!view) throw new NotFoundError();
    return view;
  }

  async history(key: string, limit = 50) {
    if (!numericLimits().some((l) => l.key === key)) throw new NotFoundError();
    return (await settingsRepository.history(this.db, key, limit)).map((h) => ({
      from: typeof h.from_json === 'number' ? h.from_json : null,
      to: typeof h.to_json === 'number' ? h.to_json : null,
      reason: h.reason,
      changedAt: new Date(h.changed_at).toISOString(),
      changedBy: h.changed_by ? binToUuid(h.changed_by) : null,
    }));
  }
}

/** Register defaults only (tests, or code paths without a database). */
export function defaultValues(): SettingValues {
  return Object.fromEntries(numericLimits().map((l) => [l.key, l.value]));
}

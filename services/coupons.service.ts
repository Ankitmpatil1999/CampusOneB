/**
 * Meal coupons and coupon types (SRS 11, CR-15 / 11.10.1, ATT 21.20.1; CPN-001…014 and the job
 * coupon-expiry; prototype c.coupons, m.coupons, t.reader).
 *
 * - Slots are one master per institution (OI-CPN-12); a meal type points at a slot, another type has
 *   its own window. The four meal slots and types (RNG-CPN-080) are created the first time an
 *   institution opens its coupons.
 * - Issuing creates one coupon per student, type and day (duplicates skipped, RNG-CPN-011); a student
 *   over a type's holding maximum is refused with nothing written for them (RNG-CPN-077); more than
 *   `cpn.issue.maxPerStudent` new coupons for any student refuses the whole request (RNG-CPN-012).
 *   Each coupon keeps its type's terms as issued (RNG-CPN-082). One transaction.
 * - Redeeming (QR by the holder, or a tap at a coupon counter) uses the holder's own coupon of the
 *   type, today, inside its window, at a regular merchant the type accepts, within the type's
 *   redemption maximum — once (the coupon row lock and a unique redemption per coupon). No money
 *   moves (Q14 M5 recommendation).
 * - The 00:00 job expires the coupons whose date has passed.
 */
import type { Insertable, Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { LIMITS, parseQrPayload } from '../config/registers';
import type { CouponPeriod, CouponsTable, CouponTypeKind, Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import type { JobContext } from '../schedulers';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import { emit, rooms } from '../utils/outbox';
import type { Principal } from '../utils/principal';
import { retryOnLock } from '../utils/retry';
import { recordAudit } from './audit.service';
import type { CardsService } from './cards.service';
import { defaultValues, type SettingValues } from './settings.service';

type FieldError = ConstructorParameters<typeof ValidationError>[0][number];

/** The meal slots of RNG-CPN-052 (start inclusive, end exclusive): the first slots of a school. */
export const DEFAULT_COUPON_SLOTS = [
  { name: 'Breakfast', start: '07:00', end: '11:00' },
  { name: 'Lunch', start: '12:00', end: '15:00' },
  { name: 'Snacks', start: '15:00', end: '18:00' },
  { name: 'Dinner', start: '19:00', end: '22:00' },
] as const;

const day = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const hm = (t: string) => t.slice(0, 5);
const toTime = (t: string) => (t.length === 5 ? `${t}:00` : t);
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const nameOf = (first: string | null, last: string | null) =>
  titleCase([first, last].filter(Boolean).join(' '));
const maskName = (first: string | null, last: string | null) =>
  [titleCase(first ?? ''), last ? `${last.charAt(0).toUpperCase()}.` : '']
    .filter(Boolean)
    .join(' ');
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const PERIOD_WORD: Record<CouponPeriod, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month' };

export interface TypeInput {
  readonly name: string;
  readonly kind: CouponTypeKind;
  readonly description?: string | null | undefined;
  readonly slotId?: string | null | undefined;
  readonly window?: { readonly start: string; readonly end: string } | null | undefined;
  readonly valuePaise?: number | undefined;
  readonly holdMax: number;
  readonly redeemMax: number;
  readonly period?: CouponPeriod | undefined;
  readonly merchantIds?: readonly string[] | null | undefined;
  readonly issueFrom?: string | null | undefined;
  readonly issueTo?: string | null | undefined;
  readonly active?: boolean | undefined;
}

export class CouponsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cards: CardsService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async setting(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  /** The IST date and time of day ('HH:MM:SS'). */
  private clock() {
    const now = this.now();
    const ist = new Date(now.getTime() + 330 * 60_000);
    return { now, today: istBusinessDate(now), time: ist.toISOString().slice(11, 19) };
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

  /** The four meal slots and types the first time an institution opens its coupons (RNG-CPN-080). */
  private async ensureDefaults(institutionId: string) {
    const any = await this.deps.db
      .selectFrom('coupon_slots')
      .select('id')
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (any) return;
    await this.deps.db.transaction().execute(async (trx) => {
      for (const [i, s] of DEFAULT_COUPON_SLOTS.entries()) {
        await trx
          .insertInto('coupon_slots')
          .ignore()
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: institutionId,
            name: s.name,
            start_time: toTime(s.start),
            end_time: toTime(s.end),
            sort_order: i,
          })
          .execute();
      }
      const slots = await trx
        .selectFrom('coupon_slots')
        .select(['id', 'name'])
        .where('institution_id', '=', institutionId)
        .execute();
      for (const s of slots) {
        await trx
          .insertInto('coupon_types')
          .ignore()
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: institutionId,
            name: s.name,
            kind: 'MEAL',
            description: `${s.name} at the mess or canteen`,
            slot_id: String(s.id),
            hold_max: 31,
            redeem_max: 1,
            redeem_period: 'DAY',
            accepts_all: 1,
          })
          .execute();
      }
    });
  }

  private async featureOn(institutionId: string) {
    const on = await this.deps.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', institutionId)
      .where('feature_key', '=', 'coupons')
      .executeTakeFirst();
    return !!on && !!Number(on.enabled);
  }

  // --- CPN-006 / CPN-007: slots ---------------------------------------------------------------------
  async slots(p: Principal) {
    const inst = await this.own(p);
    await this.ensureDefaults(inst.id);
    const rows = await this.deps.db
      .selectFrom('coupon_slots as s')
      .select([
        's.public_id',
        's.name',
        's.start_time',
        's.end_time',
        (eb) =>
          eb
            .selectFrom('coupon_types as t')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('t.slot_id', '=', 's.id')
            .as('types'),
      ])
      .where('s.institution_id', '=', inst.id)
      .orderBy('s.sort_order')
      .orderBy('s.start_time')
      .execute();
    return {
      items: rows.map((s) => ({
        id: binToUuid(s.public_id),
        name: s.name,
        start: hm(s.start_time),
        end: hm(s.end_time),
        types: Number(s.types ?? 0),
      })),
    };
  }

  async setSlots(
    p: Principal,
    input: {
      slots: readonly { id?: string | undefined; name: string; start: string; end: string }[];
    },
  ) {
    const inst = await this.own(p);
    await this.ensureDefaults(inst.id);
    const errors: FieldError[] = [];
    const names = new Set<string>();
    input.slots.forEach((s, i) => {
      if (toTime(s.end) <= toTime(s.start)) {
        errors.push({ field: `slots.${i}.end`, code: 'CPN.WINDOW_INVALID' });
      }
      const k = s.name.trim().toLowerCase();
      if (names.has(k)) errors.push({ field: `slots.${i}.name`, code: 'CPN.SLOT_NAME_TAKEN' });
      names.add(k);
    });
    if (errors.length) throw new ValidationError(errors);
    await this.deps.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('coupon_slots as s')
        .select([
          's.id',
          's.public_id',
          's.name',
          (eb) =>
            eb
              .selectFrom('coupon_types as t')
              .select(sql<number>`COUNT(*)`.as('n'))
              .whereRef('t.slot_id', '=', 's.id')
              .as('types'),
        ])
        .where('s.institution_id', '=', inst.id)
        .forUpdate()
        .execute();
      const keep = new Set(input.slots.map((s) => s.id?.toLowerCase()).filter(Boolean));
      for (const c of current) {
        if (keep.has(binToUuid(c.public_id))) continue;
        if (Number(c.types ?? 0) > 0) {
          throw new CustomAPIError(409, 'CPN.SLOT_IN_USE', { params: { slot: c.name } });
        }
        await trx.deleteFrom('coupon_slots').where('id', '=', c.id).execute();
      }
      // Free the names first so a swap of two names doesn't trip the unique key.
      for (const c of current.filter((x) => keep.has(binToUuid(x.public_id)))) {
        await trx
          .updateTable('coupon_slots')
          .set({ name: `~${c.id}` })
          .where('id', '=', c.id)
          .execute();
      }
      for (const [i, s] of input.slots.entries()) {
        const existing = s.id
          ? current.find((c) => binToUuid(c.public_id) === s.id!.toLowerCase())
          : undefined;
        if (s.id && !existing) throw new NotFoundError();
        if (existing) {
          await trx
            .updateTable('coupon_slots')
            .set({
              name: s.name.trim(),
              start_time: toTime(s.start),
              end_time: toTime(s.end),
              sort_order: i,
              updated_at: this.now(),
            })
            .where('id', '=', existing.id)
            .execute();
        } else {
          await trx
            .insertInto('coupon_slots')
            .values({
              public_id: newPublicIdPair().bin,
              institution_id: inst.id,
              name: s.name.trim(),
              start_time: toTime(s.start),
              end_time: toTime(s.end),
              sort_order: i,
            })
            .execute();
        }
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'COUPON_SLOTS_SET',
        entityType: 'institution',
        entityRef: p.institutionId!.toLowerCase(),
        before: { slots: current.map((c) => c.name) },
        after: { slots: input.slots.map((s) => `${s.name.trim()} ${s.start}–${s.end}`) },
      });
    });
    return this.slots(p);
  }

  // --- CPN-003…005: types ---------------------------------------------------------------------------
  private typesQuery(institutionId: string) {
    return this.deps.db
      .selectFrom('coupon_types as t')
      .leftJoin('coupon_slots as s', 's.id', 't.slot_id')
      .select([
        't.id',
        't.public_id',
        't.name',
        't.kind',
        't.description',
        't.window_start',
        't.window_end',
        't.value_paise',
        't.hold_max',
        't.redeem_max',
        't.redeem_period',
        't.accepts_all',
        't.issue_from',
        't.issue_to',
        't.status',
        't.row_version',
        's.public_id as slot_public_id',
        's.name as slot_name',
        's.start_time',
        's.end_time',
      ])
      .where('t.institution_id', '=', institutionId);
  }

  private async typeViews(
    rows: Awaited<ReturnType<ReturnType<CouponsService['typesQuery']>['execute']>>,
  ) {
    const ids = rows.filter((r) => !Number(r.accepts_all)).map((r) => String(r.id));
    const links = ids.length
      ? await this.deps.db
          .selectFrom('coupon_type_merchants as l')
          .innerJoin('merchants as mer', 'mer.profile_id', 'l.merchant_profile_id')
          .innerJoin('member_profiles as mp', 'mp.id', 'mer.profile_id')
          .select(['l.type_id', 'mp.public_id', 'mer.display_name'])
          .where('l.type_id', 'in', ids)
          .execute()
      : [];
    return rows.map((r) => ({
      id: binToUuid(r.public_id),
      name: r.name,
      kind: r.kind,
      description: r.description,
      slot: r.slot_public_id ? { id: binToUuid(r.slot_public_id), name: r.slot_name! } : null,
      window: {
        start: hm((r.start_time ?? r.window_start)!),
        end: hm((r.end_time ?? r.window_end)!),
      },
      value: toMoneyDto(Number(r.value_paise)),
      holdMax: r.hold_max,
      redeemMax: r.redeem_max,
      period: r.redeem_period,
      acceptsAll: !!Number(r.accepts_all),
      merchants: links
        .filter((l) => String(l.type_id) === String(r.id))
        .map((l) => ({ id: binToUuid(l.public_id), name: l.display_name })),
      issueFrom: r.issue_from ? day(r.issue_from) : null,
      issueTo: r.issue_to ? day(r.issue_to) : null,
      status: r.status,
      version: r.row_version,
    }));
  }

  async types(p: Principal) {
    const inst = await this.own(p);
    await this.ensureDefaults(inst.id);
    const rows = await this.typesQuery(inst.id).orderBy('t.status').orderBy('t.name').execute();
    return { items: await this.typeViews(rows) };
  }

  private async typeOf(institutionId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const t = await this.typesQuery(institutionId)
      .where('t.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!t) throw new NotFoundError();
    return t;
  }

  /** The slot (by public id) and the accepting merchants (regular merchants of the institution). */
  private async typeParts(
    institutionId: string,
    input: Pick<TypeInput, 'slotId' | 'window' | 'merchantIds' | 'valuePaise'>,
  ) {
    const errors: FieldError[] = [];
    let slotId: string | null = null;
    if (input.slotId) {
      const s = isUuid(input.slotId)
        ? await this.deps.db
            .selectFrom('coupon_slots')
            .select('id')
            .where('institution_id', '=', institutionId)
            .where('public_id', '=', uuidToBin(input.slotId))
            .executeTakeFirst()
        : undefined;
      if (!s) errors.push({ field: 'slotId', code: 'VALIDATION.FORMAT' });
      else slotId = String(s.id);
    } else if (!input.window) {
      errors.push({ field: 'window', code: 'VALIDATION.REQUIRED' });
    } else if (toTime(input.window.end) <= toTime(input.window.start)) {
      errors.push({ field: 'window.end', code: 'CPN.WINDOW_INVALID' });
    }
    let merchants: string[] = [];
    if (input.merchantIds?.length) {
      const ids = input.merchantIds.filter(isUuid);
      const found = ids.length
        ? await this.deps.db
            .selectFrom('member_profiles as mp')
            .innerJoin('merchants as mer', 'mer.profile_id', 'mp.id')
            .select(['mp.id'])
            .where('mp.institution_id', '=', institutionId)
            .where('mp.public_id', 'in', ids.map(uuidToBin))
            .where('mer.sub_type', '=', 'REGULAR')
            .execute()
        : [];
      if (found.length !== input.merchantIds.length) {
        errors.push({ field: 'merchantIds', code: 'CPN.NOT_REGULAR_MERCHANT' });
      }
      merchants = found.map((m) => String(m.id));
    }
    if (errors.length) throw new ValidationError(errors);
    if ((input.valuePaise ?? 0) > 0 && !(await this.setting(LIMITS.couponValueTypesEnabled))) {
      throw new CustomAPIError(409, 'CPN.VALUE_TYPES_OFF');
    }
    return { slotId, merchants };
  }

  async createType(p: Principal, input: TypeInput) {
    const inst = await this.own(p);
    await this.ensureDefaults(inst.id);
    const parts = await this.typeParts(inst.id, input);
    const pub = newPublicIdPair();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const r = await trx
          .insertInto('coupon_types')
          .values({
            public_id: pub.bin,
            institution_id: inst.id,
            name: input.name.trim(),
            kind: input.kind,
            description: input.description?.trim() || null,
            slot_id: parts.slotId,
            window_start: parts.slotId ? null : toTime(input.window!.start),
            window_end: parts.slotId ? null : toTime(input.window!.end),
            value_paise: input.valuePaise ?? 0,
            hold_max: input.holdMax,
            redeem_max: input.redeemMax,
            redeem_period: input.period ?? 'DAY',
            accepts_all: parts.merchants.length ? 0 : 1,
            issue_from: input.issueFrom ?? null,
            issue_to: input.issueTo ?? null,
            status: input.active === false ? 'INACTIVE' : 'ACTIVE',
            created_by: this.by(p),
          })
          .executeTakeFirstOrThrow();
        for (const m of parts.merchants) {
          await trx
            .insertInto('coupon_type_merchants')
            .values({ type_id: String(r.insertId), merchant_profile_id: m })
            .execute();
        }
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'COUPON_TYPE_CREATED',
          entityType: 'coupon_type',
          entityRef: pub.id,
          after: { name: input.name, kind: input.kind },
        });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'CPN.TYPE_NAME_TAKEN');
      }
      throw e;
    }
    const [view] = await this.typeViews([await this.typeOf(inst.id, pub.id)]);
    return view!;
  }

  async updateType(p: Principal, id: string, expected: number, patch: Partial<TypeInput>) {
    const inst = await this.own(p);
    const t = await this.typeOf(inst.id, id);
    if (t.row_version !== expected) throw new PreconditionFailedError();
    const touchesWindow = patch.slotId !== undefined || patch.window !== undefined;
    const parts =
      touchesWindow || patch.merchantIds !== undefined || patch.valuePaise !== undefined
        ? await this.typeParts(inst.id, {
            slotId: touchesWindow
              ? patch.slotId
              : t.slot_public_id
                ? binToUuid(t.slot_public_id)
                : null,
            window: touchesWindow
              ? patch.window
              : t.window_start
                ? { start: t.window_start, end: t.window_end! }
                : null,
            merchantIds: patch.merchantIds,
            valuePaise: patch.valuePaise,
          })
        : null;
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const res = await trx
          .updateTable('coupon_types')
          .set({
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...(patch.kind ? { kind: patch.kind } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description?.trim() || null }
              : {}),
            ...(touchesWindow && parts
              ? {
                  slot_id: parts.slotId,
                  window_start: parts.slotId ? null : toTime(patch.window!.start),
                  window_end: parts.slotId ? null : toTime(patch.window!.end),
                }
              : {}),
            ...(patch.valuePaise !== undefined ? { value_paise: patch.valuePaise } : {}),
            ...(patch.holdMax !== undefined ? { hold_max: patch.holdMax } : {}),
            ...(patch.redeemMax !== undefined ? { redeem_max: patch.redeemMax } : {}),
            ...(patch.period ? { redeem_period: patch.period } : {}),
            ...(patch.merchantIds !== undefined && parts
              ? { accepts_all: parts.merchants.length ? 0 : 1 }
              : {}),
            ...(patch.issueFrom !== undefined ? { issue_from: patch.issueFrom } : {}),
            ...(patch.issueTo !== undefined ? { issue_to: patch.issueTo } : {}),
            ...(patch.active !== undefined
              ? { status: patch.active ? ('ACTIVE' as const) : ('INACTIVE' as const) }
              : {}),
            row_version: sql<number>`row_version + 1`,
            updated_at: this.now(),
          })
          .where('id', '=', t.id)
          .where('row_version', '=', expected)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
        if (patch.merchantIds !== undefined && parts) {
          await trx.deleteFrom('coupon_type_merchants').where('type_id', '=', t.id).execute();
          for (const m of parts.merchants) {
            await trx
              .insertInto('coupon_type_merchants')
              .values({ type_id: t.id, merchant_profile_id: m })
              .execute();
          }
        }
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'COUPON_TYPE_UPDATED',
          entityType: 'coupon_type',
          entityRef: id.toLowerCase(),
          before: { name: t.name, status: t.status },
          after: { ...patch },
        });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'CPN.TYPE_NAME_TAKEN');
      }
      throw e;
    }
    const [view] = await this.typeViews([await this.typeOf(inst.id, id)]);
    return view!;
  }

  // --- CPN-008: issuing ------------------------------------------------------------------------------
  async issue(
    p: Principal,
    input: {
      typeIds: readonly string[];
      from: string;
      to: string;
      excludedDates?: readonly string[] | undefined;
      studentIds: readonly string[];
    },
  ) {
    const inst = await this.own(p);
    if (!(await this.featureOn(inst.id))) throw new CustomAPIError(409, 'CPN.FEATURE_OFF');
    await this.ensureDefaults(inst.id);
    const { today } = this.clock();
    if (input.from <= today || input.to <= today) {
      throw new ValidationError([{ field: 'from', code: 'CPN.DATES_NOT_FUTURE' }]);
    }
    const excluded = new Set(input.excludedDates ?? []);
    const days: string[] = [];
    for (let d = input.from; d <= input.to && days.length <= 400; d = addDays(d, 1)) {
      if (!excluded.has(d)) days.push(d);
    }
    if (!days.length) throw new ValidationError([{ field: 'to', code: 'CPN.NO_DAYS' }]);

    // The types, active and issuable on every day of the range.
    const typeIds = [...new Set(input.typeIds.map((x) => x.toLowerCase()))];
    const types: Awaited<ReturnType<CouponsService['typeOf']>>[] = [];
    for (const id of typeIds) {
      const t = await this.typeOf(inst.id, id);
      if (t.status !== 'ACTIVE') throw new CustomAPIError(409, 'CPN.TYPE_INACTIVE');
      const from = t.issue_from ? day(t.issue_from) : null;
      const to = t.issue_to ? day(t.issue_to) : null;
      if ((from && days[0]! < from) || (to && days.at(-1)! > to)) {
        throw new CustomAPIError(409, 'CPN.TYPE_NOT_ISSUABLE', { params: { type: t.name } });
      }
      types.push(t);
    }
    const links = await this.deps.db
      .selectFrom('coupon_type_merchants')
      .select(['type_id', 'merchant_profile_id'])
      .where(
        'type_id',
        'in',
        types.map((t) => String(t.id)),
      )
      .execute();

    // The students: active students of this institution (OI-CPN-02).
    const wanted = [...new Set(input.studentIds.map((x) => x.toLowerCase()))];
    const ids = wanted.filter(isUuid);
    const students = ids.length
      ? await this.deps.db
          .selectFrom('member_profiles as m')
          .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
          .select(['m.id', 'm.public_id', 'm.status', 'm.first_name', 'm.last_name', 'ut.category'])
          .where('m.institution_id', '=', inst.id)
          .where('m.public_id', 'in', ids.map(uuidToBin))
          .execute()
      : [];
    const byId = new Map(students.map((s) => [binToUuid(s.public_id), s]));
    const valid = wanted.filter((id) => {
      const s = byId.get(id);
      return s && s.category === 'STUDENT' && s.status === 'ACTIVE';
    });
    if (!valid.length)
      throw new ValidationError([{ field: 'studentIds', code: 'CPN.NO_STUDENTS' }]);

    const cap = await this.setting(LIMITS.couponsPerStudentPerIssuance);
    const pub = newPublicIdPair();
    const result = await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const profileIds = valid.map((id) => String(byId.get(id)!.id));
        // Lock the students' rows so two issuances for one student queue (hold maximum).
        await trx
          .selectFrom('member_profiles')
          .select('id')
          .where('id', 'in', profileIds)
          .orderBy('id')
          .forUpdate()
          .execute();
        const existing = await trx
          .selectFrom('coupons')
          .select(['profile_id', 'type_id', 'valid_on', 'status'])
          .where('profile_id', 'in', profileIds)
          .where(
            'type_id',
            'in',
            types.map((t) => String(t.id)),
          )
          .where('valid_on', '>=', today)
          .execute();
        const has = new Set(existing.map((c) => `${c.profile_id}|${c.type_id}|${day(c.valid_on)}`));
        const holding = new Map<string, number>();
        for (const c of existing.filter((x) => x.status === 'ACTIVE')) {
          const k = `${c.profile_id}|${c.type_id}`;
          holding.set(k, (holding.get(k) ?? 0) + 1);
        }
        const perStudent: {
          studentId: string;
          name: string;
          created: number;
          skipped: number;
          refused: string | null;
          /** The refusal's message placeholders (CPN.HOLD_MAX: the type and its maximum). */
          params?: { type: string; max: number };
        }[] = [];
        const rows: Insertable<CouponsTable>[] = [];
        const overCap: string[] = [];
        for (const id of wanted) {
          const s = byId.get(id);
          if (!s || s.category !== 'STUDENT' || s.status !== 'ACTIVE') {
            perStudent.push({
              studentId: id,
              name: s ? nameOf(s.first_name, s.last_name) : '',
              created: 0,
              skipped: 0,
              refused: s ? 'CPN.NO_STUDENTS' : 'GEN.NOT_FOUND',
            });
            continue;
          }
          const mine: typeof rows = [];
          let skipped = 0;
          let refused: string | null = null;
          let params: { type: string; max: number } | undefined;
          for (const t of types) {
            let added = 0;
            for (const d of days) {
              if (has.has(`${s.id}|${t.id}|${d}`)) {
                skipped += 1;
                continue;
              }
              const accepts = links
                .filter((l) => String(l.type_id) === String(t.id))
                .map((l) => String(l.merchant_profile_id));
              mine.push({
                public_id: newPublicIdPair().bin,
                institution_id: inst.id,
                profile_id: String(s.id),
                type_id: String(t.id),
                issuance_id: '0',
                valid_on: d,
                window_start: (t.start_time ?? t.window_start)!,
                window_end: (t.end_time ?? t.window_end)!,
                value_paise: Number(t.value_paise),
                accepts_all: Number(t.accepts_all) ? 1 : 0,
                accepts: Number(t.accepts_all) ? null : JSON.stringify(accepts),
              });
              added += 1;
            }
            if (!refused && (holding.get(`${s.id}|${t.id}`) ?? 0) + added > t.hold_max) {
              refused = 'CPN.HOLD_MAX';
              params = { type: t.name, max: t.hold_max };
            }
          }
          if (refused) {
            perStudent.push({
              studentId: id,
              name: nameOf(s.first_name, s.last_name),
              created: 0,
              skipped,
              refused,
              ...(params ? { params } : {}),
            });
            continue;
          }
          if (mine.length > cap) overCap.push(id);
          rows.push(...mine);
          perStudent.push({
            studentId: id,
            name: nameOf(s.first_name, s.last_name),
            created: mine.length,
            skipped,
            refused: null,
          });
        }
        if (overCap.length) {
          throw new CustomAPIError(422, 'CPN.ISSUE_LIMIT', {
            params: { max: cap },
            errors: overCap.map((id) => ({ field: `studentIds.${id}`, code: 'CPN.ISSUE_LIMIT' })),
          });
        }
        const created = rows.length;
        const skipped = perStudent.reduce((a, x) => a + x.skipped, 0);
        const refused = perStudent.filter((x) => x.refused).length;
        const iss = await trx
          .insertInto('coupon_issuances')
          .values({
            public_id: pub.bin,
            institution_id: inst.id,
            from_date: input.from,
            to_date: input.to,
            excluded_dates: JSON.stringify([...excluded].sort()),
            type_ids: JSON.stringify(typeIds),
            students: wanted.length,
            created_count: created,
            skipped_count: skipped,
            refused_count: refused,
            issued_by: this.by(p),
          })
          .executeTakeFirstOrThrow();
        for (let i = 0; i < rows.length; i += 500) {
          await trx
            .insertInto('coupons')
            .values(
              rows.slice(i, i + 500).map((r) => ({ ...r, issuance_id: String(iss.insertId) })),
            )
            .execute();
        }
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'COUPONS_ISSUED',
          entityType: 'coupon_issuance',
          entityRef: pub.id,
          after: {
            from: input.from,
            to: input.to,
            types: types.map((t) => t.name),
            created,
            skipped,
            refused,
          },
        });
        return { created, skipped, perStudent };
      }),
    );
    return { issuanceId: pub.id, ...result };
  }

  // --- CPN-009 -------------------------------------------------------------------------------------
  async issuances(p: Principal) {
    const inst = await this.own(p);
    const rows = await this.deps.db
      .selectFrom('coupon_issuances')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .orderBy('id', 'desc')
      .limit(100)
      .execute();
    const names = new Map(
      (await this.typesQuery(inst.id).execute()).map((t) => [binToUuid(t.public_id), t.name]),
    );
    const parse = (v: unknown) =>
      (typeof v === 'string' ? (JSON.parse(v) as string[]) : (v as string[])) ?? [];
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        from: day(r.from_date),
        to: day(r.to_date),
        excludedDates: parse(r.excluded_dates),
        types: parse(r.type_ids).map((id) => ({ id, name: names.get(id) ?? '' })),
        students: r.students,
        created: r.created_count,
        skipped: r.skipped_count,
        refused: r.refused_count,
        issuedAt: iso(r.created_at)!,
      })),
    };
  }

  // --- CPN-010 -------------------------------------------------------------------------------------
  private couponsQuery(institutionId: string) {
    return this.deps.db
      .selectFrom('coupons as c')
      .innerJoin('coupon_types as t', 't.id', 'c.type_id')
      .innerJoin('member_profiles as m', 'm.id', 'c.profile_id')
      .leftJoin('coupon_redemptions as r', 'r.coupon_id', 'c.id')
      .leftJoin('merchants as mer', 'mer.profile_id', 'r.merchant_profile_id')
      .select([
        'c.id',
        'c.public_id',
        'c.valid_on',
        'c.window_start',
        'c.window_end',
        'c.status',
        'c.ended_reason',
        'c.cancel_reason',
        'c.used_at',
        'c.ended_at',
        't.public_id as type_public_id',
        't.name as type_name',
        't.kind as type_kind',
        'm.public_id as student_public_id',
        'm.first_name',
        'm.last_name',
        'mer.display_name as merchant_name',
      ])
      .where('c.institution_id', '=', institutionId);
  }

  private couponView(
    c: Awaited<ReturnType<ReturnType<CouponsService['couponsQuery']>['execute']>>[number],
  ) {
    return {
      id: binToUuid(c.public_id),
      student: { id: binToUuid(c.student_public_id), name: nameOf(c.first_name, c.last_name) },
      type: { id: binToUuid(c.type_public_id), name: c.type_name, kind: c.type_kind },
      validOn: day(c.valid_on),
      window: { start: hm(c.window_start), end: hm(c.window_end) },
      status: c.status,
      state:
        c.status === 'EXPIRED' && c.ended_reason === 'CANCELLED'
          ? ('CANCELLED' as const)
          : c.status,
      usedAt: iso(c.used_at),
      merchant: c.merchant_name,
      endedAt: iso(c.ended_at),
      cancelReason: c.cancel_reason,
    };
  }

  async coupons(
    p: Principal,
    f: {
      studentId?: string | undefined;
      typeId?: string | undefined;
      date?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      state?: 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED' | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = await this.own(p);
    let q = this.couponsQuery(inst.id);
    if (f.studentId && isUuid(f.studentId)) q = q.where('m.public_id', '=', uuidToBin(f.studentId));
    if (f.typeId && isUuid(f.typeId)) q = q.where('t.public_id', '=', uuidToBin(f.typeId));
    if (f.date) q = q.where('c.valid_on', '=', f.date);
    if (f.from) q = q.where('c.valid_on', '>=', f.from);
    if (f.to) q = q.where('c.valid_on', '<=', f.to);
    if (f.state === 'CANCELLED') {
      q = q.where('c.status', '=', 'EXPIRED').where('c.ended_reason', '=', 'CANCELLED');
    } else if (f.state === 'EXPIRED') {
      q = q.where('c.status', '=', 'EXPIRED').where('c.ended_reason', '=', 'LAPSED');
    } else if (f.state) q = q.where('c.status', '=', f.state);
    const before = f.cursor && /^\d+$/.test(f.cursor) ? f.cursor : null;
    if (before) q = q.where('c.id', '<', before);
    const rows = await q.orderBy('c.id', 'desc').limit(101).execute();
    const page = rows.slice(0, 100);
    return {
      items: page.map((c) => this.couponView(c)),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  // --- CPN-011 -------------------------------------------------------------------------------------
  async reports(p: Principal, f: { from?: string | undefined; to?: string | undefined }) {
    const inst = await this.own(p);
    const { today } = this.clock();
    const to = f.to ?? today;
    const from = f.from ?? addDays(to, -13);
    const rows = await this.couponsQuery(inst.id)
      .where('c.valid_on', '>=', from)
      .where('c.valid_on', '<=', to)
      .execute();
    const views = rows.map((c) => this.couponView(c));
    const count = (s: string) => views.filter((v) => v.state === s).length;
    const group = <K extends string>(key: (v: (typeof views)[number]) => K) => {
      const m = new Map<K, typeof views>();
      for (const v of views) m.set(key(v), [...(m.get(key(v)) ?? []), v]);
      return m;
    };
    const tally = (list: typeof views) => ({
      issued: list.filter((v) => v.state !== 'CANCELLED').length,
      used: list.filter((v) => v.state === 'USED').length,
      expired: list.filter((v) => v.state === 'EXPIRED').length,
      active: list.filter((v) => v.state === 'ACTIVE').length,
    });
    const days: string[] = [];
    for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
    const byDay = group((v) => v.validOn);
    return {
      from,
      to,
      kpis: {
        issued: views.length - count('CANCELLED'),
        used: count('USED'),
        expired: count('EXPIRED'),
        active: count('ACTIVE'),
        cancelled: count('CANCELLED'),
      },
      byDay: days.map((d) => ({ date: d, ...tally(byDay.get(d) ?? []) })),
      byType: [...group((v) => v.type.name)].map(([type, list]) => ({ type, ...tally(list) })),
      byMerchant: [...group((v) => (v.merchant ?? '') as string)]
        .filter(([m]) => m)
        .map(([merchant, list]) => ({ merchant, used: list.length }))
        .sort((a, b) => b.used - a.used),
      perStudent: [...group((v) => v.student.id)]
        .map(([, list]) => ({ student: list[0]!.student, ...tally(list) }))
        .sort((a, b) => a.student.name.localeCompare(b.student.name)),
    };
  }

  // --- CPN-012 -------------------------------------------------------------------------------------
  async cancel(
    p: Principal,
    input: {
      studentIds: readonly string[];
      from: string;
      to: string;
      typeIds?: readonly string[] | undefined;
      reason: string;
    },
  ) {
    const inst = await this.own(p);
    const { today, now } = this.clock();
    const students = input.studentIds.filter(isUuid);
    if (!students.length) return { cancelled: 0 };
    let q = this.deps.db
      .updateTable('coupons')
      .set({
        status: 'EXPIRED',
        ended_reason: 'CANCELLED',
        cancel_reason: input.reason.trim(),
        ended_at: now,
      })
      .where('institution_id', '=', inst.id)
      .where('status', '=', 'ACTIVE')
      .where('valid_on', '>', today)
      .where('valid_on', '>=', input.from)
      .where('valid_on', '<=', input.to)
      .where('profile_id', 'in', (eb) =>
        eb
          .selectFrom('member_profiles')
          .select('id')
          .where('institution_id', '=', inst.id)
          .where('public_id', 'in', students.map(uuidToBin)),
      );
    const types = (input.typeIds ?? []).filter(isUuid);
    if (types.length) {
      q = q.where('type_id', 'in', (eb) =>
        eb
          .selectFrom('coupon_types')
          .select('id')
          .where('institution_id', '=', inst.id)
          .where('public_id', 'in', types.map(uuidToBin)),
      );
    }
    const res = await q.executeTakeFirst();
    const cancelled = Number(res.numUpdatedRows);
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'COUPONS_CANCELLED',
      entityType: 'institution',
      entityRef: p.institutionId!.toLowerCase(),
      after: {
        students: students.length,
        from: input.from,
        to: input.to,
        cancelled,
        reason: input.reason,
      },
    });
    return { cancelled };
  }

  // --- CPN-001 -------------------------------------------------------------------------------------
  async mine(p: Principal, forProfile?: string) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const wanted = forProfile ?? p.profileId;
    if (!wanted || !isUuid(wanted)) throw new NotFoundError();
    const db = this.deps.db;
    const m = await db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select(['m.id', 'm.institution_id'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(wanted))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    await this.ensureDefaults(String(m.institution_id));
    const { today, time } = this.clock();
    const rows = await this.couponsQuery(String(m.institution_id))
      .where('c.profile_id', '=', m.id)
      .where('c.valid_on', '>=', addDays(today, -30))
      .where('c.valid_on', '<=', addDays(today, 31))
      .orderBy('c.valid_on')
      .orderBy('c.window_start')
      .execute();
    const views = rows.map((c) => this.couponView(c));
    const todays = views.filter((v) => v.validOn === today);
    const types = await this.typeViews(
      await this.typesQuery(String(m.institution_id))
        .where('t.status', '=', 'ACTIVE')
        .orderBy('t.name')
        .execute(),
    );
    const t5 = time.slice(0, 5);
    return {
      date: today,
      time: t5,
      today: todays.map((v) => ({
        ...v,
        usableNow: v.state === 'ACTIVE' && t5 >= v.window.start && t5 < v.window.end,
      })),
      upcoming: views.filter((v) => v.validOn > today && v.state === 'ACTIVE').slice(0, 60),
      history: views
        .filter((v) => v.validOn < today || v.state !== 'ACTIVE')
        .filter((v) => v.validOn <= today)
        .reverse()
        .slice(0, 20),
      types,
    };
  }

  // --- redeeming -----------------------------------------------------------------------------------
  /**
   * The holder's coupon of the type, today, redeemed at the merchant (11.6, CR-15): regular merchant
   * of the institution, a type it accepts, inside the window, within the redemption maximum, once.
   */
  private async redeem(
    trx: Transaction<Database>,
    o: {
      institutionId: string;
      profileId: string;
      merchantProfileId: string;
      typeId: string;
      channel: 'QR' | 'READER';
      terminalId: string | null;
    },
  ) {
    const { today, time, now } = this.clock();
    const merchant = await trx
      .selectFrom('merchants as mer')
      .innerJoin('member_profiles as mp', 'mp.id', 'mer.profile_id')
      .select([
        'mer.display_name',
        'mer.sub_type',
        'mp.status',
        'mp.institution_id',
        'mp.public_id',
      ])
      .where('mer.profile_id', '=', o.merchantProfileId)
      .executeTakeFirst();
    if (
      !merchant ||
      merchant.sub_type !== 'REGULAR' ||
      merchant.status !== 'ACTIVE' ||
      String(merchant.institution_id) !== o.institutionId
    ) {
      throw new CustomAPIError(409, 'CPN.NOT_REGULAR_MERCHANT');
    }
    const c = await trx
      .selectFrom('coupons as c')
      .innerJoin('coupon_types as t', 't.id', 'c.type_id')
      .select([
        'c.id',
        'c.public_id',
        'c.window_start',
        'c.window_end',
        'c.accepts_all',
        'c.accepts',
        't.name',
        't.redeem_max',
        't.redeem_period',
      ])
      .where('c.institution_id', '=', o.institutionId)
      .where('c.profile_id', '=', o.profileId)
      .where('c.type_id', '=', o.typeId)
      .where('c.valid_on', '=', today)
      .where('c.status', '=', 'ACTIVE')
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw new CustomAPIError(409, 'CPN.NONE_ACTIVE');
    const list = Number(c.accepts_all)
      ? null
      : ((typeof c.accepts === 'string' ? JSON.parse(c.accepts) : c.accepts) as string[]);
    if (list && !list.map(String).includes(o.merchantProfileId)) {
      throw new CustomAPIError(409, 'CPN.TYPE_NOT_ACCEPTED', {
        params: { merchant: merchant.display_name, type: c.name },
      });
    }
    if (time < c.window_start || time >= c.window_end) {
      throw new CustomAPIError(409, 'CPN.OUTSIDE_WINDOW', {
        params: { type: c.name, start: hm(c.window_start), end: hm(c.window_end) },
      });
    }
    const since =
      c.redeem_period === 'DAY'
        ? today
        : c.redeem_period === 'WEEK'
          ? addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7))
          : `${today.slice(0, 8)}01`;
    const used = await trx
      .selectFrom('coupon_redemptions as r')
      .innerJoin('coupons as x', 'x.id', 'r.coupon_id')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('r.profile_id', '=', o.profileId)
      .where('x.type_id', '=', o.typeId)
      .where('x.valid_on', '>=', since)
      .executeTakeFirst();
    if (Number(used?.n ?? 0) >= c.redeem_max) {
      throw new CustomAPIError(409, 'CPN.REDEEM_MAX', {
        params: { type: c.name, max: c.redeem_max, period: PERIOD_WORD[c.redeem_period] },
      });
    }
    const res = await trx
      .updateTable('coupons')
      .set({ status: 'USED', used_at: now })
      .where('id', '=', c.id)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'CPN.NONE_ACTIVE');
    const pub = newPublicIdPair();
    const r = await trx
      .insertInto('coupon_redemptions')
      .values({
        public_id: pub.bin,
        institution_id: o.institutionId,
        coupon_id: String(c.id),
        profile_id: o.profileId,
        merchant_profile_id: o.merchantProfileId,
        channel: o.channel,
        terminal_id: o.terminalId,
        redeemed_at: now,
      })
      .executeTakeFirstOrThrow();
    const holder = await trx
      .selectFrom('member_profiles')
      .select(['public_id', 'first_name', 'last_name'])
      .where('id', '=', o.profileId)
      .executeTakeFirstOrThrow();
    await emit(trx, {
      institutionId: o.institutionId,
      type: 'coupon.redeemed',
      rooms: [rooms.profile(o.profileId), rooms.profile(o.merchantProfileId)],
      data: { couponId: binToUuid(c.public_id), type: c.name },
    });
    return {
      rowId: String(r.insertId),
      view: {
        id: pub.id,
        coupon: { id: binToUuid(c.public_id), type: c.name },
        merchant: { id: binToUuid(merchant.public_id), name: merchant.display_name },
        holder: {
          id: binToUuid(holder.public_id),
          name: nameOf(holder.first_name, holder.last_name),
        },
        redeemedAt: now.toISOString(),
      },
    };
  }

  /**
   * A canteen order covered by a coupon (prototype t.pos "Coupon"): the first of the holder's coupons
   * usable now at the counter's merchant, redeemed in the caller's transaction (11.10.1, 12.8).
   */
  async redeemAtCounter(
    trx: Transaction<Database>,
    o: { institutionId: string; profileId: string; merchantProfileId: string; terminalId: string },
  ) {
    const { today, time } = this.clock();
    const rows = await trx
      .selectFrom('coupons as c')
      .select(['c.type_id', 'c.accepts_all', 'c.accepts'])
      .where('c.institution_id', '=', o.institutionId)
      .where('c.profile_id', '=', o.profileId)
      .where('c.valid_on', '=', today)
      .where('c.status', '=', 'ACTIVE')
      .where('c.window_start', '<=', time)
      .where('c.window_end', '>', time)
      .orderBy('c.window_start')
      .execute();
    const usable = rows.find((r) => {
      if (Number(r.accepts_all)) return true;
      const list = (typeof r.accepts === 'string' ? JSON.parse(r.accepts) : r.accepts) as string[];
      return list.map(String).includes(o.merchantProfileId);
    });
    if (!usable) throw new CustomAPIError(409, 'CPN.NONE_ACTIVE');
    return this.redeem(trx, {
      ...o,
      typeId: String(usable.type_id),
      channel: 'READER',
    });
  }

  /** The holder's profile and institution from the session (the member's own coupon, OI-CPN-07). */
  private async holder(p: Principal) {
    if (!p.profileId || !isUuid(p.profileId) || !p.institutionId || !isUuid(p.institutionId)) {
      throw new NotFoundError();
    }
    const r = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select(['m.id', 'm.institution_id', 'a.public_id as account_public'])
      .where('m.public_id', '=', uuidToBin(p.profileId))
      .where('i.public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!r || !isUuid(p.subject) || binToUuid(r.account_public) !== p.subject.toLowerCase()) {
      throw new NotFoundError();
    }
    return { profileId: String(r.id), institutionId: String(r.institution_id) };
  }

  private async typeRowId(institutionId: string, typeId: string) {
    if (!isUuid(typeId)) throw new CustomAPIError(409, 'CPN.NONE_ACTIVE');
    const t = await this.deps.db
      .selectFrom('coupon_types')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(typeId))
      .executeTakeFirst();
    if (!t) throw new CustomAPIError(409, 'CPN.NONE_ACTIVE');
    return String(t.id);
  }

  // --- CPN-002 -------------------------------------------------------------------------------------
  async redeemQr(p: Principal, input: { merchantQrPayload: string; couponTypeId: string }) {
    const h = await this.holder(p);
    const parsed = parseQrPayload(input.merchantQrPayload);
    if (!parsed || parsed.kind !== 's') throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
    const q = await this.deps.db
      .selectFrom('merchant_qr_codes')
      .select(['merchant_profile_id', 'status', 'kind'])
      .where('token', '=', parsed.token)
      .where('institution_id', '=', h.institutionId)
      .executeTakeFirst();
    if (!q || q.kind !== 'COUPON') throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
    if (q.status !== 'ACTIVE') throw new CustomAPIError(409, 'PAY.QR_INACTIVE');
    const typeId = await this.typeRowId(h.institutionId, input.couponTypeId);
    return retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const r = await this.redeem(trx, {
          institutionId: h.institutionId,
          profileId: h.profileId,
          merchantProfileId: String(q.merchant_profile_id),
          typeId,
          channel: 'QR',
          terminalId: null,
        });
        return r.view;
      }),
    );
  }

  // --- CPN-013 / CPN-014: coupon counter --------------------------------------------------------------
  async tap(
    t: { id: string; institutionId: string; merchantProfileId: string | null },
    input: { cardToken: string; tapId: string },
  ) {
    if (!t.merchantProfileId) throw new CustomAPIError(409, 'CPN.NOT_REGULAR_MERCHANT');
    const card = await this.deps.cards.activeCard(t.institutionId, input.cardToken);
    await this.deps.cards.touch(String(card.id));
    const { today, time, now } = this.clock();
    const seconds = await this.setting(LIMITS.couponTapChooseSeconds);
    const rows = await this.deps.db
      .selectFrom('coupons as c')
      .innerJoin('coupon_types as ty', 'ty.id', 'c.type_id')
      .select([
        'ty.public_id',
        'ty.name',
        'c.window_start',
        'c.window_end',
        'c.accepts_all',
        'c.accepts',
      ])
      .where('c.profile_id', '=', String(card.profile_id))
      .where('c.valid_on', '=', today)
      .where('c.status', '=', 'ACTIVE')
      .where('c.window_start', '<=', time)
      .where('c.window_end', '>', time)
      .orderBy('c.window_start')
      .execute();
    const eligible = rows.filter((r) => {
      if (Number(r.accepts_all)) return true;
      const list = (typeof r.accepts === 'string' ? JSON.parse(r.accepts) : r.accepts) as string[];
      return list.map(String).includes(t.merchantProfileId!);
    });
    if (!eligible.length) throw new CustomAPIError(409, 'CPN.NONE_ACTIVE');
    await this.deps.db
      .insertInto('coupon_taps')
      .ignore()
      .values({
        institution_id: t.institutionId,
        terminal_id: t.id,
        tap_ref: input.tapId,
        profile_id: String(card.profile_id),
        expires_at: new Date(now.getTime() + seconds * 1000),
      })
      .execute();
    const enrolment = await this.deps.db
      .selectFrom('enrolments as e')
      .innerJoin('academic_years as y', (j) =>
        j.onRef('y.id', '=', 'e.year_id').on('y.is_current', '=', 1),
      )
      .innerJoin('sections as s', 's.id', 'e.section_id')
      .innerJoin('classes as cl', 'cl.id', 's.class_id')
      .select(['cl.name as class_name', 's.name as section_name'])
      .where('e.student_profile_id', '=', String(card.profile_id))
      .executeTakeFirst();
    const adm = await this.deps.db
      .selectFrom('member_profiles')
      .select('admission_no')
      .where('id', '=', String(card.profile_id))
      .executeTakeFirst();
    return {
      holder: {
        maskedName: maskName(card.first_name, card.last_name),
        classSection: enrolment ? `${enrolment.class_name} ${enrolment.section_name}` : null,
        admissionNo: adm?.admission_no ?? null,
      },
      eligibleTypes: eligible.map((r) => ({
        id: binToUuid(r.public_id),
        name: r.name,
        window: { start: hm(r.window_start), end: hm(r.window_end) },
      })),
      chooseWithinSec: seconds,
    };
  }

  async tapRedeem(
    t: { id: string; institutionId: string; merchantProfileId: string | null },
    input: { tapId: string; couponTypeId: string },
  ) {
    if (!t.merchantProfileId) throw new CustomAPIError(409, 'CPN.NOT_REGULAR_MERCHANT');
    const typeId = await this.typeRowId(t.institutionId, input.couponTypeId);
    return retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const tap = await trx
          .selectFrom('coupon_taps')
          .selectAll()
          .where('terminal_id', '=', t.id)
          .where('tap_ref', '=', input.tapId)
          .forUpdate()
          .executeTakeFirst();
        if (!tap) throw new CustomAPIError(409, 'CPN.TAP_LAPSED');
        if (tap.redemption_id) {
          // A repeated request for the same tap answers with the first redemption.
          const r = await trx
            .selectFrom('coupon_redemptions as r')
            .innerJoin('coupons as c', 'c.id', 'r.coupon_id')
            .innerJoin('coupon_types as ty', 'ty.id', 'c.type_id')
            .innerJoin('merchants as mer', 'mer.profile_id', 'r.merchant_profile_id')
            .innerJoin('member_profiles as mp', 'mp.id', 'mer.profile_id')
            .innerJoin('member_profiles as h', 'h.id', 'r.profile_id')
            .select([
              'r.public_id',
              'r.redeemed_at',
              'c.public_id as coupon_public_id',
              'ty.name',
              'mer.display_name',
              'mp.public_id as merchant_public_id',
              'h.public_id as holder_public_id',
              'h.first_name',
              'h.last_name',
            ])
            .where('r.id', '=', tap.redemption_id)
            .executeTakeFirstOrThrow();
          return {
            id: binToUuid(r.public_id),
            coupon: { id: binToUuid(r.coupon_public_id), type: r.name },
            merchant: { id: binToUuid(r.merchant_public_id), name: r.display_name },
            holder: { id: binToUuid(r.holder_public_id), name: nameOf(r.first_name, r.last_name) },
            redeemedAt: new Date(r.redeemed_at).toISOString(),
          };
        }
        if (new Date(tap.expires_at).getTime() <= this.now().getTime()) {
          throw new CustomAPIError(409, 'CPN.TAP_LAPSED');
        }
        const r = await this.redeem(trx, {
          institutionId: t.institutionId,
          profileId: String(tap.profile_id),
          merchantProfileId: t.merchantProfileId!,
          typeId,
          channel: 'READER',
          terminalId: t.id,
        });
        await trx
          .updateTable('coupon_taps')
          .set({ redemption_id: r.rowId })
          .where('id', '=', tap.id)
          .execute();
        return r.view;
      }),
    );
  }

  // --- job coupon-expiry (11.7) ----------------------------------------------------------------------
  async expire(ctx: Pick<JobContext, 'item' | 'periodKey'>) {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(ctx.periodKey)
      ? ctx.periodKey
      : istBusinessDate(this.now());
    const due = await this.deps.db
      .selectFrom('coupons')
      .select(['institution_id', sql<number>`COUNT(*)`.as('n')])
      .where('status', '=', 'ACTIVE')
      .where('valid_on', '<', today)
      .groupBy('institution_id')
      .execute();
    for (const d of due) {
      const res = await this.deps.db
        .updateTable('coupons')
        .set({ status: 'EXPIRED', ended_reason: 'LAPSED', ended_at: this.now() })
        .where('institution_id', '=', String(d.institution_id))
        .where('status', '=', 'ACTIVE')
        .where('valid_on', '<', today)
        .executeTakeFirst();
      const n = Number(res.numUpdatedRows);
      ctx.item({
        institutionId: String(d.institution_id),
        status: 'SUCCESS',
        processed: n,
        failed: 0,
        note: `${n} coupon${n === 1 ? '' : 's'} expired`,
      });
    }
    return { expired: due.reduce((a, d) => a + Number(d.n), 0) };
  }
}

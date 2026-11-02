/**
 * The canteen point of sale (SRS 12.8–12.10, 9.10, 6.34; IDN-042, MER-001…012, MER-014…022;
 * prototype t.signin, t.pos).
 *
 * - A POS terminal (purpose POS) is bound to a regular merchant; that merchant's outlet is created the
 *   first time the terminal asks for its menu (OI-MER-10). Bank details stay the merchant's (12.1).
 * - Operators sign in on the paired terminal with their NFC tag (FR-MER-04) for
 *   `pos.operator.sessionMinutes`; menu, orders, collections and tags need one. The first tag of an
 *   outlet can be registered by the paired terminal alone (nobody could sign in before it).
 * - Orders are priced on the server from the menu (OI-MER-10), with each line's GST slab, before or
 *   including GST as `pos.prices.includeGst` says. They are numbered ORD-MMDD-NNN per outlet and day.
 * - Collecting: a card tapped against a one-time NFC request of the order pays it through the payment
 *   engine (channel NFC, P3: the order is marked PAID in the payment's transaction), from the campus
 *   or the allowance wallet; or a coupon of the holder covers it. No operator wallet (Q14 M7).
 * - Offline captures arrive in batches signed by the terminal; each is posted once through the engine
 *   (keyed by the terminal's capture key); a re-sent capture is acknowledged with its first outcome.
 *   A capture the member can't afford is refused, never overdrawn (Q14 M8).
 * - A POS partner (an API client bound to one institution) creates QR requests for its counters,
 *   polls them and uploads offline captures (MER-014…016).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { LIMITS, newQrToken, qrPayload, type MessageKey } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { Database, PosOrderType } from '../models/campusone_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { applyBasisPoints, toMoneyDto } from '../utils/money';
import { emit, rooms } from '../utils/outbox';
import type { Principal } from '../utils/principal';
import { qrSvg } from '../utils/qr';
import { retryOnLock } from '../utils/retry';
import { recordAudit } from './audit.service';
import type { CardsService } from './cards.service';
import type { CouponsService } from './coupons.service';
import { forCounter, type PaymentEngine } from './payment-engine.service';
import { defaultValues, type SettingValues } from './settings.service';
import type { TerminalsService } from './terminals.service';

type Db = Kysely<Database> | Transaction<Database>;
export type PosCaller = Awaited<ReturnType<TerminalsService['caller']>>;
type Instrument = 'WALLET' | 'ALLOWANCE';

/** The GST slabs a menu item may carry (CGST + SGST, RNG-MER-067), in basis points. */
export const GST_SLABS_BP = [0, 500, 1200, 1800, 2800] as const;
const TAG_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const hash = (s: string) => createHash('sha256').update(s).digest();
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
const nameOf = (first: string | null, last: string | null) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
export const maskTagToken = (last4: string) => `OT••••${last4}`;
const maskMobile = (m: string) => `••••••${m.slice(-4)}`;

/** A tag token written to the operator's NFC tag: OT + 20 characters (100 bits). */
export function newTagToken() {
  const bytes = randomBytes(20);
  let out = 'OT';
  for (const b of bytes) out += TAG_ALPHABET[b & 31];
  return out;
}

/**
 * One order line priced from the menu: GST added to the price, or contained in it (rounded half up
 * to the paisa per line).
 */
export function priceLine(unitPaise: number, qty: number, gstBp: number, inclusive: boolean) {
  const gross = unitPaise * qty;
  if (inclusive) {
    const den = BigInt(10_000 + gstBp);
    const tax = Number((BigInt(gross) * BigInt(gstBp) * 2n + den) / (2n * den));
    return { net: gross - tax, tax, total: gross };
  }
  const tax = applyBasisPoints(gross, gstBp);
  return { net: gross, tax, total: gross + tax };
}

/** CGST and SGST are half each; an odd paisa goes to SGST. */
export const splitGst = (tax: number) => ({
  cgst: Math.floor(tax / 2),
  sgst: tax - Math.floor(tax / 2),
});

/** The message a terminal signs for an offline capture (12.10, RNG-MER-090). */
export const captureMessage = (c: {
  captureKey: string;
  cardToken: string;
  amountPaise: number;
  orderId?: string | null | undefined;
  capturedAt: string;
}) => `${c.captureKey}.${c.cardToken}.${c.amountPaise}.${c.orderId ?? ''}.${c.capturedAt}`;

export interface ItemInput {
  readonly categoryId: string;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly foodType?: 'VEG' | 'NON_VEG' | null | undefined;
  readonly pricePaise: number;
  readonly gstRate?: number | undefined;
  readonly available?: boolean | undefined;
}

export interface OrderLineInput {
  readonly itemId: string;
  readonly qty: number;
}

export interface CaptureInput {
  readonly captureKey: string;
  readonly orderId?: string | null | undefined;
  readonly order?:
    { readonly type: PosOrderType; readonly lines: readonly OrderLineInput[] } | undefined;
  readonly cardToken: string;
  readonly instrument: Instrument;
  readonly amountPaise: number;
  readonly capturedAt: string;
  readonly signature?: string | undefined;
}

export class PosService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly engine: PaymentEngine;
      readonly cards: CardsService;
      readonly coupons: CouponsService;
      readonly terminals: TerminalsService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly loggers?: Loggers;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  // --- outlet and operator ------------------------------------------------------------------------
  /** The outlet of the terminal's merchant, created on first use (OI-MER-10). */
  private async outlet(t: PosCaller, db: Db = this.deps.db) {
    if (!t.merchantProfileId) throw new CustomAPIError(409, 'MER.NO_OUTLET');
    const find = () =>
      db
        .selectFrom('pos_outlets as o')
        .innerJoin('merchants as mer', 'mer.profile_id', 'o.merchant_profile_id')
        .select([
          'o.id',
          'o.public_id',
          'o.institution_id',
          'o.merchant_profile_id',
          'o.name',
          'o.opens_at',
          'o.closes_at',
          'o.gstin',
          'o.row_version',
          'mer.display_name',
        ])
        .where('o.merchant_profile_id', '=', t.merchantProfileId!)
        .where('o.institution_id', '=', t.institutionId)
        .executeTakeFirst();
    const found = await find();
    if (found) return found;
    const m = await db
      .selectFrom('merchants as mer')
      .innerJoin('member_profiles as mp', 'mp.id', 'mer.profile_id')
      .select(['mer.display_name', 'mer.sub_type', 'mp.institution_id'])
      .where('mer.profile_id', '=', t.merchantProfileId)
      .executeTakeFirst();
    if (!m || m.sub_type !== 'REGULAR' || String(m.institution_id) !== t.institutionId) {
      throw new CustomAPIError(409, 'MER.NO_OUTLET');
    }
    await db
      .insertInto('pos_outlets')
      .ignore()
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: t.institutionId,
        merchant_profile_id: t.merchantProfileId,
        name: m.display_name.slice(0, 40),
      })
      .execute();
    const created = await find();
    if (!created) throw new CustomAPIError(409, 'MER.NO_OUTLET');
    return created;
  }

  /** The operator signed in on the terminal now, or null. */
  private async operatorOf(t: PosCaller) {
    const r = await this.deps.db
      .selectFrom('terminals as t')
      .innerJoin('pos_operator_tags as g', 'g.id', 't.operator_tag_id')
      .select([
        'g.id',
        'g.public_id',
        'g.operator_name',
        'g.mobile',
        'g.status',
        'g.token_last4',
        't.operator_since',
        't.operator_until',
      ])
      .where('t.id', '=', t.id)
      .executeTakeFirst();
    if (
      !r ||
      r.status !== 'ACTIVE' ||
      !r.operator_until ||
      new Date(r.operator_until).getTime() <= this.now().getTime()
    ) {
      return null;
    }
    return r;
  }

  private async needOperator(t: PosCaller) {
    const o = await this.operatorOf(t);
    if (!o) throw new CustomAPIError(403, 'TRM.OPERATOR_REQUIRED');
    return o;
  }

  private operatorView(o: NonNullable<Awaited<ReturnType<PosService['operatorOf']>>>) {
    return {
      id: binToUuid(o.public_id),
      name: o.operator_name,
      mobile: maskMobile(o.mobile),
      tag: maskTagToken(o.token_last4),
      since: iso(o.operator_since),
      expiresAt: iso(o.operator_until),
    };
  }

  private audit(
    db: Db,
    t: PosCaller,
    action: string,
    entityType: string,
    entityRef: string,
    after?: unknown,
    before?: unknown,
  ) {
    return recordAudit(db, {
      action,
      entityType,
      entityRef,
      institutionId: t.institutionId,
      actor: { type: 'terminal', ref: t.publicId },
      ...(after !== undefined ? { after } : {}),
      ...(before !== undefined ? { before } : {}),
    });
  }

  // --- IDN-042 / MER-019 --------------------------------------------------------------------------
  async signIn(t: PosCaller, input: { operatorTag: string }) {
    const outlet = await this.outlet(t);
    const tag = await this.deps.db
      .selectFrom('pos_operator_tags')
      .select(['id', 'status', 'outlet_id'])
      .where('token_hash', '=', hash(input.operatorTag.trim().toUpperCase()))
      .executeTakeFirst();
    if (!tag || tag.status !== 'ACTIVE' || String(tag.outlet_id) !== String(outlet.id)) {
      this.deps.loggers?.security.warn('pos.operator_refused', {
        terminal: t.publicId,
        reason: !tag ? 'unknown' : tag.status !== 'ACTIVE' ? 'inactive' : 'other_outlet',
      });
      throw new CustomAPIError(403, 'TRM.OPERATOR_INVALID');
    }
    const minutes = await this.limit(LIMITS.posOperatorSessionMinutes);
    const now = this.now();
    await this.deps.db
      .updateTable('terminals')
      .set({
        operator_tag_id: tag.id,
        operator_since: now,
        operator_until: new Date(now.getTime() + minutes * 60_000),
        last_seen_at: now,
      })
      .where('id', '=', t.id)
      .execute();
    const op = await this.operatorOf(t);
    return { operator: this.operatorView(op!) };
  }

  async signOut(t: PosCaller) {
    await this.deps.db
      .updateTable('terminals')
      .set({ operator_tag_id: null, operator_since: null, operator_until: null })
      .where('id', '=', t.id)
      .execute();
  }

  // --- MER-001 ------------------------------------------------------------------------------------
  private outletView(o: Awaited<ReturnType<PosService['outlet']>>) {
    return {
      id: binToUuid(o.public_id),
      name: o.name,
      merchant: o.display_name,
      opensAt: hm(o.opens_at),
      closesAt: hm(o.closes_at),
      gstin: o.gstin,
      version: o.row_version,
    };
  }

  private itemView(
    i: {
      public_id: Buffer;
      name: string;
      description: string | null;
      food_type: 'VEG' | 'NON_VEG' | null;
      price_paise: string;
      gst_bp: number;
      available: number;
      row_version: number;
    },
    categoryId: string,
  ) {
    return {
      id: binToUuid(i.public_id),
      categoryId,
      name: i.name,
      description: i.description,
      foodType: i.food_type,
      price: toMoneyDto(Number(i.price_paise)),
      gstRate: i.gst_bp / 100,
      available: !!Number(i.available),
      version: i.row_version,
    };
  }

  async menu(t: PosCaller) {
    const o = await this.outlet(t);
    const [cats, items, op, inclusive, gstBp] = await Promise.all([
      this.deps.db
        .selectFrom('pos_categories')
        .select(['id', 'public_id', 'name'])
        .where('institution_id', '=', t.institutionId)
        .where('outlet_id', '=', o.id)
        .orderBy('id')
        .execute(),
      this.deps.db
        .selectFrom('pos_items')
        .selectAll()
        .where('institution_id', '=', t.institutionId)
        .where('outlet_id', '=', o.id)
        .orderBy('id')
        .execute(),
      this.operatorOf(t),
      this.limit(LIMITS.posPricesIncludeGst),
      this.limit(LIMITS.posDefaultGstBp),
    ]);
    return {
      terminal: { id: t.publicId, name: t.name },
      outlet: this.outletView(o),
      operator: op ? this.operatorView(op) : null,
      pricesIncludeGst: !!inclusive,
      defaultGstRate: gstBp / 100,
      gstRates: GST_SLABS_BP.map((b) => b / 100),
      categories: cats.map((c) => {
        const id = binToUuid(c.public_id);
        return {
          id,
          name: c.name,
          items: items
            .filter((i) => String(i.category_id) === String(c.id))
            .map((i) => this.itemView(i, id)),
        };
      }),
    };
  }

  // --- MER-002 ------------------------------------------------------------------------------------
  async addCategory(t: PosCaller, input: { name: string }) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    const name = input.name.trim();
    const pub = newPublicIdPair();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('pos_categories')
          .values({
            public_id: pub.bin,
            institution_id: t.institutionId,
            outlet_id: o.id,
            name,
            created_by: uuidToBin(t.publicId),
            created_at: this.now(),
          })
          .execute();
        await this.audit(trx, t, 'POS_CATEGORY_ADDED', 'pos_category', pub.id, { name });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'MER.CATEGORY_TAKEN', { params: { name } });
      }
      throw e;
    }
    return { id: pub.id, name, items: [] };
  }

  // --- MER-003 / MER-004 --------------------------------------------------------------------------
  private async checkItem(t: PosCaller, outletId: string, input: Partial<ItemInput>) {
    const errors: { field: string; code: string }[] = [];
    let categoryRowId: string | undefined;
    if (input.categoryId !== undefined) {
      const c = isUuid(input.categoryId)
        ? await this.deps.db
            .selectFrom('pos_categories')
            .select('id')
            .where('public_id', '=', uuidToBin(input.categoryId))
            .where('outlet_id', '=', outletId)
            .executeTakeFirst()
        : undefined;
      if (!c) throw new CustomAPIError(422, 'MER.CATEGORY_UNKNOWN');
      categoryRowId = String(c.id);
    }
    if (input.pricePaise !== undefined) {
      const max = await this.limit(LIMITS.posItemMaxPaise);
      if (input.pricePaise < 100 || input.pricePaise > max) {
        errors.push({ field: 'price', code: 'VALIDATION.AMOUNT' });
      }
    }
    if (
      input.gstRate !== undefined &&
      !(GST_SLABS_BP as readonly number[]).includes(Math.round(input.gstRate * 100))
    ) {
      errors.push({ field: 'gstRate', code: 'VALIDATION.FORMAT' });
    }
    if (errors.length) throw new ValidationError(errors);
    void t;
    return categoryRowId;
  }

  async addItem(t: PosCaller, input: ItemInput) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    const categoryRowId = (await this.checkItem(t, String(o.id), input))!;
    const gstBp =
      input.gstRate !== undefined
        ? Math.round(input.gstRate * 100)
        : await this.limit(LIMITS.posDefaultGstBp);
    const pub = newPublicIdPair();
    const name = input.name.trim();
    const now = this.now();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('pos_items')
          .values({
            public_id: pub.bin,
            institution_id: t.institutionId,
            outlet_id: o.id,
            category_id: categoryRowId,
            name,
            description: input.description?.trim() || null,
            food_type: input.foodType ?? null,
            price_paise: input.pricePaise,
            gst_bp: gstBp,
            available: input.available ?? true,
            created_by: uuidToBin(t.publicId),
            created_at: now,
            updated_at: now,
          })
          .execute();
        await this.audit(trx, t, 'POS_ITEM_ADDED', 'pos_item', pub.id, {
          name,
          pricePaise: input.pricePaise,
          gstBp,
        });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'MER.ITEM_TAKEN', { params: { name } });
      }
      throw e;
    }
    return this.item(t, String(o.id), pub.id);
  }

  private async item(t: PosCaller, outletId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const i = await this.deps.db
      .selectFrom('pos_items as i')
      .innerJoin('pos_categories as c', 'c.id', 'i.category_id')
      .selectAll('i')
      .select('c.public_id as category_public_id')
      .where('i.public_id', '=', uuidToBin(id))
      .where('i.outlet_id', '=', outletId)
      .where('i.institution_id', '=', t.institutionId)
      .executeTakeFirst();
    if (!i) throw new NotFoundError();
    return this.itemView(i, binToUuid(i.category_public_id));
  }

  async updateItem(t: PosCaller, id: string, expected: number, patch: Partial<ItemInput>) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    const before = await this.item(t, String(o.id), id);
    const categoryRowId = await this.checkItem(t, String(o.id), patch);
    const set: Record<string, unknown> = {};
    if (categoryRowId) set['category_id'] = categoryRowId;
    if (patch.name !== undefined) set['name'] = patch.name.trim();
    if (patch.description !== undefined) set['description'] = patch.description?.trim() || null;
    if (patch.foodType !== undefined) set['food_type'] = patch.foodType;
    if (patch.pricePaise !== undefined) set['price_paise'] = patch.pricePaise;
    if (patch.gstRate !== undefined) set['gst_bp'] = Math.round(patch.gstRate * 100);
    if (patch.available !== undefined) set['available'] = patch.available ? 1 : 0;
    if (!Object.keys(set).length) return before;
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const res = await trx
          .updateTable('pos_items')
          .set({ ...set, updated_at: this.now(), row_version: sql<number>`row_version + 1` })
          .where('public_id', '=', uuidToBin(id))
          .where('outlet_id', '=', o.id)
          .where('row_version', '=', expected)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
        await this.audit(trx, t, 'POS_ITEM_CHANGED', 'pos_item', id, patch, before);
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'MER.ITEM_TAKEN', { params: { name: patch.name ?? '' } });
      }
      throw e;
    }
    return this.item(t, String(o.id), id);
  }

  // --- MER-005 ------------------------------------------------------------------------------------
  async updateOutlet(
    t: PosCaller,
    expected: number,
    input: { name: string; opensAt: string; closesAt: string; gstin: string | null },
  ) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    if (input.closesAt <= input.opensAt) throw new CustomAPIError(422, 'MER.OUTLET_HOURS');
    const gstin = input.gstin ? input.gstin.trim().toUpperCase() : null;
    if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
      throw new ValidationError([{ field: 'gstin', code: 'VALIDATION.FORMAT' }]);
    }
    await this.deps.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('pos_outlets')
        .set({
          name: input.name.trim(),
          opens_at: `${input.opensAt}:00`,
          closes_at: `${input.closesAt}:00`,
          gstin,
          updated_by: uuidToBin(t.publicId),
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', o.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      await this.audit(
        trx,
        t,
        'POS_OUTLET_CHANGED',
        'pos_outlet',
        binToUuid(o.public_id),
        { ...input, gstin },
        this.outletView(o),
      );
    });
    return this.outletView(await this.outlet(t));
  }

  // --- MER-006 ------------------------------------------------------------------------------------
  /** Prices the lines from the outlet's menu; `strict` refuses items marked not available. */
  private async price(
    db: Db,
    t: PosCaller,
    outletId: string,
    lines: readonly OrderLineInput[],
    strict: boolean,
  ) {
    const merged = new Map<string, number>();
    for (const l of lines) {
      if (!isUuid(l.itemId)) throw new CustomAPIError(409, 'MER.ITEM_UNKNOWN');
      merged.set(l.itemId.toLowerCase(), (merged.get(l.itemId.toLowerCase()) ?? 0) + l.qty);
    }
    const items = await db
      .selectFrom('pos_items')
      .select(['id', 'public_id', 'name', 'price_paise', 'gst_bp', 'available'])
      .where('institution_id', '=', t.institutionId)
      .where('outlet_id', '=', outletId)
      .where(
        'public_id',
        'in',
        [...merged.keys()].map((k) => uuidToBin(k)),
      )
      .execute();
    const byId = new Map(items.map((i) => [binToUuid(i.public_id), i]));
    const inclusive = !!(await this.limit(LIMITS.posPricesIncludeGst));
    const priced = [...merged.entries()].map(([id, qty], n) => {
      const i = byId.get(id);
      if (!i) throw new CustomAPIError(409, 'MER.ITEM_UNKNOWN');
      if (strict && !Number(i.available)) {
        throw new CustomAPIError(409, 'MER.ITEM_UNAVAILABLE', { params: { name: i.name } });
      }
      if (qty > 99) throw new ValidationError([{ field: 'lines', code: 'VALIDATION.FORMAT' }]);
      const p = priceLine(Number(i.price_paise), qty, i.gst_bp, inclusive);
      return {
        lineNo: n + 1,
        itemId: String(i.id),
        name: i.name,
        unit: Number(i.price_paise),
        qty,
        gstBp: i.gst_bp,
        ...p,
      };
    });
    const sum = (k: 'net' | 'tax' | 'total') => priced.reduce((a, l) => a + l[k], 0);
    return { lines: priced, subtotal: sum('net'), tax: sum('tax'), total: sum('total') };
  }

  /** Writes an order with its lines; numbered under the outlet's row lock. */
  private async insertOrder(
    trx: Transaction<Database>,
    t: PosCaller,
    outletId: string,
    operatorTagId: string | null,
    type: PosOrderType,
    priced: Awaited<ReturnType<PosService['price']>>,
    offline: boolean,
  ) {
    const now = this.now();
    const day = istBusinessDate(now);
    await trx
      .updateTable('pos_outlets')
      .set({
        order_seq: sql<number>`IF(order_day = ${day}, order_seq + 1, 1)`,
        order_day: day,
      })
      .where('id', '=', outletId)
      .execute();
    const seq = await trx
      .selectFrom('pos_outlets')
      .select('order_seq')
      .where('id', '=', outletId)
      .executeTakeFirstOrThrow();
    const orderNo = `ORD-${day.slice(5, 7)}${day.slice(8, 10)}-${String(seq.order_seq).padStart(3, '0')}`;
    const pub = newPublicIdPair();
    const r = await trx
      .insertInto('pos_orders')
      .values({
        public_id: pub.bin,
        institution_id: t.institutionId,
        outlet_id: outletId,
        terminal_id: t.id,
        operator_tag_id: operatorTagId,
        order_no: orderNo,
        business_date: day,
        order_type: type,
        subtotal_paise: priced.subtotal,
        tax_paise: priced.tax,
        total_paise: priced.total,
        offline: offline ? 1 : 0,
        created_at: now,
      })
      .executeTakeFirstOrThrow();
    const orderId = String(r.insertId);
    await trx
      .insertInto('pos_order_lines')
      .values(
        priced.lines.map((l) => ({
          order_id: orderId,
          line_no: l.lineNo,
          item_id: l.itemId,
          name: l.name,
          unit_price_paise: l.unit,
          qty: l.qty,
          gst_bp: l.gstBp,
          net_paise: l.net,
          tax_paise: l.tax,
          total_paise: l.total,
        })),
      )
      .execute();
    return { id: orderId, publicId: pub.id, orderNo };
  }

  async createOrder(t: PosCaller, input: { type: PosOrderType; lines: readonly OrderLineInput[] }) {
    const op = await this.needOperator(t);
    const o = await this.outlet(t);
    const priced = await this.price(this.deps.db, t, String(o.id), input.lines, true);
    const created = await retryOnLock(() =>
      this.deps.db
        .transaction()
        .execute((trx) =>
          this.insertOrder(trx, t, String(o.id), String(op.id), input.type, priced, false),
        ),
    );
    return this.order(t, created.publicId);
  }

  // --- orders -------------------------------------------------------------------------------------
  private async orderRows(t: PosCaller, outletId: string, f: { id?: string; day?: string }) {
    let q = this.deps.db
      .selectFrom('pos_orders as o')
      .leftJoin('member_profiles as m', 'm.id', 'o.payer_profile_id')
      .leftJoin('payment_attempts as a', 'a.id', 'o.payment_attempt_id')
      .leftJoin('pos_operator_tags as g', 'g.id', 'o.operator_tag_id')
      .selectAll('o')
      .select(['m.first_name', 'm.last_name', 'a.reference', 'g.operator_name'])
      .where('o.institution_id', '=', t.institutionId)
      .where('o.outlet_id', '=', outletId);
    if (f.id) q = q.where('o.public_id', '=', uuidToBin(f.id));
    if (f.day) q = q.where('o.business_date', '=', f.day);
    const rows = await q.orderBy('o.id', 'desc').limit(500).execute();
    const lines = rows.length
      ? await this.deps.db
          .selectFrom('pos_order_lines as l')
          .innerJoin('pos_items as i', 'i.id', 'l.item_id')
          .selectAll('l')
          .select('i.public_id as item_public_id')
          .where(
            'l.order_id',
            'in',
            rows.map((r) => String(r.id)),
          )
          .orderBy('l.line_no')
          .execute()
      : [];
    return rows.map((r) => ({
      r,
      lines: lines.filter((l) => String(l.order_id) === String(r.id)),
    }));
  }

  private orderView(x: Awaited<ReturnType<PosService['orderRows']>>[number]) {
    const { r, lines } = x;
    const tax = Number(r.tax_paise);
    const gst = splitGst(tax);
    return {
      id: binToUuid(r.public_id),
      number: r.order_no,
      type: r.order_type,
      status: r.status,
      payment:
        r.status === 'PAID'
          ? ('SUCCESS' as const)
          : r.status === 'CANCELLED'
            ? ('CANCELLED' as const)
            : r.last_failure_code
              ? ('FAILED' as const)
              : ('PENDING' as const),
      lastFailureCode: r.status === 'CREATED' ? r.last_failure_code : null,
      lines: lines.map((l) => ({
        itemId: binToUuid(l.item_public_id),
        name: l.name,
        qty: l.qty,
        unitPrice: toMoneyDto(Number(l.unit_price_paise)),
        gstRate: l.gst_bp / 100,
        net: toMoneyDto(Number(l.net_paise)),
        tax: toMoneyDto(Number(l.tax_paise)),
        total: toMoneyDto(Number(l.total_paise)),
      })),
      subtotal: toMoneyDto(Number(r.subtotal_paise)),
      tax: toMoneyDto(tax),
      cgst: toMoneyDto(gst.cgst),
      sgst: toMoneyDto(gst.sgst),
      total: toMoneyDto(Number(r.total_paise)),
      instrument: r.instrument,
      payer: r.payer_profile_id ? { name: nameOf(r.first_name, r.last_name) } : null,
      reference: r.reference ?? null,
      operator: r.operator_name ?? null,
      offline: !!Number(r.offline),
      createdAt: iso(r.created_at),
      paidAt: iso(r.paid_at),
      cancelledAt: iso(r.cancelled_at),
      version: r.row_version,
    };
  }

  private async order(t: PosCaller, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const o = await this.outlet(t);
    const [x] = await this.orderRows(t, String(o.id), { id });
    if (!x) throw new NotFoundError();
    return this.orderView(x);
  }

  /** The order's row in the terminal's outlet. */
  private async orderRow(t: PosCaller, outletId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.deps.db
      .selectFrom('pos_orders')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .where('outlet_id', '=', outletId)
      .where('institution_id', '=', t.institutionId)
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  // --- MER-020 ------------------------------------------------------------------------------------
  async orders(t: PosCaller, f: { date?: string | undefined }) {
    const o = await this.outlet(t);
    const day = f.date ?? istBusinessDate(this.now());
    const list = (await this.orderRows(t, String(o.id), { day })).map((x) => this.orderView(x));
    const paid = list.filter((x) => x.status === 'PAID');
    const unpaid = list.filter((x) => x.status === 'CREATED');
    const paise = (xs: typeof list) => xs.reduce((a, x) => a + Number(x.total.amount) * 100, 0);
    const captures = await this.deps.db
      .selectFrom('pos_offline_captures')
      .select(['outcome', sql<number>`COUNT(*)`.as('n')])
      .where('institution_id', '=', t.institutionId)
      .where('terminal_id', '=', t.id)
      .where('processed_at', '>=', new Date(`${day}T00:00:00+05:30`))
      .groupBy('outcome')
      .execute();
    const term = await this.deps.db
      .selectFrom('terminals')
      .select('last_sync_at')
      .where('id', '=', t.id)
      .executeTakeFirst();
    const count = (k: string) => Number(captures.find((c) => c.outcome === k)?.n ?? 0);
    return {
      date: day,
      summary: {
        orders: list.length,
        collected: toMoneyDto(Math.round(paise(paid))),
        unpaid: { count: unpaid.length, amount: toMoneyDto(Math.round(paise(unpaid))) },
        offline: { accepted: count('ACCEPTED'), refused: count('REFUSED') },
        lastSyncAt: iso(term?.last_sync_at),
      },
      items: list,
    };
  }

  // --- MER-007 ------------------------------------------------------------------------------------
  async cancelOrder(t: PosCaller, id: string, input: { reason?: string | null | undefined }) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    const row = await this.orderRow(t, String(o.id), id);
    await this.deps.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('pos_orders')
        .set({
          status: 'CANCELLED',
          cancelled_at: this.now(),
          cancel_reason: input.reason?.trim() || null,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'CREATED')
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'MER.ORDER_PAID');
      await trx
        .updateTable('payment_requests')
        .set({ status: 'CANCELLED', row_version: sql<number>`row_version + 1` })
        .where('order_id', '=', row.id)
        .where('status', '=', 'PENDING')
        .execute();
      await this.audit(trx, t, 'POS_ORDER_CANCELLED', 'pos_order', id, {
        reason: input.reason ?? null,
      });
    });
    return this.order(t, id);
  }

  // --- MER-017 / MER-018 --------------------------------------------------------------------------
  async createRequest(t: PosCaller, orderId: string, input: { instrument: Instrument }) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    const row = await this.orderRow(t, String(o.id), orderId);
    if (row.status !== 'CREATED') throw new CustomAPIError(409, 'MER.ORDER_PAID');
    const ttl = await this.limit(LIMITS.paymentRequestTtlSeconds);
    const now = this.now();
    const pub = newPublicIdPair();
    const nonce = randomBytes(16).toString('base64url');
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    await this.deps.db.transaction().execute(async (trx) => {
      // A new request replaces the order's earlier one (prototype "Choose another instrument").
      await trx
        .updateTable('payment_requests')
        .set({ status: 'CANCELLED', row_version: sql<number>`row_version + 1` })
        .where('order_id', '=', row.id)
        .where('status', '=', 'PENDING')
        .execute();
      await trx
        .insertInto('payment_requests')
        .values({
          public_id: pub.bin,
          institution_id: t.institutionId,
          merchant_profile_id: o.merchant_profile_id,
          kind: 'NFC',
          instrument: input.instrument,
          order_id: row.id,
          terminal_id: t.id,
          amount_paise: row.total_paise,
          token: newQrToken(),
          nonce_hash: hash(nonce),
          status: 'PENDING',
          expires_at: expiresAt,
          created_by: uuidToBin(t.publicId),
          created_at: now,
        })
        .execute();
    });
    return {
      requestId: pub.id,
      orderId,
      instrument: input.instrument,
      amount: toMoneyDto(Number(row.total_paise)),
      nonce,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: ttl,
    };
  }

  async cancelRequest(t: PosCaller, requestId: string) {
    if (!isUuid(requestId)) throw new NotFoundError();
    const res = await this.deps.db
      .updateTable('payment_requests')
      .set({ status: 'CANCELLED', row_version: sql<number>`row_version + 1` })
      .where('public_id', '=', uuidToBin(requestId))
      .where('terminal_id', '=', t.id)
      .where('institution_id', '=', t.institutionId)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) {
      const exists = await this.deps.db
        .selectFrom('payment_requests')
        .select('id')
        .where('public_id', '=', uuidToBin(requestId))
        .where('terminal_id', '=', t.id)
        .executeTakeFirst();
      if (!exists) throw new NotFoundError();
      throw new CustomAPIError(409, 'PAY.REQUEST_NOT_PENDING');
    }
    return { requestId, status: 'CANCELLED' as const };
  }

  // --- MER-008 ------------------------------------------------------------------------------------
  async collect(
    t: PosCaller,
    orderId: string,
    input: {
      instrument: Instrument | 'COUPON';
      cardToken: string;
      requestId?: string | undefined;
      nonce?: string | undefined;
    },
    idempotencyKey: string,
  ) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    const row = await this.orderRow(t, String(o.id), orderId);
    if (row.status !== 'CREATED') throw new CustomAPIError(409, 'MER.ORDER_PAID');
    const remember = async (code: string) => {
      await this.deps.db
        .updateTable('pos_orders')
        .set({ last_failure_code: code.slice(0, 64) })
        .where('id', '=', row.id)
        .where('status', '=', 'CREATED')
        .execute();
    };
    try {
      const card = await this.deps.cards.activeCard(t.institutionId, input.cardToken);
      await this.deps.cards.touch(String(card.id));
      if (input.instrument === 'COUPON') return await this.coverByCoupon(t, o, row, card);
      if (!input.requestId || !input.nonce || !isUuid(input.requestId)) {
        throw new ValidationError([{ field: 'requestId', code: 'VALIDATION.REQUIRED' }]);
      }
      const r = await this.deps.db
        .selectFrom('payment_requests')
        .selectAll()
        .where('public_id', '=', uuidToBin(input.requestId))
        .where('terminal_id', '=', t.id)
        .where('order_id', '=', row.id)
        .executeTakeFirst();
      if (!r || r.kind !== 'NFC' || !r.nonce_hash) throw new NotFoundError();
      if (
        !hash(input.nonce).equals(r.nonce_hash) ||
        r.status !== 'PENDING' ||
        r.payment_attempt_id
      ) {
        this.deps.loggers?.security.warn('pay.nonce_replay', {
          request: input.requestId,
          terminal: t.publicId,
        });
        throw new CustomAPIError(409, 'PAY.NONCE_REPLAY');
      }
      const result = await this.deps.engine.pay({
        channel: 'NFC',
        instrument: r.instrument,
        institutionId: t.institutionId,
        payerProfileId: String(card.profile_id),
        payeeProfileId: String(o.merchant_profile_id),
        amountPaise: Number(r.amount_paise),
        remarks: `POS order ${row.order_no}`,
        idempotencyKey,
        requestId: String(r.id),
        orderId: String(row.id),
        auth: { kind: 'card', accountId: card.account_id ? String(card.account_id) : null },
        actorRef: uuidToBin(t.publicId),
      });
      return {
        order: await this.order(t, orderId),
        receipt: {
          reference: result.attempt.reference,
          amount: toMoneyDto(result.attempt.amountPaise),
          instrument: r.instrument,
          payer: { name: nameOf(card.first_name, card.last_name) },
          paidAt: iso(result.attempt.completedAt ?? result.attempt.attemptedAt),
        },
        coupon: null,
        replayed: result.replayed,
      };
    } catch (e) {
      const out = forCounter(e);
      if (out instanceof CustomAPIError && out.code !== 'MER.ORDER_PAID') await remember(out.code);
      throw out;
    }
  }

  /** The holder's coupon covers the order (prototype t.pos "Coupon"; no money moves, Q14 M5). */
  private async coverByCoupon(
    t: PosCaller,
    o: Awaited<ReturnType<PosService['outlet']>>,
    row: { id: string; public_id: Buffer },
    card: Awaited<ReturnType<CardsService['activeCard']>>,
  ) {
    const orderId = binToUuid(row.public_id);
    const redeemed = await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom('pos_orders')
          .select('status')
          .where('id', '=', row.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (locked.status !== 'CREATED') throw new CustomAPIError(409, 'MER.ORDER_PAID');
        const r = await this.deps.coupons.redeemAtCounter(trx, {
          institutionId: t.institutionId,
          profileId: String(card.profile_id),
          merchantProfileId: String(o.merchant_profile_id),
          terminalId: t.id,
        });
        const now = this.now();
        await trx
          .updateTable('pos_orders')
          .set({
            status: 'PAID',
            instrument: 'COUPON',
            payer_profile_id: String(card.profile_id),
            coupon_redemption_id: r.rowId,
            paid_at: now,
            last_failure_code: null,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', row.id)
          .where('status', '=', 'CREATED')
          .execute();
        await emit(trx, {
          institutionId: t.institutionId,
          type: 'pos.order.updated',
          rooms: [rooms.profile(String(o.merchant_profile_id))],
          data: { orderId, status: 'PAID', coupon: r.view.coupon.type },
        });
        return r.view;
      }),
    );
    return {
      order: await this.order(t, orderId),
      receipt: null,
      coupon: {
        type: redeemed.coupon.type,
        holder: redeemed.holder.name,
        redeemedAt: redeemed.redeemedAt,
      },
      replayed: false,
    };
  }

  // --- MER-009 / MER-010 / MER-016 ----------------------------------------------------------------
  async sync(
    t: PosCaller,
    input: { batchId: string; captures: readonly CaptureInput[] },
    via: { apiClientId?: string | undefined } = {},
  ) {
    if (!isUuid(input.batchId))
      throw new ValidationError([{ field: 'batchId', code: 'VALIDATION.FORMAT' }]);
    const max = await this.limit(LIMITS.posOfflineBatchMax);
    if (input.captures.length > max) {
      throw new CustomAPIError(422, 'MER.BATCH_TOO_LARGE', { params: { max } });
    }
    const o = await this.outlet(t);
    const existing = await this.batchRow(t, input.batchId);
    if (existing) return this.batchView(t, existing);
    // A partner's call is signed as a whole (WAL-012 scheme); a terminal signs each capture.
    const verify = via.apiClientId ? null : await this.deps.terminals.verifier(t.id);
    const pub = { id: input.batchId.toLowerCase(), bin: uuidToBin(input.batchId) };
    let batchRowId: string;
    try {
      const r = await this.deps.db
        .insertInto('pos_offline_batches')
        .values({
          public_id: pub.bin,
          institution_id: t.institutionId,
          terminal_id: t.id,
          api_client_id: via.apiClientId ?? null,
          captures: input.captures.length,
          received_at: this.now(),
        })
        .executeTakeFirstOrThrow();
      batchRowId = String(r.insertId);
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        const again = await this.batchRow(t, input.batchId);
        if (again) return this.batchView(t, again);
      }
      throw e;
    }
    let seq = 0;
    for (const c of input.captures) {
      const out = await this.capture(t, o, batchRowId, c, verify);
      await this.deps.db
        .insertInto('pos_offline_batch_items')
        .values({
          batch_id: batchRowId,
          capture_id: out.captureId,
          seq: ++seq,
          replayed: out.replayed,
        })
        .execute();
    }
    await this.deps.db
      .updateTable('terminals')
      .set({ last_sync_at: this.now() })
      .where('id', '=', t.id)
      .execute();
    return this.batchView(t, (await this.batchRow(t, input.batchId))!);
  }

  private batchRow(t: PosCaller, batchId: string) {
    return this.deps.db
      .selectFrom('pos_offline_batches')
      .selectAll()
      .where('terminal_id', '=', t.id)
      .where('institution_id', '=', t.institutionId)
      .where('public_id', '=', uuidToBin(batchId))
      .executeTakeFirst();
  }

  async batch(t: PosCaller, batchId: string) {
    if (!isUuid(batchId)) throw new NotFoundError();
    const b = await this.batchRow(t, batchId);
    if (!b) throw new NotFoundError();
    return this.batchView(t, b);
  }

  private async batchView(
    t: PosCaller,
    b: NonNullable<Awaited<ReturnType<PosService['batchRow']>>>,
  ) {
    const rows = await this.deps.db
      .selectFrom('pos_offline_batch_items as bi')
      .innerJoin('pos_offline_captures as c', 'c.id', 'bi.capture_id')
      .leftJoin('payment_attempts as a', 'a.id', 'c.payment_attempt_id')
      .leftJoin('pos_orders as o', 'o.id', 'c.order_id')
      .select([
        'bi.seq',
        'bi.replayed',
        'c.capture_key',
        'c.outcome',
        'c.refusal_code',
        'c.amount_paise',
        'c.captured_at',
        'c.card_last4',
        'a.reference',
        'o.public_id as order_public_id',
        'o.order_no',
      ])
      .where('bi.batch_id', '=', b.id)
      .orderBy('bi.seq')
      .execute();
    const captures = rows.map((r) => ({
      captureKey: r.capture_key,
      outcome: r.outcome,
      replayed: !!Number(r.replayed),
      code: r.refusal_code,
      reference: r.reference ?? null,
      order: r.order_public_id ? { id: binToUuid(r.order_public_id), number: r.order_no } : null,
      amount: toMoneyDto(Number(r.amount_paise)),
      card: r.card_last4 ? `NFC••••${r.card_last4}` : null,
      capturedAt: iso(r.captured_at),
    }));
    void t;
    return {
      batchId: binToUuid(b.public_id),
      receivedAt: iso(b.received_at),
      summary: {
        accepted: captures.filter((c) => !c.replayed && c.outcome === 'ACCEPTED').length,
        refused: captures.filter((c) => !c.replayed && c.outcome === 'REFUSED').length,
        replayed: captures.filter((c) => c.replayed).length,
      },
      captures,
    };
  }

  /** One capture, posted at most once (RNG-MER-089); returns its row and whether it was a repeat. */
  private async capture(
    t: PosCaller,
    o: Awaited<ReturnType<PosService['outlet']>>,
    batchRowId: string,
    c: CaptureInput,
    verify: ((message: string, signature: string) => boolean) | null,
  ): Promise<{ captureId: string; replayed: boolean }> {
    const prior = await this.deps.db
      .selectFrom('pos_offline_captures')
      .selectAll()
      .where('terminal_id', '=', t.id)
      .where('capture_key', '=', c.captureKey)
      .executeTakeFirst();
    if (prior && prior.outcome !== 'PROCESSING')
      return { captureId: String(prior.id), replayed: true };

    const now = this.now();
    const capturedAt = new Date(c.capturedAt);
    let refusal: { code: MessageKey; params?: Record<string, string | number> } | null = null;
    const maxAge = await this.limit(LIMITS.posOfflineMaxAgeHours);
    if (verify && !verify(captureMessage(c), c.signature ?? '')) {
      refusal = { code: 'MER.CAPTURE_SIGNATURE' };
    } else if (
      Number.isNaN(capturedAt.getTime()) ||
      capturedAt.getTime() > now.getTime() + 300_000
    ) {
      refusal = { code: 'MER.CAPTURE_TIME_INVALID' };
    } else if (now.getTime() - capturedAt.getTime() > maxAge * 3_600_000) {
      refusal = { code: 'MER.CAPTURE_TOO_OLD', params: { hours: maxAge } };
    }
    let card: Awaited<ReturnType<CardsService['activeCard']>> | null = null;
    if (!refusal) {
      try {
        card = await this.deps.cards.activeCard(t.institutionId, c.cardToken);
      } catch (e) {
        if (!(e instanceof CustomAPIError)) throw e;
        refusal = { code: e.code };
      }
    }
    // The order: one created online before the connection dropped, or one priced now from its lines.
    let orderRowId: string | null = null;
    let orderNo = '';
    let priced: Awaited<ReturnType<PosService['price']>> | null = null;
    if (!refusal) {
      try {
        if (c.orderId) {
          const row = await this.orderRow(t, String(o.id), c.orderId);
          if (row.status !== 'CREATED') throw new CustomAPIError(409, 'MER.ORDER_PAID');
          if (Number(row.total_paise) !== c.amountPaise) {
            throw new CustomAPIError(409, 'MER.CAPTURE_AMOUNT_MISMATCH', {
              params: {
                captured: toMoneyDto(c.amountPaise).amount,
                total: toMoneyDto(Number(row.total_paise)).amount,
              },
            });
          }
          orderRowId = String(row.id);
          orderNo = row.order_no;
        } else if (c.order) {
          priced = await this.price(this.deps.db, t, String(o.id), c.order.lines, false);
          if (priced.total !== c.amountPaise) {
            throw new CustomAPIError(409, 'MER.CAPTURE_AMOUNT_MISMATCH', {
              params: {
                captured: toMoneyDto(c.amountPaise).amount,
                total: toMoneyDto(priced.total).amount,
              },
            });
          }
        } else {
          throw new ValidationError([{ field: 'orderId', code: 'VALIDATION.REQUIRED' }]);
        }
      } catch (e) {
        if (!(e instanceof CustomAPIError)) throw e;
        refusal = { code: e.code };
      }
    }

    // The capture row: claimed before posting, so a concurrent re-send sees it.
    let captureId: string;
    if (prior) {
      captureId = String(prior.id);
      orderRowId = orderRowId ?? (prior.order_id ? String(prior.order_id) : null);
    } else {
      try {
        const r = await this.deps.db
          .insertInto('pos_offline_captures')
          .values({
            institution_id: t.institutionId,
            terminal_id: t.id,
            batch_id: batchRowId,
            capture_key: c.captureKey,
            order_id: orderRowId,
            card_last4: c.cardToken.trim().slice(-4).toUpperCase() || null,
            payer_profile_id: card ? String(card.profile_id) : null,
            instrument: c.instrument,
            amount_paise: c.amountPaise,
            captured_at: Number.isNaN(capturedAt.getTime()) ? now : capturedAt,
          })
          .executeTakeFirstOrThrow();
        captureId = String(r.insertId);
      } catch (e) {
        if ((e as { errno?: number }).errno === 1062) {
          const again = await this.deps.db
            .selectFrom('pos_offline_captures')
            .select('id')
            .where('terminal_id', '=', t.id)
            .where('capture_key', '=', c.captureKey)
            .executeTakeFirstOrThrow();
          return { captureId: String(again.id), replayed: true };
        }
        throw e;
      }
    }
    const finish = async (
      outcome: 'ACCEPTED' | 'REFUSED',
      extra: { refusal_code?: string; payment_attempt_id?: string | null },
    ) => {
      await this.deps.db
        .updateTable('pos_offline_captures')
        .set({ outcome, processed_at: this.now(), order_id: orderRowId, ...extra })
        .where('id', '=', captureId)
        .execute();
      return { captureId, replayed: false };
    };
    if (refusal) return finish('REFUSED', { refusal_code: refusal.code });

    // An order priced from its lines is written now (offline; the operator is the terminal's last).
    if (!orderRowId && priced && c.order) {
      const created = await retryOnLock(() =>
        this.deps.db
          .transaction()
          .execute((trx) =>
            this.insertOrder(trx, t, String(o.id), null, c.order!.type, priced!, true),
          ),
      );
      orderRowId = created.id;
      orderNo = created.orderNo;
    }
    try {
      const result = await this.deps.engine.pay({
        channel: 'NFC',
        instrument: c.instrument,
        institutionId: t.institutionId,
        payerProfileId: String(card!.profile_id),
        payeeProfileId: String(o.merchant_profile_id),
        amountPaise: c.amountPaise,
        remarks: `Offline POS order ${orderNo}`.trim(),
        idempotencyKey: `POSOFF:${createHash('sha256').update(`${t.id}:${c.captureKey}`).digest('hex')}`,
        orderId: orderRowId!,
        auth: { kind: 'card', accountId: card!.account_id ? String(card!.account_id) : null },
        actorRef: uuidToBin(t.publicId),
      });
      const attempt = await this.deps.db
        .selectFrom('payment_attempts')
        .select('id')
        .where('reference', '=', result.attempt.reference)
        .executeTakeFirst();
      return finish('ACCEPTED', { payment_attempt_id: attempt ? String(attempt.id) : null });
    } catch (thrown) {
      const e = forCounter(thrown);
      if (!(e instanceof CustomAPIError)) throw e;
      if (orderRowId) {
        await this.deps.db
          .updateTable('pos_orders')
          .set({ last_failure_code: e.code.slice(0, 64) })
          .where('id', '=', orderRowId)
          .where('status', '=', 'CREATED')
          .execute();
      }
      const ref = (e.extensions as { attempt?: { reference?: string } }).attempt?.reference;
      const attempt = ref
        ? await this.deps.db
            .selectFrom('payment_attempts')
            .select('id')
            .where('reference', '=', ref)
            .executeTakeFirst()
        : undefined;
      return finish('REFUSED', {
        refusal_code: e.code,
        payment_attempt_id: attempt ? String(attempt.id) : null,
      });
    }
  }

  // --- MER-021 / MER-011 / MER-022 ----------------------------------------------------------------
  async tags(t: PosCaller) {
    const o = await this.outlet(t);
    const op = await this.operatorOf(t);
    const rows = await this.deps.db
      .selectFrom('pos_operator_tags')
      .selectAll()
      .where('institution_id', '=', t.institutionId)
      .where('outlet_id', '=', o.id)
      .orderBy('status')
      .orderBy('issued_at', 'desc')
      .execute();
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        operatorName: r.operator_name,
        mobile: maskMobile(r.mobile),
        tag: maskTagToken(r.token_last4),
        status: r.status,
        reissueCount: r.reissue_count,
        reissueReason: r.reissue_reason,
        issuedAt: iso(r.issued_at),
        endedAt: iso(r.ended_at),
        signedInNow: !!op && String(op.id) === String(r.id),
      })),
    };
  }

  async registerTag(t: PosCaller, input: { operatorName: string; operatorMobile: string }) {
    const o = await this.outlet(t);
    const active = await this.deps.db
      .selectFrom('pos_operator_tags')
      .select(['id', 'mobile', 'operator_name', 'token_last4'])
      .where('outlet_id', '=', o.id)
      .where('status', '=', 'ACTIVE')
      .execute();
    // The first tag of an outlet: the paired terminal alone; afterwards an operator registers.
    if (active.length) await this.needOperator(t);
    const dup = active.find((a) => a.mobile === input.operatorMobile);
    if (dup) {
      throw new CustomAPIError(409, 'MER.TAG_ACTIVE_EXISTS', {
        params: { tag: maskTagToken(dup.token_last4), name: dup.operator_name },
      });
    }
    const token = newTagToken();
    const pub = newPublicIdPair();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('pos_operator_tags')
          .values({
            public_id: pub.bin,
            institution_id: t.institutionId,
            outlet_id: o.id,
            operator_name: input.operatorName.trim(),
            mobile: input.operatorMobile,
            token_hash: hash(token),
            token_last4: token.slice(-4),
            issued_by_terminal: t.id,
            issued_at: this.now(),
          })
          .execute();
        await this.audit(trx, t, 'POS_TAG_REGISTERED', 'pos_operator_tag', pub.id, {
          operatorName: input.operatorName.trim(),
          mobile: maskMobile(input.operatorMobile),
        });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'MER.TAG_ACTIVE_EXISTS', {
          params: { tag: '', name: input.operatorName.trim() },
        });
      }
      throw e;
    }
    return { tag: await this.tagView(pub.id), tagToken: token };
  }

  private async tagView(id: string) {
    const r = await this.deps.db
      .selectFrom('pos_operator_tags')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirstOrThrow();
    return {
      id,
      operatorName: r.operator_name,
      mobile: maskMobile(r.mobile),
      tag: maskTagToken(r.token_last4),
      status: r.status,
      reissueCount: r.reissue_count,
      reissueReason: r.reissue_reason,
      issuedAt: iso(r.issued_at),
      endedAt: iso(r.ended_at),
    };
  }

  async reissueTag(t: PosCaller, tagId: string, input: { reason: string }) {
    await this.needOperator(t);
    const o = await this.outlet(t);
    if (!isUuid(tagId)) throw new NotFoundError();
    const token = newTagToken();
    const pub = newPublicIdPair();
    await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const old = await trx
          .selectFrom('pos_operator_tags')
          .selectAll()
          .where('public_id', '=', uuidToBin(tagId))
          .where('outlet_id', '=', o.id)
          .where('institution_id', '=', t.institutionId)
          .forUpdate()
          .executeTakeFirst();
        if (!old) throw new NotFoundError();
        if (old.status !== 'ACTIVE') throw new CustomAPIError(409, 'MER.TAG_NOT_ACTIVE');
        const now = this.now();
        await trx
          .updateTable('pos_operator_tags')
          .set({ status: 'INACTIVE', ended_at: now })
          .where('id', '=', old.id)
          .execute();
        const r = await trx
          .insertInto('pos_operator_tags')
          .values({
            public_id: pub.bin,
            institution_id: t.institutionId,
            outlet_id: o.id,
            operator_name: old.operator_name,
            mobile: old.mobile,
            token_hash: hash(token),
            token_last4: token.slice(-4),
            reissue_count: old.reissue_count + 1,
            replaces_id: old.id,
            reissue_reason: input.reason.trim(),
            issued_by_terminal: t.id,
            issued_at: now,
          })
          .executeTakeFirstOrThrow();
        // An operator signed in with the old tag stays signed in on the new one (prototype).
        await trx
          .updateTable('terminals')
          .set({ operator_tag_id: String(r.insertId) })
          .where('operator_tag_id', '=', old.id)
          .execute();
        await this.audit(
          trx,
          t,
          'POS_TAG_REISSUED',
          'pos_operator_tag',
          pub.id,
          { replaces: tagId, reason: input.reason.trim(), reissueCount: old.reissue_count + 1 },
          { status: 'ACTIVE' },
        );
      }),
    );
    return { tag: await this.tagView(pub.id), tagToken: token };
  }

  // --- MER-012 ------------------------------------------------------------------------------------
  async consoleTerminals(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await this.deps.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!inst) throw new NotFoundError();
    const instId = String(inst.id);
    const now = this.now();
    const day = istBusinessDate(now);
    const rows = await this.deps.db
      .selectFrom('terminals as t')
      .leftJoin('merchants as mer', 'mer.profile_id', 't.merchant_profile_id')
      .leftJoin('pos_outlets as o', 'o.merchant_profile_id', 't.merchant_profile_id')
      .leftJoin('pos_operator_tags as g', 'g.id', 't.operator_tag_id')
      .select([
        't.id',
        't.public_id',
        't.name',
        't.location',
        't.status',
        't.last_seen_at',
        't.last_sync_at',
        't.operator_until',
        'mer.display_name',
        'o.name as outlet_name',
        'g.operator_name',
        'g.status as tag_status',
      ])
      .where('t.institution_id', '=', instId)
      .where('t.purpose', '=', 'POS')
      .orderBy('t.name')
      .execute();
    const ids = rows.map((r) => String(r.id));
    const orders = ids.length
      ? await this.deps.db
          .selectFrom('pos_orders')
          .select([
            'terminal_id',
            'status',
            sql<number>`COUNT(*)`.as('n'),
            sql<string>`COALESCE(SUM(total_paise), 0)`.as('paise'),
          ])
          .where('institution_id', '=', instId)
          .where('business_date', '=', day)
          .where('terminal_id', 'in', ids)
          .groupBy(['terminal_id', 'status'])
          .execute()
      : [];
    const captures = ids.length
      ? await this.deps.db
          .selectFrom('pos_offline_captures')
          .select(['terminal_id', 'outcome', sql<number>`COUNT(*)`.as('n')])
          .where('institution_id', '=', instId)
          .where('terminal_id', 'in', ids)
          .where('processed_at', '>=', new Date(`${day}T00:00:00+05:30`))
          .groupBy(['terminal_id', 'outcome'])
          .execute()
      : [];
    const of = <T extends { terminal_id: string }>(xs: T[], id: string) =>
      xs.filter((x) => String(x.terminal_id) === id);
    return {
      date: day,
      items: rows.map((r) => {
        const id = String(r.id);
        const ord = of(orders, id);
        const cap = of(captures, id);
        const signedIn =
          !!r.operator_name &&
          r.tag_status === 'ACTIVE' &&
          !!r.operator_until &&
          new Date(r.operator_until).getTime() > now.getTime();
        const n = (s: string) => Number(ord.find((x) => x.status === s)?.n ?? 0);
        const paise = (s: string) => Number(ord.find((x) => x.status === s)?.paise ?? 0);
        return {
          id: binToUuid(r.public_id),
          name: r.name,
          location: r.location,
          status: r.status,
          merchant: r.display_name ?? null,
          outlet: r.outlet_name ?? null,
          operator: signedIn ? r.operator_name : null,
          lastSeenAt: iso(r.last_seen_at),
          lastSyncAt: iso(r.last_sync_at),
          today: {
            orders: ord.reduce((a, x) => a + Number(x.n), 0),
            paid: n('PAID'),
            collected: toMoneyDto(paise('PAID')),
            unpaid: n('CREATED'),
            offlineAccepted: Number(cap.find((x) => x.outcome === 'ACCEPTED')?.n ?? 0),
            offlineRefused: Number(cap.find((x) => x.outcome === 'REFUSED')?.n ?? 0),
          },
        };
      }),
    };
  }

  // --- MER-014 / MER-015 / MER-016: the POS partner API -------------------------------------------
  /** The partner's counter: a POS terminal of the client's institution (RNG-GOV-006). */
  async partnerTerminal(client: { institutionId: string | null }, terminalRef: string) {
    if (!client.institutionId || !isUuid(terminalRef)) {
      throw new CustomAPIError(404, 'MER.POS_TERMINAL_UNKNOWN');
    }
    const t = await this.deps.db
      .selectFrom('terminals')
      .select([
        'id',
        'public_id',
        'institution_id',
        'purpose',
        'status',
        'merchant_profile_id',
        'name',
      ])
      .where('public_id', '=', uuidToBin(terminalRef))
      .where('institution_id', '=', client.institutionId)
      .executeTakeFirst();
    if (!t || t.purpose !== 'POS' || t.status !== 'ACTIVE') {
      throw new CustomAPIError(404, 'MER.POS_TERMINAL_UNKNOWN');
    }
    return {
      id: String(t.id),
      publicId: binToUuid(t.public_id),
      institutionId: String(t.institution_id),
      purpose: t.purpose,
      merchantProfileId: t.merchant_profile_id ? String(t.merchant_profile_id) : null,
      sectionId: null,
      locationType: null,
      name: t.name,
    } satisfies PosCaller;
  }

  async partnerRequest(
    client: { rowId: string; institutionId: string | null },
    input: { terminalRef: string; amountPaise: number; orderRef?: string | undefined },
  ) {
    const t = await this.partnerTerminal(client, input.terminalRef);
    const o = await this.outlet(t);
    const merchant = await this.deps.db
      .selectFrom('member_profiles')
      .select('status')
      .where('id', '=', o.merchant_profile_id)
      .executeTakeFirstOrThrow();
    if (merchant.status !== 'ACTIVE') {
      throw new CustomAPIError(409, 'PAY.PAYEE_NOT_ACCEPTING', {
        params: { merchant: o.display_name },
      });
    }
    let orderRowId: string | null = null;
    if (input.orderRef) {
      const row = await this.orderRow(t, String(o.id), input.orderRef);
      if (row.status !== 'CREATED') throw new CustomAPIError(409, 'MER.ORDER_PAID');
      if (Number(row.total_paise) !== input.amountPaise) {
        throw new CustomAPIError(409, 'MER.CAPTURE_AMOUNT_MISMATCH', {
          params: {
            captured: toMoneyDto(input.amountPaise).amount,
            total: toMoneyDto(Number(row.total_paise)).amount,
          },
        });
      }
      orderRowId = String(row.id);
    }
    const max = await this.limit(LIMITS.dynamicQrMaxPaise);
    if (input.amountPaise <= 0) throw new CustomAPIError(422, 'PAY.AMOUNT_INVALID');
    if (input.amountPaise > max) {
      throw new CustomAPIError(422, 'PAY.LIMIT_EXCEEDED', {
        params: { max: toMoneyDto(max).amount },
      });
    }
    const ttl = await this.limit(LIMITS.paymentRequestTtlSeconds);
    const now = this.now();
    const pub = newPublicIdPair();
    const token = newQrToken();
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    await this.deps.db
      .insertInto('payment_requests')
      .values({
        public_id: pub.bin,
        institution_id: t.institutionId,
        merchant_profile_id: o.merchant_profile_id,
        kind: 'DYNAMIC_QR',
        instrument: 'WALLET',
        order_id: orderRowId,
        terminal_id: t.id,
        api_client_id: client.rowId,
        amount_paise: input.amountPaise,
        token,
        status: 'PENDING',
        expires_at: expiresAt,
        created_at: now,
      })
      .execute();
    const payload = qrPayload('d', token);
    return {
      requestId: pub.id,
      amount: toMoneyDto(input.amountPaise),
      qrPayload: payload,
      svg: qrSvg(payload),
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: ttl,
    };
  }

  async partnerRequestStatus(client: { rowId: string }, requestId: string) {
    if (!isUuid(requestId)) throw new NotFoundError();
    const r = await this.deps.db
      .selectFrom('payment_requests as r')
      .leftJoin('payment_attempts as a', 'a.id', 'r.payment_attempt_id')
      .leftJoin('pos_orders as o', 'o.id', 'r.order_id')
      .select([
        'r.public_id',
        'r.status',
        'r.amount_paise',
        'r.expires_at',
        'r.consumed_at',
        'a.reference',
        'o.public_id as order_public_id',
        'o.order_no',
        'o.status as order_status',
      ])
      .where('r.public_id', '=', uuidToBin(requestId))
      .where('r.api_client_id', '=', client.rowId)
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    const expired =
      r.status === 'PENDING' && new Date(r.expires_at).getTime() <= this.now().getTime();
    return {
      requestId: binToUuid(r.public_id),
      status: expired ? ('EXPIRED' as const) : r.status,
      amount: toMoneyDto(Number(r.amount_paise)),
      expiresAt: iso(r.expires_at),
      completedAt: iso(r.consumed_at),
      receiptRef: r.status === 'SUCCESS' ? (r.reference ?? null) : null,
      order: r.order_public_id
        ? { id: binToUuid(r.order_public_id), number: r.order_no, status: r.order_status }
        : null,
    };
  }
}

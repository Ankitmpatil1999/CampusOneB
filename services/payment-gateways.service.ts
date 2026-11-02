/**
 * A school's own payment gateways (client 2026-10-09; INS-038…041, migration 0065). Each school
 * collects online fees into its own gateway account and may add several; the Institution
 * Administrator and the Accountant manage them (task "gateways").
 *
 * - Every credential (key id, key secret, webhook secret, merchant id) is encrypted at field level
 *   (AES-256-GCM, envelope keys; the gateway's public id as associated data). Nothing is ever
 *   returned or logged: the console sees a masked key id and whether the other values are set.
 *   A secret is replaced by sending a new one; leaving it out keeps it.
 * - One active gateway is the default for new payments (the first one added; another can be made
 *   the default; disabling the default passes it to the newest active one).
 * - "Check" asks the gateway whether it accepts the keys (a read-only call).
 * - Payments: `defaultFor` gives the school's default gateway; a payment keeps the gateway it was
 *   taken with (`byId`), and each gateway's webhook arrives at its own address (`forWebhook`).
 * - Production refuses test keys.
 */
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Loggers } from '../controllers/logger';
import { LIMITS, PAYMENT_GATEWAY_PROVIDERS, type MessageKey } from '../config/registers';
import type { PaymentGateway } from '../integrations/payment-gateway.provider';
import { createRazorpayGateway, type RazorpayConfig } from '../integrations/razorpay.gateway';
import type { Database } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import type { FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { defaultValues, type SettingValues } from './settings.service';

/** Builds a gateway from a school's keys (tests answer like Razorpay without the network). */
export type SchoolGatewayFactory = (keys: RazorpayConfig) => PaymentGateway;

export interface GatewayInput {
  readonly provider?: string | undefined;
  readonly label?: string | undefined;
  readonly keyId?: string | undefined;
  readonly keySecret?: string | undefined;
  readonly webhookSecret?: string | null | undefined;
  readonly merchantId?: string | null | undefined;
  readonly isDefault?: boolean | undefined;
  readonly status?: 'ACTIVE' | 'DISABLED' | undefined;
}

type Row = Selectable<Database['institution_payment_gateways']>;

const PURPOSE = {
  keyId: 'pg_key_id',
  keySecret: 'pg_key_secret',
  webhookSecret: 'pg_webhook_secret',
  merchantId: 'pg_merchant_id',
} as const;

/** rzp_test_TXtPkPTrdeekK0 → rzp_test_••••eK0 */
export function keyIdHint(keyId: string): string {
  const prefix = /^[a-z]+_(?:test|live)_/i.exec(keyId)?.[0] ?? '';
  return `${prefix}••••${keyId.slice(-3)}`;
}

export class PaymentGatewaysService {
  private readonly factory: SchoolGatewayFactory;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cipher: FieldCipher;
      readonly loggers: Loggers;
      /** Production refuses test keys. */
      readonly production: boolean;
      /** The web address that forwards /api to the API (the webhook address shown). */
      readonly webUrl: string;
      readonly factory?: SchoolGatewayFactory;
      /** CampusOne's own Razorpay account is configured (live mode with keys). */
      readonly platformLive?: boolean;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {
    this.factory = deps.factory ?? ((keys) => createRazorpayGateway(keys));
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async own(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new CustomAPIError(404, 'PG.NOT_FOUND');
    const inst = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!inst) throw new CustomAPIError(404, 'PG.NOT_FOUND');
    return inst;
  }

  private async row(institutionId: string, id: string, db: Kysely<Database> = this.deps.db) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'PG.NOT_FOUND');
    const r = await db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'PG.NOT_FOUND');
    return r;
  }

  private enc(field: keyof typeof PURPOSE, value: string, publicId: string) {
    return this.deps.cipher.encrypt(PURPOSE[field], value, `pg:${publicId}`);
  }

  private dec(field: keyof typeof PURPOSE, blob: Buffer | null, publicId: string) {
    return blob ? this.deps.cipher.decrypt(PURPOSE[field], blob, `pg:${publicId}`) : null;
  }

  /** The decrypted keys of a gateway row (server side only). */
  private keys(r: Row): RazorpayConfig {
    const pid = binToUuid(r.public_id);
    return {
      keyId: this.dec('keyId', r.key_id_enc, pid)!,
      keySecret: this.dec('keySecret', r.key_secret_enc, pid)!,
      webhookSecret: this.dec('webhookSecret', r.webhook_secret_enc, pid),
    };
  }

  private dto(r: Row) {
    const id = binToUuid(r.public_id);
    const provider = PAYMENT_GATEWAY_PROVIDERS.find((x) => x.code === r.provider);
    return {
      id,
      provider: r.provider,
      providerName: provider?.name ?? r.provider,
      label: r.label,
      keyIdHint: r.key_id_hint,
      environment: r.environment,
      status: r.status,
      isDefault: Boolean(Number(r.is_default)),
      hasWebhookSecret: r.webhook_secret_enc !== null,
      hasMerchantId: r.merchant_id_enc !== null,
      webhookUrl: `${this.deps.webUrl}/api/v1/partners/gateway/webhooks/${id}`,
      lastCheck: r.last_checked_at
        ? {
            at: new Date(r.last_checked_at).toISOString(),
            ok: Boolean(Number(r.last_check_ok)),
            note: r.last_check_note,
          }
        : null,
      version: Number(r.row_version),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  /** The checks every input passes; `creating` needs the key id and secret. */
  private validate(input: GatewayInput, creating: boolean, provider: string) {
    const errors: { field: string; code: MessageKey }[] = [];
    const def = PAYMENT_GATEWAY_PROVIDERS.find((x) => x.code === provider);
    if (!def) {
      throw new ValidationError([{ field: 'provider', code: 'PG.PROVIDER_UNSUPPORTED' }]);
    }
    if (creating || input.label !== undefined) {
      const label = (input.label ?? '').trim();
      if (label.length < 2 || label.length > 80) {
        errors.push({ field: 'label', code: 'VALIDATION.FORMAT' });
      }
    }
    if (creating || input.keyId !== undefined) {
      const keyId = (input.keyId ?? '').trim();
      if (!def.keyIdPattern.test(keyId)) errors.push({ field: 'keyId', code: 'PG.KEY_ID_FORMAT' });
      else if (this.deps.production && keyId.startsWith(def.testPrefix)) {
        errors.push({ field: 'keyId', code: 'PG.TEST_KEY_IN_PRODUCTION' });
      }
    }
    if (creating || input.keySecret !== undefined) {
      const secret = (input.keySecret ?? '').trim();
      if (secret.length < 8 || secret.length > 128) {
        errors.push({ field: 'keySecret', code: 'PG.SECRET_REQUIRED' });
      }
    }
    if (input.webhookSecret && input.webhookSecret.trim().length > 128) {
      errors.push({ field: 'webhookSecret', code: 'VALIDATION.FORMAT' });
    }
    if (input.merchantId && input.merchantId.trim().length > 64) {
      errors.push({ field: 'merchantId', code: 'VALIDATION.FORMAT' });
    }
    if (errors.length) throw new ValidationError(errors);
  }

  private async clearDefault(trx: Transaction<Database>, institutionId: string, except: string) {
    await trx
      .updateTable('institution_payment_gateways')
      .set({ is_default: false, row_version: sql<number>`row_version + 1` })
      .where('institution_id', '=', institutionId)
      .where('id', '<>', except)
      .where('is_default', '=', true)
      .execute();
  }

  // --- INS-038 ----------------------------------------------------------------------------------------
  async list(p: Principal) {
    const inst = await this.own(p);
    const rows = await this.deps.db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('institution_id', '=', String(inst.id))
      .orderBy('is_default', 'desc')
      .orderBy('id', 'asc')
      .execute();
    const values = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    const fallbackOn =
      Number(values[LIMITS.pgPlatformFallback.key] ?? LIMITS.pgPlatformFallback.value) === 1;
    const hasDefault = rows.some((r) => Boolean(Number(r.is_default)) && r.status === 'ACTIVE');
    return {
      providers: PAYMENT_GATEWAY_PROVIDERS.map((x) => ({ code: x.code, name: x.name })),
      items: rows.map((r) => this.dto(r)),
      // Razorpay by default (client 2026-10-09): until the school adds its own, new payments are
      // taken with CampusOne's Razorpay account (setting pg.platformFallback).
      platform: {
        provider: 'Razorpay',
        inUse: !hasDefault && fallbackOn && Boolean(this.deps.platformLive),
      },
    };
  }

  // --- INS-039 ----------------------------------------------------------------------------------------
  async create(p: Principal, input: GatewayInput) {
    const inst = await this.own(p);
    const provider = (input.provider ?? 'RAZORPAY').trim().toUpperCase();
    this.validate(input, true, provider);
    const pub = newPublicIdPair();
    const keyId = input.keyId!.trim();
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    const id = await this.deps.db.transaction().execute(async (trx) => {
      const anyActive = await trx
        .selectFrom('institution_payment_gateways')
        .select('id')
        .where('institution_id', '=', String(inst.id))
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst();
      const makeDefault = !anyActive || input.isDefault === true;
      const r = await trx
        .insertInto('institution_payment_gateways')
        .values({
          public_id: pub.bin,
          institution_id: String(inst.id),
          provider,
          label: input.label!.trim(),
          key_id_enc: this.enc('keyId', keyId, pub.id),
          key_secret_enc: this.enc('keySecret', input.keySecret!.trim(), pub.id),
          webhook_secret_enc: input.webhookSecret?.trim()
            ? this.enc('webhookSecret', input.webhookSecret.trim(), pub.id)
            : null,
          merchant_id_enc: input.merchantId?.trim()
            ? this.enc('merchantId', input.merchantId.trim(), pub.id)
            : null,
          key_id_hint: keyIdHint(keyId),
          environment: keyId.includes('_test_') ? 'TEST' : 'LIVE',
          is_default: false,
          created_by: by,
          updated_by: by,
        })
        .executeTakeFirstOrThrow();
      const newId = String(r.insertId);
      if (makeDefault) {
        await this.clearDefault(trx, String(inst.id), newId);
        await trx
          .updateTable('institution_payment_gateways')
          .set({ is_default: true })
          .where('id', '=', newId)
          .execute();
      }
      await recordAudit(trx, {
        institutionId: String(inst.id),
        action: 'PAYMENT_GATEWAY_ADDED',
        entityType: 'payment_gateway',
        entityRef: pub.id,
        after: {
          provider,
          label: input.label!.trim(),
          keyId: keyIdHint(keyId),
          isDefault: makeDefault,
          webhookSecret: Boolean(input.webhookSecret?.trim()),
        },
      });
      return newId;
    });
    // A first check, so the console shows at once whether the gateway accepts the keys.
    return this.runCheck(String(inst.id), id);
  }

  // --- INS-040 ----------------------------------------------------------------------------------------
  async update(p: Principal, id: string, expected: number, input: GatewayInput) {
    const inst = await this.own(p);
    const current = await this.row(String(inst.id), id);
    this.validate(input, false, current.provider);
    const pid = binToUuid(current.public_id);
    const status = input.status ?? current.status;
    if (input.isDefault === true && status !== 'ACTIVE') {
      throw new CustomAPIError(409, 'PG.DEFAULT_DISABLED');
    }
    const keyId = input.keyId?.trim();
    const changed = Object.keys(input).filter(
      (k) => (input as Record<string, unknown>)[k] !== undefined,
    );
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    await this.deps.db.transaction().execute(async (trx) => {
      const wasDefault = Boolean(Number(current.is_default));
      const makeDefault = input.isDefault === true || (wasDefault && status === 'ACTIVE');
      if (input.isDefault === true) await this.clearDefault(trx, String(inst.id), current.id);
      const res = await trx
        .updateTable('institution_payment_gateways')
        .set({
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(keyId
            ? {
                key_id_enc: this.enc('keyId', keyId, pid),
                key_id_hint: keyIdHint(keyId),
                environment: keyId.includes('_test_') ? ('TEST' as const) : ('LIVE' as const),
              }
            : {}),
          ...(input.keySecret?.trim()
            ? { key_secret_enc: this.enc('keySecret', input.keySecret.trim(), pid) }
            : {}),
          ...(input.webhookSecret !== undefined
            ? {
                webhook_secret_enc: input.webhookSecret?.trim()
                  ? this.enc('webhookSecret', input.webhookSecret.trim(), pid)
                  : null,
              }
            : {}),
          ...(input.merchantId !== undefined
            ? {
                merchant_id_enc: input.merchantId?.trim()
                  ? this.enc('merchantId', input.merchantId.trim(), pid)
                  : null,
              }
            : {}),
          status,
          is_default: makeDefault && status === 'ACTIVE',
          // New keys: the last check no longer applies.
          ...(keyId || input.keySecret?.trim()
            ? { last_checked_at: null, last_check_ok: null, last_check_note: null }
            : {}),
          updated_by: by,
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', current.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      // The default was disabled: the newest active gateway takes over.
      if (wasDefault && status !== 'ACTIVE') {
        const next = await trx
          .selectFrom('institution_payment_gateways')
          .select('id')
          .where('institution_id', '=', String(inst.id))
          .where('status', '=', 'ACTIVE')
          .where('id', '<>', current.id)
          .orderBy('id', 'desc')
          .executeTakeFirst();
        if (next) {
          await trx
            .updateTable('institution_payment_gateways')
            .set({ is_default: true, row_version: sql<number>`row_version + 1` })
            .where('id', '=', String(next.id))
            .execute();
        }
      }
      await recordAudit(trx, {
        institutionId: String(inst.id),
        action: 'PAYMENT_GATEWAY_CHANGED',
        entityType: 'payment_gateway',
        entityRef: pid,
        // Which values changed — never the values of the secrets.
        after: {
          changed,
          ...(keyId ? { keyId: keyIdHint(keyId) } : {}),
          status,
          isDefault: makeDefault && status === 'ACTIVE',
        },
      });
    });
    return this.dto(await this.row(String(inst.id), id));
  }

  // --- INS-041 ----------------------------------------------------------------------------------------
  async check(p: Principal, id: string) {
    const inst = await this.own(p);
    const r = await this.row(String(inst.id), id);
    return this.runCheck(String(inst.id), r.id);
  }

  private async runCheck(institutionId: string, rowId: string) {
    const r = await this.deps.db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('id', '=', rowId)
      .executeTakeFirstOrThrow();
    const g = this.factory(this.keys(r));
    const result = g.checkCredentials
      ? await g.checkCredentials().catch(() => ({ ok: false, note: 'The gateway did not answer' }))
      : { ok: false, note: 'This gateway cannot be checked' };
    await this.deps.db
      .updateTable('institution_payment_gateways')
      .set({
        last_checked_at: this.now(),
        last_check_ok: result.ok,
        last_check_note: result.note.slice(0, 200),
      })
      .where('id', '=', rowId)
      .execute();
    await recordAudit(this.deps.db, {
      institutionId,
      action: 'PAYMENT_GATEWAY_CHECKED',
      entityType: 'payment_gateway',
      entityRef: binToUuid(r.public_id),
      after: { ok: result.ok },
    });
    const after = await this.deps.db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('id', '=', rowId)
      .executeTakeFirstOrThrow();
    return this.dto(after);
  }

  // --- payments ------------------------------------------------------------------------------------------
  /** The school's default active gateway, or null when it has none. */
  async defaultFor(institutionId: string): Promise<{ id: string; gateway: PaymentGateway } | null> {
    const r = await this.deps.db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('status', '=', 'ACTIVE')
      .where('is_default', '=', true)
      .executeTakeFirst();
    if (!r) return null;
    return { id: String(r.id), gateway: this.factory(this.keys(r)) };
  }

  /** The gateway a payment was taken with (also when it was disabled since). */
  async byId(id: string): Promise<PaymentGateway | null> {
    const r = await this.deps.db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? this.factory(this.keys(r)) : null;
  }

  /** A webhook's gateway by the id in its address. */
  async forWebhook(publicId: string): Promise<{ id: string; gateway: PaymentGateway } | null> {
    if (!isUuid(publicId)) return null;
    const r = await this.deps.db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('public_id', '=', uuidToBin(publicId))
      .executeTakeFirst();
    return r ? { id: String(r.id), gateway: this.factory(this.keys(r)) } : null;
  }
}

/**
 * A school's corporate codes and the classes each one serves (client 2026-10-13/14; INS-043…048,
 * migration 0073). A code is allotted by a bank (Axis, SBI, …) for the account the school collects
 * into; it carries the bank name, IFSC and pool account. Whole classes map to a code, and one code is
 * the school's default for everyone a class mapping doesn't cover. The VAN is put together from them
 * (services/vans.ts).
 *
 * - The Institution Administrator manages them in the console (task "corpcodes"); the RingPe back
 *   office for any school (sub-task inst.register, as the bank arrangement).
 * - The first code becomes the default; another can be made the default; the default can't be
 *   disabled or un-set (another code is made the default instead).
 * - A class uses one code: a class already on another code is refused (CC.CLASS_TAKEN; client
 *   2026-10-14) — it is taken off that code first.
 * - The default is kept in the institution's own corporate code and pool account fields as well, which
 *   the onboarding checklist and the bank arrangement (INS-006) read and write.
 */
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import type { FieldError } from '../utils/validators';
import { recordAudit } from './audit.service';
import { defaultValues, type SettingValues } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;
type Row = Selectable<Database['institution_corporate_codes']>;

export interface CorporateCodeInput {
  readonly bankName?: string | undefined;
  readonly ifsc?: string | null | undefined;
  readonly corporateCode?: string | undefined;
  readonly poolAccountRef?: string | null | undefined;
  readonly isDefault?: boolean | undefined;
  readonly status?: 'ACTIVE' | 'DISABLED' | undefined;
  /** The classes (public ids) whose VANs use this code; replaces the code's classes. */
  readonly classIds?: readonly string[] | undefined;
}

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const POOL = /^[A-Za-z0-9]{1,40}$/;
const iso = (d: Date | string) => new Date(d).toISOString();

/**
 * The bank arrangement (INS-006) names the school's code and pool account: it becomes (or changes)
 * the school's default code. Runs in the arrangement's transaction.
 */
export async function setDefaultFromArrangement(
  trx: Transaction<Database>,
  institutionId: string,
  code: string,
  poolAccountRef: string | null,
  by: Buffer | null,
  at: Date,
) {
  const current = await trx
    .selectFrom('institution_corporate_codes')
    .select(['id'])
    .where('institution_id', '=', institutionId)
    .where('is_default', '=', 1)
    .executeTakeFirst();
  if (current) {
    await trx
      .updateTable('institution_corporate_codes')
      .set({
        corporate_code: code,
        pool_account_ref: poolAccountRef,
        updated_by: by,
        updated_at: at,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', current.id)
      .execute();
    return;
  }
  await trx
    .insertInto('institution_corporate_codes')
    .values({
      public_id: newPublicIdPair().bin,
      institution_id: institutionId,
      corporate_code: code,
      pool_account_ref: poolAccountRef,
      is_default: true,
      created_by: by,
      updated_by: by,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

export class CorporateCodesService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async maxLength() {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    const l = LIMITS.corporateCodeMaxLength;
    return Number(v[l.key] ?? l.value);
  }

  /** The school (by public id); another school's id is not found. */
  private async institution(db: Db, publicId: string) {
    if (!isUuid(publicId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(db, uuidToBin(publicId));
    if (!i) throw new NotFoundError();
    return i;
  }

  /** The school of a console session. */
  institutionOf(p: Principal) {
    if (!p.institutionId) throw new NotFoundError();
    return p.institutionId;
  }

  private async row(db: Db, institutionId: string, id: string, lock = false) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'CC.NOT_FOUND');
    let q = db
      .selectFrom('institution_corporate_codes')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(id));
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'CC.NOT_FOUND');
    return r;
  }

  private async view(db: Db, institutionId: string) {
    const [codes, classes] = await Promise.all([
      db
        .selectFrom('institution_corporate_codes')
        .selectAll()
        .where('institution_id', '=', institutionId)
        .orderBy('is_default', 'desc')
        .orderBy('id')
        .execute(),
      db
        .selectFrom('classes as c')
        .leftJoin('class_corporate_codes as m', 'm.class_id', 'c.id')
        .select(['c.id', 'c.public_id', 'c.name', 'm.corporate_code_id'])
        .where('c.institution_id', '=', institutionId)
        .orderBy('c.sort_order')
        .orderBy('c.name')
        .execute(),
    ]);
    const codeOf = new Map(codes.map((c) => [String(c.id), binToUuid(c.public_id)]));
    const present = (c: Row) => ({
      id: binToUuid(c.public_id),
      bankName: c.bank_name,
      ifsc: c.ifsc,
      corporateCode: c.corporate_code,
      poolAccountRef: c.pool_account_ref,
      isDefault: Boolean(Number(c.is_default)),
      status: c.status,
      classes: classes
        .filter((k) => k.corporate_code_id !== null && String(k.corporate_code_id) === String(c.id))
        .map((k) => ({ id: binToUuid(k.public_id), name: k.name })),
      version: c.row_version,
      updatedAt: iso(c.updated_at),
    });
    return {
      items: codes.map(present),
      classes: classes.map((k) => ({
        id: binToUuid(k.public_id),
        name: k.name,
        codeId: k.corporate_code_id ? (codeOf.get(String(k.corporate_code_id)) ?? null) : null,
      })),
    };
  }

  // --- INS-043 / INS-046 ----------------------------------------------------------------------------
  async list(institutionPublicId: string) {
    const db = this.deps.db;
    const inst = await this.institution(db, institutionPublicId);
    return { maxLength: await this.maxLength(), ...(await this.view(db, String(inst.id))) };
  }

  private async validate(input: CorporateCodeInput, create: boolean) {
    const errors: FieldError[] = [];
    if (create || input.bankName !== undefined) {
      const n = input.bankName?.trim() ?? '';
      if (n.length < 2 || n.length > 100) {
        errors.push({ field: 'bankName', code: 'CC.BANK_NAME_REQUIRED' });
      }
    }
    if (create || input.corporateCode !== undefined) {
      const max = await this.maxLength();
      const c = input.corporateCode?.trim().toUpperCase() ?? '';
      if (!new RegExp(`^[A-Z0-9]{1,${max}}$`).test(c)) {
        errors.push({ field: 'corporateCode', code: 'INS.CORPORATE_CODE_FORMAT', params: { max } });
      }
    }
    const ifsc = input.ifsc?.trim().toUpperCase();
    if (ifsc && !IFSC.test(ifsc)) errors.push({ field: 'ifsc', code: 'IDN.IFSC_INVALID' });
    const pool = input.poolAccountRef?.trim();
    if (pool && !POOL.test(pool)) {
      errors.push({ field: 'poolAccountRef', code: 'INS.POOL_ACCOUNT_FORMAT' });
    }
    if (input.classIds?.some((id) => !isUuid(id))) {
      errors.push({ field: 'classIds', code: 'CC.CLASS_UNKNOWN' });
    }
    if (errors.length) throw new ValidationError(errors);
  }

  /** The school's class rows for the given public ids (all must be the school's). */
  private async classRows(db: Db, institutionId: string, ids: readonly string[]) {
    if (!ids.length) return [];
    const rows = await db
      .selectFrom('classes')
      .select(['id', 'public_id'])
      .where('institution_id', '=', institutionId)
      .where(
        'public_id',
        'in',
        ids.map((x) => uuidToBin(x)),
      )
      .execute();
    if (rows.length !== new Set(ids.map((x) => x.toLowerCase())).size) {
      throw new ValidationError([{ field: 'classIds', code: 'CC.CLASS_UNKNOWN' }]);
    }
    return rows;
  }

  /** The code's classes become exactly these (a class mapped elsewhere moves here). */
  private async mapClasses(
    trx: Transaction<Database>,
    institutionId: string,
    codeRowId: string,
    classIds: readonly string[],
    by: Buffer | null,
    at: Date,
  ) {
    const rows = await this.classRows(trx, institutionId, classIds);
    const keep = rows.map((r) => String(r.id));
    // A class uses one code (client 2026-10-14): one already on another code is refused — it is
    // taken off that code first.
    if (keep.length) {
      const taken = await trx
        .selectFrom('class_corporate_codes as m')
        .innerJoin('classes as c', 'c.id', 'm.class_id')
        .innerJoin('institution_corporate_codes as cc', 'cc.id', 'm.corporate_code_id')
        .select(['c.name', 'cc.corporate_code'])
        .where('m.class_id', 'in', keep)
        .where('m.corporate_code_id', '<>', codeRowId)
        .orderBy('c.sort_order')
        .execute();
      if (taken.length) {
        throw new CustomAPIError(409, 'CC.CLASS_TAKEN', {
          params: {
            classes: taken.map((t) => t.name).join(', '),
            code: [...new Set(taken.map((t) => t.corporate_code))].join(', '),
          },
        });
      }
    }
    let del = trx.deleteFrom('class_corporate_codes').where('corporate_code_id', '=', codeRowId);
    if (keep.length) del = del.where('class_id', 'not in', keep);
    await del.execute();
    for (const r of rows) {
      await trx
        .insertInto('class_corporate_codes')
        .values({
          class_id: String(r.id),
          institution_id: institutionId,
          corporate_code_id: codeRowId,
          updated_by: by,
          updated_at: at,
        })
        .onDuplicateKeyUpdate({ updated_by: by, updated_at: at })
        .execute();
    }
  }

  /** The institution's own fields follow the default code (onboarding, bank arrangement, portal). */
  private async mirrorDefault(trx: Transaction<Database>, institutionId: string) {
    const d = await trx
      .selectFrom('institution_corporate_codes')
      .select(['corporate_code', 'pool_account_ref'])
      .where('institution_id', '=', institutionId)
      .where('is_default', '=', 1)
      .executeTakeFirst();
    if (!d) return;
    await trx
      .updateTable('institutions')
      .set({
        corporate_code: d.corporate_code,
        ...(d.pool_account_ref ? { pool_account_ref: d.pool_account_ref } : {}),
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', institutionId)
      .where((eb) =>
        eb.or([
          eb('corporate_code', 'is', null),
          eb('corporate_code', '<>', d.corporate_code),
          ...(d.pool_account_ref
            ? [eb('pool_account_ref', 'is', null), eb('pool_account_ref', '<>', d.pool_account_ref)]
            : []),
        ]),
      )
      .execute();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async unique<T>(run: () => Promise<T>) {
    try {
      return await run();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'INS.CORPORATE_CODE_TAKEN');
      }
      throw e;
    }
  }

  // --- INS-044 / INS-047 ----------------------------------------------------------------------------
  async create(p: Principal, institutionPublicId: string, input: CorporateCodeInput) {
    await this.validate(input, true);
    const at = this.now();
    const by = this.by(p);
    const code = input.corporateCode!.trim().toUpperCase();
    return this.unique(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const inst = await this.institution(trx, institutionPublicId);
        const institutionId = String(inst.id);
        const hasDefault = await trx
          .selectFrom('institution_corporate_codes')
          .select('id')
          .where('institution_id', '=', institutionId)
          .where('is_default', '=', 1)
          .forUpdate()
          .executeTakeFirst();
        const makeDefault = !hasDefault || input.isDefault === true;
        if (makeDefault && hasDefault) {
          await trx
            .updateTable('institution_corporate_codes')
            .set({ is_default: false, updated_by: by, updated_at: at })
            .where('id', '=', hasDefault.id)
            .execute();
        }
        const pub = newPublicIdPair();
        const ins = await trx
          .insertInto('institution_corporate_codes')
          .values({
            public_id: pub.bin,
            institution_id: institutionId,
            bank_name: input.bankName!.trim(),
            ifsc: input.ifsc?.trim().toUpperCase() || null,
            corporate_code: code,
            pool_account_ref: input.poolAccountRef?.trim() || null,
            is_default: makeDefault,
            created_by: by,
            updated_by: by,
            created_at: at,
            updated_at: at,
          })
          .executeTakeFirstOrThrow();
        if (input.classIds?.length) {
          await this.mapClasses(trx, institutionId, String(ins.insertId), input.classIds, by, at);
        }
        await this.mirrorDefault(trx, institutionId);
        await recordAudit(trx, {
          institutionId,
          action: 'CORPORATE_CODE_ADDED',
          entityType: 'corporate_code',
          entityRef: pub.id,
          after: {
            corporateCode: code,
            bankName: input.bankName!.trim(),
            isDefault: makeDefault,
            classes: input.classIds?.length ?? 0,
          },
        });
        const v = await this.view(trx, institutionId);
        return v.items.find((x) => x.id === pub.id)!;
      }),
    );
  }

  // --- INS-045 / INS-048 ----------------------------------------------------------------------------
  async update(
    p: Principal,
    institutionPublicId: string,
    id: string,
    expected: number,
    input: CorporateCodeInput,
  ) {
    await this.validate(input, false);
    const at = this.now();
    const by = this.by(p);
    return this.unique(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const inst = await this.institution(trx, institutionPublicId);
        const institutionId = String(inst.id);
        const current = await this.row(trx, institutionId, id, true);
        if (current.row_version !== expected) throw new PreconditionFailedError();
        const wasDefault = Boolean(Number(current.is_default));
        const status = input.status ?? current.status;
        if (input.isDefault === false && wasDefault) {
          throw new CustomAPIError(409, 'CC.DEFAULT_REQUIRED');
        }
        if (status === 'DISABLED' && (wasDefault || input.isDefault === true)) {
          throw new CustomAPIError(409, 'CC.DEFAULT_DISABLED');
        }
        if (input.isDefault === true && !wasDefault) {
          await trx
            .updateTable('institution_corporate_codes')
            .set({ is_default: false, updated_by: by, updated_at: at })
            .where('institution_id', '=', institutionId)
            .where('is_default', '=', 1)
            .execute();
        }
        await trx
          .updateTable('institution_corporate_codes')
          .set({
            ...(input.bankName !== undefined ? { bank_name: input.bankName.trim() } : {}),
            ...(input.ifsc !== undefined ? { ifsc: input.ifsc?.trim().toUpperCase() || null } : {}),
            ...(input.corporateCode !== undefined
              ? { corporate_code: input.corporateCode.trim().toUpperCase() }
              : {}),
            ...(input.poolAccountRef !== undefined
              ? { pool_account_ref: input.poolAccountRef?.trim() || null }
              : {}),
            status,
            is_default: wasDefault || input.isDefault === true,
            updated_by: by,
            updated_at: at,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', current.id)
          .execute();
        if (input.classIds !== undefined) {
          await this.mapClasses(trx, institutionId, String(current.id), input.classIds, by, at);
        }
        await this.mirrorDefault(trx, institutionId);
        await recordAudit(trx, {
          institutionId,
          action: 'CORPORATE_CODE_CHANGED',
          entityType: 'corporate_code',
          entityRef: id.toLowerCase(),
          before: {
            corporateCode: current.corporate_code,
            bankName: current.bank_name,
            status: current.status,
            isDefault: wasDefault,
          },
          after: {
            changed: Object.keys(input).filter(
              (k) => (input as Record<string, unknown>)[k] !== undefined,
            ),
          },
        });
        const v = await this.view(trx, institutionId);
        return v.items.find((x) => x.id === id.toLowerCase())!;
      }),
    );
  }
}

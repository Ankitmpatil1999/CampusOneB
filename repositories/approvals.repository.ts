/**
 * Maker-checker requests (section 17; MKR-001…005; ADR-0015): what a maker asked for, its payload
 * and its decision. The request is never deleted; its effect is applied when a checker approves
 * (the effect handler re-validates first). An Institution Administrator's own request is recorded
 * as applied directly.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';

type Db = Kysely<Database> | Transaction<Database>;

export type ApprovalModule =
  | 'MEMBER_SUSPENSION'
  | 'MEMBER_DELINK'
  | 'PII_CORRECTION'
  | 'INSTITUTION_DETAILS'
  | 'BANK_CREDIT_RETURN'
  | 'FEE_STRUCTURE'
  | 'FEE_RECORD_CHANGE'
  | 'GRIEVANCE_UPDATE'
  | 'ACADEMIC_CORRECTION';
export type ApprovalState = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ApprovalFilter {
  readonly status: ApprovalState;
  readonly module?: string | undefined;
  readonly makerRef?: Buffer | undefined;
  readonly q?: string | undefined;
  /** Keyset: requests older than this id (newest first). */
  readonly before?: string | undefined;
  readonly limit: number;
}

const COLUMNS = [
  'a.id',
  'a.public_id',
  'a.request_seq',
  'a.institution_id',
  'a.module',
  'a.action',
  'a.summary',
  'a.subject_type',
  'a.subject_ref',
  'a.payload',
  'a.maker_type',
  'a.maker_ref',
  'a.status',
  'a.checker_ref',
  'a.remarks',
  'a.decided_at',
  'a.effect_error_code',
  'a.effect_error_params',
  'a.applied_directly',
  'a.row_version',
  'a.created_at',
  'mk.first_name as maker_first',
  'mk.last_name as maker_last',
  'ck.first_name as checker_first',
  'ck.last_name as checker_last',
] as const;

/** Requests of one institution, or the platform's own (`null`), with maker and checker names. */
function base(db: Db, institutionId: string | null) {
  let q = db
    .selectFrom('approval_requests as a')
    .leftJoin('platform_accounts as mk', 'mk.public_id', 'a.maker_ref')
    .leftJoin('platform_accounts as ck', 'ck.public_id', 'a.checker_ref');
  q =
    institutionId === null
      ? q.where('a.institution_id', 'is', null)
      : q.where('a.institution_id', '=', institutionId);
  return q;
}

export const approvalsRepository = {
  async insert(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string | null;
      module: ApprovalModule;
      action: 'CREATE' | 'UPDATE' | 'DELETE';
      summary: string;
      payload: Readonly<Record<string, unknown>>;
      makerType: 'member' | 'staff' | 'operator';
      makerRef: Buffer;
      subjectType?:
        | 'member'
        | 'account'
        | 'institution'
        | 'bank_credit'
        | 'fee_structure'
        | 'fee_record'
        | 'ticket'
        | 'enrolment';
      subjectRef?: Buffer;
      /** ADR-0015: recorded as approved without a checker. */
      appliedDirectly?: { at: Date; remarks: string | null };
    },
  ) {
    const r = await db
      .insertInto('approval_requests')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        module: v.module,
        action: v.action,
        summary: v.summary.slice(0, 300),
        subject_type: v.subjectType ?? null,
        subject_ref: v.subjectRef ?? null,
        payload: JSON.stringify(v.payload),
        maker_type: v.makerType,
        maker_ref: v.makerRef,
        ...(v.appliedDirectly
          ? {
              status: 'APPROVED' as const,
              applied_directly: 1,
              decided_at: v.appliedDirectly.at,
              remarks: v.appliedDirectly.remarks,
            }
          : {}),
      })
      .executeTakeFirstOrThrow();
    const id = String(r.insertId);
    const row = await db
      .selectFrom('approval_requests')
      .select('request_seq')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id, seq: row.request_seq };
  },

  async byPublicId(db: Db, institutionId: string | null, publicId: Buffer, lock = false) {
    let q = db.selectFrom('approval_requests').selectAll().where('public_id', '=', publicId);
    q =
      institutionId === null
        ? q.where('institution_id', 'is', null)
        : q.where('institution_id', '=', institutionId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  /** One request with maker and checker names (MKR-002). */
  async detail(db: Db, institutionId: string | null, publicId: Buffer) {
    return base(db, institutionId)
      .select([...COLUMNS])
      .where('a.public_id', '=', publicId)
      .executeTakeFirst();
  },

  /** A page of the queue, newest first (MKR-001, MKR-004). */
  async page(db: Db, institutionId: string | null, f: ApprovalFilter) {
    let q = base(db, institutionId)
      .select([...COLUMNS])
      .where('a.status', '=', f.status);
    if (f.module) q = q.where('a.module', '=', f.module);
    if (f.makerRef) q = q.where('a.maker_ref', '=', f.makerRef);
    if (f.before) q = q.where('a.id', '<', f.before);
    const text = f.q?.trim();
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const digits = /^(?:APR-?)?0*(\d{1,9})$/i.exec(text)?.[1];
      q = q.where((eb) =>
        eb.or([
          eb('a.summary', 'like', like),
          eb(sql<string>`CONCAT_WS(' ', mk.first_name, mk.last_name)`, 'like', like),
          ...(digits ? [eb('a.request_seq', '=', Number(digits))] : []),
        ]),
      );
    }
    return q
      .orderBy('a.id', 'desc')
      .limit(f.limit + 1)
      .execute();
  },

  /** Counts for the tabs and the cards (MKR-001). */
  async counts(db: Db, institutionId: string | null, me: Buffer | null, since: Date) {
    let q = db
      .selectFrom('approval_requests')
      .select([
        sql<number>`SUM(status = 'PENDING')`.as('pending'),
        sql<number>`SUM(status = 'APPROVED')`.as('approved'),
        sql<number>`SUM(status = 'REJECTED')`.as('rejected'),
        sql<number>`SUM(status = 'PENDING' AND maker_ref = ${me ?? Buffer.alloc(16)})`.as('mine'),
        sql<number>`SUM(status <> 'PENDING' AND decided_at >= ${since})`.as('decided'),
      ]);
    q =
      institutionId === null
        ? q.where('institution_id', 'is', null)
        : q.where('institution_id', '=', institutionId);
    const r = await q.executeTakeFirst();
    return {
      pending: Number(r?.pending ?? 0),
      approved: Number(r?.approved ?? 0),
      rejected: Number(r?.rejected ?? 0),
      mine: Number(r?.mine ?? 0),
      decided: Number(r?.decided ?? 0),
    };
  },

  /** Everyone who raised a request here, for the maker filter. */
  async makers(db: Db, institutionId: string | null) {
    return base(db, institutionId)
      .select(['a.maker_ref', 'mk.first_name', 'mk.last_name'])
      .groupBy(['a.maker_ref', 'mk.first_name', 'mk.last_name'])
      .orderBy('mk.first_name')
      .execute();
  },

  /** Modules that have requests here, for the module filter. */
  async modules(db: Db, institutionId: string | null) {
    let q = db.selectFrom('approval_requests').select('module').distinct();
    q =
      institutionId === null
        ? q.where('institution_id', 'is', null)
        : q.where('institution_id', '=', institutionId);
    return (await q.orderBy('module').execute()).map((r) => r.module);
  },

  /** Guarded decision: only a pending request, and never by its maker (also a CHECK). */
  async decide(
    db: Db,
    id: string,
    v: { status: 'APPROVED' | 'REJECTED'; checker: Buffer; remarks: string | null; at: Date },
  ) {
    const r = await db
      .updateTable('approval_requests')
      .set({
        status: v.status,
        checker_ref: v.checker,
        remarks: v.remarks,
        decided_at: v.at,
        effect_error_code: null,
        effect_error_params: null,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .where('maker_ref', '!=', v.checker)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async setEffectError(
    db: Db,
    id: string,
    code: string,
    params: Readonly<Record<string, unknown>> = {},
  ) {
    await db
      .updateTable('approval_requests')
      .set({ effect_error_code: code.slice(0, 60), effect_error_params: JSON.stringify(params) })
      .where('id', '=', id)
      .execute();
  },
};

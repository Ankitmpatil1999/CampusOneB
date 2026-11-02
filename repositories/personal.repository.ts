/**
 * Personal details (SRS 6.11; RNG-IDN-113: one record of each kind per account) and the CR-06
 * correction requests with their approval request (section 17 core). Saves are version-guarded:
 * version 0 inserts the first record, a later save updates `WHERE row_version = ?`.
 */
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely';
import type { AccountPiiField, Database } from '../models/campusone_models';
import { PreconditionFailedError } from '../utils/CustomAPIError';

type Db = Kysely<Database> | Transaction<Database>;
type Section =
  'account_addresses' | 'account_bank_accounts' | 'account_nominees' | 'account_income';
type Values<T extends Section> = Omit<
  Insertable<Database[T]>,
  'account_id' | 'row_version' | 'created_at' | 'updated_at'
>;

const isDuplicate = (e: unknown) => (e as { code?: string }).code === 'ER_DUP_ENTRY';

/** Insert (expected 0) or guarded update; 412 when someone saved first. Returns the new version. */
async function save<T extends Section>(
  db: Db,
  table: T,
  accountId: string,
  expected: number,
  values: Values<T>,
): Promise<number> {
  // One code path for the four one-per-account tables: typed per call, written through a loose view.
  const loose = db as unknown as Kysely<Record<string, Record<string, unknown>>>;
  const row = values as Record<string, unknown>;
  if (expected === 0) {
    try {
      await loose
        .insertInto(table as string)
        .values({ ...row, account_id: accountId })
        .execute();
    } catch (e) {
      if (isDuplicate(e)) throw new PreconditionFailedError();
      throw e;
    }
    return 1;
  }
  const r = await loose
    .updateTable(table as string)
    .set({ ...row, row_version: sql`row_version + 1`, updated_at: sql`UTC_TIMESTAMP(3)` })
    .where('account_id', '=', accountId)
    .where('row_version', '=', expected)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
  return expected + 1;
}

export const personalRepository = {
  async address(db: Db, accountId: string) {
    return db
      .selectFrom('account_addresses as a')
      .innerJoin('files as f', 'f.id', 'a.proof_file_id')
      .select([
        'a.line1',
        'a.line2',
        'a.city',
        'a.state',
        'a.pin_code',
        'a.proof_type',
        'a.proof_file_id',
        'a.row_version',
        'f.public_id as proof_public_id',
        'f.original_name as proof_name',
      ])
      .where('a.account_id', '=', accountId)
      .executeTakeFirst();
  },
  saveAddress: (db: Db, accountId: string, expected: number, v: Values<'account_addresses'>) =>
    save(db, 'account_addresses', accountId, expected, v),

  async bankAccount(db: Db, accountId: string) {
    return db
      .selectFrom('account_bank_accounts')
      .select([
        'holder_name',
        'bank_name',
        'acct_last4',
        'ifsc',
        'verified_at',
        'verification_ref',
        'row_version',
      ])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  },
  saveBankAccount: (
    db: Db,
    accountId: string,
    expected: number,
    v: Values<'account_bank_accounts'>,
  ) => save(db, 'account_bank_accounts', accountId, expected, v),

  async nominee(db: Db, accountId: string) {
    return db
      .selectFrom('account_nominees')
      .select(['name', 'relation_code', 'dob', 'share_pct', 'row_version'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  },
  saveNominee: (db: Db, accountId: string, expected: number, v: Values<'account_nominees'>) =>
    save(db, 'account_nominees', accountId, expected, v),

  async income(db: Db, accountId: string) {
    return db
      .selectFrom('account_income')
      .select(['occupation', 'band_code', 'row_version'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  },
  saveIncome: (db: Db, accountId: string, expected: number, v: Values<'account_income'>) =>
    save(db, 'account_income', accountId, expected, v),

  async activeCodes(
    db: Db,
    table: 'ref_relations' | 'ref_income_bands' | 'ref_occupations' | 'ref_address_proof_types',
  ): Promise<{ code: string; label_key: string; usage_scope?: string }[]> {
    if (table === 'ref_relations') {
      return db
        .selectFrom('ref_relations')
        .select(['code', 'label_key', 'usage_scope'])
        .where('active', '=', 1)
        .orderBy('sort_order')
        .execute();
    }
    return db
      .selectFrom(table)
      .select(['code', 'label_key'])
      .where('active', '=', 1)
      .orderBy('sort_order')
      .execute();
  },

  /** The correction row of a member's own request; its approval request is raised first. */
  async insertCorrection(
    trx: Transaction<Database>,
    c: {
      correctionPublicId: Buffer;
      accountId: string;
      institutionId: string | null;
      approvalRowId: string;
      field: AccountPiiField;
      currentMasked: string;
      proposedEnc: Buffer;
      reason: string;
      evidenceFileId: string;
    },
  ): Promise<void> {
    await trx
      .insertInto('pii_correction_requests')
      .values({
        public_id: c.correctionPublicId,
        account_id: c.accountId,
        institution_id: c.institutionId,
        field: c.field,
        current_masked: c.currentMasked,
        proposed_enc: c.proposedEnc,
        reason: c.reason,
        evidence_file_id: c.evidenceFileId,
        approval_request_id: c.approvalRowId,
      })
      .execute();
  },

  async corrections(db: Db, accountId: string) {
    return db
      .selectFrom('pii_correction_requests as c')
      .innerJoin('approval_requests as a', 'a.id', 'c.approval_request_id')
      .select([
        'c.public_id',
        'c.field',
        'c.current_masked',
        'c.reason',
        'c.created_at',
        'c.applied_at',
        'a.status',
        'a.remarks',
        'a.decided_at',
      ])
      .where('c.account_id', '=', accountId)
      .orderBy('c.created_at', 'desc')
      .orderBy('c.id', 'desc')
      .execute();
  },
};

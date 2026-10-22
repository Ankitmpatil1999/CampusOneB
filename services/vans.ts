/**
 * Virtual account numbers (client 2026-10-13/14; migration 0076). A school has several corporate
 * codes — one per bank account it collects into — and its classes map to them; one code is the
 * school's default. A wallet's VAN is the code of its owner's class this academic year (or the
 * default, for everyone a class mapping doesn't cover: staff, merchants, students not placed or in
 * an unmapped class) followed by the wallet number.
 *
 * There is no old or new VAN: nothing is stored, the VAN is put together when shown and when a bank
 * pays. A bank's account number is matched on the wallet number, and accepted only when its code is
 * the one that wallet's VAN uses now (as the legacy app matched the wallet number; client answer 7).
 *
 * A parent — the father, the mother or a guardian — has no VAN (client 2026-10-13/14, migrations 0073
 * and 0074): only the student's campus wallet has one, so a bank credit to a parent's older wallet is
 * refused as an incorrect VAN.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';

type Db = Kysely<Database> | Transaction<Database>;

/** Wallet kinds that have a VAN (school wallets only; client 2026-10-14). */
export const VAN_WALLET_KINDS = ['CAMPUS', 'MERCHANT'] as const;

export interface VanCode {
  readonly id: string;
  readonly code: string;
  /** Null until filled in (codes carried over from the single-code set-up). */
  readonly bankName: string | null;
  readonly ifsc: string | null;
  readonly poolAccountRef: string | null;
}

export interface WalletVan {
  readonly walletId: string;
  readonly walletNo: string;
  readonly institutionId: string;
  readonly van: string;
  readonly code: VanCode;
  /** True when a class mapping chose the code; false when it is the school's default. */
  readonly byClass: boolean;
}

/**
 * The VAN of each wallet (wallets of other kinds, a parent's, or of a school with no code, are left
 * out).
 */
export async function vansOf(
  db: Db,
  walletIds: readonly string[],
): Promise<Map<string, WalletVan>> {
  const out = new Map<string, WalletVan>();
  if (!walletIds.length) return out;
  const rows = await db
    .selectFrom('wallets as w')
    .leftJoin('member_profiles as o', 'o.id', 'w.owner_profile_id')
    .leftJoin('user_types as ot', 'ot.id', 'o.user_type_id')
    .leftJoin('academic_years as y', (j) =>
      j.onRef('y.institution_id', '=', 'w.institution_id').on('y.is_current', '=', 1),
    )
    .leftJoin('enrolments as en', (j) =>
      j.onRef('en.student_profile_id', '=', 'w.owner_profile_id').onRef('en.year_id', '=', 'y.id'),
    )
    .leftJoin('sections as s', 's.id', 'en.section_id')
    .leftJoin('class_corporate_codes as m', 'm.class_id', 's.class_id')
    .leftJoin('institution_corporate_codes as cc', (j) =>
      j.onRef('cc.id', '=', 'm.corporate_code_id').on('cc.status', '=', 'ACTIVE'),
    )
    .leftJoin('institution_corporate_codes as dc', (j) =>
      j
        .onRef('dc.institution_id', '=', 'w.institution_id')
        .on('dc.is_default', '=', 1)
        .on('dc.status', '=', 'ACTIVE'),
    )
    .select([
      'w.id',
      'w.wallet_no',
      'w.institution_id',
      'cc.id as c_id',
      'cc.corporate_code as c_code',
      'cc.bank_name as c_bank',
      'cc.ifsc as c_ifsc',
      'cc.pool_account_ref as c_pool',
      'dc.id as d_id',
      'dc.corporate_code as d_code',
      'dc.bank_name as d_bank',
      'dc.ifsc as d_ifsc',
      'dc.pool_account_ref as d_pool',
    ])
    .where('w.id', 'in', [...walletIds])
    .where('w.kind', 'in', [...VAN_WALLET_KINDS])
    .where((eb) => eb.or([eb('ot.category', 'is', null), eb('ot.category', '!=', 'PARENT')]))
    .execute();
  for (const r of rows) {
    const byClass = !!r.c_id && !!r.c_code;
    const id = byClass ? r.c_id : r.d_id;
    const code = byClass ? r.c_code : r.d_code;
    if (!id || !code) continue;
    out.set(String(r.id), {
      walletId: String(r.id),
      walletNo: r.wallet_no,
      institutionId: String(r.institution_id),
      van: `${code}${r.wallet_no}`,
      byClass,
      code: {
        id: String(id),
        code,
        bankName: (byClass ? r.c_bank : r.d_bank) ?? null,
        ifsc: (byClass ? r.c_ifsc : r.d_ifsc) ?? null,
        poolAccountRef: (byClass ? r.c_pool : r.d_pool) ?? null,
      },
    });
  }
  return out;
}

/**
 * The wallet a bank's account number names: an active code it starts with, the rest the wallet
 * number of one of that school's wallets, and that code the one the wallet's VAN uses now. Null
 * otherwise (the bank is answered "Incorrect Van" and returns the money).
 */
export async function resolveVan(db: Db, accountNumber: string): Promise<WalletVan | null> {
  const no = accountNumber.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,40}$/.test(no)) return null;
  // Codes are letters and digits only, so LIKE sees no wildcard in them.
  const codes = await db
    .selectFrom('institution_corporate_codes')
    .select(['id', 'institution_id', 'corporate_code'])
    .where('status', '=', 'ACTIVE')
    .where(sql<boolean>`${no} LIKE CONCAT(corporate_code, '%')`)
    .execute();
  // The longest code first: "AXIS1" before "AXIS" when both are someone's code.
  codes.sort((a, b) => b.corporate_code.length - a.corporate_code.length);
  for (const c of codes) {
    const walletNo = no.slice(c.corporate_code.length);
    if (!walletNo) continue;
    const w = await db
      .selectFrom('wallets')
      .select('id')
      .where('wallet_no', '=', walletNo)
      .where('institution_id', '=', String(c.institution_id))
      .where('kind', 'in', [...VAN_WALLET_KINDS])
      .executeTakeFirst();
    if (!w) continue;
    const van = (await vansOf(db, [String(w.id)])).get(String(w.id));
    if (van && van.code.id === String(c.id)) return van;
  }
  return null;
}

/**
 * Merchants and their static QR codes (SRS 9.2, 12.1–12.5, 12.11; PAY-007/008, PAY-013/014,
 * PAY-016…024, PAY-029/030; prototype c.merchants and the merchant app m.mer.home, m.mer.qrs,
 * m.mer.txns).
 *
 * - A merchant is a member profile of the institution's MERCHANT user type plus a `merchants` row.
 *   Registering one opens its wallet (database trigger). Its status is the profile's: activating and
 *   deactivating go through the member status rules, and the fee account can't be deactivated.
 * - The settlement bank account is encrypted at field level with a blind index; only the last four
 *   digits are ever shown (golden rule).
 * - A static QR code is generated once per merchant and kind (prototype); vendors take wallet
 *   payments only, regular merchants allowances and coupons when they accept them. A code is Active
 *   or Inactive; an Inactive code refuses payments (OI-PAY-01). Re-issue is the operator's (OQ-17).
 * - QR e-mails go through the e-mail sender (a log sender until the provider is chosen, Q17): the
 *   message points to the app and the console, where the code is shown and the card printed.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { newQrToken, qrPayload, type MessageKey } from '../config/registers';
import type { Database, MerchantQrKind } from '../models/ringpe_models';
import { accountRepository } from '../repositories/account.repository';
import { institutionsRepository } from '../repositories/institutions.repository';
import { membersRepository } from '../repositories/members.repository';
import type { MessageSender } from '../integrations/sms.provider';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import type { FieldCipher } from '../utils/fieldEncryption';
import { lastFour, maskAccountNumber } from '../utils/fieldEncryption';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { qrCardPdf, qrSvg } from '../utils/qr';
import type { FieldError } from '../utils/validators';
import { recordAudit } from './audit.service';
import type { MembersService } from './members.service';

type Db = Kysely<Database> | Transaction<Database>;

export type QrKind = MerchantQrKind;
const KIND_LABEL: Readonly<Record<QrKind, string>> = {
  PAYMENT: 'Payment',
  ALLOWANCE: 'Allowance',
  COUPON: 'Coupon',
};

/** Banks by IFSC prefix, for the bank name when the form leaves it out (prototype IFSC_BANKS). */
const IFSC_BANKS: Readonly<Record<string, string>> = {
  SBIN: 'State Bank of India',
  CNRB: 'Canara Bank',
  HDFC: 'HDFC Bank',
  ICIC: 'ICICI Bank',
  UTIB: 'Axis Bank',
  KARB: 'Karnataka Bank',
  BARB: 'Bank of Baroda',
  UBIN: 'Union Bank of India',
  KKBK: 'Kotak Mahindra Bank',
};

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const personName = (first: string | null, last: string | null) =>
  titleCase([first, last].filter(Boolean).join(' '));
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const first3 = (s: string) => (s.replace(/[^A-Za-z]/g, '').toUpperCase() + 'XXX').slice(0, 3);
const bool = (v: unknown) => v === true || v === 1 || v === '1';
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** 27.4 §9 merchant code: MER + 3 name + 3 institution + 5-digit id + MMYY (IST). */
export function merchantCode(displayName: string, institution: string, id: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    month: '2-digit',
    year: '2-digit',
  }).formatToParts(at);
  const mm = parts.find((p) => p.type === 'month')?.value ?? '01';
  const yy = parts.find((p) => p.type === 'year')?.value ?? '00';
  return `MER${first3(displayName)}${first3(institution)}${id.slice(-5).padStart(5, '0')}${mm}${yy}`;
}

export interface BankInput {
  readonly holderName: string;
  readonly bankName?: string | null | undefined;
  readonly accountNumber: string;
  readonly ifsc: string;
}

export interface MerchantInput {
  readonly displayName: string;
  readonly operatorFirstName: string;
  readonly operatorLastName?: string | null | undefined;
  readonly subType: 'REGULAR' | 'VENDOR';
  readonly departmentId?: string | null | undefined;
  readonly mobile: string;
  readonly email?: string | null | undefined;
  readonly acceptsAllowance?: boolean | undefined;
  readonly acceptsCoupon?: boolean | undefined;
  readonly bank?: BankInput | null | undefined;
  readonly chequeFileId?: string | null | undefined;
  readonly logoFileId?: string | null | undefined;
}

export interface MerchantPatch {
  readonly displayName?: string | undefined;
  readonly acceptsAllowance?: boolean | undefined;
  readonly acceptsCoupon?: boolean | undefined;
  readonly bank?: BankInput | undefined;
  readonly chequeFileId?: string | null | undefined;
  readonly logoFileId?: string | null | undefined;
}

export class MerchantsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cipher: FieldCipher;
      readonly members: MembersService;
      readonly email?: MessageSender;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async own(p: Principal, db: Db = this.deps.db) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    return row;
  }

  /** The merchant row of the institution by its profile's public id (another tenant's → 404). */
  private async merchant(db: Db, institutionId: string, id: string, lock = false) {
    if (!isUuid(id)) throw new NotFoundError();
    let q = db
      .selectFrom('member_profiles as m')
      .innerJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .leftJoin('departments as d', 'd.id', 'm.department_id')
      .select([
        'm.id',
        'm.public_id',
        'm.institution_id',
        'm.first_name',
        'm.last_name',
        'm.status',
        'm.status_reason',
        'm.contact_mobile',
        'm.contact_email',
        'm.account_id',
        'm.created_at',
        'd.name as department',
        'mer.unique_id',
        'mer.display_name',
        'mer.sub_type',
        'mer.holder_name',
        'mer.bank_name',
        'mer.acct_last4',
        'mer.ifsc',
        'mer.cheque_file_id',
        'mer.logo_file_id',
        'mer.accepts_allowance',
        'mer.accepts_coupon',
        'mer.dynamic_qr_enabled',
        'mer.nfc_enabled',
        'mer.is_fee_account',
        'mer.row_version',
      ])
      .where('m.institution_id', '=', institutionId)
      .where('m.public_id', '=', uuidToBin(id));
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  /** Today's successful collections of the merchants (IST business day). */
  private async today(db: Db, institutionId: string, profileIds: readonly string[]) {
    if (!profileIds.length) return new Map<string, { amount: number; count: number }>();
    const day = istBusinessDate(this.now());
    const start = new Date(`${day}T00:00:00+05:30`);
    const rows = await db
      .selectFrom('payment_attempts')
      .select([
        'payee_profile_id',
        sql<string>`COALESCE(SUM(amount_paise), 0)`.as('amount'),
        sql<number>`COUNT(*)`.as('n'),
      ])
      .where('institution_id', '=', institutionId)
      .where('payee_profile_id', 'in', [...profileIds])
      .where('status', '=', 'SUCCESS')
      .where('attempted_at', '>=', start)
      .groupBy('payee_profile_id')
      .execute();
    return new Map(
      rows.map((r) => [
        String(r.payee_profile_id),
        { amount: Number(r.amount), count: Number(r.n) },
      ]),
    );
  }

  private view(
    m: Awaited<ReturnType<MerchantsService['merchant']>>,
    today?: { amount: number; count: number },
  ) {
    return {
      id: binToUuid(m.public_id),
      displayName: m.display_name,
      uniqueId: m.unique_id,
      subType: m.sub_type,
      status: m.status,
      statusReason: m.status_reason,
      department: m.department ?? null,
      operator: personName(m.first_name === m.display_name ? null : m.first_name, m.last_name),
      mobile: m.contact_mobile,
      email: m.contact_email,
      accepts: {
        wallet: true,
        allowance: bool(m.accepts_allowance),
        coupon: bool(m.accepts_coupon),
      },
      channels: { dynamicQr: bool(m.dynamic_qr_enabled), nfc: bool(m.nfc_enabled) },
      isFeeAccount: bool(m.is_fee_account),
      today: {
        amount: toMoneyDto(today?.amount ?? 0),
        count: today?.count ?? 0,
      },
      onboardedAt: iso(m.created_at),
      version: m.row_version,
    };
  }

  // --- PAY-016 ------------------------------------------------------------------------------------
  async list(
    p: Principal,
    f: {
      q?: string | undefined;
      subType?: 'REGULAR' | 'VENDOR' | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const inst = await this.own(p);
    const db = this.deps.db;
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const after = f.cursor ? idCursor.decode(f.cursor) : null;
    let q = db
      .selectFrom('member_profiles as m')
      .innerJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .select('m.public_id')
      .where('m.institution_id', '=', inst.id);
    if (f.subType) q = q.where('mer.sub_type', '=', f.subType);
    if (f.status) q = q.where('m.status', '=', f.status);
    const text = f.q?.trim();
    if (text) {
      const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('mer.display_name', 'like', like),
          eb('mer.unique_id', 'like', like),
          eb('m.first_name', 'like', like),
          eb('m.last_name', 'like', like),
        ]),
      );
    }
    if (after) q = q.where('m.id', '>', after);
    const ids = await q
      .orderBy('m.id')
      .limit(limit + 1)
      .execute();
    const page = ids.slice(0, limit);
    const rows = await Promise.all(
      page.map((r) => this.merchant(db, inst.id, binToUuid(r.public_id))),
    );
    const today = await this.today(
      db,
      inst.id,
      rows.map((r) => String(r.id)),
    );
    const all = await db
      .selectFrom('member_profiles as m')
      .innerJoin('merchants as mer', 'mer.profile_id', 'm.id')
      .select(['m.id', 'm.status'])
      .where('m.institution_id', '=', inst.id)
      .execute();
    const todayAll = await this.today(
      db,
      inst.id,
      all.map((r) => String(r.id)),
    );
    let amount = 0;
    let count = 0;
    for (const t of todayAll.values()) {
      amount += t.amount;
      count += t.count;
    }
    return {
      items: rows.map((r) => this.view(r, today.get(String(r.id)))),
      nextCursor: ids.length > limit ? idCursor.encode(String(rows[rows.length - 1]!.id)) : null,
      kpis: {
        total: all.length,
        active: all.filter((r) => r.status === 'ACTIVE').length,
        collectionsToday: toMoneyDto(amount),
        paymentsToday: count,
      },
    };
  }

  /** The merchant's QR codes with their SVG and payload. */
  private async codes(db: Db, profileId: string) {
    const rows = await db
      .selectFrom('merchant_qr_codes')
      .selectAll()
      .where('merchant_profile_id', '=', profileId)
      .orderBy('id')
      .execute();
    return rows.map((q) => {
      const payload = qrPayload('s', q.token);
      return {
        id: binToUuid(q.public_id),
        kind: q.kind,
        status: q.status,
        statusReason: q.status_reason,
        createdAt: iso(q.created_at)!,
        statusChangedAt: iso(q.status_changed_at),
        payload,
        svg: qrSvg(payload),
        version: q.row_version,
      };
    });
  }

  // --- PAY-016 detail (drawer) -------------------------------------------------------------------
  async detail(p: Principal, id: string) {
    const inst = await this.own(p);
    const db = this.deps.db;
    const m = await this.merchant(db, inst.id, id);
    const [today, codes, wallet] = await Promise.all([
      this.today(db, inst.id, [String(m.id)]),
      this.codes(db, String(m.id)),
      db
        .selectFrom('wallets as w')
        .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
        .select(['w.wallet_no', 'w.status', 'b.available_paise'])
        .where('w.owner_profile_id', '=', m.id)
        .where('w.kind', '=', 'MERCHANT')
        .executeTakeFirst(),
    ]);
    return {
      ...this.view(m, today.get(String(m.id))),
      bank: m.ifsc
        ? {
            holderName: m.holder_name,
            bankName: m.bank_name,
            accountNumber: maskAccountNumber(m.acct_last4),
            ifsc: m.ifsc,
            chequeFileId: m.cheque_file_id ? await this.filePublicId(db, m.cheque_file_id) : null,
          }
        : null,
      wallet: wallet
        ? {
            walletNo: wallet.wallet_no,
            status: wallet.status,
            balance: toMoneyDto(Number(wallet.available_paise)),
          }
        : null,
      qrCodes: codes,
    };
  }

  private async filePublicId(db: Db, fileId: string) {
    const f = await db
      .selectFrom('files')
      .select('public_id')
      .where('id', '=', fileId)
      .executeTakeFirst();
    return f ? binToUuid(f.public_id) : null;
  }

  /** An uploaded file of this institution, clean, of an allowed purpose (cheque, logo). */
  private async claimFile(db: Db, institutionId: string, fileId: string, field: string) {
    if (!isUuid(fileId)) throw new ValidationError([{ field, code: 'VALIDATION.FORMAT' }]);
    const f = await db
      .selectFrom('files')
      .select(['id', 'institution_id', 'purpose', 'scan_status'])
      .where('public_id', '=', uuidToBin(fileId))
      .executeTakeFirst();
    if (!f || String(f.institution_id) !== institutionId || f.scan_status !== 'CLEAN') {
      throw new ValidationError([{ field, code: 'VALIDATION.FORMAT' }]);
    }
    return String(f.id);
  }

  /** Validates and encrypts a bank account (9–18 digits, IFSC per RNG-IDN-114). */
  private bankColumns(bank: BankInput, aad: string) {
    const number = bank.accountNumber.replace(/\s+/g, '');
    const ifsc = bank.ifsc.trim().toUpperCase();
    const holder = bank.holderName.trim();
    const e: FieldError[] = [];
    if (!holder) e.push({ field: 'bank.holderName', code: 'VALIDATION.REQUIRED' });
    if (!/^\d{9,18}$/.test(number))
      e.push({ field: 'bank.accountNumber', code: 'VALIDATION.FORMAT' });
    if (!IFSC.test(ifsc)) e.push({ field: 'bank.ifsc', code: 'IDN.IFSC_INVALID' });
    if (e.length) throw new ValidationError(e);
    const c = this.deps.cipher;
    return {
      holder_name: holder.toUpperCase(),
      bank_name: bank.bankName?.trim() || IFSC_BANKS[ifsc.slice(0, 4)] || null,
      acct_enc: c.encrypt('bank_acct', number, aad),
      acct_bidx: c.blindIndex('bank_acct', number),
      acct_last4: lastFour(number),
      ifsc,
    };
  }

  private async nameTaken(db: Db, institutionId: string, name: string, exceptId?: string) {
    let q = db
      .selectFrom('merchants')
      .select('profile_id')
      .where('institution_id', '=', institutionId)
      .where(sql`LOWER(display_name)`, '=', name.toLowerCase());
    if (exceptId) q = q.where('profile_id', '<>', exceptId);
    return !!(await q.executeTakeFirst());
  }

  // --- PAY-017 ------------------------------------------------------------------------------------
  async create(p: Principal, input: MerchantInput) {
    const by = this.by(p);
    const at = this.now();
    const displayName = input.displayName.trim();
    const pub = newPublicIdPair();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx);
      const errors: FieldError[] = [];
      const types = await trx
        .selectFrom('user_types')
        .select(['id', 'public_id'])
        .where('institution_id', '=', inst.id)
        .where('category', '=', 'MERCHANT')
        .where('status', '=', 'ACTIVE')
        .orderBy('id')
        .execute();
      const type = types[0];
      if (!type)
        throw new CustomAPIError(422, 'IDN.USER_TYPE_UNKNOWN', { params: { t: 'Merchant' } });
      let departmentId: string | null = null;
      if (input.departmentId) {
        const d = isUuid(input.departmentId)
          ? await trx
              .selectFrom('departments')
              .select('id')
              .where('public_id', '=', uuidToBin(input.departmentId))
              .where('user_type_id', '=', type.id)
              .executeTakeFirst()
          : undefined;
        if (!d) errors.push({ field: 'departmentId', code: 'VALIDATION.FORMAT' });
        else departmentId = String(d.id);
      }
      if (await this.nameTaken(trx, inst.id, displayName)) {
        errors.push({ field: 'displayName', code: 'MER.NAME_TAKEN' });
      }
      if (input.subType === 'VENDOR' && (input.acceptsAllowance || input.acceptsCoupon)) {
        errors.push({ field: 'subType', code: 'VALIDATION.FORMAT' });
      }
      if (errors.length) throw new ValidationError(errors);
      // One institution per person (BR-01): the mobile can't belong to another institution.
      const others = await membersRepository.profilesOfMobile(trx, input.mobile);
      if (others.some((x) => String(x.institution_id) !== inst.id)) {
        throw new CustomAPIError(409, 'IDN.MOBILE_IN_OTHER_INSTITUTION', {
          errors: [{ field: 'mobile', code: 'IDN.MOBILE_IN_OTHER_INSTITUTION' }],
        });
      }
      const account = await accountRepository.findByMobile(trx, input.mobile);
      const profileId = await membersRepository.insert(trx, {
        publicId: pub.bin,
        institutionId: inst.id,
        accountId: account ? String(account.id) : null,
        userTypeId: String(type.id),
        departmentId,
        firstName: input.operatorFirstName.trim().toUpperCase(),
        lastName: input.operatorLastName?.trim().toUpperCase() || null,
        gender: null,
        dateOfBirth: null,
        contactMobile: input.mobile,
        contactEmail: input.email?.trim().toLowerCase() || null,
        admissionNo: null,
        employeeNo: null,
        joinedOn: istBusinessDate(at),
        by,
      });
      const uniqueId = merchantCode(displayName, inst.name, profileId, at);
      await trx
        .insertInto('merchants')
        .values({
          profile_id: profileId,
          institution_id: inst.id,
          unique_id: uniqueId,
          display_name: displayName,
          sub_type: input.subType,
          ...(input.bank ? this.bankColumns(input.bank, `merchants.acct:${pub.id}`) : {}),
          cheque_file_id: input.chequeFileId
            ? await this.claimFile(trx, inst.id, input.chequeFileId, 'chequeFileId')
            : null,
          logo_file_id: input.logoFileId
            ? await this.claimFile(trx, inst.id, input.logoFileId, 'logoFileId')
            : null,
          accepts_allowance: input.subType === 'REGULAR' && !!input.acceptsAllowance,
          accepts_coupon: input.subType === 'REGULAR' && !!input.acceptsCoupon,
          created_by: by,
          created_at: at,
          updated_at: at,
        })
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MERCHANT_REGISTERED',
        entityType: 'merchant',
        entityRef: pub.id,
        after: {
          displayName,
          uniqueId,
          subType: input.subType,
          bank: input.bank ? { last4: lastFour(input.bank.accountNumber) } : null,
        },
      });
      return { uniqueId };
    });
    return { merchantId: pub.id, uniqueId: out.uniqueId };
  }

  // --- PAY-018 ------------------------------------------------------------------------------------
  async update(p: Principal, id: string, expected: number | null, patch: MerchantPatch) {
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx);
      const m = await this.merchant(trx, inst.id, id, true);
      if (expected === null || m.row_version !== expected) throw new PreconditionFailedError();
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (patch.displayName !== undefined) {
        const name = patch.displayName.trim();
        if (name !== m.display_name) {
          if (await this.nameTaken(trx, inst.id, name, String(m.id))) {
            throw new ValidationError([{ field: 'displayName', code: 'MER.NAME_TAKEN' }]);
          }
          set['display_name'] = name;
          before['displayName'] = m.display_name;
          after['displayName'] = name;
        }
      }
      const vendor = m.sub_type === 'VENDOR';
      for (const [key, col] of [
        ['acceptsAllowance', 'accepts_allowance'],
        ['acceptsCoupon', 'accepts_coupon'],
      ] as const) {
        const v = patch[key];
        if (v === undefined) continue;
        if (vendor && v) throw new ValidationError([{ field: key, code: 'VALIDATION.FORMAT' }]);
        set[col] = v;
        after[key] = v;
      }
      if (patch.bank) {
        Object.assign(set, this.bankColumns(patch.bank, `merchants.acct:${id.toLowerCase()}`));
        before['bank'] = m.acct_last4 ? { last4: m.acct_last4 } : null;
        after['bank'] = { last4: lastFour(patch.bank.accountNumber) };
      }
      if (patch.chequeFileId !== undefined) {
        set['cheque_file_id'] = patch.chequeFileId
          ? await this.claimFile(trx, inst.id, patch.chequeFileId, 'chequeFileId')
          : null;
        after['cheque'] = !!patch.chequeFileId;
      }
      if (patch.logoFileId !== undefined) {
        set['logo_file_id'] = patch.logoFileId
          ? await this.claimFile(trx, inst.id, patch.logoFileId, 'logoFileId')
          : null;
        after['logo'] = !!patch.logoFileId;
      }
      if (!Object.keys(set).length) return;
      const r = await trx
        .updateTable('merchants')
        .set({
          ...set,
          row_version: sql<number>`row_version + 1`,
          updated_at: this.now(),
        })
        .where('profile_id', '=', m.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MERCHANT_UPDATED',
        entityType: 'merchant',
        entityRef: binToUuid(m.public_id),
        before,
        after,
      });
    });
    return this.detail(p, id);
  }

  // --- PAY-019 ------------------------------------------------------------------------------------
  async setStatus(
    p: Principal,
    id: string,
    input: { to: 'ACTIVE' | 'INACTIVE'; reason?: string | null | undefined },
  ) {
    const inst = await this.own(p);
    const m = await this.merchant(this.deps.db, inst.id, id);
    if (input.to !== 'ACTIVE' && bool(m.is_fee_account)) {
      throw new CustomAPIError(409, 'MER.FEE_ACCOUNT_PROTECTED');
    }
    await this.deps.members.changeStatus(p, id, input);
    return this.detail(p, id);
  }

  // --- PAY-020 ------------------------------------------------------------------------------------
  async setChannels(
    p: Principal,
    id: string,
    expected: number | null,
    input: { dynamicQr: boolean; nfc: boolean },
  ) {
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx);
      const m = await this.merchant(trx, inst.id, id, true);
      if (expected === null || m.row_version !== expected) throw new PreconditionFailedError();
      await trx
        .updateTable('merchants')
        .set({
          dynamic_qr_enabled: input.dynamicQr,
          nfc_enabled: input.nfc,
          row_version: sql<number>`row_version + 1`,
          updated_at: this.now(),
        })
        .where('profile_id', '=', m.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MERCHANT_CHANNELS_SET',
        entityType: 'merchant',
        entityRef: binToUuid(m.public_id),
        before: { dynamicQr: bool(m.dynamic_qr_enabled), nfc: bool(m.nfc_enabled) },
        after: input,
      });
    });
    return this.detail(p, id);
  }

  // --- PAY-021 ------------------------------------------------------------------------------------
  async qrCodes(p: Principal, id: string) {
    const inst = await this.own(p);
    const m = await this.merchant(this.deps.db, inst.id, id);
    return { items: await this.codes(this.deps.db, String(m.id)) };
  }

  // --- PAY-022 ------------------------------------------------------------------------------------
  async generateQr(p: Principal, id: string, input: { kind: QrKind }) {
    const by = this.by(p);
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx);
      const m = await this.merchant(trx, inst.id, id, true);
      const kind = input.kind;
      const accepts =
        kind === 'PAYMENT' ||
        (m.sub_type === 'REGULAR' &&
          (kind === 'ALLOWANCE' ? bool(m.accepts_allowance) : bool(m.accepts_coupon)));
      if (!accepts) {
        throw new CustomAPIError(409, 'MER.QR_KIND_NOT_ACCEPTED', {
          params: { merchant: m.display_name, kind: KIND_LABEL[kind].toLowerCase() },
        });
      }
      const exists = await trx
        .selectFrom('merchant_qr_codes')
        .select('id')
        .where('merchant_profile_id', '=', m.id)
        .where('kind', '=', kind)
        .executeTakeFirst();
      if (exists) {
        throw new CustomAPIError(409, 'MER.QR_EXISTS', { params: { kind: KIND_LABEL[kind] } });
      }
      await trx
        .insertInto('merchant_qr_codes')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          merchant_profile_id: m.id,
          kind,
          token: newQrToken(),
          status: 'ACTIVE',
          created_by: by,
          created_at: this.now(),
        })
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MERCHANT_QR_GENERATED',
        entityType: 'merchant_qr',
        entityRef: pub.id,
        after: { merchant: binToUuid(m.public_id), kind },
      });
    });
    const codes = await this.qrCodes(p, id);
    return codes.items.find((q) => q.id === pub.id)!;
  }

  private async qrOf(db: Db, institutionId: string, qrId: string, lock = false) {
    if (!isUuid(qrId)) throw new NotFoundError();
    let q = db
      .selectFrom('merchant_qr_codes as q')
      .innerJoin('merchants as mer', 'mer.profile_id', 'q.merchant_profile_id')
      .innerJoin('member_profiles as m', 'm.id', 'q.merchant_profile_id')
      .select([
        'q.id',
        'q.public_id',
        'q.kind',
        'q.status',
        'q.token',
        'q.row_version',
        'q.merchant_profile_id',
        'mer.display_name',
        'mer.unique_id',
        'm.public_id as merchant_public_id',
        'm.contact_email',
      ])
      .where('q.institution_id', '=', institutionId)
      .where('q.public_id', '=', uuidToBin(qrId));
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  // --- PAY-023 ------------------------------------------------------------------------------------
  async setQrStatus(
    p: Principal,
    qrId: string,
    expected: number | null,
    input: { status: 'ACTIVE' | 'INACTIVE'; reason?: string | null | undefined },
  ) {
    const reason = input.reason?.trim() || null;
    if (input.status === 'INACTIVE' && !reason) {
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.REQUIRED' }]);
    }
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx);
      const q = await this.qrOf(trx, inst.id, qrId, true);
      if (expected !== null && q.row_version !== expected) throw new PreconditionFailedError();
      if (q.status !== input.status) {
        await trx
          .updateTable('merchant_qr_codes')
          .set({
            status: input.status,
            status_reason: reason,
            status_changed_at: this.now(),
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', q.id)
          .execute();
        await recordAudit(trx, {
          institutionId: inst.id,
          action: input.status === 'ACTIVE' ? 'MERCHANT_QR_ACTIVATED' : 'MERCHANT_QR_DEACTIVATED',
          entityType: 'merchant_qr',
          entityRef: qrId.toLowerCase(),
          before: { status: q.status },
          after: { status: input.status },
          reason: reason ?? undefined,
        });
      }
      return { merchantProfileId: String(q.merchant_profile_id) };
    });
    const items = await this.codes(this.deps.db, out.merchantProfileId);
    return items.find((x) => x.id === qrId.toLowerCase())!;
  }

  private async mail(
    to: string | null,
    codes: readonly { kind: QrKind; merchant: string; uniqueId: string }[],
  ) {
    if (!to || !codes.length || !this.deps.email) return 0;
    const lines = codes.map((c) => `${KIND_LABEL[c.kind]} QR · ${c.merchant} · ${c.uniqueId}`);
    await this.deps.email.send({
      to,
      purpose: 'merchant.qr_codes',
      text: [
        'Your RingPe QR codes:',
        ...lines,
        'Open the RingPe app (My QR codes) or ask the school office to print the cards.',
      ].join('\n'),
    });
    return codes.length;
  }

  // --- PAY-024 ------------------------------------------------------------------------------------
  async emailQrs(
    p: Principal,
    input: { merchantIds?: readonly string[] | undefined; all?: boolean },
  ) {
    const inst = await this.own(p);
    const db = this.deps.db;
    let q = db
      .selectFrom('merchant_qr_codes as q')
      .innerJoin('merchants as mer', 'mer.profile_id', 'q.merchant_profile_id')
      .innerJoin('member_profiles as m', 'm.id', 'q.merchant_profile_id')
      .select(['q.kind', 'mer.display_name', 'mer.unique_id', 'm.contact_email', 'm.public_id'])
      .where('q.institution_id', '=', inst.id)
      .where('q.status', '=', 'ACTIVE');
    if (!input.all) {
      const ids = (input.merchantIds ?? []).filter(isUuid).map(uuidToBin);
      if (!ids.length)
        throw new ValidationError([{ field: 'merchantIds', code: 'VALIDATION.REQUIRED' }]);
      q = q.where('m.public_id', 'in', ids);
    }
    const rows = await q.execute();
    const byMerchant = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = binToUuid(r.public_id);
      byMerchant.set(k, [...(byMerchant.get(k) ?? []), r]);
    }
    let sent = 0;
    let skipped = 0;
    for (const list of byMerchant.values()) {
      const n = await this.mail(
        list[0]!.contact_email,
        list.map((r) => ({ kind: r.kind, merchant: r.display_name, uniqueId: r.unique_id })),
      );
      if (n) sent += n;
      else skipped += list.length;
    }
    return { sent, skipped };
  }

  // --- PAY-029 ------------------------------------------------------------------------------------
  async qrCard(p: Principal, qrId: string) {
    const inst = await this.own(p);
    const q = await this.qrOf(this.deps.db, inst.id, qrId);
    return {
      name: `${q.display_name} ${KIND_LABEL[q.kind]} QR.pdf`,
      data: qrCardPdf({
        institution: inst.name,
        merchant: q.display_name,
        kindLabel: KIND_LABEL[q.kind],
        code: q.unique_id,
        payload: qrPayload('s', q.token),
      }),
    };
  }

  // --- The merchant's own app (member surface, active profile a merchant) --------------------------

  /** The signed-in merchant: the session's active profile must be a merchant of its institution. */
  async self(p: Principal, db: Db = this.deps.db) {
    if (!p.profileId || !isUuid(p.profileId) || !p.institutionId || !isUuid(p.institutionId)) {
      throw new CustomAPIError(403, 'MER.NOT_MERCHANT');
    }
    const inst = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId));
    if (!inst) throw new NotFoundError();
    try {
      return { inst, m: await this.merchant(db, inst.id, p.profileId) };
    } catch {
      throw new CustomAPIError(403, 'MER.NOT_MERCHANT');
    }
  }

  // --- PAY-007 ------------------------------------------------------------------------------------
  async home(p: Principal) {
    const { inst, m } = await this.self(p);
    const db = this.deps.db;
    const [today, codes, wallet, pending] = await Promise.all([
      this.today(db, inst.id, [String(m.id)]),
      this.codes(db, String(m.id)),
      db
        .selectFrom('wallets as w')
        .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
        .select(['w.wallet_no', 'w.status', 'b.available_paise'])
        .where('w.owner_profile_id', '=', m.id)
        .where('w.kind', '=', 'MERCHANT')
        .executeTakeFirst(),
      db
        .selectFrom('payment_requests')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('merchant_profile_id', '=', m.id)
        .where('status', '=', 'PENDING')
        .where('expires_at', '>', this.now())
        .executeTakeFirst(),
    ]);
    const t = today.get(String(m.id));
    return {
      merchant: this.view(m, t),
      today: { gross: toMoneyDto(t?.amount ?? 0), count: t?.count ?? 0 },
      // Settlement runs arrive in Phase 6; until then nothing is waiting to be settled.
      pendingSettlement: null,
      wallet: wallet
        ? {
            walletNo: wallet.wallet_no,
            status: wallet.status,
            balance: toMoneyDto(Number(wallet.available_paise)),
          }
        : null,
      qr: codes.map((c) => ({ id: c.id, kind: c.kind, status: c.status })),
      openRequests: Number(pending?.n ?? 0),
    };
  }

  // --- PAY-008 ------------------------------------------------------------------------------------
  async myQrCodes(p: Principal) {
    const { m } = await this.self(p);
    return { items: await this.codes(this.deps.db, String(m.id)) };
  }

  // --- PAY-030 ------------------------------------------------------------------------------------
  async myQrCard(p: Principal, qrId: string) {
    const { inst, m } = await this.self(p);
    const q = await this.qrOf(this.deps.db, inst.id, qrId);
    if (String(q.merchant_profile_id) !== String(m.id)) throw new NotFoundError();
    return this.qrCard(p, qrId);
  }

  // --- PAY-013 ------------------------------------------------------------------------------------
  async emailMyQr(p: Principal, qrId: string, input: { email?: string | null | undefined }) {
    const { inst, m } = await this.self(p);
    const q = await this.qrOf(this.deps.db, inst.id, qrId);
    if (String(q.merchant_profile_id) !== String(m.id)) throw new NotFoundError();
    const to = input.email?.trim().toLowerCase() || m.contact_email;
    if (!to) throw new ValidationError([{ field: 'email', code: 'VALIDATION.REQUIRED' }]);
    await this.mail(to, [{ kind: q.kind, merchant: q.display_name, uniqueId: q.unique_id }]);
    return { sentTo: to.replace(/^(.)[^@]*(@.*)$/, (_x, a: string, b: string) => `${a}•••${b}`) };
  }

  // --- PAY-014 ------------------------------------------------------------------------------------
  async collections(
    p: Principal,
    f: {
      from?: string | undefined;
      to?: string | undefined;
      status?: 'SUCCESS' | 'FAILURE' | 'PENDING' | undefined;
      channel?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const { inst, m } = await this.self(p);
    const db = this.deps.db;
    const limit = Math.min(Math.max(f.limit ?? 30, 1), 100);
    const after = f.cursor ? idCursor.decode(f.cursor) : null;
    let q = db
      .selectFrom('payment_attempts as a')
      .innerJoin('member_profiles as payer', 'payer.id', 'a.payer_profile_id')
      .select([
        'a.id',
        'a.public_id',
        'a.reference',
        'a.channel',
        'a.amount_paise',
        'a.status',
        'a.failure_code',
        'a.attempted_at',
        'payer.first_name',
        'payer.last_name',
      ])
      .where('a.institution_id', '=', inst.id)
      .where('a.payee_profile_id', '=', m.id);
    const range = (d: string | undefined, end: boolean) =>
      d && /^\d{4}-\d{2}-\d{2}$/.test(d)
        ? new Date(`${d}T${end ? '23:59:59.999' : '00:00:00'}+05:30`)
        : null;
    const from = range(f.from, false);
    const to = range(f.to, true);
    if (from) q = q.where('a.attempted_at', '>=', from);
    if (to) q = q.where('a.attempted_at', '<=', to);
    if (f.status) q = q.where('a.status', '=', f.status);
    if (f.channel) q = q.where('a.channel', '=', f.channel);
    const totals = await q
      .clearSelect()
      .select([
        sql<string>`COALESCE(SUM(CASE WHEN a.status = 'SUCCESS' THEN a.amount_paise ELSE 0 END), 0)`.as(
          'amount',
        ),
        sql<number>`SUM(a.status = 'SUCCESS')`.as('n'),
      ])
      .executeTakeFirst();
    if (after) q = q.where('a.id', '<', after);
    const rows = await q
      .orderBy('a.id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: binToUuid(r.public_id),
        reference: r.reference,
        channel: r.channel,
        amount: toMoneyDto(Number(r.amount_paise)),
        status: r.status,
        failureCode: r.failure_code as MessageKey | null,
        payer: personName(r.first_name, r.last_name),
        at: iso(r.attempted_at)!,
      })),
      nextCursor: rows.length > limit ? idCursor.encode(String(page[page.length - 1]!.id)) : null,
      totals: { amount: toMoneyDto(Number(totals?.amount ?? 0)), count: Number(totals?.n ?? 0) },
    };
  }

  /** For the payment routes: a merchant's display line for receipts and confirmations. */
  static display(m: { display_name: string; unique_id: string; sub_type: string }) {
    return { name: m.display_name, code: m.unique_id.slice(-9), subType: m.sub_type };
  }
}

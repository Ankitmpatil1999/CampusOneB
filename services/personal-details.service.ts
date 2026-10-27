/**
 * Personal details of the signed-in member (SRS 6.10, 6.11, 6.38.5; IDN-015…017, IDN-020…023;
 * prototype m.kyc).
 *
 * - Identity (name, date of birth, gender, PAN, identity number) is display-only (CR-06); it changes
 *   only through a correction request with evidence, approved by a checker (section 17), and the
 *   stored value stands until then (RNG-IDN-388…391). The mobile number is the account key and has
 *   no correction path (OI-IDN-40).
 * - Address, bank account, nominee and income are contact data the member keeps (RNG-IDN-113: one
 *   record of each); each save is version-guarded (If-Match). The fields asked for are the
 *   prototype's (client 2026-10-03, migration 0011); the SRS extras (proof document type, bank name,
 *   re-entered number, nominee date of birth, change reason) are optional.
 * - The bank account is checked with ₹1 (penny drop) through the bank-check provider (test mode
 *   until one is chosen, Q17); the number is encrypted with a blind index (ADR-0012).
 *
 * - A correction goes to the member's school (its Institution Administrator decides it in the
 *   console approvals); an account without an institution profile goes to RingPe's back office.
 *
 * Not yet here, by phase: the transaction-PIN gate of RNG-IDN-112 arrives with the PIN (Phase 3).
 */
import { sql, type Kysely } from 'kysely';
import {
  BANK_CHANGE_REASONS,
  GENDERS,
  idNumberPattern,
  type MessageKey,
} from '../config/registers';
import type { BankVerifier } from '../integrations/bank-verify.provider';
import type { AccountPiiField, Database } from '../models/ringpe_models';
import { accountRepository, referenceRepository } from '../repositories/account.repository';
import { fileRepository } from '../repositories/file.repository';
import { personalRepository } from '../repositories/personal.repository';
import { FIELD_LABELS, raiseApproval } from './approvals.service';
import { recordAudit } from './audit.service';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../utils/CustomAPIError';
import {
  lastFour,
  maskAccountNumber,
  maskIdNumber,
  maskPan,
  normaliseForIndex,
  type FieldCipher,
} from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { PATTERNS, isRealDate } from '../utils/validators';
import type { FieldError } from '../utils/validators';

const NAME = /^[A-Za-z]+(?: [A-Za-z]+)*$/;
const PERSON = /^[A-Za-z.'-]+(?: [A-Za-z.'-]+)*$/;
const CITY = /^[A-Za-z]+(?:[ .'-][A-Za-z]+)*$/;
const OCCUPATION = /^[A-Za-z][A-Za-z .,&()/'-]*$/;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const day = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

export const CORRECTABLE: readonly AccountPiiField[] = [
  'FULL_NAME',
  'DOB',
  'GENDER',
  'PAN',
  'ID_NUMBER',
];

export interface AddressInput {
  readonly line1: string;
  readonly line2?: string | undefined;
  readonly city: string;
  readonly state?: string | undefined;
  readonly pinCode: string;
  readonly proofType?: string | undefined;
  readonly proofFileId?: string | undefined;
}

export interface BankInput {
  readonly holderName: string;
  readonly bankName?: string | undefined;
  readonly accountNumber: string;
  readonly confirmAccountNumber?: string | undefined;
  readonly ifsc: string;
  readonly changeReason?: string | undefined;
}

export interface NomineeInput {
  readonly name: string;
  readonly relation: string;
  readonly dob?: string | undefined;
  readonly sharePct: number;
}

export interface CorrectionInput {
  readonly field: string;
  readonly proposedValue: string;
  readonly reason: string;
  readonly evidenceFileId: string;
}

export class PersonalDetailsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cipher: FieldCipher;
      readonly bankVerifier: BankVerifier;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private async account(p: Principal) {
    const a = await accountRepository.findByPublicId(this.deps.db, uuidToBin(p.subject));
    if (!a || a.status !== 'ACTIVE') throw new AuthenticationError();
    return a;
  }

  /** IDN-015: identity (masked, display-only), contact, money details, pending corrections. */
  async view(p: Principal) {
    const a = await this.account(p);
    const db = this.deps.db;
    const [address, bank, nominee, income, corrections, relations, bands, occupations, proofs] =
      await Promise.all([
        personalRepository.address(db, a.id),
        personalRepository.bankAccount(db, a.id),
        personalRepository.nominee(db, a.id),
        personalRepository.income(db, a.id),
        personalRepository.corrections(db, a.id),
        personalRepository.activeCodes(db, 'ref_relations'),
        personalRepository.activeCodes(db, 'ref_income_bands'),
        personalRepository.activeCodes(db, 'ref_occupations'),
        personalRepository.activeCodes(db, 'ref_address_proof_types'),
      ]);
    const choice = (r: { code: string; label_key: string }) => ({
      code: r.code,
      labelKey: r.label_key,
    });
    return {
      identity: {
        fullName: [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(' '),
        dob: a.dob ? day(a.dob) : null,
        gender: a.gender,
        pan: maskPan(a.pan_last4),
        idDocument: a.id_doc_type
          ? { type: a.id_doc_type, number: maskIdNumber(a.id_doc_type, a.id_doc_last4) }
          : null,
        mobile: a.mobile,
      },
      contact: { email: a.email, emailVerified: a.email_verified_at !== null },
      address: address
        ? {
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            state: address.state,
            pinCode: address.pin_code,
            proofType: address.proof_type,
            proofFile: { fileId: binToUuid(address.proof_public_id), name: address.proof_name },
            version: address.row_version,
          }
        : null,
      bankAccount: bank
        ? {
            holderName: bank.holder_name,
            bankName: bank.bank_name,
            accountNumber: maskAccountNumber(bank.acct_last4),
            ifsc: bank.ifsc,
            verified: bank.verified_at !== null,
            verifiedAt: iso(bank.verified_at),
            testVerification: bank.verification_ref?.startsWith('TEST-') ?? false,
            version: bank.row_version,
          }
        : null,
      nominee: nominee
        ? {
            name: nominee.name,
            relation: nominee.relation_code,
            dob: nominee.dob ? day(nominee.dob) : null,
            sharePct: nominee.share_pct,
            version: nominee.row_version,
          }
        : null,
      income: income
        ? {
            occupation: income.occupation,
            band: income.band_code,
            version: income.row_version,
          }
        : null,
      pendingCorrections: corrections
        .filter((c) => c.status === 'PENDING')
        .map((c) => ({ requestId: binToUuid(c.public_id), field: c.field })),
      options: {
        relations: relations
          .filter((r) => (r.usage_scope ?? '').split(',').includes('nominee'))
          .map(choice),
        incomeBands: bands.map(choice),
        occupations: occupations.map(choice),
        addressProofTypes: proofs.map(choice),
        bankChangeReasons: BANK_CHANGE_REASONS.map((r) => ({ code: r.code, labelKey: r.labelKey })),
      },
    };
  }

  /** A file this member uploaded for the given purpose, clean of viruses; 404 otherwise. */
  private async ownFile(p: Principal, fileId: string, purpose: 'document' | 'evidence') {
    if (!isUuid(fileId)) throw new NotFoundError();
    const f = await fileRepository.findByPublicId(this.deps.db, uuidToBin(fileId));
    const own = f && f.created_by !== null && binToUuid(f.created_by) === p.subject;
    if (!f || !own || f.purpose !== purpose || f.scan_status !== 'CLEAN') {
      throw new NotFoundError();
    }
    return f;
  }

  /** IDN-020: address lines, PIN code and the address proof (OI-IDN-12). */
  async saveAddress(p: Principal, input: AddressInput, expected: number) {
    const a = await this.account(p);
    const e: FieldError[] = [];
    const line1 = input.line1.trim();
    const line2 = input.line2?.trim() || null;
    const city = input.city.trim();
    const state = input.state?.trim() || null;
    if (!line1) e.push({ field: 'line1', code: 'VALIDATION.REQUIRED' });
    if (!city) e.push({ field: 'city', code: 'VALIDATION.REQUIRED' });
    else if (!CITY.test(city)) e.push({ field: 'city', code: 'IDN.NAME_LETTERS_ONLY' });
    if (state && !CITY.test(state)) e.push({ field: 'state', code: 'IDN.NAME_LETTERS_ONLY' });
    if (!PATTERNS.postalCode.test(input.pinCode.trim())) {
      e.push({ field: 'pinCode', code: 'VALIDATION.PIN_CODE' });
    }
    if (input.proofType) {
      const proofTypes = await personalRepository.activeCodes(
        this.deps.db,
        'ref_address_proof_types',
      );
      if (!proofTypes.some((t) => t.code === input.proofType)) {
        e.push({ field: 'proofType', code: 'VALIDATION.FORMAT' });
      }
    }
    const current = await personalRepository.address(this.deps.db, a.id);
    if (!input.proofFileId && !current)
      e.push({ field: 'proofFileId', code: 'VALIDATION.REQUIRED' });
    if (e.length > 0) throw new ValidationError(e);
    const proof = input.proofFileId
      ? await this.ownFile(p, input.proofFileId, 'document')
      : undefined;
    // A new file replaces the proof; its document type is whatever came with it (optional).
    const proofFileId = proof ? String(proof.id) : String(current?.proof_file_id);
    const proofType = input.proofType ?? (proof ? null : (current?.proof_type ?? null));
    const version = await this.deps.db.transaction().execute(async (trx) => {
      const v = await personalRepository.saveAddress(trx, a.id, expected, {
        line1,
        line2,
        city,
        state,
        pin_code: input.pinCode.trim(),
        proof_type: proofType,
        proof_file_id: proofFileId,
      });
      await recordAudit(trx, {
        action: expected === 0 ? 'ADDRESS_ADDED' : 'ADDRESS_UPDATED',
        entityType: 'account_address',
        entityRef: binToUuid(a.public_id),
        after: { city, pinCode: input.pinCode.trim(), proofType, proofReplaced: Boolean(proof) },
        actor: { type: 'member', ref: p.subject },
      });
      return v;
    });
    return { version };
  }

  /** IDN-021: the personal-wallet bank account, checked with ₹1 before use (prototype pf.bankgo). */
  async saveBankAccount(p: Principal, input: BankInput, expected: number) {
    const a = await this.account(p);
    const e: FieldError[] = [];
    const holder = input.holderName.trim().replace(/\s+/g, ' ');
    const bankName = input.bankName?.trim().replace(/\s+/g, ' ') || null;
    const number = input.accountNumber.replace(/\s+/g, '');
    const ifsc = input.ifsc.trim().toUpperCase();
    if (!holder) e.push({ field: 'holderName', code: 'VALIDATION.REQUIRED' });
    else if (!PERSON.test(holder)) e.push({ field: 'holderName', code: 'IDN.NAME_LETTERS_ONLY' });
    if (!number) e.push({ field: 'accountNumber', code: 'VALIDATION.REQUIRED' });
    else if (!/^\d{9,18}$/.test(number)) {
      e.push({ field: 'accountNumber', code: 'VALIDATION.FORMAT' });
    } else if (
      input.confirmAccountNumber !== undefined &&
      number !== input.confirmAccountNumber.replace(/\s+/g, '')
    ) {
      e.push({ field: 'confirmAccountNumber', code: 'IDN.ACCOUNT_NUMBER_MISMATCH' });
    }
    if (!PATTERNS.ifsc.test(ifsc)) e.push({ field: 'ifsc', code: 'IDN.IFSC_INVALID' });
    const replacing = expected > 0;
    if (input.changeReason && !BANK_CHANGE_REASONS.some((r) => r.code === input.changeReason)) {
      e.push({ field: 'changeReason', code: 'VALIDATION.FORMAT' });
    }
    if (e.length > 0) throw new ValidationError(e);

    const check = await this.deps.bankVerifier.check({
      holderName: holder,
      accountNumber: number,
      ifsc,
    });
    if (!check.verified && check.reason !== 'NOT_CONFIGURED') {
      throw new ValidationError([{ field: 'accountNumber', code: 'IDN.BANK_VERIFY_FAILED' }]);
    }
    const now = this.now();
    const c = this.deps.cipher;
    const version = await this.deps.db.transaction().execute(async (trx) => {
      const v = await personalRepository.saveBankAccount(trx, a.id, expected, {
        holder_name: holder.toUpperCase(),
        bank_name: bankName,
        acct_enc: c.encrypt(
          'bank_acct',
          number,
          `account_bank_accounts.acct:${binToUuid(a.public_id)}`,
        ),
        acct_bidx: c.blindIndex('bank_acct', number),
        acct_last4: lastFour(number),
        ifsc,
        change_reason: replacing ? (input.changeReason ?? null) : null,
        verified_at: check.verified ? now : null,
        verification_ref: check.verified ? check.reference : null,
      });
      await recordAudit(trx, {
        action: replacing ? 'BANK_ACCOUNT_REPLACED' : 'BANK_ACCOUNT_LINKED',
        entityType: 'account_bank_account',
        entityRef: binToUuid(a.public_id),
        after: {
          accountLast4: lastFour(number),
          ifsc,
          verified: check.verified,
          ...(replacing ? { reason: input.changeReason } : {}),
        },
        actor: { type: 'member', ref: p.subject },
      });
      return v;
    });
    return {
      version,
      verified: check.verified,
      testVerification: check.verified && check.test,
    };
  }

  /** IDN-022: one nominee — name, relation (prototype list), share; date of birth optional. */
  async saveNominee(p: Principal, input: NomineeInput, expected: number) {
    const a = await this.account(p);
    const e: FieldError[] = [];
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (!name) e.push({ field: 'name', code: 'VALIDATION.REQUIRED' });
    else if (!NAME.test(name) || name.length > 100) {
      e.push({ field: 'name', code: 'IDN.NAME_LETTERS_ONLY' });
    }
    const relations = await personalRepository.activeCodes(this.deps.db, 'ref_relations');
    const nomineeRelations = relations.filter((r) =>
      (r.usage_scope ?? '').split(',').includes('nominee'),
    );
    if (!nomineeRelations.some((r) => r.code === input.relation)) {
      e.push({ field: 'relation', code: 'VALIDATION.REQUIRED' });
    }
    if (
      input.dob !== undefined &&
      (!isRealDate(input.dob) || new Date(`${input.dob}T00:00:00Z`) > this.now())
    ) {
      e.push({ field: 'dob', code: 'IDN.DOB_NOT_VALID' });
    }
    if (!Number.isInteger(input.sharePct) || input.sharePct < 1 || input.sharePct > 100) {
      e.push({ field: 'sharePct', code: 'VALIDATION.RANGE', params: { min: 1, max: 100 } });
    }
    if (e.length > 0) throw new ValidationError(e);
    const version = await this.deps.db.transaction().execute(async (trx) => {
      const v = await personalRepository.saveNominee(trx, a.id, expected, {
        name: name.toUpperCase(),
        relation_code: input.relation,
        dob: input.dob ?? null,
        share_pct: input.sharePct,
      });
      await recordAudit(trx, {
        action: expected === 0 ? 'NOMINEE_ADDED' : 'NOMINEE_UPDATED',
        entityType: 'account_nominee',
        entityRef: binToUuid(a.public_id),
        after: { relation: input.relation, sharePct: input.sharePct },
        actor: { type: 'member', ref: p.subject },
      });
      return v;
    });
    return { version };
  }

  /** IDN-023: occupation (text, as the prototype asks) and annual income band. */
  async saveIncome(p: Principal, input: { occupation: string; band: string }, expected: number) {
    const a = await this.account(p);
    const bands = await personalRepository.activeCodes(this.deps.db, 'ref_income_bands');
    const e: FieldError[] = [];
    const occupation = input.occupation.trim().replace(/\s+/g, ' ');
    if (!occupation) e.push({ field: 'occupation', code: 'VALIDATION.REQUIRED' });
    else if (!OCCUPATION.test(occupation) || occupation.length > 100) {
      e.push({ field: 'occupation', code: 'VALIDATION.FORMAT' });
    }
    if (!bands.some((b) => b.code === input.band))
      e.push({ field: 'band', code: 'VALIDATION.REQUIRED' });
    if (e.length > 0) throw new ValidationError(e);
    const version = await this.deps.db.transaction().execute(async (trx) => {
      const v = await personalRepository.saveIncome(trx, a.id, expected, {
        occupation,
        band_code: input.band,
      });
      await recordAudit(trx, {
        action: 'INCOME_UPDATED',
        entityType: 'account_income',
        entityRef: binToUuid(a.public_id),
        after: { occupation, band: input.band },
        actor: { type: 'member', ref: p.subject },
      });
      return v;
    });
    return { version };
  }

  /**
   * IDN-016: a correction request for a display-only field (RNG-IDN-388/389): the corrected value
   * (encrypted), the reason and the evidence; it waits for a checker. One open request per field.
   */
  async requestCorrection(p: Principal, input: CorrectionInput) {
    const a = await this.account(p);
    const field = input.field as AccountPiiField;
    if (!CORRECTABLE.includes(field)) {
      throw new ValidationError([{ field: 'field', code: 'IDN.PII_FIELD_NOT_CORRECTABLE' }]);
    }
    const value = input.proposedValue.trim();
    const reason = input.reason.trim();
    const e: FieldError[] = [];
    const invalid = (code: MessageKey) => e.push({ field: 'proposedValue', code });
    if (!value) invalid('VALIDATION.REQUIRED');
    else if (field === 'FULL_NAME' && !NAME.test(value)) invalid('IDN.NAME_LETTERS_ONLY');
    else if (field === 'DOB' && !isRealDate(value)) invalid('VALIDATION.DATE');
    else if (field === 'GENDER' && !GENDERS.some((g) => g.code === value))
      invalid('VALIDATION.FORMAT');
    else if (field === 'PAN' && !PATTERNS.pan.test(value.toUpperCase())) invalid('IDN.PAN_INVALID');
    else if (field === 'ID_NUMBER') {
      const types = await referenceRepository.idDocumentTypes(this.deps.db);
      const type = types.find((t) => t.code === a.id_doc_type);
      if (!type || !idNumberPattern(type.code, type.number_regex).test(normaliseForIndex(value))) {
        invalid('IDN.ID_DOC_NUMBER_INVALID');
      }
    }
    if (!reason) e.push({ field: 'reason', code: 'VALIDATION.REQUIRED' });
    else if (reason.length < 10 || reason.length > 300) {
      e.push({ field: 'reason', code: 'VALIDATION.FORMAT' });
    }
    if (!input.evidenceFileId) e.push({ field: 'evidenceFileId', code: 'VALIDATION.REQUIRED' });
    if (e.length > 0) throw new ValidationError(e);
    const evidence = await this.ownFile(p, input.evidenceFileId, 'evidence');

    const current = {
      FULL_NAME: [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(' '),
      DOB: a.dob ? day(a.dob) : '—',
      GENDER: a.gender ?? '—',
      PAN: maskPan(a.pan_last4) ?? '—',
      ID_NUMBER: maskIdNumber(a.id_doc_type, a.id_doc_last4) ?? '—',
    }[field];
    const correction = newPublicIdPair();
    const stored =
      field === 'PAN' ? value.toUpperCase() : field === 'FULL_NAME' ? value.toUpperCase() : value;
    const proposedShown =
      field === 'PAN' || field === 'ID_NUMBER'
        ? `••••${lastFour(normaliseForIndex(stored))}`
        : field === 'GENDER'
          ? (GENDERS.find((g) => g.code === stored)?.en ?? stored)
          : stored;
    const name = [a.first_name, a.last_name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .replace(/(^|[\s.'-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
    const summary = `${FIELD_LABELS[field]} for ${name}: ${current} → ${proposedShown} (member request)`;
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        // The member's school decides (prototype m.kyc: "the school approves it") — the session's
        // own when the account belongs to several (client 2026-10-27); an account without an
        // institution profile goes to RingPe's back office.
        const session = p.institutionId && isUuid(p.institutionId) ? p.institutionId : null;
        let q = trx
          .selectFrom('member_profiles as m')
          .innerJoin('institutions as i', 'i.id', 'm.institution_id')
          .select('m.institution_id')
          // Or the student's own profile on their own login (client 2026-10-23).
          .where((eb) => eb.or([eb('m.account_id', '=', a.id), eb('m.own_account_id', '=', a.id)]));
        if (session) q = q.orderBy(sql`i.public_id = ${uuidToBin(session)}`, 'desc');
        const profile = await q.orderBy('m.id').executeTakeFirst();
        const institutionId = profile ? String(profile.institution_id) : null;
        if (institutionId) {
          await trx
            .selectFrom('institutions')
            .select('id')
            .where('id', '=', institutionId)
            .forUpdate()
            .execute();
        }
        const raised = await raiseApproval(trx, {
          institutionId,
          module: 'PII_CORRECTION',
          summary,
          payload: { correction: correction.id, field },
          makerType: 'member',
          makerRef: a.public_id,
          subjectType: 'account',
          subjectRef: a.public_id,
          at: this.now(),
        });
        await personalRepository.insertCorrection(trx, {
          correctionPublicId: correction.bin,
          accountId: a.id,
          institutionId,
          approvalRowId: raised.rowId,
          field,
          currentMasked: current,
          proposedEnc: this.deps.cipher.encrypt(
            'pii_correction',
            stored,
            `pii_correction_requests.proposed:${correction.id}`,
          ),
          reason,
          evidenceFileId: String(evidence.id),
        });
        await recordAudit(trx, {
          action: 'PII_CORRECTION_REQUESTED',
          entityType: 'pii_correction_request',
          entityRef: correction.id,
          after: { field, reasonLength: reason.length },
          actor: { type: 'member', ref: p.subject },
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ConflictError('IDN.CORRECTION_PENDING');
      }
      throw err;
    }
    return { requestId: correction.id, status: 'PENDING' as const };
  }

  /** IDN-017: my correction requests and their outcome. */
  async corrections(p: Principal) {
    const a = await this.account(p);
    const rows = await personalRepository.corrections(this.deps.db, a.id);
    return rows.map((r) => ({
      requestId: binToUuid(r.public_id),
      field: r.field,
      current: r.current_masked,
      reason: r.reason,
      status: r.status,
      remarks: r.remarks,
      createdAt: iso(r.created_at),
      decidedAt: iso(r.decided_at),
      appliedAt: iso(r.applied_at),
    }));
  }
}

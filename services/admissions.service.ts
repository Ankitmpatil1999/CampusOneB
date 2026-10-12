/**
 * Admission applications (SRS 19.2–19.12; CR-14; ADM-002…025; prototype p.form, p.pay, p.done,
 * p.status, c.applications, c.admfees).
 *
 * - One model for the public form and the counsellor: a Draft is saved section by section; at
 *   submission everything is checked — the student, an address, a primary contact with a mobile, the
 *   documents, the age band (BR-50, on 1 June or the joining date for a mid-term joiner, OI-ADM-23),
 *   and for a mid-term admission a transfer certificate or an undertaking with a date (OI-ADM-27) and
 *   at least one reference (OI-ADM-29).
 * - The application fee: when the year's entry fees make it mandatory the application stays a Draft
 *   until it is paid (online, or cash at the desk), then it is Submitted (BR-36); otherwise it is
 *   Submitted at once. The admission fee is paid after approval. Neither touches a campus wallet.
 * - A family reaches its applications only after a one-time code to the mobile on the application;
 *   the public answers show the application number and status, never another family's details
 *   (RNG-GOV-007). Tokens: `admission-resume` (the family's drafts), `admission-pay` (one fee link).
 * - Approval creates the member, the wallets, the guardian links and the enrolment in one
 *   transaction with the application's change (FR-ADM-09); a rejection keeps the reason (RC-21).
 * - The identity number is only its last 6 digits (Q16 e), encrypted, with a blind index scoped to
 *   the institution for resume; the last 4 are shown.
 */
import { createHash } from 'node:crypto';
import type { MessageSender } from '../integrations/sms.provider';
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS, renderMessage, type MessageKey } from '../config/registers';
import type {
  GatewayOrder,
  GatewayPayment,
  PaymentGateway,
} from '../integrations/payment-gateway.provider';
import { ipToBin } from '../utils/ip';
import type { PaymentGatewaysService } from './payment-gateways.service';
import type {
  AdmissionDocType,
  AdmissionFeeType,
  ApplicationStatus,
  Database,
} from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  SECTIONS,
  type ApplicationInput,
  type SectionName,
  addressesSectionSchema,
  parentsSectionSchema,
  previousSectionSchema,
} from '../schemas/admissions.schema';
import {
  BadRequestError,
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { parseCsv, toCsv } from '../utils/csv';
import type { FieldCipher } from '../utils/fieldEncryption';
import type { FlowTokens } from '../utils/flow-tokens';
import { formatDate, formatDateTime, formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import { PdfDocument, rupeesInWords } from '../utils/pdf';
import type { Principal } from '../utils/principal';
import type { FieldError } from '../utils/validators';
import { PATTERNS } from '../utils/validators';
import type { AdmissionLinksService } from './admission-links.service';
import { classOrder } from './admission-links.service';
import { recordAudit } from './audit.service';
import { activeFields, parseValues } from './custom-values.service';
import type { FileService } from './file.service';
import type { MembersService, OnboardInput } from './members.service';
import type { OtpService } from './otp.service';
import { defaultValues, type SettingValues } from './settings.service';
import type { z } from 'zod';

type Db = Kysely<Database> | Transaction<Database>;
type Addresses = z.infer<typeof addressesSectionSchema>;
type Parents = z.infer<typeof parentsSectionSchema>;
type Previous = z.infer<typeof previousSectionSchema>;

/** The form beyond the searchable columns, kept as one document. */
interface StoredData {
  student?: {
    category?: string | null;
    medium?: string | null;
    bloodGroup?: string | null;
    allergies?: string | null;
    health?: string | null;
  };
  addresses?: Addresses;
  previous?: Previous;
  parents?: Parents;
  customFields?: Record<string, unknown>;
  midTermReason?: string | null;
}

interface State {
  yearRowId: string;
  classRowId: string | null;
  joiningDate: string | null;
  midTerm: boolean;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  dob: string | null;
  idNumber?: string | null;
  primaryName: string | null;
  primaryRelation: 'FATHER' | 'MOTHER' | 'GUARDIAN' | null;
  primaryMobile: string | null;
  primaryEmail: string | null;
  data: StoredData;
  step: number;
}

const ADMISSION_HEADER = 'X-Admission-Token';
/** Stands in for the mobile in a resume token when nothing matched (never a valid mobile). */
const RESUME_DECOY = '0000000000';
const day = (d: Date | string) =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : istBusinessDate(new Date(d));
const dayOrNull = (d: Date | string | null | undefined) => (d ? day(d) : null);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const title = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const fullName = (...parts: (string | null | undefined)[]) =>
  title(parts.filter(Boolean).join(' '));
const maskName = (n: string) =>
  n.trim()
    ? n
        .trim()
        .split(/\s+/)
        .map((w) => w[0]!.toUpperCase() + '•'.repeat(Math.max(2, Math.min(6, w.length - 1))))
        .join(' ')
    : 'Name not entered yet';
const maskMobile = (m: string | null) => (m ? `+91 ••••• •••${m.slice(-2)}` : null);
const splitName = (n: string) => {
  const w = n.trim().split(/\s+/);
  return w.length > 1
    ? { firstName: w.slice(0, -1).join(' '), lastName: w.at(-1)! }
    : { firstName: w[0]!, lastName: null };
};
const ageOn = (dob: string, ref: string) => {
  const [y1, m1, d1] = dob.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = ref.split('-').map(Number) as [number, number, number];
  let y = y2 - y1;
  if (m2 < m1 || (m2 === m1 && d2 < d1)) y--;
  return y;
};

export class AdmissionsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cipher: FieldCipher;
      readonly files: FileService;
      readonly members: MembersService;
      readonly otp: OtpService;
      readonly flows: FlowTokens;
      readonly links: AdmissionLinksService;
      /** RingPe's own gateway (PAYMENT_GATEWAY_MODE), or the test checkout. */
      readonly gateway: PaymentGateway;
      /** Each school's own gateways (client 2026-10-09). */
      readonly gateways?: PaymentGatewaysService;
      readonly webUrl: string;
      /** The family's notices (logged senders: every send is in the communication log). */
      readonly sms?: MessageSender;
      readonly email?: MessageSender;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  static readonly TOKEN_HEADER = ADMISSION_HEADER;

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  private async consoleInst(p: Principal, db: Db = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(
      db as Kysely<Database>,
      uuidToBin(p.institutionId),
      lock,
    );
    if (!i) throw new NotFoundError();
    return i;
  }

  private by(p?: Principal) {
    return p && isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- identifiers -------------------------------------------------------------------------------------
  /** The application-number prefix (Q24): the short name's letters, else the name's initials. */
  private prefixOf(i: { name: string; short_name: string | null }) {
    const short = (i.short_name ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (short.length >= 2) return short.slice(0, 5);
    const words = i.name.split(/\s+/).filter(Boolean);
    const p = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'APP').slice(0, 3);
    return p
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 5)
      .padEnd(2, 'X');
  }

  /** `<prefix>/<yyyy>/<6 digits>`, numbered per institution and year (FR-ADM-06, Q24). */
  private async nextNo(
    trx: Transaction<Database>,
    institutionId: string,
    prefix: string,
    yyyy: number,
  ) {
    await sql`INSERT INTO admission_application_seq (institution_id, year_number, last_no)
              VALUES (${institutionId}, ${yyyy}, LAST_INSERT_ID(1))
              ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)`.execute(trx);
    const r = await sql<{ n: number }>`SELECT LAST_INSERT_ID() AS n`.execute(trx);
    return `${prefix}/${yyyy}/${String(Number(r.rows[0]?.n ?? 1)).padStart(6, '0')}`;
  }

  private idFields(institutionId: string, appPublicId: string, value: string | null) {
    if (!value) return { id_number_enc: null, id_number_bidx: null, id_number_last4: null };
    return {
      id_number_enc: this.deps.cipher.encrypt('adm_id_number', value, appPublicId),
      id_number_bidx: this.idIndex(institutionId, value),
      id_number_last4: value.slice(-4),
    };
  }

  private idIndex(institutionId: string, value: string) {
    return this.deps.cipher.blindIndex('adm_id_number', `${institutionId}:${value}`);
  }

  // --- reading -----------------------------------------------------------------------------------------
  private rows(db: Db) {
    return db
      .selectFrom('admission_applications as a')
      .innerJoin('academic_years as y', 'y.id', 'a.year_id')
      .leftJoin('classes as c', 'c.id', 'a.class_id')
      .leftJoin('sections as s', 's.id', 'a.section_id')
      .leftJoin('member_profiles as m', 'm.id', 'a.member_profile_id')
      .selectAll('a')
      .select([
        'y.public_id as year_public_id',
        'y.label as year_label',
        'y.starts_on as year_starts_on',
        'y.ends_on as year_ends_on',
        'c.public_id as class_public_id',
        'c.name as class_name',
        's.public_id as section_public_id',
        's.name as section_name',
        'm.public_id as member_public_id',
      ]);
  }

  private dataOf(r: { data: unknown }): StoredData {
    const d = typeof r.data === 'string' ? (JSON.parse(r.data) as unknown) : r.data;
    return (d && typeof d === 'object' ? d : {}) as StoredData;
  }

  private async view(
    r: Awaited<ReturnType<ReturnType<AdmissionsService['rows']>['execute']>>[number],
    opts: { console: boolean; p?: Principal },
  ) {
    const data = this.dataOf(r);
    const [refs, docs, fees] = await Promise.all([
      this.deps.db
        .selectFrom('admission_references')
        .select(['public_id', 'name', 'relation', 'mobile', 'email', 'created_at'])
        .where('application_id', '=', r.id)
        .orderBy('id')
        .execute(),
      this.deps.db
        .selectFrom('admission_documents as d')
        .innerJoin('files as f', 'f.id', 'd.file_id')
        .select([
          'd.doc_type',
          'd.added_at',
          'f.public_id',
          'f.original_name',
          'f.size_bytes',
          'f.mime_type',
        ])
        .where('d.application_id', '=', r.id)
        .orderBy('d.doc_type')
        .execute(),
      this.deps.db
        .selectFrom('admission_payments')
        .selectAll()
        .where('application_id', '=', r.id)
        .orderBy('fee_type')
        .execute(),
    ]);
    const band = r.class_name ? await this.deps.links.band(r.class_name) : null;
    const ref = this.ageReference(r);
    const age = r.dob && ref ? ageOn(day(r.dob), ref) : null;
    return {
      id: binToUuid(r.public_id),
      applicationNo: r.application_no,
      source: r.source,
      status: r.status,
      step: r.step,
      year: { id: binToUuid(r.year_public_id), label: r.year_label },
      class: r.class_public_id ? { id: binToUuid(r.class_public_id), name: r.class_name! } : null,
      section: r.section_public_id
        ? { id: binToUuid(r.section_public_id), name: r.section_name! }
        : null,
      midTerm: !!Number(r.mid_term),
      joiningDate: dayOrNull(r.joining_date),
      midTermReason: data.midTermReason ?? null,
      student: {
        firstName: r.first_name,
        middleName: r.middle_name,
        lastName: r.last_name,
        gender: r.gender,
        dob: dayOrNull(r.dob),
        idNumber: r.id_number_last4 ? `••${r.id_number_last4}` : null,
        ...data.student,
      },
      age:
        age !== null
          ? {
              years: age,
              on: ref,
              band,
              withinBand: band ? age >= band.min && age <= band.max : null,
            }
          : null,
      addresses: data.addresses ?? null,
      previous: data.previous ?? null,
      parents: data.parents ?? null,
      primaryContact: {
        name: r.primary_name,
        relation: r.primary_relation,
        mobile: r.primary_mobile,
        email: r.primary_email,
      },
      customFields: data.customFields ?? {},
      tc: r.tc_mode
        ? {
            mode: r.tc_mode,
            number: r.tc_number,
            date: dayOrNull(r.tc_date),
            dueDate: dayOrNull(r.tc_due),
          }
        : null,
      references: refs.map((x) => ({
        id: binToUuid(x.public_id),
        name: x.name,
        relation: x.relation,
        mobile: x.mobile,
        email: x.email,
      })),
      documents: await Promise.all(
        docs.map(async (d) => ({
          type: d.doc_type,
          name: d.original_name,
          sizeBytes: d.size_bytes,
          mimeType: d.mime_type,
          addedAt: iso(d.added_at),
          url:
            opts.console && opts.p
              ? (await this.deps.files.signedUrl(opts.p, binToUuid(d.public_id))).url
              : null,
        })),
      ),
      fees: fees.map((f) => ({
        id: binToUuid(f.public_id),
        feeType: f.fee_type,
        amount: toMoneyDto(Number(f.amount_paise)),
        status: f.status,
        mode: f.mode,
        receiptNo: f.receipt_no,
        paidAt: iso(f.paid_at),
        paidBy: opts.console ? f.paid_by : null,
        failureReason: f.failure_reason,
      })),
      declaration: r.declared_at ? { at: iso(r.declared_at), by: r.declared_by } : null,
      submittedAt: iso(r.submitted_at),
      decidedAt: iso(r.decided_at),
      rejection: r.rejection_reason
        ? { reasonCode: r.rejection_reason, remarks: r.rejection_remarks }
        : null,
      admissionNo: r.admission_no,
      memberId: opts.console && r.member_public_id ? binToUuid(r.member_public_id) : null,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      version: r.row_version,
    };
  }

  /** Age is measured on 1 June of the year's start, or on the joining date mid-term (OI-ADM-23). */
  private ageReference(r: {
    mid_term: number;
    joining_date: Date | string | null;
    year_starts_on: Date | string;
  }) {
    if (Number(r.mid_term) && r.joining_date) return day(r.joining_date);
    return `${day(r.year_starts_on).slice(0, 4)}-06-01`;
  }

  // --- building a draft --------------------------------------------------------------------------------
  /** Checks the year (open for admission) and the joining date; tells whether it is mid-term. */
  private async yearFor(db: Db, institutionId: string, yearId: string, joining: string | null) {
    if (!isUuid(yearId)) throw new CustomAPIError(422, 'ADM.YEAR_NOT_OPEN');
    const y = await db
      .selectFrom('academic_years')
      .select(['id', 'label', 'starts_on', 'ends_on', 'status'])
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(yearId))
      .executeTakeFirst();
    const today = istBusinessDate(this.now());
    if (!y || y.status !== 'OPEN' || day(y.ends_on) < today) {
      throw new CustomAPIError(422, 'ADM.YEAR_NOT_OPEN');
    }
    const from = day(y.starts_on);
    const to = day(y.ends_on);
    const started = from <= today;
    const bad = () =>
      new CustomAPIError(422, 'ADM.JOINING_DATE', { params: { to: formatDate(to) } });
    if (started) {
      if (!joining || joining < today || joining > to) throw bad();
    } else if (joining && (joining < from || joining > to)) {
      throw bad();
    }
    return { rowId: String(y.id), label: y.label, midTerm: started, joining };
  }

  private async classFor(db: Db, institutionId: string, classId: string) {
    if (!isUuid(classId)) throw new CustomAPIError(422, 'ADM.CLASS_INVALID');
    const c = await db
      .selectFrom('classes')
      .select(['id', 'name'])
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(classId))
      .executeTakeFirst();
    if (!c) throw new CustomAPIError(422, 'ADM.CLASS_INVALID');
    return { rowId: String(c.id), name: c.name };
  }

  /** Applies one section to the working state (a section replaces its earlier answer). */
  private async apply(db: Db, institutionId: string, s: State, section: SectionName, raw: unknown) {
    switch (section) {
      case 'class': {
        const v = SECTIONS.class.parse(raw);
        const y = await this.yearFor(db, institutionId, v.yearId, v.joiningDate ?? null);
        const c = await this.classFor(db, institutionId, v.classId);
        s.yearRowId = y.rowId;
        s.classRowId = c.rowId;
        s.joiningDate = y.joining;
        s.midTerm = y.midTerm;
        s.data.midTermReason = v.midTermReason ?? null;
        return;
      }
      case 'student': {
        const v = SECTIONS.student.parse(raw);
        s.firstName = v.firstName;
        s.middleName = v.middleName ?? null;
        s.lastName = v.lastName;
        s.gender = v.gender;
        s.dob = v.dob;
        if (v.dob > istBusinessDate(this.now())) {
          throw new ValidationError([{ field: 'student.dob', code: 'VALIDATION.DATE' }]);
        }
        if (v.idNumber !== undefined) s.idNumber = v.idNumber ?? null;
        s.data.student = {
          category: v.category ?? null,
          medium: v.medium ?? null,
          bloodGroup: v.bloodGroup ?? null,
          allergies: v.allergies ?? null,
          health: v.health ?? null,
        };
        return;
      }
      case 'addresses':
        s.data.addresses = SECTIONS.addresses.parse(raw);
        return;
      case 'previous':
        s.data.previous = SECTIONS.previous.parse(raw);
        return;
      case 'parents': {
        const v = SECTIONS.parents.parse(raw);
        const primary =
          v.primary === 'FATHER' ? v.father : v.primary === 'MOTHER' ? v.mother : v.guardian;
        if (!primary) {
          throw new ValidationError([
            { field: `parents.${v.primary.toLowerCase()}`, code: 'VALIDATION.REQUIRED' },
          ]);
        }
        s.data.parents = v;
        s.primaryName = primary.name;
        s.primaryRelation = v.primary;
        s.primaryMobile = primary.mobile ?? null;
        s.primaryEmail = primary.email ?? null;
        return;
      }
      case 'customFields': {
        const v = SECTIONS.customFields.parse(raw);
        const fields = await activeFields(db, institutionId, 'ADMISSION_APPLICATION');
        const { errors } = parseValues(fields, v, { partial: true });
        if (errors.length) throw new ValidationError(errors);
        s.data.customFields = v;
        return;
      }
    }
  }

  /** The partial student section of a new application, applied field by field. */
  private applyPartialStudent(s: State, v: NonNullable<ApplicationInput['student']>) {
    s.firstName = v.firstName ?? null;
    s.middleName = v.middleName ?? null;
    s.lastName = v.lastName ?? null;
    s.gender = v.gender ?? null;
    s.dob = v.dob ?? null;
    s.idNumber = v.idNumber ?? null;
    s.data.student = {
      category: v.category ?? null,
      medium: v.medium ?? null,
      bloodGroup: v.bloodGroup ?? null,
      allergies: v.allergies ?? null,
      health: v.health ?? null,
    };
  }

  private columns(s: State) {
    return {
      year_id: s.yearRowId,
      class_id: s.classRowId,
      joining_date: s.joiningDate,
      mid_term: s.midTerm ? 1 : 0,
      first_name: s.firstName,
      middle_name: s.middleName,
      last_name: s.lastName,
      gender: s.gender,
      dob: s.dob,
      primary_name: s.primaryName,
      primary_relation: s.primaryRelation,
      primary_mobile: s.primaryMobile,
      primary_email: s.primaryEmail,
      data: JSON.stringify(s.data),
      step: s.step,
    };
  }

  private stateOf(r: {
    year_id: string;
    class_id: string | null;
    joining_date: Date | string | null;
    mid_term: number;
    first_name: string | null;
    middle_name: string | null;
    last_name: string | null;
    gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
    dob: Date | string | null;
    primary_name: string | null;
    primary_relation: 'FATHER' | 'MOTHER' | 'GUARDIAN' | null;
    primary_mobile: string | null;
    primary_email: string | null;
    data: unknown;
    step: number;
  }): State {
    return {
      yearRowId: String(r.year_id),
      classRowId: r.class_id ? String(r.class_id) : null,
      joiningDate: dayOrNull(r.joining_date),
      midTerm: !!Number(r.mid_term),
      firstName: r.first_name,
      middleName: r.middle_name,
      lastName: r.last_name,
      gender: r.gender,
      dob: dayOrNull(r.dob),
      primaryName: r.primary_name,
      primaryRelation: r.primary_relation,
      primaryMobile: r.primary_mobile,
      primaryEmail: r.primary_email,
      data: this.dataOf(r),
      step: r.step,
    };
  }

  /** One application of this child and year is enough (OI-ADM-02): identity digits + birth date. */
  private async duplicate(db: Db, institutionId: string, s: State, exceptRowId?: string) {
    if (!s.idNumber || !s.dob) return;
    let q = db
      .selectFrom('admission_applications as a')
      .innerJoin('academic_years as y', 'y.id', 'a.year_id')
      .select(['a.id', 'y.label'])
      .where('a.institution_id', '=', institutionId)
      .where('a.year_id', '=', s.yearRowId)
      .where('a.id_number_bidx', '=', this.idIndex(institutionId, s.idNumber))
      .where('a.dob', '=', s.dob)
      .where('a.status', '<>', 'REJECTED');
    if (exceptRowId) q = q.where('a.id', '<>', exceptRowId);
    const d = await q.executeTakeFirst();
    if (d) throw new CustomAPIError(409, 'ADM.DUPLICATE', { params: { year: d.label } });
  }

  /** Creates a draft (public form or counsellor). */
  private async createDraft(
    institutionId: string,
    input: ApplicationInput,
    source: 'PUBLIC' | 'COUNSELLOR',
    by: Buffer | null,
  ) {
    const s: State = {
      yearRowId: '',
      classRowId: null,
      joiningDate: null,
      midTerm: false,
      firstName: null,
      middleName: null,
      lastName: null,
      gender: null,
      dob: null,
      idNumber: null,
      primaryName: null,
      primaryRelation: null,
      primaryMobile: null,
      primaryEmail: null,
      data: {},
      step: input.step ?? 0,
    };
    const db = this.deps.db;
    await this.apply(db, institutionId, s, 'class', input.class);
    if (input.student) this.applyPartialStudent(s, input.student);
    if (s.dob && s.dob > istBusinessDate(this.now())) {
      throw new ValidationError([{ field: 'student.dob', code: 'VALIDATION.DATE' }]);
    }
    for (const k of ['addresses', 'previous', 'parents', 'customFields'] as const) {
      if (input[k] !== undefined) await this.apply(db, institutionId, s, k, input[k]);
    }
    await this.duplicate(db, institutionId, s);
    const pub = newPublicIdPair();
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await trx
        .selectFrom('institutions')
        .select(['id', 'name', 'short_name'])
        .where('id', '=', institutionId)
        .executeTakeFirstOrThrow();
      const y = await trx
        .selectFrom('academic_years')
        .select('starts_on')
        .where('id', '=', s.yearRowId)
        .executeTakeFirstOrThrow();
      const no = await this.nextNo(
        trx,
        institutionId,
        this.prefixOf(inst),
        Number(day(y.starts_on).slice(0, 4)),
      );
      await trx
        .insertInto('admission_applications')
        .values({
          public_id: pub.bin,
          institution_id: institutionId,
          application_no: no,
          source,
          ...this.columns(s),
          ...this.idFields(institutionId, pub.id, s.idNumber ?? null),
          created_by: by,
          created_at: at,
          updated_at: at,
        })
        .execute();
      await recordAudit(trx, {
        institutionId,
        action: 'ADMISSION_APPLICATION_STARTED',
        entityType: 'admission_application',
        entityRef: pub.id,
        after: { applicationNo: no, source },
      });
    });
    return pub.id;
  }

  /** Updates one section of a Draft (or, for the counsellor, a Submitted application). */
  private async updateSection(
    institutionId: string,
    id: string,
    expected: number | null,
    input: { section: SectionName; data: unknown; step?: number | undefined },
    allowed: readonly ApplicationStatus[],
  ) {
    const r = await this.lockless(institutionId, id);
    if (!allowed.includes(r.status)) {
      throw new CustomAPIError(
        409,
        r.status === 'SUBMITTED' ? 'ADM.NOT_DRAFT' : 'ADM.NOT_EDITABLE',
      );
    }
    if (expected !== null && r.row_version !== expected) throw new PreconditionFailedError();
    const s = this.stateOf(r);
    await this.apply(this.deps.db, institutionId, s, input.section, input.data);
    if (input.step !== undefined) s.step = Math.max(s.step, input.step);
    if (input.section === 'student' || input.section === 'class') {
      await this.duplicate(this.deps.db, institutionId, s, String(r.id));
    }
    const res = await this.deps.db
      .updateTable('admission_applications')
      .set({
        ...this.columns(s),
        ...(s.idNumber !== undefined
          ? this.idFields(institutionId, binToUuid(r.public_id), s.idNumber)
          : {}),
        updated_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', r.id)
      .where('row_version', '=', r.row_version)
      .where('status', 'in', [...allowed])
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
  }

  private async lockless(institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ADM.NOT_FOUND');
    const r = await this.rows(this.deps.db)
      .where('a.institution_id', '=', institutionId)
      .where('a.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'ADM.NOT_FOUND');
    return r;
  }

  // --- the family's notices ---------------------------------------------------------------------------
  /** SMS and e-mail as the platform and the school have them on (BR-70). */
  private async familyChannels(institutionId: string) {
    const [platform, school] = await Promise.all([
      this.deps.db.selectFrom('messaging_channels').select(['channel', 'enabled']).execute(),
      this.deps.db
        .selectFrom('notification_channel_settings')
        .select(['channel', 'enabled'])
        .where('institution_id', '=', institutionId)
        .execute(),
    ]);
    const on = (c: string) =>
      !!Number(platform.find((x) => x.channel === c)?.enabled ?? 0) &&
      !!Number(school.find((x) => x.channel === c)?.enabled ?? 0);
    return { sms: on('SMS'), email: on('EMAIL') };
  }

  /**
   * Tells the family that the application was received, approved or not approved — by SMS to the
   * primary mobile and e-mail to the primary e-mail, through the channels the school has on; each
   * send is in the communication log. The reason for a rejection stays with the school. A failed
   * send never undoes the action.
   */
  private async tellFamily(
    institutionId: string,
    id: string,
    event: 'SUBMITTED' | 'APPROVED' | 'REJECTED',
  ) {
    try {
      const r = await this.lockless(institutionId, id);
      const inst = await this.deps.db
        .selectFrom('institutions')
        .select('name')
        .where('id', '=', institutionId)
        .executeTakeFirst();
      const school = inst?.name ?? 'The school';
      const child = fullName(r.first_name, r.last_name) || 'your child';
      const no = r.application_no;
      const text =
        event === 'SUBMITTED'
          ? `${school}: we have received application ${no} for ${child}${r.class_name ? ` (${r.class_name})` : ''}. We will let you know when it has been reviewed.`
          : event === 'APPROVED'
            ? `${school}: application ${no} for ${child} is approved${r.admission_no ? `, admission number ${r.admission_no}` : ''}. The school will contact you about the next steps.`
            : `${school}: application ${no} for ${child} was not approved. Please contact the school office for details.`;
      const subject =
        event === 'SUBMITTED'
          ? 'Application received'
          : event === 'APPROVED'
            ? 'Application approved'
            : 'Application not approved';
      const log = {
        institutionId,
        kind: 'TRANSACTIONAL' as const,
        subject,
        refType: 'admission_application',
        refId: id,
      };
      const purpose = `admission.${event.toLowerCase()}`;
      const channels = await this.familyChannels(institutionId);
      const sends: Promise<void>[] = [];
      if (channels.sms && r.primary_mobile && this.deps.sms) {
        sends.push(this.deps.sms.send({ to: r.primary_mobile, purpose, text, log }));
      }
      if (channels.email && r.primary_email && this.deps.email) {
        sends.push(this.deps.email.send({ to: r.primary_email, purpose, text, log }));
      }
      await Promise.allSettled(sends);
    } catch {
      // The notice is best effort: the communication log records any failed send.
    }
  }

  // --- public: tokens ----------------------------------------------------------------------------------
  private async resumeToken(institutionPublicId: string, appIds: readonly string[]) {
    const minutes = await this.limit(LIMITS.admResumeMinutes);
    return this.deps.flows.issue(
      'admission-resume',
      { inst: institutionPublicId, apps: appIds.join(',') },
      minutes * 60,
    );
  }

  /**
   * The application a public caller may act on: a resume token listing it, or a payment link for it
   * (payments only). Anything else is a 404, so ids can't be probed.
   */
  private async access(id: string, token: string | undefined, purpose: 'edit' | 'pay' | 'read') {
    if (!isUuid(id) || !token) throw new CustomAPIError(404, 'ADM.NOT_FOUND');
    const resume = await this.deps.flows.verify('admission-resume', token);
    const pay = resume ? undefined : await this.deps.flows.verify('admission-pay', token);
    const claims = resume ?? pay;
    const ok =
      (resume &&
        String(resume['apps'] ?? '')
          .split(',')
          .includes(id.toLowerCase())) ||
      (pay && purpose !== 'edit' && String(pay['app'] ?? '') === id.toLowerCase());
    if (!claims || !ok || !isUuid(String(claims['inst']))) {
      throw new CustomAPIError(404, 'ADM.NOT_FOUND');
    }
    const inst = await institutionsRepository.byPublicId(
      this.deps.db,
      uuidToBin(String(claims['inst'])),
    );
    if (!inst) throw new CustomAPIError(404, 'ADM.NOT_FOUND');
    const r = await this.lockless(inst.id, id);
    return {
      inst,
      row: r,
      scope: resume ? ('resume' as const) : ('pay' as const),
      fee: pay ? (String(pay['fee']) as AdmissionFeeType) : null,
    };
  }

  // --- ADM-002 / ADM-003 -----------------------------------------------------------------------------
  /**
   * Resume: the identity digits or the mobile; a code goes to the mobile on the application. The
   * answer looks the same whether or not anything matched (enumeration-safe).
   */
  async resumeAsk(
    linkToken: string,
    input: { identityNumber?: string | undefined; mobile?: string | undefined },
  ) {
    const c = await this.deps.links.context(linkToken);
    if (!input.identityNumber && !input.mobile) throw new CustomAPIError(422, 'ADM.RESUME_NEEDS');
    let q = this.deps.db
      .selectFrom('admission_applications')
      .select(['primary_mobile'])
      .where('institution_id', '=', c.institutionId)
      .where('primary_mobile', 'is not', null);
    q = input.identityNumber
      ? q.where('id_number_bidx', '=', this.idIndex(c.institutionId, input.identityNumber))
      : q.where('primary_mobile', '=', input.mobile!);
    const hit = await q.orderBy('id', 'desc').executeTakeFirst();
    const mobile = hit?.primary_mobile ?? null;
    let challengeId: string = newPublicIdPair().id;
    let testCode: string | undefined;
    if (mobile) {
      const issued = await this.deps.otp.issue({
        purpose: 'ADMISSION_RESUME',
        channel: 'SMS',
        destination: mobile,
        institutionId: c.institutionId,
        contextHash: this.otpContext(c.institutionId),
        reuseLive: true,
      });
      challengeId = issued.challengeId;
      testCode = issued.testCode;
    }
    // The token carries the matched mobile encrypted, at the same length whether or not anything
    // matched (a decoy number otherwise): it reveals neither the parent's mobile nor existence.
    const sealed = this.deps.cipher
      .encrypt(
        'adm_resume',
        JSON.stringify({
          m: mobile ?? RESUME_DECOY,
          b: input.identityNumber
            ? this.idIndex(c.institutionId, input.identityNumber).toString('hex')
            : '',
        }),
        c.institutionPublicId,
      )
      .toString('base64url');
    const request = await this.deps.flows.issue(
      'admission-otp',
      { inst: c.institutionPublicId, s: sealed },
      600,
    );
    return {
      challengeId,
      requestToken: request.token,
      sentTo: input.mobile ? maskMobile(input.mobile) : 'the mobile number on the application',
      ...(testCode ? { testCode } : {}),
    };
  }

  private otpContext(institutionId: string) {
    return createHash('sha256').update(`admission-resume:${institutionId}`).digest();
  }

  async resumeVerify(
    linkToken: string,
    input: { challengeId: string; requestToken: string; otp: string },
  ) {
    const c = await this.deps.links.context(linkToken);
    const claims = await this.deps.flows.verify('admission-otp', input.requestToken);
    if (!claims || claims['inst'] !== c.institutionPublicId || typeof claims['s'] !== 'string') {
      throw new BadRequestError('AUTH.OTP_INVALID');
    }
    await this.deps.otp.verify(input.challengeId, input.otp, 'ADMISSION_RESUME', {
      contextHash: this.otpContext(c.institutionId),
    });
    let sealed: { m: string; b: string };
    try {
      sealed = JSON.parse(
        this.deps.cipher.decrypt(
          'adm_resume',
          Buffer.from(claims['s'], 'base64url'),
          c.institutionPublicId,
        ),
      ) as { m: string; b: string };
    } catch {
      throw new BadRequestError('AUTH.OTP_INVALID');
    }
    if (!sealed.m || sealed.m === RESUME_DECOY) throw new BadRequestError('AUTH.OTP_INVALID');
    let q = this.rows(this.deps.db)
      .where('a.institution_id', '=', c.institutionId)
      .where('a.primary_mobile', '=', sealed.m);
    if (sealed.b) {
      q = q.where('a.id_number_bidx', '=', Buffer.from(sealed.b, 'hex'));
    }
    const rows = await q.orderBy('a.id', 'desc').limit(20).execute();
    const token = await this.resumeToken(
      c.institutionPublicId,
      rows.map((r) => binToUuid(r.public_id)),
    );
    return {
      applications: rows.map((r) => ({
        id: binToUuid(r.public_id),
        applicationNo: r.application_no,
        status: r.status,
        name: maskName(fullName(r.first_name, r.last_name)),
        classApplied: r.class_name,
        year: r.year_label,
        midTerm: !!Number(r.mid_term),
        step: r.step,
        updatedAt: iso(r.updated_at),
      })),
      resumeToken: token.token,
      expiresAt: token.expiresAt.toISOString(),
    };
  }

  // --- ADM-004 / ADM-025 / ADM-005 --------------------------------------------------------------------
  async publicCreate(linkToken: string, input: ApplicationInput) {
    const c = await this.deps.links.context(linkToken);
    const id = await this.createDraft(c.institutionId, input, 'PUBLIC', null);
    const token = await this.resumeToken(c.institutionPublicId, [id]);
    const r = await this.lockless(c.institutionId, id);
    return {
      application: await this.view(r, { console: false }),
      resumeToken: token.token,
      expiresAt: token.expiresAt.toISOString(),
    };
  }

  async publicRead(id: string, token: string | undefined) {
    const a = await this.access(id, token, 'read');
    const v = await this.view(a.row, { console: false });
    if (a.scope === 'resume') return v;
    // A payment link sees what the checkout shows, not the family's details.
    return {
      id: v.id,
      applicationNo: v.applicationNo,
      status: v.status,
      year: v.year,
      class: v.class,
      student: { name: maskName(fullName(v.student.firstName, v.student.lastName)) },
      fees: v.fees,
      version: v.version,
    };
  }

  async publicUpdate(
    id: string,
    token: string | undefined,
    expected: number | null,
    input: { section: SectionName; data: unknown; step?: number | undefined },
  ) {
    const a = await this.access(id, token, 'edit');
    await this.updateSection(a.inst.id, id, expected, input, ['DRAFT']);
    return this.view(await this.lockless(a.inst.id, id), { console: false });
  }

  // --- documents and references (ADM-006…008; console ADM-026…028) ------------------------------------
  private async addDocument(
    institutionId: string,
    institutionPublicId: string,
    r: { id: string; public_id: Buffer },
    input: { docType: AdmissionDocType; fileName: string; data: Buffer },
    by: Principal | null,
  ) {
    const stored = await this.deps.files.upload({
      principal: by ?? {
        subject: binToUuid(r.public_id),
        surface: 'member',
        sessionId: 'admission',
        institutionId: institutionPublicId,
        subTasks: [],
      },
      purpose: input.docType === 'PHOTO' ? 'photo' : 'document',
      originalName: input.fileName,
      data: input.data,
    });
    const file = await this.deps.db
      .selectFrom('files')
      .select('id')
      .where('public_id', '=', uuidToBin(stored.fileId))
      .executeTakeFirstOrThrow();
    await this.deps.db
      .insertInto('admission_documents')
      .values({
        application_id: r.id,
        doc_type: input.docType,
        file_id: String(file.id),
        added_at: this.now(),
      })
      .onDuplicateKeyUpdate({ file_id: String(file.id), added_at: this.now() })
      .execute();
    await this.touch(r.id);
    void institutionId;
  }

  private async touch(rowId: string) {
    await this.deps.db
      .updateTable('admission_applications')
      .set({ updated_at: this.now(), row_version: sql<number>`row_version + 1` })
      .where('id', '=', rowId)
      .execute();
  }

  private async addReference(
    r: { id: string },
    input: {
      name: string;
      relation?: string | null | undefined;
      mobile: string;
      email?: string | null | undefined;
    },
  ) {
    const max = await this.limit(LIMITS.admReferencesMax);
    const n = await this.deps.db
      .selectFrom('admission_references')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('application_id', '=', r.id)
      .executeTakeFirst();
    if (Number(n?.n ?? 0) >= max) {
      throw new CustomAPIError(422, 'ADM.REFERENCE_LIMIT', { params: { max } });
    }
    const pub = newPublicIdPair();
    await this.deps.db
      .insertInto('admission_references')
      .values({
        public_id: pub.bin,
        application_id: r.id,
        name: title(input.name),
        relation: input.relation?.trim() || null,
        mobile: input.mobile,
        email: input.email ?? null,
        created_at: this.now(),
      })
      .execute();
    await this.touch(r.id);
    return pub.id;
  }

  private async removeReference(
    r: { id: string; mid_term: number; status: ApplicationStatus },
    refId: string,
  ) {
    if (!isUuid(refId)) throw new NotFoundError();
    const ref = await this.deps.db
      .selectFrom('admission_references')
      .select('id')
      .where('application_id', '=', r.id)
      .where('public_id', '=', uuidToBin(refId))
      .executeTakeFirst();
    if (!ref) throw new NotFoundError();
    if (Number(r.mid_term) && r.status === 'SUBMITTED') {
      const n = await this.deps.db
        .selectFrom('admission_references')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('application_id', '=', r.id)
        .executeTakeFirst();
      if (Number(n?.n ?? 0) <= 1) throw new CustomAPIError(409, 'ADM.REFERENCE_MINIMUM');
    }
    await this.deps.db.deleteFrom('admission_references').where('id', '=', ref.id).execute();
    await this.touch(r.id);
  }

  async publicDocument(
    id: string,
    token: string | undefined,
    input: { docType: AdmissionDocType; fileName: string; data: Buffer },
  ) {
    const a = await this.access(id, token, 'edit');
    if (a.row.status !== 'DRAFT') throw new CustomAPIError(409, 'ADM.NOT_DRAFT');
    await this.addDocument(a.inst.id, binToUuid(a.inst.public_id), a.row, input, null);
    return this.view(await this.lockless(a.inst.id, id), { console: false });
  }

  async publicAddReference(
    id: string,
    token: string | undefined,
    input: {
      name: string;
      relation?: string | null | undefined;
      mobile: string;
      email?: string | null | undefined;
    },
  ) {
    const a = await this.access(id, token, 'edit');
    if (a.row.status !== 'DRAFT') throw new CustomAPIError(409, 'ADM.NOT_DRAFT');
    await this.addReference(a.row, input);
    return this.view(await this.lockless(a.inst.id, id), { console: false });
  }

  async publicRemoveReference(id: string, token: string | undefined, refId: string) {
    const a = await this.access(id, token, 'edit');
    if (a.row.status !== 'DRAFT') throw new CustomAPIError(409, 'ADM.NOT_DRAFT');
    await this.removeReference(a.row, refId);
  }

  // --- submission (ADM-009) ------------------------------------------------------------------------------
  /** Everything a submitted application needs (FR-ADM-05, BR-50, CR-14). */
  private async completeness(r: Awaited<ReturnType<AdmissionsService['lockless']>>) {
    const errors: FieldError[] = [];
    const need = (ok: unknown, field: string, code: MessageKey = 'VALIDATION.REQUIRED') => {
      if (!ok) errors.push({ field, code });
    };
    const data = this.dataOf(r);
    need(r.class_id, 'class.classId');
    need(r.first_name, 'student.firstName');
    need(r.last_name, 'student.lastName');
    need(r.gender, 'student.gender');
    need(r.dob, 'student.dob');
    need(data.addresses?.residential, 'addresses.residential');
    need(r.primary_name, 'parents.primary');
    need(r.primary_mobile, 'parents.primaryMobile', 'ADM.MOBILE_INVALID');
    const docs = await this.deps.db
      .selectFrom('admission_documents')
      .select('doc_type')
      .where('application_id', '=', r.id)
      .execute();
    const has = (t: AdmissionDocType) => docs.some((d) => d.doc_type === t);
    need(has('BIRTH'), 'documents.BIRTH');
    need(has('ADDRESS'), 'documents.ADDRESS');
    const order = r.class_name ? classOrder(r.class_name) : null;
    // Grade 1 and above bring the last report card (prototype p.form).
    if (order !== null && order >= 3) need(has('REPORT'), 'documents.REPORT');
    const fields = await activeFields(
      this.deps.db,
      String(r.institution_id),
      'ADMISSION_APPLICATION',
    );
    if (fields.length) {
      const parsed = parseValues(fields, data.customFields ?? {}, { partial: false });
      errors.push(...parsed.errors);
    }
    if (errors.length) throw new ValidationError(errors);
    // The age band (BR-50) on 1 June, or on the joining date mid-term (OI-ADM-23).
    if (r.class_name && r.dob) {
      const band = await this.deps.links.band(r.class_name);
      const ref = this.ageReference(r);
      const age = ageOn(day(r.dob), ref);
      if (band && age < band.min) {
        throw new CustomAPIError(422, 'ADM.AGE_TOO_LOW', {
          params: { n: band.min, standard: r.class_name, date: formatDate(ref) },
        });
      }
      if (band && age > band.max) {
        throw new CustomAPIError(422, 'ADM.AGE_TOO_HIGH', {
          params: { standard: r.class_name, n: band.max },
        });
      }
    }
    if (Number(r.mid_term)) await this.midTermReady(r, has('TC'));
  }

  /** Mid-term: a transfer certificate (or an undertaking with a date) and one reference (CR-14). */
  private async midTermReady(
    r: {
      id: string;
      tc_mode: string | null;
      tc_due: Date | string | null;
      tc_number: string | null;
    },
    hasTcDoc: boolean,
  ) {
    const tcOk =
      (r.tc_mode === 'TC' && (hasTcDoc || !!r.tc_number)) ||
      (r.tc_mode === 'UNDERTAKING' && !!r.tc_due) ||
      (!r.tc_mode && hasTcDoc);
    if (!tcOk) throw new CustomAPIError(422, 'ADM.TC_OR_UNDERTAKING_REQUIRED');
    const n = await this.deps.db
      .selectFrom('admission_references')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('application_id', '=', r.id)
      .executeTakeFirst();
    if (Number(n?.n ?? 0) < 1) throw new CustomAPIError(422, 'ADM.REFERENCES_REQUIRED');
  }

  private async entryFees(db: Db, institutionId: string, yearRowId: string) {
    return db
      .selectFrom('entry_fees')
      .select(['application_fee_paise', 'application_mandatory', 'admission_fee_paise'])
      .where('institution_id', '=', institutionId)
      .where('year_id', '=', yearRowId)
      .executeTakeFirst();
  }

  /** A fee row for the application, created when first needed (one per fee type). */
  private async feeRow(
    trx: Transaction<Database>,
    institutionId: string,
    appRowId: string,
    feeType: AdmissionFeeType,
    amountPaise: number,
  ) {
    const pub = newPublicIdPair();
    await trx
      .insertInto('admission_payments')
      .ignore()
      .values({
        public_id: pub.bin,
        institution_id: institutionId,
        application_id: appRowId,
        fee_type: feeType,
        amount_paise: amountPaise,
        created_at: this.now(),
        updated_at: this.now(),
      })
      .execute();
    return trx
      .selectFrom('admission_payments')
      .selectAll()
      .where('application_id', '=', appRowId)
      .where('fee_type', '=', feeType)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  private async submit(
    institutionId: string,
    id: string,
    input: { payLater?: boolean | undefined; declaredBy: string | null },
    by: Buffer | null,
  ) {
    const r = await this.lockless(institutionId, id);
    if (r.status !== 'DRAFT') throw new CustomAPIError(409, 'ADM.NOT_DRAFT');
    await this.completeness(r);
    const fees = await this.entryFees(this.deps.db, institutionId, String(r.year_id));
    if (!fees) throw new CustomAPIError(409, 'ADM.FEE_CONFIG_MISSING');
    const appFee = Number(fees.application_fee_paise);
    const mandatory = !!Number(fees.application_mandatory) && appFee > 0;
    if (mandatory && input.payLater) throw new CustomAPIError(409, 'ADM.FEE_REQUIRED');
    const at = this.now();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const cur = await trx
        .selectFrom('admission_applications')
        .select(['id', 'status', 'row_version'])
        .where('id', '=', r.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (cur.status !== 'DRAFT') throw new CustomAPIError(409, 'ADM.NOT_DRAFT');
      let paid = false;
      if (appFee > 0) {
        const f = await this.feeRow(trx, institutionId, r.id, 'APPLICATION', appFee);
        paid = f.status === 'PAID';
      }
      const submitNow = !mandatory || paid;
      await trx
        .updateTable('admission_applications')
        .set({
          declared_at: at,
          declared_by: input.declaredBy?.slice(0, 100) ?? null,
          step: 7,
          ...(submitNow ? { status: 'SUBMITTED' as const, submitted_at: at } : {}),
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', r.id)
        .where('status', '=', 'DRAFT')
        .execute();
      await recordAudit(trx, {
        institutionId,
        action: submitNow ? 'ADMISSION_APPLICATION_SUBMITTED' : 'ADMISSION_APPLICATION_DECLARED',
        entityType: 'admission_application',
        entityRef: id,
        after: { applicationNo: r.application_no, feeDue: submitNow ? null : appFee },
      });
      void by;
      return {
        status: submitNow ? ('SUBMITTED' as const) : ('DRAFT' as const),
        applicationNo: r.application_no,
        feeDue: !paid && appFee > 0 ? { ...toMoneyDto(appFee), mandatory } : null,
      };
    });
    if (out.status === 'SUBMITTED') await this.tellFamily(institutionId, id, 'SUBMITTED');
    return out;
  }

  async publicSubmit(
    id: string,
    token: string | undefined,
    input: { payLater?: boolean | undefined },
  ) {
    const a = await this.access(id, token, 'edit');
    return this.submit(a.inst.id, id, { ...input, declaredBy: a.row.primary_name }, null);
  }

  // --- payments (ADM-010 / ADM-011; ADM-022…024) -----------------------------------------------------
  /**
   * The next free generated receipt number of the year, from the payment row's id upwards: a number
   * already taken (a desk receipt typed in the same form, a seeded one) is skipped. The institution
   * row is locked first so two payments never take the same number.
   */
  private async receiptNo(
    trx: Transaction<Database>,
    institutionId: string,
    prefix: string,
    paidAt: Date,
    rowId: string,
  ) {
    await trx
      .selectFrom('institutions')
      .select('id')
      .where('id', '=', institutionId)
      .forUpdate()
      .execute();
    const base = `${prefix}/R/${istBusinessDate(paidAt).slice(0, 4)}/`;
    const taken = new Set(
      (
        await trx
          .selectFrom('admission_payments')
          .select('receipt_no')
          .where('institution_id', '=', institutionId)
          .where('receipt_no', 'like', `${base}%`)
          .execute()
      ).map((r) => r.receipt_no),
    );
    let n = Number(rowId);
    while (taken.has(`${base}${String(n).padStart(6, '0')}`)) n++;
    return `${base}${String(n).padStart(6, '0')}`;
  }

  /** Marks a fee paid; a paid application fee submits a declared Draft (BR-36). */
  private async markPaid(
    trx: Transaction<Database>,
    pay: { id: string; fee_type: AdmissionFeeType; institution_id: string; application_id: string },
    set: {
      mode: 'ONLINE' | 'CASH';
      paidAt: Date;
      receiptNo?: string | null;
      paidBy?: string | null;
      collectedBy?: Buffer | null;
      gatewayPaymentId?: string | null;
    },
  ) {
    const inst = await trx
      .selectFrom('institutions')
      .select(['name', 'short_name'])
      .where('id', '=', String(pay.institution_id))
      .executeTakeFirstOrThrow();
    const receipt =
      set.receiptNo ||
      (await this.receiptNo(
        trx,
        String(pay.institution_id),
        this.prefixOf(inst),
        set.paidAt,
        String(pay.id),
      ));
    const res = await trx
      .updateTable('admission_payments')
      .set({
        status: 'PAID',
        mode: set.mode,
        paid_at: set.paidAt,
        receipt_no: receipt,
        paid_by: set.paidBy ?? null,
        collected_by: set.collectedBy ?? null,
        gateway_payment_id: set.gatewayPaymentId ?? null,
        failure_reason: null,
        updated_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', pay.id)
      .where('status', 'in', ['PENDING', 'FAILED'])
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'ADM.FEE_ALREADY_PAID');
    const now = this.now();
    await trx
      .updateTable('admission_applications')
      .set({
        payment_status: 'COMPLETED',
        updated_at: now,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', String(pay.application_id))
      .execute();
    if (pay.fee_type === 'APPLICATION') {
      await trx
        .updateTable('admission_applications')
        .set({ status: 'SUBMITTED', submitted_at: now })
        .where('id', '=', String(pay.application_id))
        .where('status', '=', 'DRAFT')
        .where('declared_at', 'is not', null)
        .execute();
    }
    await recordAudit(trx, {
      institutionId: String(pay.institution_id),
      action: 'ADMISSION_FEE_PAID',
      entityType: 'admission_payment',
      entityRef: String(pay.id),
      after: { feeType: pay.fee_type, mode: set.mode, receipt },
    });
    return receipt;
  }

  /** Which fee to pay and its amount; the application must be able to pay it. */
  private async payable(
    r: { id: string; status: ApplicationStatus; year_id: string; institution_id: string },
    feeType: AdmissionFeeType,
  ) {
    if (r.status === 'REJECTED') throw new CustomAPIError(409, 'ADM.REJECTED_NO_PAYMENT');
    if (feeType === 'ADMISSION' && r.status !== 'APPROVED') {
      throw new CustomAPIError(409, 'ADM.FEE_AFTER_APPROVAL');
    }
    const fees = await this.entryFees(this.deps.db, String(r.institution_id), String(r.year_id));
    if (!fees) throw new CustomAPIError(409, 'ADM.FEE_CONFIG_MISSING');
    const amount = Number(
      feeType === 'APPLICATION' ? fees.application_fee_paise : fees.admission_fee_paise,
    );
    if (amount <= 0) throw new CustomAPIError(409, 'ADM.FEE_CONFIG_MISSING');
    return amount;
  }

  async startPayment(
    id: string,
    token: string | undefined,
    input: { feeType?: AdmissionFeeType | undefined },
  ) {
    const a = await this.access(id, token, 'pay');
    const feeType: AdmissionFeeType =
      a.fee ?? input.feeType ?? (a.row.status === 'APPROVED' ? 'ADMISSION' : 'APPLICATION');
    const amount = await this.payable(a.row, feeType);
    const chosen = await this.gatewayFor(String(a.inst.id));
    let order: GatewayOrder | null;
    try {
      order = await chosen.gateway.createOrder({
        amountPaise: amount,
        receipt: a.row.application_no,
        notes: { applicationNo: a.row.application_no, feeType },
      });
    } catch {
      // The gateway didn't answer (Razorpay down, wrong keys): the family can try again.
      throw new CustomAPIError(503, 'GEN.UNAVAILABLE');
    }
    if (!order) throw new CustomAPIError(503, 'ADM.GATEWAY_NOT_CONFIGURED');
    const pay = await this.deps.db.transaction().execute(async (trx) => {
      const f = await this.feeRow(trx, a.inst.id, a.row.id, feeType, amount);
      if (f.status === 'PAID') throw new CustomAPIError(409, 'ADM.FEE_ALREADY_PAID');
      await trx
        .updateTable('admission_payments')
        .set({
          status: 'PENDING',
          mode: 'ONLINE',
          amount_paise: amount,
          gateway_order_id: order.orderId,
          gateway_id: chosen.gatewayId,
          attempts: sql<number>`attempts + 1`,
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', f.id)
        .execute();
      return f;
    });
    return {
      paymentId: binToUuid(pay.public_id),
      feeType,
      amount: toMoneyDto(amount),
      gatewayOrder: {
        orderId: order.orderId,
        amount: toMoneyDto(order.amountPaise),
        mode: chosen.gateway.mode,
        ...(order.test ? { test: order.test } : {}),
        // Live: the page opens the gateway's checkout with this public key and the order.
        ...(order.checkout ? { checkout: { keyId: order.checkout.keyId, name: a.inst.name } } : {}),
      },
    };
  }

  async verifyPayment(
    id: string,
    token: string | undefined,
    paymentId: string,
    input: { gatewayPaymentId: string; signature: string },
  ) {
    const a = await this.access(id, token, 'pay');
    if (!isUuid(paymentId)) throw new NotFoundError();
    const f = await this.deps.db
      .selectFrom('admission_payments')
      .selectAll()
      .where('application_id', '=', a.row.id)
      .where('public_id', '=', uuidToBin(paymentId))
      .executeTakeFirst();
    if (!f) throw new NotFoundError();
    if (f.status === 'PAID') {
      if (f.gateway_payment_id === input.gatewayPaymentId) {
        return {
          status: 'PAID' as const,
          receiptNo: f.receipt_no,
          applicationStatus: a.row.status,
        };
      }
      throw new CustomAPIError(409, 'ADM.FEE_ALREADY_PAID');
    }
    const gateway = await this.gatewayOf(f.gateway_id);
    const ok =
      !!f.gateway_order_id &&
      gateway.verify({
        orderId: f.gateway_order_id,
        paymentId: input.gatewayPaymentId,
        signature: input.signature,
      });
    if (!ok) {
      await this.failPayment(f.id, 'The gateway’s signature did not verify');
      throw new CustomAPIError(402, 'ADM.PAYMENT_NOT_VERIFIED');
    }
    // Live: the payment as Razorpay holds it — this order, the fee's amount, captured.
    const wrong = await this.gatewayProblem(gateway, f, input.gatewayPaymentId);
    if (wrong) {
      await this.failPayment(f.id, wrong);
      throw new CustomAPIError(402, 'ADM.PAYMENT_NOT_VERIFIED');
    }
    const receipt = await this.deps.db.transaction().execute((trx) =>
      this.markPaid(trx, f, {
        mode: 'ONLINE',
        paidAt: this.now(),
        gatewayPaymentId: input.gatewayPaymentId,
      }),
    );
    const after = await this.lockless(a.inst.id, id);
    if (a.row.status === 'DRAFT' && after.status === 'SUBMITTED') {
      await this.tellFamily(a.inst.id, id, 'SUBMITTED');
    }
    return { status: 'PAID' as const, receiptNo: receipt, applicationStatus: after.status };
  }

  private async failPayment(id: string, reason: string) {
    await this.deps.db
      .updateTable('admission_payments')
      .set({
        status: 'FAILED',
        failure_reason: reason.slice(0, 200),
        updated_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .execute();
  }

  /**
   * Live gateway: what is wrong with the payment as the gateway holds it, or null when it is this
   * order's, for the fee's amount, and captured (an authorised payment is captured first).
   */
  /**
   * The gateway for a new payment: the test checkout in test mode; else the school's default
   * gateway; else RingPe's own (setting pg.platformFallback); else none.
   */
  private async gatewayFor(
    institutionId: string,
  ): Promise<{ gatewayId: string | null; gateway: PaymentGateway }> {
    if (this.deps.gateway.mode === 'test') return { gatewayId: null, gateway: this.deps.gateway };
    const own = await this.deps.gateways?.defaultFor(institutionId);
    if (own) return { gatewayId: own.id, gateway: own.gateway };
    if ((await this.limit(LIMITS.pgPlatformFallback)) === 1) {
      return { gatewayId: null, gateway: this.deps.gateway };
    }
    throw new CustomAPIError(503, 'ADM.GATEWAY_NOT_CONFIGURED');
  }

  /** The gateway a payment was taken with. */
  private async gatewayOf(gatewayId: string | null): Promise<PaymentGateway> {
    if (gatewayId === null) return this.deps.gateway;
    const g = await this.deps.gateways?.byId(gatewayId);
    if (!g) throw new CustomAPIError(503, 'GEN.UNAVAILABLE');
    return g;
  }

  private async gatewayProblem(
    g: PaymentGateway,
    f: { gateway_order_id: string | null; amount_paise: number | string },
    paymentId: string,
  ): Promise<string | null> {
    if (!g.fetchPayment) return null;
    let p: GatewayPayment;
    try {
      p = await g.fetchPayment(paymentId);
      if (p.status === 'authorized' && g.capturePayment && p.orderId === f.gateway_order_id) {
        p = await g.capturePayment(paymentId, Number(f.amount_paise));
      }
    } catch {
      // Not reached or not answered: nothing is marked; the family checks again.
      throw new CustomAPIError(503, 'GEN.UNAVAILABLE');
    }
    if (p.orderId !== f.gateway_order_id) return 'The payment belongs to another order';
    if (p.amountPaise !== Number(f.amount_paise)) return 'The amount paid differs from the fee';
    if (p.status !== 'captured') return `The gateway reports the payment as ${p.status}`;
    return null;
  }

  // --- SAS-033: the gateway's webhook (Razorpay; client 2026-10-09) -------------------------------------
  /**
   * A signed event from the gateway: a captured payment marks its admission or application fee paid
   * even when the family closed the page before ADM-011. The signature is checked on the raw body;
   * each event id is processed once (webhook_receipts); anything else is acknowledged and ignored.
   */
  async gatewayEvent(input: {
    rawBody: Buffer | undefined;
    signature: string | undefined;
    eventId: string | undefined;
    ip: string | undefined;
    /** A school gateway's webhook address carries its id; none = RingPe's own gateway. */
    gatewayPublicId?: string | undefined;
  }) {
    let gatewayId: string | null = null;
    let g = this.deps.gateway;
    if (input.gatewayPublicId !== undefined) {
      const own = await this.deps.gateways?.forWebhook(input.gatewayPublicId);
      if (!own) throw new CustomAPIError(401, 'INT.SIGNATURE_INVALID');
      gatewayId = own.id;
      g = own.gateway;
    }
    const client = input.gatewayPublicId
      ? `pg:${input.gatewayPublicId.toLowerCase()}`.slice(0, 64)
      : 'razorpay';
    const raw = input.rawBody;
    if (!raw || !input.signature || !g.verifyWebhook || !g.verifyWebhook(raw, input.signature)) {
      throw new CustomAPIError(401, 'INT.SIGNATURE_INVALID');
    }
    const bodySha = createHash('sha256').update(raw).digest('hex');
    const eventId = (input.eventId ?? bodySha).slice(0, 100);
    try {
      await this.deps.db
        .insertInto('webhook_receipts')
        .values({
          partner_client_id: client,
          partner_event_id: eventId,
          signature_ok: true,
          source_ip: ipToBin(input.ip) ?? Buffer.alloc(16),
          body_sha256: bodySha,
          body_encrypted: null,
          outcome: 'RECEIVED',
          response_code: '200',
        })
        .execute();
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') return { ok: true, duplicate: true };
      throw e;
    }
    const outcome = await this.applyGatewayEvent(raw, gatewayId).catch(() => 'ERROR');
    await this.deps.db
      .updateTable('webhook_receipts')
      .set({ outcome })
      .where('partner_client_id', '=', client)
      .where('partner_event_id', '=', eventId)
      .execute();
    return { ok: true, outcome };
  }

  private async applyGatewayEvent(raw: Buffer, gatewayId: string | null): Promise<string> {
    const body = JSON.parse(raw.toString('utf8')) as {
      event?: string;
      payload?: { payment?: { entity?: Record<string, unknown> } };
    };
    if (body.event !== 'payment.captured' && body.event !== 'order.paid') return 'IGNORED';
    const p = body.payload?.payment?.entity;
    const orderId = typeof p?.['order_id'] === 'string' ? p['order_id'] : null;
    const paymentId = typeof p?.['id'] === 'string' ? p['id'] : null;
    if (!orderId || !paymentId) return 'IGNORED';
    const f = await this.deps.db
      .selectFrom('admission_payments')
      .selectAll()
      .where('gateway_order_id', '=', orderId)
      // Only payments taken with this gateway: one school's keys never settle another's.
      .where('gateway_id', gatewayId === null ? 'is' : '=', gatewayId)
      .executeTakeFirst();
    if (!f) return 'UNKNOWN_ORDER';
    if (f.status === 'PAID') return 'ALREADY_PAID';
    if (Number(p?.['amount']) !== Number(f.amount_paise)) return 'AMOUNT_MISMATCH';
    if (p?.['status'] !== 'captured') return 'NOT_CAPTURED';
    const app = await this.deps.db
      .selectFrom('admission_applications')
      .select(['public_id', 'status'])
      .where('id', '=', String(f.application_id))
      .executeTakeFirstOrThrow();
    try {
      await this.deps.db.transaction().execute((trx) =>
        this.markPaid(trx, f, {
          mode: 'ONLINE',
          paidAt: this.now(),
          gatewayPaymentId: paymentId,
        }),
      );
    } catch (e) {
      if (e instanceof CustomAPIError && e.code === 'ADM.FEE_ALREADY_PAID') return 'ALREADY_PAID';
      throw e;
    }
    const id = binToUuid(app.public_id);
    const after = await this.lockless(String(f.institution_id), id);
    if (app.status === 'DRAFT' && after.status === 'SUBMITTED') {
      await this.tellFamily(String(f.institution_id), id, 'SUBMITTED');
    }
    return 'PAID';
  }

  // --- ADM-012 ---------------------------------------------------------------------------------------
  /** Status by application number and the mobile (or birth date): progress only (RNG-GOV-007). */
  async status(input: {
    applicationNo: string;
    mobile?: string | undefined;
    dob?: string | undefined;
  }) {
    if (!input.mobile && !input.dob) throw new CustomAPIError(422, 'ADM.RESUME_NEEDS');
    let q = this.rows(this.deps.db).where('a.application_no', '=', input.applicationNo);
    q = input.mobile
      ? q.where('a.primary_mobile', '=', input.mobile)
      : q.where('a.dob', '=', input.dob!);
    const r = await q.executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'ADM.STATUS_NOT_FOUND');
    const fees = await this.deps.db
      .selectFrom('admission_payments')
      .select(['fee_type', 'status', 'amount_paise'])
      .where('application_id', '=', r.id)
      .execute();
    const yearFees = await this.entryFees(
      this.deps.db,
      String(r.institution_id),
      String(r.year_id),
    );
    const fee = (t: AdmissionFeeType) => {
      const f = fees.find((x) => x.fee_type === t);
      const configured =
        t === 'APPLICATION' ? yearFees?.application_fee_paise : yearFees?.admission_fee_paise;
      return f
        ? { status: f.status, amount: toMoneyDto(Number(f.amount_paise)) }
        : configured
          ? { status: 'NOT_DUE' as const, amount: toMoneyDto(Number(configured)) }
          : null;
    };
    return {
      applicationNo: r.application_no,
      status: r.status,
      name: maskName(fullName(r.first_name, r.last_name)),
      classApplied: r.class_name,
      year: r.year_label,
      midTerm: !!Number(r.mid_term),
      joiningDate: dayOrNull(r.joining_date),
      createdAt: iso(r.created_at),
      submittedAt: iso(r.submitted_at),
      decidedAt: iso(r.decided_at),
      admissionNo: r.status === 'APPROVED' ? r.admission_no : null,
      rejectionReason: r.status === 'REJECTED' ? r.rejection_remarks : null,
      tc: r.tc_mode ? { mode: r.tc_mode, dueDate: dayOrNull(r.tc_due) } : null,
      fees: { application: fee('APPLICATION'), admission: fee('ADMISSION') },
    };
  }

  // --- console: ADM-013 / ADM-014 -------------------------------------------------------------------
  async list(
    p: Principal,
    f: {
      status?: ApplicationStatus | undefined;
      yearId?: string | undefined;
      classId?: string | undefined;
      midTerm?: boolean | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const i = await this.consoleInst(p);
    let q = this.rows(this.deps.db).where('a.institution_id', '=', i.id);
    if (f.yearId) {
      if (!isUuid(f.yearId)) return { items: [], nextCursor: null, counts: {}, kpis: null };
      q = q.where('y.public_id', '=', uuidToBin(f.yearId));
    }
    if (f.classId) {
      if (!isUuid(f.classId)) return { items: [], nextCursor: null, counts: {}, kpis: null };
      q = q.where('c.public_id', '=', uuidToBin(f.classId));
    }
    if (f.midTerm) q = q.where('a.mid_term', '=', 1);
    const term = f.q?.trim();
    if (term) {
      const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) =>
        eb.or([
          eb('a.application_no', 'like', like),
          eb(sql<string>`CONCAT_WS(' ', a.first_name, a.last_name)`, 'like', like),
          eb('a.primary_mobile', '=', term.replace(/\D/g, '')),
          eb('a.primary_name', 'like', like),
        ]),
      );
    }
    const countRows = await q
      .clearSelect()
      .select(['a.status', sql<number>`COUNT(*)`.as('n')])
      .groupBy('a.status')
      .execute();
    if (f.status) q = q.where('a.status', '=', f.status);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('a.id', '<', f.cursor);
    const rows = await q.orderBy('a.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    const appFees = page.length
      ? await this.deps.db
          .selectFrom('admission_payments')
          .select(['application_id', 'status', 'amount_paise', 'fee_type'])
          .where(
            'application_id',
            'in',
            page.map((r) => r.id),
          )
          .execute()
      : [];
    const kpi = await this.deps.db
      .selectFrom('admission_applications as a')
      .innerJoin('academic_years as y', 'y.id', 'a.year_id')
      .select([
        sql<number>`SUM(a.status = 'SUBMITTED')`.as('awaiting'),
        sql<number>`SUM(a.status = 'APPROVED')`.as('approved'),
        sql<number>`SUM(a.mid_term = 1 AND y.is_current = 1 AND a.status <> 'REJECTED')`.as('mid'),
        sql<number>`SUM(a.mid_term = 1 AND y.is_current = 1 AND a.status = 'SUBMITTED')`.as(
          'midToDecide',
        ),
      ])
      .where('a.institution_id', '=', i.id)
      .executeTakeFirst();
    const received = await this.deps.db
      .selectFrom('admission_payments')
      .select([
        sql<string>`COALESCE(SUM(amount_paise), 0)`.as('amount'),
        sql<number>`COUNT(*)`.as('n'),
      ])
      .where('institution_id', '=', i.id)
      .where('fee_type', '=', 'APPLICATION')
      .where('status', '=', 'PAID')
      .executeTakeFirst();
    return {
      items: page.map((r) => {
        const fee = appFees.find((x) => x.application_id === r.id && x.fee_type === 'APPLICATION');
        return {
          id: binToUuid(r.public_id),
          applicationNo: r.application_no,
          source: r.source,
          status: r.status,
          name: fullName(r.first_name, r.middle_name, r.last_name) || null,
          primaryContact: {
            name: r.primary_name,
            relation: r.primary_relation,
            mobile: r.primary_mobile,
          },
          class: r.class_public_id
            ? { id: binToUuid(r.class_public_id), name: r.class_name! }
            : null,
          section: r.section_name,
          admissionNo: r.admission_no,
          year: { id: binToUuid(r.year_public_id), label: r.year_label },
          midTerm: !!Number(r.mid_term),
          joiningDate: dayOrNull(r.joining_date),
          submittedAt: iso(r.submitted_at),
          createdAt: iso(r.created_at),
          applicationFee: fee
            ? { amount: toMoneyDto(Number(fee.amount_paise)), status: fee.status }
            : null,
        };
      }),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
      counts: Object.fromEntries(countRows.map((c) => [c.status, Number(c.n)])),
      kpis: {
        awaitingReview: Number(kpi?.awaiting ?? 0),
        approved: Number(kpi?.approved ?? 0),
        midTermThisYear: Number(kpi?.mid ?? 0),
        midTermToDecide: Number(kpi?.midToDecide ?? 0),
        applicationFeesReceived: toMoneyDto(Number(received?.amount ?? 0)),
        applicationFeesPaid: Number(received?.n ?? 0),
      },
    };
  }

  async detail(p: Principal, id: string) {
    const i = await this.consoleInst(p);
    return this.view(await this.lockless(i.id, id), { console: true, p });
  }

  // --- console: ADM-015 / ADM-016 / ADM-017 -----------------------------------------------------------
  async consoleCreate(p: Principal, input: ApplicationInput & { submit?: boolean | undefined }) {
    const i = await this.consoleInst(p);
    const { submit, ...rest } = input;
    const id = await this.createDraft(i.id, rest, 'COUNSELLOR', this.by(p));
    if (submit) await this.submit(i.id, id, { declaredBy: 'Counsellor' }, this.by(p));
    return this.detail(p, id);
  }

  async consoleUpdate(
    p: Principal,
    id: string,
    expected: number,
    input: { section: SectionName; data: unknown; step?: number | undefined },
  ) {
    const i = await this.consoleInst(p);
    await this.updateSection(i.id, id, expected, input, ['DRAFT', 'SUBMITTED']);
    return this.detail(p, id);
  }

  async consoleSubmit(p: Principal, id: string, input: { payLater?: boolean | undefined }) {
    const i = await this.consoleInst(p);
    const out = await this.submit(i.id, id, { ...input, declaredBy: 'Counsellor' }, this.by(p));
    return { ...out, application: await this.detail(p, id) };
  }

  async setTransferCertificate(
    p: Principal,
    id: string,
    input: {
      mode: 'TC' | 'UNDERTAKING';
      number?: string | null | undefined;
      date?: string | null | undefined;
      dueDate?: string | null | undefined;
    },
  ) {
    const i = await this.consoleInst(p);
    const r = await this.lockless(i.id, id);
    if (!['DRAFT', 'SUBMITTED'].includes(r.status))
      throw new CustomAPIError(409, 'ADM.NOT_EDITABLE');
    await this.recordTc(i.id, r, id, input);
    return this.detail(p, id);
  }

  private async recordTc(
    institutionId: string,
    r: { id: string; mid_term: number },
    id: string,
    input: {
      mode: 'TC' | 'UNDERTAKING';
      number?: string | null | undefined;
      date?: string | null | undefined;
      dueDate?: string | null | undefined;
    },
  ) {
    const i = { id: institutionId };
    if (!Number(r.mid_term)) throw new CustomAPIError(409, 'ADM.TC_NOT_MID_TERM');
    const today = istBusinessDate(this.now());
    if (input.mode === 'UNDERTAKING' && (!input.dueDate || input.dueDate < today)) {
      throw new ValidationError([{ field: 'dueDate', code: 'VALIDATION.DATE' }]);
    }
    if (input.mode === 'TC' && input.date && input.date > today) {
      throw new ValidationError([{ field: 'date', code: 'VALIDATION.DATE' }]);
    }
    await this.deps.db
      .updateTable('admission_applications')
      .set({
        tc_mode: input.mode,
        tc_number: input.mode === 'TC' ? (input.number ?? null) : null,
        tc_date: input.mode === 'TC' ? (input.date ?? null) : null,
        tc_due: input.mode === 'UNDERTAKING' ? (input.dueDate ?? null) : null,
        updated_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', r.id)
      .execute();
    await recordAudit(this.deps.db, {
      institutionId: i.id,
      action: 'ADMISSION_TC_RECORDED',
      entityType: 'admission_application',
      entityRef: id,
      after: { mode: input.mode, due: input.dueDate ?? null },
    });
  }

  async consoleDocument(
    p: Principal,
    id: string,
    input: { docType: AdmissionDocType; fileName: string; data: Buffer },
  ) {
    const i = await this.consoleInst(p);
    const r = await this.lockless(i.id, id);
    if (!['DRAFT', 'SUBMITTED'].includes(r.status))
      throw new CustomAPIError(409, 'ADM.NOT_EDITABLE');
    await this.addDocument(i.id, binToUuid(i.public_id), r, input, p);
    return this.detail(p, id);
  }

  async consoleAddReference(
    p: Principal,
    id: string,
    input: {
      name: string;
      relation?: string | null | undefined;
      mobile: string;
      email?: string | null | undefined;
    },
  ) {
    const i = await this.consoleInst(p);
    const r = await this.lockless(i.id, id);
    if (!['DRAFT', 'SUBMITTED'].includes(r.status))
      throw new CustomAPIError(409, 'ADM.NOT_EDITABLE');
    await this.addReference(r, input);
    return this.detail(p, id);
  }

  async consoleRemoveReference(p: Principal, id: string, refId: string) {
    const i = await this.consoleInst(p);
    const r = await this.lockless(i.id, id);
    if (!['DRAFT', 'SUBMITTED'].includes(r.status))
      throw new CustomAPIError(409, 'ADM.NOT_EDITABLE');
    await this.removeReference(r, refId);
    return this.detail(p, id);
  }

  // --- ADM-018 / ADM-019 -------------------------------------------------------------------------------
  private decidable(r: { status: ApplicationStatus }) {
    if (r.status === 'APPROVED' || r.status === 'REJECTED') {
      throw new CustomAPIError(409, 'ADM.ALREADY_DECIDED', {
        params: { status: r.status === 'APPROVED' ? 'Approved' : 'Rejected' },
      });
    }
    if (r.status !== 'SUBMITTED') throw new CustomAPIError(409, 'ADM.NOT_SUBMITTED');
  }

  /**
   * Approval (FR-ADM-09): the member (student), the wallets, the guardian links and the enrolment are
   * created by the onboarding service in the same transaction as the application's change; any
   * refusal leaves nothing behind.
   */
  async approve(
    p: Principal,
    id: string,
    expected: number,
    input: {
      userTypeId: string;
      departmentId?: string | null | undefined;
      sectionId: string;
      admissionNo: string;
      joiningDate?: string | null | undefined;
    },
  ) {
    const i0 = await this.consoleInst(p);
    const r = await this.lockless(i0.id, id);
    this.decidable(r);
    if (r.row_version !== expected) throw new PreconditionFailedError();
    if (Number(r.mid_term)) {
      const tcDoc = await this.deps.db
        .selectFrom('admission_documents')
        .select('doc_type')
        .where('application_id', '=', r.id)
        .where('doc_type', '=', 'TC')
        .executeTakeFirst();
      await this.midTermReady(r, !!tcDoc);
    }
    if (!isUuid(input.sectionId)) {
      throw new ValidationError([{ field: 'sectionId', code: 'VALIDATION.FORMAT' }]);
    }
    const sec = await this.deps.db
      .selectFrom('sections')
      .select(['id', 'class_id'])
      .where('institution_id', '=', i0.id)
      .where('public_id', '=', uuidToBin(input.sectionId))
      .executeTakeFirst();
    if (!sec || String(sec.class_id) !== String(r.class_id)) {
      throw new CustomAPIError(422, 'ADM.SECTION_NOT_IN_CLASS', {
        params: { class: r.class_name ?? '—' },
      });
    }
    const data = this.dataOf(r);
    const parents = data.parents;
    const guardians: NonNullable<OnboardInput['guardians']>[number][] = [];
    const add = (
      who: { name: string; mobile?: string | null; email?: string | null } | null | undefined,
      relation: 'FATHER' | 'MOTHER' | 'GUARDIAN',
    ) => {
      if (!who?.mobile || guardians.some((g) => g.mobile === who.mobile)) return;
      const n = splitName(title(who.name));
      guardians.push({
        firstName: n.firstName,
        lastName: n.lastName,
        mobile: who.mobile,
        email: who.email ?? null,
        relation,
      });
    };
    const order: ('FATHER' | 'MOTHER' | 'GUARDIAN')[] = [
      parents?.primary ?? 'FATHER',
      'FATHER',
      'MOTHER',
      'GUARDIAN',
    ];
    for (const rel of order) {
      add(
        rel === 'FATHER' ? parents?.father : rel === 'MOTHER' ? parents?.mother : parents?.guardian,
        rel,
      );
    }
    const joinedOn = input.joiningDate ?? dayOrNull(r.joining_date) ?? day(r.year_starts_on);
    const at = this.now();
    const memberId = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await institutionsRepository.byPublicId(
        trx as unknown as Kysely<Database>,
        uuidToBin(p.institutionId!),
        true,
      );
      if (!inst) throw new NotFoundError();
      const cur = await trx
        .selectFrom('admission_applications')
        .select(['status', 'row_version'])
        .where('id', '=', r.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      this.decidable(cur);
      if (cur.row_version !== expected) throw new PreconditionFailedError();
      const pub = newPublicIdPair();
      await this.deps.members.createMember(
        trx as unknown as Kysely<Database>,
        inst,
        pub,
        {
          userTypeId: input.userTypeId,
          departmentId: input.departmentId ?? null,
          firstName: title(r.first_name),
          lastName: title([r.middle_name, r.last_name].filter(Boolean).join(' ')) || null,
          gender: r.gender,
          dateOfBirth: dayOrNull(r.dob),
          mobile: null,
          email: null,
          joinedOn,
          admissionNo: input.admissionNo,
          sectionId: input.sectionId,
          guardians,
          enrolYearId: binToUuid(r.year_public_id),
        },
        this.by(p),
      );
      const member = await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('public_id', '=', pub.bin)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('admission_applications')
        .set({
          status: 'APPROVED',
          section_id: String(sec.id),
          admission_no: input.admissionNo.trim(),
          member_profile_id: String(member.id),
          decided_at: at,
          decided_by: this.by(p),
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', r.id)
        .where('status', '=', 'SUBMITTED')
        .execute();
      await recordAudit(trx, {
        institutionId: i0.id,
        action: 'ADMISSION_APPROVED',
        entityType: 'admission_application',
        entityRef: id,
        after: { member: pub.id, admissionNo: input.admissionNo.trim(), section: input.sectionId },
      });
      return pub.id;
    });
    await this.tellFamily(i0.id, id, 'APPROVED');
    return { memberId, application: await this.detail(p, id) };
  }

  async reject(
    p: Principal,
    id: string,
    expected: number,
    input: { reasonCode: string; remarks: string },
  ) {
    const i = await this.consoleInst(p);
    const r = await this.lockless(i.id, id);
    this.decidable(r);
    if (r.row_version !== expected) throw new PreconditionFailedError();
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('admission_applications')
        .set({
          status: 'REJECTED',
          rejection_reason: input.reasonCode,
          rejection_remarks: input.remarks.trim(),
          decided_at: at,
          decided_by: this.by(p),
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', r.id)
        .where('status', '=', 'SUBMITTED')
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      await recordAudit(trx, {
        institutionId: i.id,
        action: 'ADMISSION_REJECTED',
        entityType: 'admission_application',
        entityRef: id,
        after: { reason: input.reasonCode },
      });
    });
    await this.tellFamily(i.id, id, 'REJECTED');
    return this.detail(p, id);
  }

  // --- ADM-020 -----------------------------------------------------------------------------------------
  static readonly IMPORT_COLUMNS = [
    'Student first name',
    'Student last name',
    'Gender',
    'Date of birth',
    'Class',
    'Section',
    'Admission number',
    'Joining date',
    'Parent name',
    'Parent mobile',
    'Parent relation',
  ] as const;

  importTemplate() {
    return {
      fileName: 'ringpe-existing-students-template.csv',
      csv: toCsv([
        [...AdmissionsService.IMPORT_COLUMNS],
        [
          'Aarav',
          'Shetty',
          'Male',
          '2014-05-21',
          'Grade 6',
          'A',
          'TV-2026-0101',
          '2026-06-01',
          'Ramesh Shetty',
          '9845012390',
          'Father',
        ],
      ]),
    };
  }

  /**
   * Existing students (FR-ADM-10): each row is checked like the form and, when it passes, creates the
   * member, wallets, guardian link and enrolment with an Approved application, in its own
   * transaction — a refused row leaves nothing and is reported.
   */
  async import(p: Principal, input: { fileName: string; content: string }) {
    const i = await this.consoleInst(p);
    const rows = parseCsv(input.content.trimStart());
    const cols = AdmissionsService.IMPORT_COLUMNS;
    const got = (rows[0] ?? []).map((c) => c.trim().toLowerCase());
    if (!rows.length || cols.some((h, k) => got[k] !== h.toLowerCase())) {
      throw new CustomAPIError(422, 'UPL.HEADER_MISMATCH');
    }
    const data = rows.slice(1).filter((r) => r.some((c) => c.trim()));
    if (!data.length) throw new CustomAPIError(422, 'UPL.NO_ROWS');
    const max = await this.limit(LIMITS.uploadMaxRows);
    if (data.length > max) throw new CustomAPIError(422, 'UPL.TOO_MANY_ROWS', { params: { max } });
    const year = await this.deps.db
      .selectFrom('academic_years')
      .select(['id', 'public_id', 'starts_on'])
      .where('institution_id', '=', i.id)
      .where('is_current', '=', 1)
      .executeTakeFirst();
    if (!year) throw new CustomAPIError(409, 'ACA.NO_CURRENT_YEAR');
    const studentType = await this.deps.db
      .selectFrom('user_types')
      .select('public_id')
      .where('institution_id', '=', i.id)
      .where('category', '=', 'STUDENT')
      .where('status', '=', 'ACTIVE')
      .orderBy('id')
      .executeTakeFirst();
    const sections = await this.deps.db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.public_id', 's.name as section', 'c.id as class_id', 'c.name as class'])
      .where('s.institution_id', '=', i.id)
      .execute();
    const report: {
      row: number;
      name: string;
      outcome: 'IMPORTED' | 'REJECTED';
      applicationNo?: string;
      errors: { column: string; message: string }[];
    }[] = [];
    const genders: Record<string, 'MALE' | 'FEMALE' | 'OTHER'> = {
      male: 'MALE',
      m: 'MALE',
      female: 'FEMALE',
      f: 'FEMALE',
      other: 'OTHER',
    };
    const relations: Record<string, 'FATHER' | 'MOTHER' | 'GUARDIAN'> = {
      father: 'FATHER',
      mother: 'MOTHER',
      guardian: 'GUARDIAN',
    };
    for (const [k, cells] of data.entries()) {
      const cell = (n: (typeof cols)[number]) => (cells[cols.indexOf(n)] ?? '').trim();
      const errors: { column: string; message: string }[] = [];
      const err = (column: string, code: MessageKey, params?: Record<string, string | number>) =>
        errors.push({ column, message: renderMessage(code, params) });
      const first = cell('Student first name');
      const last = cell('Student last name');
      if (!first || !PATTERNS.personName.test(first))
        err('Student first name', 'VALIDATION.REQUIRED');
      const gender = genders[cell('Gender').toLowerCase()];
      if (!gender) err('Gender', 'VALIDATION.FORMAT');
      const dob = cell('Date of birth');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)))
        err('Date of birth', 'VALIDATION.DATE');
      const sec = sections.find(
        (s) =>
          s.class.toLowerCase() === cell('Class').toLowerCase() &&
          s.section.toLowerCase() === cell('Section').toLowerCase(),
      );
      if (!sec) err('Section', 'ADM.CLASS_INVALID');
      const admissionNo = cell('Admission number');
      if (!admissionNo) err('Admission number', 'IDN.ADMISSION_NO_REQUIRED');
      const joining = cell('Joining date') || day(year.starts_on);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(joining)) err('Joining date', 'VALIDATION.DATE');
      const parent = cell('Parent name');
      const mobile = cell('Parent mobile');
      const relation = relations[cell('Parent relation').toLowerCase()];
      if (!parent) err('Parent name', 'VALIDATION.REQUIRED');
      if (!PATTERNS.mobile.test(mobile)) err('Parent mobile', 'ADM.MOBILE_INVALID');
      if (!relation) err('Parent relation', 'VALIDATION.FORMAT');
      if (!studentType) err('Class', 'IDN.USER_TYPE_UNKNOWN', { t: 'Student' });
      const name = fullName(first, last) || '—';
      if (errors.length) {
        report.push({ row: k + 2, name, outcome: 'REJECTED', errors });
        continue;
      }
      try {
        const no = await this.deps.db.transaction().execute(async (trx) => {
          const inst = await institutionsRepository.byPublicId(
            trx as unknown as Kysely<Database>,
            i.public_id,
            true,
          );
          const pub = newPublicIdPair();
          const n = splitName(title(parent));
          await this.deps.members.createMember(
            trx as unknown as Kysely<Database>,
            inst!,
            pub,
            {
              userTypeId: binToUuid(studentType!.public_id),
              firstName: title(first),
              lastName: title(last) || null,
              gender,
              dateOfBirth: dob,
              joinedOn: joining,
              admissionNo,
              sectionId: binToUuid(sec!.public_id),
              guardians: [
                { firstName: n.firstName, lastName: n.lastName, mobile, relation: relation! },
              ],
            },
            this.by(p),
          );
          const m = await trx
            .selectFrom('member_profiles')
            .select('id')
            .where('public_id', '=', pub.bin)
            .executeTakeFirstOrThrow();
          const appPub = newPublicIdPair();
          const appNo = await this.nextNo(
            trx,
            i.id,
            this.prefixOf(i),
            Number(day(year.starts_on).slice(0, 4)),
          );
          const at = this.now();
          await trx
            .insertInto('admission_applications')
            .values({
              public_id: appPub.bin,
              institution_id: i.id,
              application_no: appNo,
              source: 'IMPORT',
              status: 'APPROVED',
              year_id: String(year.id),
              class_id: String(sec!.class_id),
              first_name: title(first),
              last_name: title(last) || null,
              gender,
              dob,
              joining_date: joining,
              primary_name: title(parent),
              primary_relation: relation!,
              primary_mobile: mobile,
              data: JSON.stringify({}),
              admission_no: admissionNo,
              member_profile_id: String(m.id),
              submitted_at: at,
              decided_at: at,
              decided_by: this.by(p),
              created_by: this.by(p),
              created_at: at,
              updated_at: at,
            })
            .execute();
          return appNo;
        });
        report.push({ row: k + 2, name, outcome: 'IMPORTED', applicationNo: no, errors: [] });
      } catch (e) {
        if (!(e instanceof CustomAPIError)) throw e;
        const fieldErrors = (e as { errors?: readonly FieldError[] }).errors ?? [];
        report.push({
          row: k + 2,
          name,
          outcome: 'REJECTED',
          errors: fieldErrors.length
            ? fieldErrors.map((f) => ({
                column: f.field,
                message: renderMessage(f.code as MessageKey, f.params),
              }))
            : [{ column: '—', message: renderMessage(e.code as MessageKey, e.params) }],
        });
      }
    }
    const imported = report.filter((r) => r.outcome === 'IMPORTED').length;
    const pub = newPublicIdPair();
    await this.deps.db
      .insertInto('admission_imports')
      .values({
        public_id: pub.bin,
        institution_id: i.id,
        file_name: input.fileName.slice(0, 200),
        rows_total: report.length,
        rows_imported: imported,
        rows_rejected: report.length - imported,
        report: JSON.stringify(report),
        created_by: this.by(p),
        created_at: this.now(),
      })
      .execute();
    await recordAudit(this.deps.db, {
      institutionId: i.id,
      action: 'ADMISSION_STUDENTS_IMPORTED',
      entityType: 'admission_import',
      entityRef: pub.id,
      after: { imported, rejected: report.length - imported },
    });
    return {
      uploadId: pub.id,
      total: report.length,
      imported,
      rejected: report.length - imported,
      rows: report,
    };
  }

  // --- ADM-021…024 ---------------------------------------------------------------------------------------
  /** Application and admission fees by year (prototype c.admfees). */
  async fees(
    p: Principal,
    f: {
      yearId?: string | undefined;
      feeType?: AdmissionFeeType | undefined;
      status?: 'PENDING' | 'PAID' | 'FAILED' | undefined;
    },
  ) {
    const i = await this.consoleInst(p);
    let q = this.rows(this.deps.db)
      .where('a.institution_id', '=', i.id)
      .where((eb) => eb.or([eb('a.status', '=', 'APPROVED'), eb('a.declared_at', 'is not', null)]));
    if (f.yearId) {
      if (!isUuid(f.yearId)) return { items: [], totals: null };
      q = q.where('y.public_id', '=', uuidToBin(f.yearId));
    }
    const apps = await q.orderBy('a.id', 'desc').limit(500).execute();
    const pays = apps.length
      ? await this.deps.db
          .selectFrom('admission_payments')
          .selectAll()
          .where(
            'application_id',
            'in',
            apps.map((a) => a.id),
          )
          .execute()
      : [];
    const yearFees = new Map<string, Awaited<ReturnType<AdmissionsService['entryFees']>>>();
    for (const a of apps) {
      const k = String(a.year_id);
      if (!yearFees.has(k)) yearFees.set(k, await this.entryFees(this.deps.db, i.id, k));
    }
    const items: {
      applicationId: string;
      applicationNo: string;
      applicationStatus: ApplicationStatus;
      student: string | null;
      admissionNo: string | null;
      class: string | null;
      year: string;
      feeType: AdmissionFeeType;
      paymentId: string | null;
      amount: ReturnType<typeof toMoneyDto>;
      status: 'PENDING' | 'PAID' | 'FAILED';
      mode: 'ONLINE' | 'CASH' | null;
      receiptNo: string | null;
      paidAt: string | null;
      paidBy: string | null;
    }[] = [];
    let collectedPaise = 0;
    let pendingPaise = 0;
    for (const a of apps) {
      for (const type of ['APPLICATION', 'ADMISSION'] as const) {
        if (f.feeType && f.feeType !== type) continue;
        const row = pays.find((x) => x.application_id === a.id && x.fee_type === type);
        const cfg = yearFees.get(String(a.year_id));
        const configured = Number(
          (type === 'APPLICATION' ? cfg?.application_fee_paise : cfg?.admission_fee_paise) ?? 0,
        );
        if (!row && (type === 'ADMISSION' ? a.status !== 'APPROVED' : true)) continue;
        if (!row && configured <= 0) continue;
        const status = row?.status ?? 'PENDING';
        if (f.status && f.status !== status) continue;
        const paise = row ? Number(row.amount_paise) : configured;
        if (status === 'PAID') collectedPaise += paise;
        else pendingPaise += paise;
        items.push({
          applicationId: binToUuid(a.public_id),
          applicationNo: a.application_no,
          applicationStatus: a.status,
          student: fullName(a.first_name, a.last_name) || null,
          admissionNo: a.admission_no,
          class: a.section_name ? `${a.class_name} ${a.section_name}` : a.class_name,
          year: a.year_label,
          feeType: type,
          paymentId: row ? binToUuid(row.public_id) : null,
          amount: toMoneyDto(paise),
          status,
          mode: row?.mode ?? null,
          receiptNo: row?.receipt_no ?? null,
          paidAt: iso(row?.paid_at),
          paidBy: row?.paid_by ?? null,
        });
      }
    }
    return {
      items,
      totals: {
        collected: toMoneyDto(collectedPaise),
        pending: toMoneyDto(pendingPaise),
        paidCount: items.filter((x) => x.status === 'PAID').length,
        pendingCount: items.filter((x) => x.status !== 'PAID').length,
      },
    };
  }

  /** Cash at the accounts desk (19.8; FR-FEE-12): recorded once, with who collected it. */
  async cash(
    p: Principal,
    id: string,
    input: {
      feeType?: AdmissionFeeType | undefined;
      receivedAt: string;
      receiptNo?: string | null | undefined;
      paidBy: string;
    },
  ) {
    const i = await this.consoleInst(p);
    const r = await this.lockless(i.id, id);
    const feeType: AdmissionFeeType = input.feeType ?? 'ADMISSION';
    const amount = await this.payable(r, feeType);
    if (input.receivedAt > istBusinessDate(this.now())) {
      throw new ValidationError([{ field: 'receivedAt', code: 'VALIDATION.DATE' }]);
    }
    try {
      const receipt = await this.deps.db.transaction().execute(async (trx) => {
        const f = await this.feeRow(trx, i.id, r.id, feeType, amount);
        if (f.status === 'PAID') throw new CustomAPIError(409, 'ADM.FEE_ALREADY_PAID');
        await trx
          .updateTable('admission_payments')
          .set({ amount_paise: amount })
          .where('id', '=', f.id)
          .execute();
        return this.markPaid(trx, f, {
          mode: 'CASH',
          paidAt: new Date(`${input.receivedAt}T12:00:00+05:30`),
          receiptNo: input.receiptNo ?? null,
          paidBy: title(input.paidBy),
          collectedBy: this.by(p),
        });
      });
      const pay = await this.deps.db
        .selectFrom('admission_payments')
        .select('public_id')
        .where('application_id', '=', r.id)
        .where('fee_type', '=', feeType)
        .executeTakeFirstOrThrow();
      if (r.status === 'DRAFT' && (await this.lockless(i.id, id)).status === 'SUBMITTED') {
        await this.tellFamily(i.id, id, 'SUBMITTED');
      }
      return {
        receipt: {
          paymentId: binToUuid(pay.public_id),
          receiptNo: receipt,
          amount: toMoneyDto(amount),
          feeType,
        },
        application: await this.detail(p, id),
      };
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'ADM.RECEIPT_TAKEN');
      throw e;
    }
  }

  /** A payment link for the admission fee (19.8): the family pays online without signing in. */
  async onlineLink(p: Principal, id: string) {
    const i = await this.consoleInst(p);
    const r = await this.lockless(i.id, id);
    const amount = await this.payable(r, 'ADMISSION');
    await this.deps.db.transaction().execute(async (trx) => {
      const f = await this.feeRow(trx, i.id, r.id, 'ADMISSION', amount);
      if (f.status === 'PAID') throw new CustomAPIError(409, 'ADM.FEE_ALREADY_PAID');
    });
    const days = await this.limit(LIMITS.admPayLinkDays);
    const t = await this.deps.flows.issue(
      'admission-pay',
      { inst: binToUuid(i.public_id), app: id.toLowerCase(), fee: 'ADMISSION' },
      days * 86_400,
    );
    return {
      paymentLink: `${this.deps.webUrl}/admissions/pay/${id.toLowerCase()}?token=${encodeURIComponent(t.token)}`,
      amount: toMoneyDto(amount),
      expiresAt: t.expiresAt.toISOString(),
      sendTo: { mobile: r.primary_mobile, email: r.primary_email },
    };
  }

  async receiptPdf(p: Principal, paymentId: string) {
    const i = await this.consoleInst(p);
    if (!isUuid(paymentId)) throw new NotFoundError();
    const f = await this.deps.db
      .selectFrom('admission_payments as f')
      .innerJoin('admission_applications as a', 'a.id', 'f.application_id')
      .innerJoin('academic_years as y', 'y.id', 'a.year_id')
      .leftJoin('classes as c', 'c.id', 'a.class_id')
      .select([
        'f.fee_type',
        'f.amount_paise',
        'f.status',
        'f.mode',
        'f.receipt_no',
        'f.paid_at',
        'f.paid_by',
        'a.application_no',
        'a.first_name',
        'a.last_name',
        'a.admission_no',
        'y.label as year_label',
        'c.name as class_name',
      ])
      .where('f.institution_id', '=', i.id)
      .where('f.public_id', '=', uuidToBin(paymentId))
      .executeTakeFirst();
    if (!f || f.status !== 'PAID') throw new NotFoundError();
    const amount = Number(f.amount_paise);
    const doc = new PdfDocument(`Receipt ${f.receipt_no ?? ''}`);
    const brand: [number, number, number] = [15, 110, 120];
    const muted: [number, number, number] = [90, 100, 110];
    doc.text(48, 64, i.name, { size: 18, bold: true, color: brand });
    doc.text(
      48,
      84,
      f.fee_type === 'APPLICATION' ? 'Application fee receipt' : 'Admission fee receipt',
      { size: 12, color: muted },
    );
    doc.text(547, 64, f.receipt_no ?? '', { size: 12, bold: true, align: 'right' });
    doc.text(547, 84, f.paid_at ? formatDateTime(new Date(f.paid_at)) : '—', {
      size: 10,
      align: 'right',
      color: muted,
    });
    doc.line(48, 100, 547, 100, { color: [220, 226, 230] });
    doc.text(48, 140, formatInr(amount).replace('₹', 'Rs. '), { size: 26, bold: true });
    doc.text(48, 160, rupeesInWords(amount), { size: 9, color: muted });
    const rows: [string, string][] = [
      ['Application', f.application_no],
      ['Student', fullName(f.first_name, f.last_name) || '—'],
      ['Class sought', f.class_name ?? '—'],
      ['Academic year', f.year_label],
      ['Admission number', f.admission_no ?? '—'],
      ['Paid', f.mode === 'CASH' ? `In cash${f.paid_by ? ` by ${f.paid_by}` : ''}` : 'Online'],
    ];
    let y = 200;
    for (const [k, v] of rows) {
      doc.text(48, y, k, { size: 10, color: muted });
      doc.text(180, y, v, { size: 10 });
      y += 22;
    }
    doc.line(48, y + 4, 547, y + 4, { color: [220, 226, 230] });
    doc.text(48, y + 26, 'This receipt is generated by RingPe and needs no signature.', {
      size: 8,
      color: [120, 130, 140],
    });
    return {
      fileName: `${(f.receipt_no ?? paymentId).replace(/\//g, '-')}.pdf`,
      pdf: doc.toBuffer(),
    };
  }
}

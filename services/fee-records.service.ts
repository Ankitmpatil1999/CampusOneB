/**
 * Fee records and their collection (SRS 13.3, 13.4, 13.5, 13.15; FEE-010…012, FEE-016…018, job
 * fee-retry; prototype c.feerecords).
 *
 * - A record is one instalment of one student: raised by an assignment (FeesService), entered by
 *   hand (one head), or uploaded. Duplicate rule: student + academic year + instalment (OI-FEE-04).
 * - Collecting takes the outstanding amount (amount, plus the late fine once overdue, less what was
 *   paid) from the student's campus wallet to the institution's fee account through the payment
 *   engine (channel TUITION, RPTF): the ledger is posted and the record marked PAID in one
 *   transaction (OI-FEE-21). Consent is needed when the institution's feeConsent toggle is on; a
 *   financed record is never debited.
 * - A refusal at a guard or a validation (a short balance most often) keeps one PENDING attempt per
 *   record (RNG-PAY-126); the job retries it (Q14 M9) — each try is its own engine attempt, keyed so a
 *   re-run of the job never pays twice.
 * - The job also marks unpaid records past their due date OVERDUE, which applies the late fine once.
 */
import type { Kysely, Transaction } from 'kysely';
import { notifyFeeAssigned } from './fee-notices.service';
import { sql } from 'kysely';
import type { Database, FeeRecordStatus } from '../models/ringpe_models';
import { academicsRepository } from '../repositories/academics.repository';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import { formatDate, formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import type { JobContext } from '../schedulers';
import { raiseApproval } from './approvals.service';
import { recordAudit } from './audit.service';
import { tellMembers } from './member-notices';
import type { MembersService } from './members.service';
import { outstandingOf, PaymentRefusedError, type PaymentEngine } from './payment-engine.service';
import { defaultValues, type SettingValues } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const day = (d: Date | string) => istBusinessDate(new Date(d));
const nameOf = (first: string | null, last: string | null) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** A share in basis points as the structure shows it: "40", "33.33". */
const formatShare = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2));

export class FeeRecordsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly engine: PaymentEngine;
      /** ADR-0015: an administrator's own change applies directly (FEE-013). */
      readonly members?: Pick<MembersService, 'adminSelfApplies'>;
      readonly settings?: { values(): Promise<SettingValues> };
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

  private async inst(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!i) throw new NotFoundError();
    return i;
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async toggle(institutionId: string, key: 'tuition' | 'feeConsent') {
    const t = await this.deps.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', institutionId)
      .where('feature_key', '=', key)
      .executeTakeFirst();
    return !!t && !!Number(t.enabled);
  }

  /** The student's latest consent, if still valid (13.5). */
  private async consentValid(institutionId: string, studentRowId: string) {
    const c = await this.deps.db
      .selectFrom('fee_consents')
      .select('valid_until')
      .where('institution_id', '=', institutionId)
      .where('student_profile_id', '=', studentRowId)
      .orderBy('valid_until', 'desc')
      .executeTakeFirst();
    return !!c && new Date(c.valid_until).getTime() > this.now().getTime();
  }

  // --- reading --------------------------------------------------------------------------------------
  private rows(db: Db, institutionId: string) {
    return db
      .selectFrom('fee_records as r')
      .innerJoin('member_profiles as m', 'm.id', 'r.student_profile_id')
      .innerJoin('academic_years as y', 'y.id', 'r.year_id')
      .leftJoin('enrolments as e', (j) =>
        j
          .onRef('e.student_profile_id', '=', 'r.student_profile_id')
          .onRef('e.year_id', '=', 'r.year_id'),
      )
      .leftJoin('sections as sec', 'sec.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
      .leftJoin('fee_structure_versions as v', 'v.id', 'r.version_id')
      .leftJoin('fee_structures as s', 's.id', 'v.structure_id')
      .leftJoin('fee_collection_attempts as a', (j) =>
        j.onRef('a.record_id', '=', 'r.id').on('a.status', '=', 'PENDING'),
      )
      .leftJoin('fee_structure_instalments as fi', (j) =>
        j.onRef('fi.version_id', '=', 'r.version_id').onRef('fi.seq', '=', 'r.instalment_seq'),
      )
      .selectAll('r')
      .select((eb) => [
        'm.public_id as student_public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'y.public_id as year_public_id',
        'y.label as year_label',
        'c.public_id as class_public_id',
        'c.name as class_name',
        'sec.name as section_name',
        'sec.public_id as section_public_id',
        's.name as structure_name',
        'v.version_no',
        'fi.share_bp',
        'a.public_id as attempt_public_id',
        'a.tries',
        'a.last_failure_code',
        'a.last_tried_at',
        // The student's latest consent (13.5) and a change waiting for a checker (FEE-013).
        eb
          .selectFrom('fee_consents as fc')
          .select(sql<Date | null>`MAX(fc.valid_until)`.as('u'))
          .whereRef('fc.student_profile_id', '=', 'r.student_profile_id')
          .whereRef('fc.institution_id', '=', 'r.institution_id')
          .as('consent_until'),
        eb
          .exists(
            eb
              .selectFrom('approval_requests as ar')
              .select('ar.id')
              .where('ar.module', '=', 'FEE_RECORD_CHANGE')
              .where('ar.status', '=', 'PENDING')
              .whereRef('ar.subject_ref', '=', 'r.public_id'),
          )
          .as('change_pending'),
      ])
      .where('r.institution_id', '=', institutionId);
  }

  private view(r: Awaited<ReturnType<ReturnType<FeeRecordsService['rows']>['execute']>>[number]) {
    const fine = Number(r.fine_applied) ? Number(r.late_fine_paise) : 0;
    return {
      id: binToUuid(r.public_id),
      student: {
        id: binToUuid(r.student_public_id),
        name: nameOf(r.first_name, r.last_name),
        admissionNo: r.admission_no,
        classSection: r.class_name ? `${r.class_name} ${r.section_name ?? ''}`.trim() : null,
      },
      year: { id: binToUuid(r.year_public_id), label: r.year_label },
      source: r.source,
      structure: r.structure_name ? { name: r.structure_name, version: r.version_no } : null,
      instalment: {
        seq: r.instalment_seq,
        label: r.label,
        share:
          r.share_bp === null || r.share_bp === undefined ? null : formatShare(Number(r.share_bp)),
      },
      dueDate: day(r.due_date),
      amount: toMoneyDto(Number(r.amount_paise)),
      lateFine: toMoneyDto(Number(r.late_fine_paise)),
      fine: toMoneyDto(fine),
      paid: toMoneyDto(Number(r.paid_paise)),
      outstanding: toMoneyDto(r.status === 'CANCELLED' ? 0 : outstandingOf(r)),
      status: r.status,
      financed: !!Number(r.financed),
      remarks: r.remarks,
      pendingAttempt: r.attempt_public_id
        ? {
            id: binToUuid(r.attempt_public_id),
            tries: r.tries ?? 0,
            lastFailureCode: r.last_failure_code,
            lastTriedAt: iso(r.last_tried_at),
          }
        : null,
      consent: {
        valid: !!r.consent_until && new Date(r.consent_until).getTime() > this.now().getTime(),
        validUntil: iso(r.consent_until),
      },
      changePending: !!Number(r.change_pending),
      paidAt: iso(r.paid_at),
      paidReference: r.paid_reference ?? null,
      createdAt: iso(r.created_at),
      version: r.row_version,
    };
  }

  // --- FEE-010 --------------------------------------------------------------------------------------
  async list(
    p: Principal,
    f: {
      yearId?: string | undefined;
      sectionId?: string | undefined;
      classId?: string | undefined;
      status?: FeeRecordStatus | undefined;
      studentId?: string | undefined;
      financed?: boolean | undefined;
      waiting?: boolean | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const i = await this.inst(p);
    let q = this.rows(this.deps.db, String(i.id));
    if (f.classId) {
      if (!isUuid(f.classId)) return { items: [], nextCursor: null };
      q = q.where('c.public_id', '=', uuidToBin(f.classId));
    }
    if (f.financed !== undefined) q = q.where('r.financed', '=', f.financed ? 1 : 0);
    if (f.waiting) q = q.where('a.id', 'is not', null);
    const term = f.q?.trim();
    if (term) {
      const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql<string>`CONCAT_WS(' ', m.first_name, m.last_name)`, 'like', like),
          eb('m.admission_no', 'like', like),
          eb('r.label', 'like', like),
        ]),
      );
    }
    if (f.yearId) {
      if (!isUuid(f.yearId)) return { items: [], nextCursor: null };
      q = q.where('y.public_id', '=', uuidToBin(f.yearId));
    }
    if (f.sectionId) {
      if (!isUuid(f.sectionId)) return { items: [], nextCursor: null };
      q = q.where('sec.public_id', '=', uuidToBin(f.sectionId));
    }
    if (f.studentId) {
      if (!isUuid(f.studentId)) return { items: [], nextCursor: null };
      q = q.where('m.public_id', '=', uuidToBin(f.studentId));
    }
    if (f.status) q = q.where('r.status', '=', f.status);
    const after = idCursor.decode(f.cursor);
    if (after) q = q.where('r.id', '<', after);
    const rows = await q.orderBy('r.id', 'desc').limit(101).execute();
    const page = rows.slice(0, 100);
    return {
      items: page.map((r) => this.view(r)),
      nextCursor: rows.length > 100 ? idCursor.encode(String(page.at(-1)!.id)) : null,
    };
  }

  // --- FEE-043 --------------------------------------------------------------------------------------
  /**
   * The active students a fee can be billed to, by name or admission number, with their class in the
   * year (the current one unless given): what the fee forms need to pick a student, without the
   * member directory's contact details, so fee staff need no members.view (client 2026-10-15).
   */
  async students(p: Principal, f: { q?: string | undefined; yearId?: string | undefined }) {
    const i = await this.inst(p);
    const instId = String(i.id);
    let yearRowId: string | null = null;
    if (f.yearId) {
      if (!isUuid(f.yearId)) return { items: [] };
      const y = await academicsRepository.yearByPublicId(this.deps.db, instId, uuidToBin(f.yearId));
      yearRowId = y ? String(y.id) : null;
    } else {
      const y = await academicsRepository.currentYear(this.deps.db, instId);
      yearRowId = y ? String(y.id) : null;
    }
    let q = this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').on('e.year_id', '=', yearRowId ?? '0'),
      )
      .leftJoin('sections as sec', 'sec.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'c.name as class_name',
        'sec.name as section_name',
      ])
      .where('m.institution_id', '=', instId)
      // Students, and staff with transport dues (client 2026-10-21).
      .where((eb) =>
        eb.or([
          eb('ut.category', '=', 'STUDENT'),
          eb.exists(
            eb
              .selectFrom('fee_records as fr')
              .select('fr.id')
              .whereRef('fr.student_profile_id', '=', 'm.id')
              .where('fr.source', '=', 'TRANSPORT'),
          ),
        ]),
      )
      .where('m.status', '=', 'ACTIVE');
    const term = f.q?.trim();
    if (term) {
      const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql<string>`CONCAT_WS(' ', m.first_name, m.last_name)`, 'like', like),
          eb('m.admission_no', 'like', like),
        ]),
      );
    }
    const rows = await q.orderBy('m.first_name').orderBy('m.last_name').limit(50).execute();
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        name: nameOf(r.first_name, r.last_name),
        admissionNo: r.admission_no,
        grade: r.class_name ? { class: r.class_name, section: r.section_name ?? null } : null,
      })),
    };
  }

  // --- FEE-011 --------------------------------------------------------------------------------------
  async detail(p: Principal, id: string) {
    const i = await this.inst(p);
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.rows(this.deps.db, String(i.id))
      .where('r.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    const [heads, collections, attempts] = await Promise.all([
      this.deps.db
        .selectFrom('fee_record_heads')
        .select(['name', 'amount_paise'])
        .where('record_id', '=', r.id)
        .execute(),
      this.deps.db
        .selectFrom('fee_collections as fc')
        // Cash and online collections have no engine attempt (0075): their receipt is the reference.
        .leftJoin('payment_attempts as pa', 'pa.id', 'fc.payment_attempt_id')
        .select([
          'fc.amount_paise',
          'fc.fine_paise',
          'fc.source',
          'fc.mode',
          'fc.receipt_no',
          'fc.paid_by',
          'fc.gateway_payment_id',
          'fc.status',
          'fc.collected_at',
          'pa.reference',
        ])
        .where('fc.record_id', '=', r.id)
        .orderBy('fc.id')
        .execute(),
      this.deps.db
        .selectFrom('payment_attempts')
        .select(['reference', 'status', 'failure_code', 'attempted_at', 'amount_paise'])
        .where('institution_id', '=', String(i.id))
        .where('fee_record_id', '=', r.id)
        .orderBy('id', 'desc')
        .limit(20)
        .execute(),
    ]);
    return {
      ...this.view(r),
      heads: heads.map((h) => ({ name: h.name, amount: toMoneyDto(Number(h.amount_paise)) })),
      collections: collections.map((c) => ({
        reference: c.reference ?? c.receipt_no ?? '—',
        amount: toMoneyDto(Number(c.amount_paise)),
        fine: toMoneyDto(Number(c.fine_paise)),
        source: c.source,
        mode: c.mode,
        paidBy: c.paid_by,
        transactionId: c.gateway_payment_id,
        status: c.status,
        collectedAt: iso(c.collected_at),
      })),
      attempts: attempts.map((a) => ({
        reference: a.reference,
        status: a.status,
        failureCode: a.failure_code,
        amount: toMoneyDto(Number(a.amount_paise)),
        at: iso(a.attempted_at),
      })),
    };
  }

  // --- FEE-012 --------------------------------------------------------------------------------------
  async manual(
    p: Principal,
    input: {
      studentId: string;
      yearId: string;
      label: string;
      dueDate: string;
      amountPaise: number;
      headId?: string | undefined;
      remarks?: string | null | undefined;
      lateFinePaise?: number | undefined;
    },
  ) {
    const i = await this.inst(p);
    const instId = String(i.id);
    if (!isUuid(input.studentId)) throw new CustomAPIError(422, 'FEE.NOT_A_STUDENT');
    const st = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select(['m.id', 'm.first_name', 'm.last_name', 'ut.category'])
      .where('m.institution_id', '=', instId)
      .where('m.public_id', '=', uuidToBin(input.studentId))
      .executeTakeFirst();
    if (!st || st.category !== 'STUDENT') throw new CustomAPIError(422, 'FEE.NOT_A_STUDENT');
    if (!isUuid(input.yearId))
      throw new ValidationError([{ field: 'yearId', code: 'VALIDATION.FORMAT' }]);
    const y = await this.deps.db
      .selectFrom('academic_years')
      .select(['id', 'label', 'starts_on', 'ends_on', 'status'])
      .where('institution_id', '=', instId)
      .where('public_id', '=', uuidToBin(input.yearId))
      .executeTakeFirst();
    if (!y) throw new ValidationError([{ field: 'yearId', code: 'VALIDATION.FORMAT' }]);
    if (y.status === 'CLOSED')
      throw new CustomAPIError(409, 'FEE.YEAR_CLOSED', { params: { year: y.label } });
    // BR-30: a new record isn't already past due; it falls inside the year.
    const today = istBusinessDate(this.now());
    if (input.dueDate < today || input.dueDate > day(y.ends_on)) {
      throw new ValidationError([{ field: 'dueDate', code: 'VALIDATION.DATE' }]);
    }
    // The head: the one chosen, else Tuition.
    let head =
      input.headId && isUuid(input.headId)
        ? await this.deps.db
            .selectFrom('fee_heads')
            .select(['id', 'name'])
            .where('institution_id', '=', instId)
            .where('public_id', '=', uuidToBin(input.headId))
            .where('status', '=', 'ACTIVE')
            .executeTakeFirst()
        : await this.deps.db
            .selectFrom('fee_heads')
            .select(['id', 'name'])
            .where('institution_id', '=', instId)
            .where('name', '=', 'Tuition')
            .executeTakeFirst();
    if (!head) {
      if (input.headId) throw new CustomAPIError(422, 'FEE.HEAD_UNKNOWN');
      const pub = newPublicIdPair();
      await this.deps.db
        .insertInto('fee_heads')
        .ignore()
        .values({ public_id: pub.bin, institution_id: instId, name: 'Tuition', sort_order: 1 })
        .execute();
      head = (await this.deps.db
        .selectFrom('fee_heads')
        .select(['id', 'name'])
        .where('institution_id', '=', instId)
        .where('name', '=', 'Tuition')
        .executeTakeFirst())!;
    }
    const pub = newPublicIdPair();
    const now = this.now();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const seq = await trx
          .selectFrom('fee_records')
          .select(sql<number>`COALESCE(MAX(instalment_seq), 0)`.as('m'))
          .where('institution_id', '=', instId)
          .where('student_profile_id', '=', String(st.id))
          .where('year_id', '=', String(y.id))
          .executeTakeFirst();
        const r = await trx
          .insertInto('fee_records')
          .values({
            public_id: pub.bin,
            institution_id: instId,
            year_id: String(y.id),
            student_profile_id: String(st.id),
            source: 'MANUAL',
            instalment_seq: Number(seq?.m ?? 0) + 1,
            label: input.label.trim(),
            due_date: input.dueDate,
            amount_paise: input.amountPaise,
            late_fine_paise: input.lateFinePaise ?? 0,
            remarks: input.remarks?.trim() || null,
            created_by: this.by(p),
            created_at: now,
            updated_at: now,
          })
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('fee_record_heads')
          .values({
            record_id: String(r.insertId),
            head_id: String(head.id),
            name: head.name,
            amount_paise: input.amountPaise,
          })
          .execute();
        await recordAudit(trx, {
          institutionId: instId,
          action: 'FEE_RECORD_CREATED',
          entityType: 'fee_record',
          entityRef: pub.id,
          after: {
            student: input.studentId,
            amount: formatInr(input.amountPaise),
            due: input.dueDate,
          },
        });
        // Client 2026-10-16: the student and parents are told (in the app, and by e-mail).
        await notifyFeeAssigned(
          trx,
          instId,
          String(y.id),
          new Map([[String(st.id), input.amountPaise]]),
          now,
        );
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'FEE.DUPLICATE_RECORD', {
          params: {
            student: nameOf(st.first_name, st.last_name),
            instalment: input.label,
            year: y.label,
          },
        });
      }
      throw e;
    }
    return this.detail(p, pub.id);
  }

  // --- FEE-013 --------------------------------------------------------------------------------------
  /**
   * Asks for a change to an unpaid record's amount, due date or remarks (FR-FEE-07, OI-FEE-08). A
   * checker approves it (maker ≠ checker); an administrator's own request applies at once (ADR-0015).
   * One change waits per record. The amount can't drop below what was already paid, and a new due
   * date falls between today and the year's end.
   */
  async requestChange(
    p: Principal,
    id: string,
    input: {
      amountPaise?: number | undefined;
      dueDate?: string | undefined;
      remarks?: string | null | undefined;
      reason: string;
    },
  ) {
    const by = this.by(p);
    if (!by) throw new NotFoundError();
    if (!isUuid(id)) throw new NotFoundError();
    if (input.amountPaise === undefined && !input.dueDate && input.remarks === undefined) {
      throw new ValidationError([{ field: 'amount', code: 'VALIDATION.REQUIRED' }]);
    }
    const at = this.now();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const i = await this.inst(p);
      await trx
        .selectFrom('institutions')
        .select('id')
        .where('id', '=', i.id)
        .forUpdate()
        .execute();
      const r = await trx
        .selectFrom('fee_records as r')
        .innerJoin('member_profiles as m', 'm.id', 'r.student_profile_id')
        .innerJoin('academic_years as y', 'y.id', 'r.year_id')
        .select([
          'r.id',
          'r.public_id',
          'r.status',
          'r.label',
          'r.amount_paise',
          'r.paid_paise',
          'r.due_date',
          'r.remarks',
          'r.row_version',
          'm.first_name',
          'm.last_name',
          'y.ends_on',
          'y.label as year_label',
          'y.status as year_status',
        ])
        .where('r.institution_id', '=', String(i.id))
        .where('r.public_id', '=', uuidToBin(id))
        .forUpdate()
        .executeTakeFirst();
      if (!r) throw new NotFoundError();
      if (!['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(r.status)) {
        throw new CustomAPIError(409, 'FEE.RECORD_PAID');
      }
      if (r.year_status === 'CLOSED') {
        throw new CustomAPIError(409, 'FEE.YEAR_CLOSED', { params: { year: r.year_label } });
      }
      const waiting = await trx
        .selectFrom('approval_requests')
        .select('id')
        .where('module', '=', 'FEE_RECORD_CHANGE')
        .where('subject_ref', '=', r.public_id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (waiting) throw new CustomAPIError(409, 'FEE.CHANGE_PENDING');
      const errors: { field: string; code: 'VALIDATION.AMOUNT' | 'VALIDATION.DATE' }[] = [];
      if (
        input.amountPaise !== undefined &&
        (input.amountPaise <= 0 || input.amountPaise < Number(r.paid_paise))
      ) {
        errors.push({ field: 'amount', code: 'VALIDATION.AMOUNT' });
      }
      if (
        input.dueDate &&
        (input.dueDate < istBusinessDate(at) || input.dueDate > day(r.ends_on))
      ) {
        errors.push({ field: 'dueDate', code: 'VALIDATION.DATE' });
      }
      if (errors.length) throw new ValidationError(errors);
      const parts: string[] = [];
      if (input.amountPaise !== undefined && input.amountPaise !== Number(r.amount_paise)) {
        parts.push(`amount ${formatInr(Number(r.amount_paise))} → ${formatInr(input.amountPaise)}`);
      }
      if (input.dueDate && input.dueDate !== day(r.due_date)) {
        parts.push(`due ${day(r.due_date)} → ${input.dueDate}`);
      }
      if (input.remarks !== undefined && (input.remarks?.trim() || null) !== r.remarks) {
        parts.push('remarks');
      }
      if (!parts.length)
        throw new ValidationError([{ field: 'amount', code: 'VALIDATION.REQUIRED' }]);
      const direct = this.deps.members
        ? await this.deps.members.adminSelfApplies(trx as unknown as Kysely<Database>, p)
        : false;
      const payload = {
        record: id,
        version: r.row_version,
        ...(input.amountPaise !== undefined ? { amountPaise: input.amountPaise } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(input.remarks !== undefined ? { remarks: input.remarks?.trim() || null } : {}),
      };
      const raised = await raiseApproval(trx, {
        institutionId: String(i.id),
        module: 'FEE_RECORD_CHANGE',
        summary:
          `${nameOf(r.first_name, r.last_name)} — ${r.label}: ${parts.join('; ')} — ${input.reason.trim()}`.slice(
            0,
            300,
          ),
        payload,
        makerType: 'staff',
        makerRef: by,
        subjectType: 'fee_record',
        subjectRef: r.public_id,
        at,
        appliedDirectly: direct,
      });
      if (direct) await this.applyChange(trx, payload, at);
      return { approvalId: raised.id, no: raised.no, appliedDirectly: direct };
    });
    return { ...out, record: await this.detail(p, id) };
  }

  /**
   * The approved change (MKR-003), re-checked under the record lock: still unpaid and unchanged since
   * the request. The amount difference goes to the record's largest head; a later due date lifts an
   * overdue record and its fine.
   */
  async applyChange(trx: Transaction<Database>, payload: Record<string, unknown>, at: Date) {
    const id = String(payload['record'] ?? '');
    if (!isUuid(id)) throw new NotFoundError();
    const r = await trx
      .selectFrom('fee_records')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    if (
      !['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(r.status) ||
      r.row_version !== Number(payload['version'])
    ) {
      throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    }
    const amount =
      payload['amountPaise'] !== undefined
        ? Number(payload['amountPaise'])
        : Number(r.amount_paise);
    const due = typeof payload['dueDate'] === 'string' ? payload['dueDate'] : day(r.due_date);
    const paid = Number(r.paid_paise);
    if (amount < paid || amount <= 0) throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    const diff = amount - Number(r.amount_paise);
    if (diff) {
      const lines = await trx
        .selectFrom('fee_record_heads')
        .select(['head_id', 'amount_paise'])
        .where('record_id', '=', r.id)
        .orderBy('amount_paise', 'desc')
        .execute();
      const top = lines[0];
      if (top && Number(top.amount_paise) + diff > 0) {
        await trx
          .updateTable('fee_record_heads')
          .set({ amount_paise: sql<string>`amount_paise + ${diff}` })
          .where('record_id', '=', r.id)
          .where('head_id', '=', top.head_id)
          .execute();
      } else {
        throw new ValidationError([{ field: 'amount', code: 'VALIDATION.AMOUNT' }]);
      }
    }
    const lifted = due >= istBusinessDate(at);
    const fineApplied = lifted ? 0 : Number(r.fine_applied);
    const outstanding = amount + (fineApplied ? Number(r.late_fine_paise) : 0) - paid;
    const status =
      outstanding <= 0 ? 'PAID' : lifted ? (paid > 0 ? 'PARTIALLY_PAID' : 'DUE') : r.status;
    await trx
      .updateTable('fee_records')
      .set({
        amount_paise: amount,
        due_date: due,
        fine_applied: fineApplied,
        status,
        ...(payload['remarks'] !== undefined
          ? { remarks: (payload['remarks'] as string | null) ?? null }
          : {}),
        ...(status === 'PAID' ? { paid_at: at } : {}),
        updated_at: at,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', r.id)
      .execute();
    if (status === 'PAID') {
      await trx
        .updateTable('fee_collection_attempts')
        .set({ status: 'CANCELLED', closed_at: at })
        .where('record_id', '=', r.id)
        .where('status', '=', 'PENDING')
        .execute();
    }
    await recordAudit(trx, {
      institutionId: String(r.institution_id),
      action: 'FEE_RECORD_CHANGED',
      entityType: 'fee_record',
      entityRef: id,
      before: {
        amount: formatInr(Number(r.amount_paise)),
        due: day(r.due_date),
        status: r.status,
      },
      after: { amount: formatInr(amount), due, status },
    });
    // The student and parents are told of a new amount or due date (client 2026-10-22).
    const what = [
      ...(amount !== Number(r.amount_paise)
        ? [`amount ${formatInr(Number(r.amount_paise))} → ${formatInr(amount)}`]
        : []),
      ...(due !== day(r.due_date)
        ? [`due date ${formatDate(day(r.due_date))} → ${formatDate(due)}`]
        : []),
    ];
    if (what.length) {
      await tellMembers(
        trx,
        {
          institutionId: String(r.institution_id),
          profileRowIds: [String(r.student_profile_id)],
          titleKey: 'NTF.FEE_CHANGED',
          params: { fee: r.label, what: what.join('; ') },
          body: status === 'PAID' ? 'Nothing more is due on it.' : 'See it in the app under Fees.',
          category: 'PAYMENT',
          link: '/fees',
        },
        at,
      );
    }
  }

  /** What the checker sees: each changed field, before and after. */
  async changeRows(db: Db, payload: Record<string, unknown>) {
    const id = String(payload['record'] ?? '');
    if (!isUuid(id)) return [];
    const r = await db
      .selectFrom('fee_records')
      .select(['amount_paise', 'due_date', 'remarks'])
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) return [];
    const rows: { label: string; from: string; to: string }[] = [];
    if (payload['amountPaise'] !== undefined) {
      rows.push({
        label: 'Amount',
        from: formatInr(Number(r.amount_paise)),
        to: formatInr(Number(payload['amountPaise'])),
      });
    }
    if (typeof payload['dueDate'] === 'string') {
      rows.push({ label: 'Due date', from: day(r.due_date), to: payload['dueDate'] });
    }
    if (payload['remarks'] !== undefined) {
      rows.push({
        label: 'Remarks',
        from: r.remarks ?? '—',
        to: (payload['remarks'] as string | null) ?? '—',
      });
    }
    return rows;
  }

  // --- FEE-016 --------------------------------------------------------------------------------------
  /**
   * Collects the outstanding amount now. A refusal the job can retry (a short balance, a held
   * wallet) keeps the record's pending attempt and answers 202 with it.
   */
  async collect(p: Principal, id: string, idempotencyKey: string) {
    const i = await this.inst(p);
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.deps.db
      .selectFrom('fee_records')
      .selectAll()
      .where('institution_id', '=', String(i.id))
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    const out = await this.attempt(String(i.id), r, 'CONSOLE', idempotencyKey, this.by(p));
    return { ...out, record: await this.detail(p, id) };
  }

  /** One collection try of a record; shared by the console, the member and the job. */
  async attempt(
    institutionId: string,
    r: {
      id: string;
      student_profile_id: string;
      status: FeeRecordStatus;
      financed: number;
      amount_paise: string;
      late_fine_paise: string;
      fine_applied: number;
      paid_paise: string;
      label: string;
    },
    source: 'CONSOLE' | 'JOB' | 'MEMBER',
    idempotencyKey: string,
    actorRef: Buffer | null,
    auth?: { kind: 'pin'; accountId: string; pin: string },
  ): Promise<
    | { collected: true; receipt: { reference: string; amount: ReturnType<typeof toMoneyDto> } }
    | { collected: false; pendingAttempt: { id: string; tries: number; reasonCode: string } }
  > {
    if (!['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(r.status)) {
      throw new CustomAPIError(409, 'FEE.RECORD_PAID');
    }
    if (Number(r.financed)) throw new CustomAPIError(409, 'FEE.FINANCED');
    if (!(await this.toggle(institutionId, 'tuition')))
      throw new CustomAPIError(409, 'FEE.TUITION_OFF');
    if (
      source !== 'MEMBER' &&
      (await this.toggle(institutionId, 'feeConsent')) &&
      !(await this.consentValid(institutionId, String(r.student_profile_id)))
    ) {
      throw new CustomAPIError(409, 'FEE.CONSENT_REQUIRED');
    }
    const inst = await this.deps.db
      .selectFrom('institutions')
      .select('fee_merchant_profile_id')
      .where('id', '=', institutionId)
      .executeTakeFirstOrThrow();
    if (!inst.fee_merchant_profile_id) throw new CustomAPIError(409, 'FEE.NO_FEE_ACCOUNT');
    const amount = outstandingOf(r);
    try {
      const res = await this.deps.engine.pay({
        channel: 'TUITION',
        institutionId,
        payerProfileId: String(r.student_profile_id),
        payeeProfileId: String(inst.fee_merchant_profile_id),
        amountPaise: amount,
        remarks: `Fee: ${r.label}`.slice(0, 140),
        idempotencyKey,
        feeRecordId: String(r.id),
        feeSource: source,
        auth: auth ?? { kind: 'system' },
        actorRef,
      });
      return {
        collected: true,
        receipt: { reference: res.attempt.reference, amount: toMoneyDto(res.attempt.amountPaise) },
      };
    } catch (e) {
      // P-checks (paid meanwhile) and PIN problems are answered as they are; the rest wait.
      if (!(e instanceof PaymentRefusedError) || e.refusal.check.startsWith('P')) throw e;
      if (auth) throw e;
      const ref = (e.extensions as { attempt?: { reference?: string } }).attempt?.reference;
      const engineAttempt = ref
        ? await this.deps.db
            .selectFrom('payment_attempts')
            .select('id')
            .where('reference', '=', ref)
            .executeTakeFirst()
        : undefined;
      const at = this.now();
      await this.deps.db
        .insertInto('fee_collection_attempts')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: institutionId,
          record_id: String(r.id),
          tries: 1,
          last_failure_code: e.code,
          last_tried_at: at,
          payment_attempt_id: engineAttempt ? String(engineAttempt.id) : null,
          created_by: actorRef,
          created_at: at,
        })
        .onDuplicateKeyUpdate({
          tries: sql<number>`tries + 1`,
          last_failure_code: e.code,
          last_tried_at: at,
          payment_attempt_id: engineAttempt ? String(engineAttempt.id) : null,
        })
        .execute();
      const a = await this.deps.db
        .selectFrom('fee_collection_attempts')
        .select(['public_id', 'tries'])
        .where('record_id', '=', String(r.id))
        .where('status', '=', 'PENDING')
        .executeTakeFirstOrThrow();
      return {
        collected: false,
        pendingAttempt: { id: binToUuid(a.public_id), tries: a.tries, reasonCode: e.code },
      };
    }
  }

  // --- FEE-018 --------------------------------------------------------------------------------------
  async attempts(p: Principal, f: { status?: 'PENDING' | 'SUCCEEDED' | 'CANCELLED' | undefined }) {
    const i = await this.inst(p);
    const rows = await this.deps.db
      .selectFrom('fee_collection_attempts as a')
      .innerJoin('fee_records as r', 'r.id', 'a.record_id')
      .innerJoin('member_profiles as m', 'm.id', 'r.student_profile_id')
      .select([
        'a.public_id',
        'a.status',
        'a.tries',
        'a.last_failure_code',
        'a.last_tried_at',
        'a.created_at',
        'r.public_id as record_public_id',
        'r.label',
        'r.amount_paise',
        'r.late_fine_paise',
        'r.fine_applied',
        'r.paid_paise',
        'm.first_name',
        'm.last_name',
      ])
      .where('a.institution_id', '=', String(i.id))
      .where('a.status', '=', f.status ?? 'PENDING')
      .orderBy('a.id', 'desc')
      .limit(500)
      .execute();
    return {
      items: rows.map((a) => ({
        id: binToUuid(a.public_id),
        status: a.status,
        tries: a.tries,
        lastFailureCode: a.last_failure_code,
        lastTriedAt: iso(a.last_tried_at),
        createdAt: iso(a.created_at),
        record: { id: binToUuid(a.record_public_id), label: a.label },
        student: { name: nameOf(a.first_name, a.last_name) },
        outstanding: toMoneyDto(outstandingOf(a)),
      })),
    };
  }

  // --- FEE-017 --------------------------------------------------------------------------------------
  async report(
    p: Principal,
    f: { yearId?: string | undefined; from?: string | undefined; to?: string | undefined },
  ) {
    const i = await this.inst(p);
    const instId = String(i.id);
    let q = this.deps.db
      .selectFrom('fee_records as r')
      .innerJoin('academic_years as y', 'y.id', 'r.year_id')
      .leftJoin('enrolments as e', (j) =>
        j
          .onRef('e.student_profile_id', '=', 'r.student_profile_id')
          .onRef('e.year_id', '=', 'r.year_id'),
      )
      .leftJoin('sections as sec', 'sec.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 'sec.class_id')
      .select([
        'c.name as class_name',
        'sec.name as section_name',
        sql<number>`COUNT(*)`.as('records'),
        sql<number>`COUNT(DISTINCT r.student_profile_id)`.as('students'),
        sql<string>`COALESCE(SUM(CASE WHEN r.status <> 'CANCELLED' THEN r.amount_paise + IF(r.fine_applied, r.late_fine_paise, 0) ELSE 0 END), 0)`.as(
          'billed',
        ),
        sql<string>`COALESCE(SUM(r.paid_paise), 0)`.as('collected'),
        sql<number>`SUM(r.status = 'OVERDUE')`.as('overdue'),
      ])
      .where('r.institution_id', '=', instId);
    if (f.yearId) {
      if (!isUuid(f.yearId)) return { rows: [], totals: null };
      q = q.where('y.public_id', '=', uuidToBin(f.yearId));
    }
    if (f.from) q = q.where('r.due_date', '>=', f.from);
    if (f.to) q = q.where('r.due_date', '<=', f.to);
    const rows = await q
      .groupBy(['c.name', 'sec.name', 'c.sort_order'])
      .orderBy('c.sort_order')
      .orderBy('sec.name')
      .execute();
    const out = rows.map((r) => {
      const billed = Number(r.billed);
      const collected = Number(r.collected);
      return {
        classSection: r.class_name
          ? `${r.class_name} ${r.section_name ?? ''}`.trim()
          : 'Not enrolled',
        students: Number(r.students),
        records: Number(r.records),
        billed: toMoneyDto(billed),
        collected: toMoneyDto(collected),
        outstanding: toMoneyDto(Math.max(0, billed - collected)),
        overdue: Number(r.overdue ?? 0),
      };
    });
    const sum = (k: 'billed' | 'collected' | 'outstanding') =>
      toMoneyDto(
        rows.reduce(
          (a, r) =>
            a +
            (k === 'billed'
              ? Number(r.billed)
              : k === 'collected'
                ? Number(r.collected)
                : Math.max(0, Number(r.billed) - Number(r.collected))),
          0,
        ),
      );
    void instId;
    return {
      rows: out,
      totals: {
        students: out.reduce((a, r) => a + r.students, 0),
        records: out.reduce((a, r) => a + r.records, 0),
        billed: sum('billed'),
        collected: sum('collected'),
        outstanding: sum('outstanding'),
        overdue: out.reduce((a, r) => a + r.overdue, 0),
      },
    };
  }

  /**
   * Right after money reaches a student's wallet (a bank credit, a released hold), the student's
   * pending collections are tried once (Q14 M9: "every 30 minutes and right after a top-up"). Keys
   * are the job's (`FEE-RETRY:<attempt>:<n>`), so a top-up and a job run never pay twice.
   */
  async retryForStudent(institutionId: string, studentRowId: string) {
    const pending = await this.deps.db
      .selectFrom('fee_collection_attempts as a')
      .innerJoin('fee_records as r', 'r.id', 'a.record_id')
      .select([
        'a.id as attempt_id',
        'a.tries',
        'r.id',
        'r.student_profile_id',
        'r.status',
        'r.financed',
        'r.amount_paise',
        'r.late_fine_paise',
        'r.fine_applied',
        'r.paid_paise',
        'r.label',
      ])
      .where('a.status', '=', 'PENDING')
      .where('a.institution_id', '=', institutionId)
      .where('r.student_profile_id', '=', studentRowId)
      .orderBy('r.due_date')
      .execute();
    let collected = 0;
    for (const a of pending) {
      if (!['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(a.status)) continue;
      try {
        const out = await this.attempt(
          institutionId,
          a,
          'JOB',
          `FEE-RETRY:${a.attempt_id}:${a.tries + 1}`,
          null,
        );
        if (out.collected) collected++;
      } catch (e) {
        // Tuition off, consent lapsed, financed meanwhile: the job reports it on its next run.
        if (!(e instanceof CustomAPIError)) throw e;
      }
    }
    return { collected };
  }

  // --- job fee-retry (13.15; Q14 M9) ----------------------------------------------------------------
  /**
   * Marks unpaid records past their due date OVERDUE (the late fine applies once), then retries every
   * pending attempt once. A try is keyed by the attempt and its try number, so a re-run of the same
   * run never pays twice; a consent or financing change is honoured at each try.
   */
  async retry(ctx: Pick<JobContext, 'item' | 'periodKey'>, scope?: { institutionId: string }) {
    const today = istBusinessDate(this.now());
    let overdueQ = this.deps.db
      .updateTable('fee_records')
      .set({
        status: 'OVERDUE',
        fine_applied: sql<number>`late_fine_paise > 0`,
        updated_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('status', 'in', ['DUE', 'PARTIALLY_PAID'])
      .where('due_date', '<', today);
    if (scope) overdueQ = overdueQ.where('institution_id', '=', scope.institutionId);
    const overdue = await overdueQ.executeTakeFirst();
    let q = this.deps.db
      .selectFrom('fee_collection_attempts as a')
      .innerJoin('fee_records as r', 'r.id', 'a.record_id')
      .select([
        'a.id as attempt_id',
        'a.tries',
        'a.institution_id',
        'r.id',
        'r.student_profile_id',
        'r.status',
        'r.financed',
        'r.amount_paise',
        'r.late_fine_paise',
        'r.fine_applied',
        'r.paid_paise',
        'r.label',
      ])
      .where('a.status', '=', 'PENDING');
    if (scope) q = q.where('a.institution_id', '=', scope.institutionId);
    const pending = await q.orderBy('a.institution_id').orderBy('a.id').execute();
    const byInst = new Map<string, typeof pending>();
    for (const a of pending) {
      const k = String(a.institution_id);
      byInst.set(k, [...(byInst.get(k) ?? []), a]);
    }
    let collected = 0;
    let waiting = 0;
    for (const [instId, items] of byInst) {
      {
        let ok = 0;
        let still = 0;
        for (const a of items) {
          if (!['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(a.status)) {
            await this.deps.db
              .updateTable('fee_collection_attempts')
              .set({ status: 'CANCELLED', closed_at: this.now() })
              .where('id', '=', a.attempt_id)
              .where('status', '=', 'PENDING')
              .execute();
            continue;
          }
          try {
            const out = await this.attempt(
              instId,
              a,
              'JOB',
              `FEE-RETRY:${a.attempt_id}:${a.tries + 1}`,
              null,
            );
            if (out.collected) ok++;
            else still++;
          } catch (e) {
            if (!(e instanceof CustomAPIError)) throw e;
            still++;
            await this.deps.db
              .updateTable('fee_collection_attempts')
              .set({
                last_failure_code: e.code,
                last_tried_at: this.now(),
                tries: sql<number>`tries + 1`,
              })
              .where('id', '=', a.attempt_id)
              .where('status', '=', 'PENDING')
              .execute();
          }
        }
        collected += ok;
        waiting += still;
        ctx.item({
          institutionId: instId,
          status: 'SUCCESS',
          processed: ok,
          failed: 0,
          note: `collected ${ok}, still waiting ${still}`,
        });
      }
    }
    return { overdue: Number(overdue.numUpdatedRows), collected, waiting };
  }
}

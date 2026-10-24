/**
 * Fee financing (SRS 13.11–13.12, FR-FEE-11; FEE-024…027, FEE-038, FEE-042; prototype m.financing).
 * An example contract until the partner is named (OQ-03, OI-FEE-17, OI-INT-02):
 *
 * - The institution registers a student (FEE-025), or — while `fee.financing.memberRegisters` is on —
 *   the family asks from the app (FEE-042). One live registration per student. The unpaid records of
 *   the current academic year are offered; the partner receives the minimum data (RNG-GOV-007).
 * - The partner decides on its signed, replay-safe webhook (FEE-026): approved — the records become
 *   financed and are never debited from the wallet (pending collections end); rejected — with its
 *   reason, and a new registration may follow; paid — the financed records are marked paid with the
 *   partner's reference, without a ledger posting (the money doesn't pass through a campus wallet).
 * - The partner reads a registered student's fee details by its reference (FEE-027).
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { FinancingPartner } from '../integrations/financing.provider';
import type { Database, FinancingStatus } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { formatAmount, toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { outstandingOf } from './payment-engine.service';
import { defaultValues, type SettingValues } from './settings.service';
import { usesProfile } from './member-roles';

const day = (d: Date | string) => istBusinessDate(new Date(d));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null, last: string | null) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const UNPAID = ['DUE', 'OVERDUE', 'PARTIALLY_PAID'] as const;
const STATUS_LABEL: Readonly<Record<FinancingStatus, string>> = {
  PENDING: 'Pending',
  SUCCESS: 'Success',
  FAILED: 'Failed',
};

export interface FinancingWebhook {
  readonly eventId: string;
  readonly partnerRef: string;
  readonly event: 'APPROVED' | 'REJECTED' | 'PAID';
  readonly reason?: string | undefined;
  /** PAID: the records paid (their ids from FEE-027); all financed ones when absent. */
  readonly recordIds?: readonly string[] | undefined;
  readonly paidOn?: string | undefined;
}

export class FinancingService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly partner: FinancingPartner;
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

  /** The student with class and the current year, in the institution. */
  private async student(institutionId: string, where: { rowId?: string; publicId?: string }) {
    let q = this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('academic_years as y', (j) =>
        j.onRef('y.institution_id', '=', 'm.institution_id').on('y.is_current', '=', 1),
      )
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').onRef('en.year_id', '=', 'y.id'),
      )
      .leftJoin('sections as s', 's.id', 'en.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'ut.category',
        'y.id as year_id',
        'y.starts_on',
        'y.ends_on',
        'c.name as class_name',
        's.name as section_name',
      ])
      .where('m.institution_id', '=', institutionId);
    if (where.rowId) q = q.where('m.id', '=', where.rowId);
    else if (where.publicId && isUuid(where.publicId)) {
      q = q.where('m.public_id', '=', uuidToBin(where.publicId));
    } else throw new NotFoundError();
    const m = await q.executeTakeFirst();
    if (!m || m.category !== 'STUDENT') throw new CustomAPIError(422, 'FEE.NOT_A_STUDENT');
    return {
      rowId: String(m.id),
      id: binToUuid(m.public_id),
      name: nameOf(m.first_name, m.last_name),
      admissionNo: m.admission_no,
      classSection: m.class_name ? `${m.class_name} ${m.section_name ?? ''}`.trim() : null,
      year: m.year_id
        ? { rowId: String(m.year_id), from: day(m.starts_on!), to: day(m.ends_on!) }
        : null,
    };
  }

  /** The member's own profile or a child's on the account (CR-04, `for`). */
  private async memberTarget(p: Principal, forProfile?: string) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const wanted = forProfile ?? p.profileId;
    if (!wanted || !isUuid(wanted)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select(['m.id', 'm.institution_id', 'ut.category'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(wanted))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    // Financing is for a student's fees: a parent's own profile is refused, not offered.
    if (m.category !== 'STUDENT') throw new CustomAPIError(422, 'FEE.NOT_A_STUDENT');
    return { rowId: String(m.id), institutionId: String(m.institution_id) };
  }

  private async live(institutionId: string, studentRowId: string) {
    return this.deps.db
      .selectFrom('fee_financing_registrations')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('student_profile_id', '=', studentRowId)
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  private async recordsOf(registrationId: string) {
    return this.deps.db
      .selectFrom('fee_financing_records as fr')
      .innerJoin('fee_records as r', 'r.id', 'fr.record_id')
      .select([
        'r.id',
        'r.public_id',
        'r.label',
        'r.due_date',
        'r.amount_paise',
        'r.late_fine_paise',
        'r.fine_applied',
        'r.paid_paise',
        'r.status',
        'r.financed',
      ])
      .where('fr.registration_id', '=', registrationId)
      .orderBy('r.due_date')
      .execute();
  }

  private recordView(r: Awaited<ReturnType<FinancingService['recordsOf']>>[number]) {
    return {
      id: binToUuid(r.public_id),
      label: r.label,
      dueDate: day(r.due_date),
      amount: toMoneyDto(Number(r.amount_paise)),
      outstanding: toMoneyDto(
        UNPAID.includes(r.status as never) ? Math.max(0, outstandingOf(r)) : 0,
      ),
      status: r.status,
      financed: !!Number(r.financed),
    };
  }

  // --- FEE-025 / FEE-042 ----------------------------------------------------------------------------
  private async register(
    institutionId: string,
    institutionName: string,
    studentRowId: string,
    recordIds: readonly string[] | undefined,
    by: { type: 'STAFF' | 'MEMBER'; ref: Buffer | null },
  ) {
    const st = await this.student(institutionId, { rowId: studentRowId });
    const today = istBusinessDate(this.now());
    // OI-FEE-17: only the current year's unpaid, unfinanced records (the year includes today).
    if (!st.year || st.year.from > today || st.year.to < today) {
      throw new CustomAPIError(422, 'FEE.FINANCING_NOT_ELIGIBLE');
    }
    let q = this.deps.db
      .selectFrom('fee_records')
      .select([
        'id',
        'public_id',
        'label',
        'due_date',
        'amount_paise',
        'late_fine_paise',
        'fine_applied',
        'paid_paise',
        'status',
        'financed',
      ])
      .where('institution_id', '=', institutionId)
      .where('student_profile_id', '=', studentRowId)
      .where('year_id', '=', st.year.rowId)
      .where('status', 'in', [...UNPAID])
      .where('financed', '=', 0);
    if (recordIds?.length) {
      if (!recordIds.every(isUuid)) throw new CustomAPIError(422, 'FEE.FINANCING_NOT_ELIGIBLE');
      q = q.where(
        'public_id',
        'in',
        recordIds.map((r) => uuidToBin(r)),
      );
    }
    const records = await q.orderBy('due_date').execute();
    if (!records.length || (recordIds?.length && records.length !== new Set(recordIds).size)) {
      throw new CustomAPIError(422, 'FEE.FINANCING_NOT_ELIGIBLE');
    }
    const pub = newPublicIdPair();
    const partnerRef = `RPFN${randomBytes(8).toString('hex').toUpperCase()}`;
    const at = this.now();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const ins = await trx
          .insertInto('fee_financing_registrations')
          .values({
            public_id: pub.bin,
            institution_id: institutionId,
            student_profile_id: studentRowId,
            partner_ref: partnerRef,
            partner_name: this.deps.partner.name,
            requested_by_type: by.type,
            requested_by: by.ref,
            created_at: at,
          })
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('fee_financing_records')
          .values(
            records.map((r) => ({
              registration_id: String(ins.insertId),
              record_id: String(r.id),
            })),
          )
          .execute();
        await recordAudit(trx, {
          institutionId,
          action: 'FEE_FINANCING_REGISTERED',
          entityType: 'fee_financing',
          entityRef: pub.id,
          after: { student: st.id, records: records.length, by: by.type, partnerRef },
        });
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        const cur = await this.live(institutionId, studentRowId);
        throw new CustomAPIError(409, 'FEE.FINANCING_EXISTS', {
          params: { student: st.name, status: cur ? STATUS_LABEL[cur.status] : 'Pending' },
        });
      }
      throw e;
    }
    // The partner gets the minimum data (RNG-GOV-007). A partner that isn't connected yet leaves the
    // registration pending, so nothing is lost.
    const sent = await this.deps.partner.register({
      reference: partnerRef,
      institution: institutionName,
      student: { name: st.name, admissionNo: st.admissionNo, classSection: st.classSection },
      records: records.map((r) => ({
        label: r.label,
        dueDate: day(r.due_date),
        amount: formatAmount(Math.max(0, outstandingOf(r))),
      })),
    });
    return { id: pub.id, sent: sent.sent, test: sent.sent && sent.test };
  }

  private async view(institutionId: string, registrationRowId: string) {
    const g = await this.deps.db
      .selectFrom('fee_financing_registrations as g')
      .innerJoin('member_profiles as m', 'm.id', 'g.student_profile_id')
      .selectAll('g')
      .select(['m.public_id as student_public_id', 'm.first_name', 'm.last_name', 'm.admission_no'])
      .where('g.institution_id', '=', institutionId)
      .where('g.id', '=', registrationRowId)
      .executeTakeFirstOrThrow();
    const records = await this.recordsOf(String(g.id));
    return {
      id: binToUuid(g.public_id),
      partnerRef: g.partner_ref,
      partnerName: g.partner_name,
      status: g.status,
      requestedBy: g.requested_by_type,
      failureReason: g.failure_reason,
      student: {
        id: binToUuid(g.student_public_id),
        name: nameOf(g.first_name, g.last_name),
        admissionNo: g.admission_no,
      },
      records: records.map((r) => this.recordView(r)),
      total: toMoneyDto(records.reduce((a, r) => a + Number(r.amount_paise), 0)),
      createdAt: iso(g.created_at),
      decidedAt: iso(g.decided_at),
      version: g.row_version,
    };
  }

  // --- FEE-024 --------------------------------------------------------------------------------------
  async list(p: Principal, f: { status?: FinancingStatus | undefined }) {
    const i = await this.inst(p);
    let q = this.deps.db
      .selectFrom('fee_financing_registrations')
      .select('id')
      .where('institution_id', '=', i.id);
    if (f.status) q = q.where('status', '=', f.status);
    const rows = await q.orderBy('id', 'desc').limit(200).execute();
    return {
      items: await Promise.all(rows.map((r) => this.view(i.id, String(r.id)))),
      partner: { name: this.deps.partner.name, mode: this.deps.partner.mode },
    };
  }

  // --- FEE-025 --------------------------------------------------------------------------------------
  async registerByInstitution(
    p: Principal,
    input: { studentProfileId: string; recordIds?: readonly string[] | undefined },
  ) {
    const i = await this.inst(p);
    const st = await this.student(i.id, { publicId: input.studentProfileId });
    const out = await this.register(i.id, i.name, st.rowId, input.recordIds, {
      type: 'STAFF',
      ref: isUuid(p.subject) ? uuidToBin(p.subject) : null,
    });
    const g = await this.deps.db
      .selectFrom('fee_financing_registrations')
      .select('id')
      .where('public_id', '=', uuidToBin(out.id))
      .executeTakeFirstOrThrow();
    return { ...(await this.view(i.id, String(g.id))), sent: out.sent, test: out.test };
  }

  // --- FEE-038 --------------------------------------------------------------------------------------
  async mine(p: Principal, forProfile?: string) {
    const t = await this.memberTarget(p, forProfile);
    const g = await this.live(t.institutionId, t.rowId);
    const memberMay = (await this.limit(LIMITS.feeFinancingMemberRegisters)) === 1;
    return {
      status: g ? g.status : ('NOT_REGISTERED' as const),
      partnerName: g?.partner_name ?? this.deps.partner.name,
      partnerRef: g?.partner_ref ?? null,
      failureReason: g?.failure_reason ?? null,
      registeredAt: iso(g?.created_at),
      decidedAt: iso(g?.decided_at),
      records: g ? (await this.recordsOf(String(g.id))).map((r) => this.recordView(r)) : [],
      canRegister: memberMay && (!g || g.status === 'FAILED'),
      sharedData: ['name', 'class', 'admission number', 'fee details'],
    };
  }

  // --- FEE-042 --------------------------------------------------------------------------------------
  async registerByMember(p: Principal, forProfile?: string) {
    if ((await this.limit(LIMITS.feeFinancingMemberRegisters)) !== 1) {
      throw new CustomAPIError(409, 'FEE.FINANCING_BY_SCHOOL');
    }
    const t = await this.memberTarget(p, forProfile);
    const inst = await this.deps.db
      .selectFrom('institutions')
      .select('name')
      .where('id', '=', t.institutionId)
      .executeTakeFirstOrThrow();
    const out = await this.register(t.institutionId, inst.name, t.rowId, undefined, {
      type: 'MEMBER',
      ref: isUuid(p.subject) ? uuidToBin(p.subject) : null,
    });
    return { ...(await this.mine(p, forProfile)), sent: out.sent, test: out.test };
  }

  // --- FEE-026 --------------------------------------------------------------------------------------
  /** The partner's decision or payment; run once per event id by the caller (partners.once). */
  async webhook(w: FinancingWebhook) {
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const g = await trx
        .selectFrom('fee_financing_registrations')
        .selectAll()
        .where('partner_ref', '=', w.partnerRef)
        .forUpdate()
        .executeTakeFirst();
      if (!g) throw new NotFoundError();
      const links = await trx
        .selectFrom('fee_financing_records')
        .select('record_id')
        .where('registration_id', '=', g.id)
        .execute();
      const recordRowIds = links.map((l) => String(l.record_id));
      if (w.event === 'APPROVED' || w.event === 'REJECTED') {
        if (g.status !== 'PENDING') throw new CustomAPIError(409, 'FEE.FINANCING_DECIDED');
        const to: FinancingStatus = w.event === 'APPROVED' ? 'SUCCESS' : 'FAILED';
        await trx
          .updateTable('fee_financing_registrations')
          .set({
            status: to,
            decided_at: at,
            failure_reason:
              to === 'FAILED' ? (w.reason ?? 'Rejected by the partner').slice(0, 300) : null,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', g.id)
          .where('status', '=', 'PENDING')
          .execute();
        if (to === 'SUCCESS' && recordRowIds.length) {
          await trx
            .updateTable('fee_records')
            .set({ financed: 1, updated_at: at, row_version: sql<number>`row_version + 1` })
            .where('id', 'in', recordRowIds)
            .where('status', 'in', [...UNPAID])
            .execute();
          // Financed records are never debited: their pending collections end.
          await trx
            .updateTable('fee_collection_attempts')
            .set({ status: 'CANCELLED', closed_at: at })
            .where('record_id', 'in', recordRowIds)
            .where('status', '=', 'PENDING')
            .execute();
        }
        await recordAudit(trx, {
          institutionId: String(g.institution_id),
          action: to === 'SUCCESS' ? 'FEE_FINANCING_APPROVED' : 'FEE_FINANCING_REJECTED',
          entityType: 'fee_financing',
          entityRef: binToUuid(g.public_id),
          after: { partnerRef: g.partner_ref, eventId: w.eventId, reason: w.reason ?? null },
        });
        return { partnerRef: g.partner_ref, status: to, recordsPaid: 0 };
      }
      // PAID: the partner paid the school for financed records (no wallet debit, no posting).
      if (g.status !== 'SUCCESS') throw new CustomAPIError(409, 'FEE.FINANCING_DECIDED');
      let targets = recordRowIds;
      if (w.recordIds?.length) {
        if (!w.recordIds.every(isUuid)) {
          throw new ValidationError([{ field: 'recordIds', code: 'VALIDATION.FORMAT' }]);
        }
        const chosen = recordRowIds.length
          ? await trx
              .selectFrom('fee_records')
              .select('id')
              .where('id', 'in', recordRowIds)
              .where(
                'public_id',
                'in',
                w.recordIds.map((r) => uuidToBin(r)),
              )
              .execute()
          : [];
        if (chosen.length !== new Set(w.recordIds).size) throw new NotFoundError();
        targets = chosen.map((c) => String(c.id));
      }
      const paidOn = w.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(w.paidOn) ? w.paidOn : null;
      const res = targets.length
        ? await trx
            .updateTable('fee_records')
            .set({
              status: 'PAID',
              paid_paise: sql<string>`amount_paise + IF(fine_applied, late_fine_paise, 0)`,
              paid_at: paidOn ? new Date(`${paidOn}T12:00:00+05:30`) : at,
              paid_reference: `FIN-${w.eventId}`.slice(0, 40),
              updated_at: at,
              row_version: sql<number>`row_version + 1`,
            })
            .where('id', 'in', targets)
            .where('financed', '=', 1)
            .where('status', 'in', [...UNPAID])
            .executeTakeFirst()
        : { numUpdatedRows: 0n };
      await recordAudit(trx, {
        institutionId: String(g.institution_id),
        action: 'FEE_FINANCING_PAID',
        entityType: 'fee_financing',
        entityRef: binToUuid(g.public_id),
        after: { eventId: w.eventId, records: Number(res.numUpdatedRows) },
      });
      return {
        partnerRef: g.partner_ref,
        status: g.status,
        recordsPaid: Number(res.numUpdatedRows),
      };
    });
  }

  // --- FEE-027 --------------------------------------------------------------------------------------
  /** The minimum the partner may read about a registered student (RNG-GOV-007). */
  async partnerFees(partnerRef: string) {
    const g = await this.deps.db
      .selectFrom('fee_financing_registrations as g')
      .innerJoin('institutions as i', 'i.id', 'g.institution_id')
      .select([
        'g.id',
        'g.institution_id',
        'g.student_profile_id',
        'g.partner_ref',
        'g.status',
        'i.name as institution_name',
      ])
      .where('g.partner_ref', '=', partnerRef)
      .executeTakeFirst();
    if (!g) throw new NotFoundError();
    const st = await this.student(String(g.institution_id), {
      rowId: String(g.student_profile_id),
    });
    const records = await this.recordsOf(String(g.id));
    return {
      partnerRef: g.partner_ref,
      status: g.status,
      institution: g.institution_name,
      student: { name: st.name, admissionNo: st.admissionNo, classSection: st.classSection },
      records: records.map((r) => this.recordView(r)),
    };
  }
}

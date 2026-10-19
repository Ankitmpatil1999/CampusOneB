/**
 * Enrolments, transfers, corrections into a closed year and the year roll-over (SRS 20.10, 20.40.1;
 * ACA-027…033; CR-13 RNG-ACA-445…457; RC-23; OI-ACA-59/60 proposals; prototype c.enrol).
 *
 * - A student holds one enrolment per academic year, dated inside it. A transfer moves the student to
 *   another section of the same class (a reason is kept); moving up a class happens at roll-over.
 * - Every placement writes a change row; nothing is overwritten (RNG-ACA-445).
 * - A closed year refuses changes; a correction into it goes through the approvals queue (coordinator
 *   maker, administrator checker — module ACADEMIC_CORRECTION) and is recorded as an adjustment
 *   carrying the closed year, which stays closed (OI-ACA-60).
 * - Roll-over (RNG-ACA-451…455): proposed from the class order (the same section name where it exists),
 *   amended per student (promote, repeat, leave), committed as a whole into the next year. A leaver is
 *   recorded and kept. Families are told of each new placement.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, RolloverOutcome } from '../models/ringpe_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import {
  assertInYear,
  assertOpen,
  institutionOf,
  nextYear,
  yearFor,
  yearView,
  type Year,
} from './academic-year';
import { raiseApproval } from './approvals.service';
import { recordAudit } from './audit.service';
import { notify } from './notifications.service';

type Db = Kysely<Database> | Transaction<Database>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string | null) =>
  d === null ? null : typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d);

export class EnrolmentsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly members?: { adminSelfApplies(db: Kysely<Database>, p: Principal): Promise<boolean> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private today() {
    return istBusinessDate(this.now());
  }

  private reason(value: string | undefined, min: number, max: number) {
    const r = (value ?? '').trim();
    if (r.length < min || r.length > max) {
      throw new ValidationError([{ field: 'reason', code: 'ACA.REASON', params: { min, max } }]);
    }
    return r;
  }

  private async section(db: Db, institutionId: string, id: string | undefined) {
    if (!id || !isUuid(id)) throw new NotFoundError();
    const s = await db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.id', 's.name', 's.class_id', 'c.name as class_name', 'c.sort_order'])
      .where('s.public_id', '=', uuidToBin(id))
      .where('s.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!s) throw new NotFoundError();
    return { id: String(s.id), classId: String(s.class_id), label: `${s.class_name} ${s.name}` };
  }

  /** Tells a student's own account and their guardians of a new placement. */
  private async tell(
    trx: Transaction<Database>,
    institutionId: string,
    studentId: string,
    v: { name: string; section: string; year: string },
    at: Date,
  ) {
    const owner = await trx
      .selectFrom('member_profiles')
      .select('account_id')
      .where('id', '=', studentId)
      .executeTakeFirst();
    const guardians = await trx
      .selectFrom('guardianships as g')
      .innerJoin('member_profiles as m', 'm.id', 'g.guardian_profile_id')
      .select('m.account_id')
      .where('g.ward_profile_id', '=', studentId)
      .where('m.account_id', 'is not', null)
      .execute();
    const accounts = [owner?.account_id, ...guardians.map((g) => g.account_id)].filter(
      (a): a is string => !!a,
    );
    // Parents without the app are e-mailed too (client 2026-10-16).
    await notify(
      trx,
      {
        institutionId,
        accountIds: accounts.map(String),
        about: [studentId],
        surface: 'MEMBER',
        category: 'ACCOUNT',
        titleKey: 'NTF.CLASS_PLACED',
        params: v,
        body: `${v.section} · ${v.year}`,
      },
      at,
    );
  }

  private change(
    trx: Transaction<Database>,
    v: {
      institutionId: string;
      studentId: string;
      yearId: string;
      kind: 'ENROLLED' | 'TRANSFERRED' | 'CORRECTED' | 'ROLLED_OVER' | 'LEFT';
      from: string | null;
      to: string | null;
      on: string;
      reason?: string | null;
      approvalId?: string | null;
      actor: Buffer | null;
      at: Date;
    },
  ) {
    return trx
      .insertInto('enrolment_changes')
      .values({
        institution_id: v.institutionId,
        student_profile_id: v.studentId,
        year_id: v.yearId,
        kind: v.kind,
        from_section_id: v.from,
        to_section_id: v.to,
        effective_on: v.on,
        reason: v.reason ?? null,
        approval_id: v.approvalId ?? null,
        actor_ref: v.actor,
        at: v.at,
      })
      .execute();
  }

  // --- ACA-027 --------------------------------------------------------------------------------------------
  async list(
    p: Principal,
    f: {
      yearId?: string | undefined;
      classId?: string | undefined;
      sectionId?: string | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    let q = this.deps.db
      .selectFrom('enrolments as e')
      .innerJoin('member_profiles as m', 'm.id', 'e.student_profile_id')
      .innerJoin('sections as s', 's.id', 'e.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'e.id',
        'e.public_id',
        'e.enrolled_on',
        'e.outcome',
        'e.created_at',
        'm.public_id as student_public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'm.status',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.public_id as class_public_id',
        'c.name as class_name',
        (eb) =>
          eb
            .selectFrom('approval_requests as ar')
            .select('ar.public_id')
            .where('ar.module', '=', 'ACADEMIC_CORRECTION')
            .whereRef('ar.subject_ref', '=', 'e.public_id')
            .where('ar.status', '=', 'PENDING')
            .limit(1)
            .as('pending_correction'),
        (eb) =>
          eb
            .selectFrom('enrolment_changes as ch')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ch.student_profile_id', '=', 'e.student_profile_id')
            .whereRef('ch.year_id', '=', 'e.year_id')
            .where('ch.kind', 'in', ['TRANSFERRED', 'CORRECTED'])
            .as('moves'),
      ])
      .where('e.institution_id', '=', inst.id)
      .where('e.year_id', '=', year.id);
    if (f.classId && isUuid(f.classId)) q = q.where('c.public_id', '=', uuidToBin(f.classId));
    if (f.sectionId && isUuid(f.sectionId)) q = q.where('s.public_id', '=', uuidToBin(f.sectionId));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, '')}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql`CONCAT(m.first_name, ' ', COALESCE(m.last_name, ''))`, 'like', like),
          eb('m.admission_no', 'like', like),
        ]),
      );
    }
    const total = await q
      .select(sql<number>`COUNT(*) OVER ()`.as('total'))
      .limit(1)
      .executeTakeFirst();
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('e.id', '>', f.cursor);
    const rows = await q.orderBy('e.id').limit(101).execute();
    const page = rows.slice(0, 100);
    return {
      year: yearView(year),
      total: Number(total?.total ?? 0),
      items: page.map((r) => ({
        id: binToUuid(r.public_id),
        student: {
          id: binToUuid(r.student_public_id),
          name: nameOf(r.first_name, r.last_name),
          admissionNo: r.admission_no,
          status: r.status,
        },
        class: { id: binToUuid(r.class_public_id), name: r.class_name },
        section: { id: binToUuid(r.section_public_id), name: r.section_name },
        enrolledOn: ymd(r.enrolled_on) ?? ymd(r.created_at),
        outcome: r.outcome,
        moves: Number(r.moves ?? 0),
        correctionPending: r.pending_correction ? binToUuid(r.pending_correction) : null,
      })),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  // --- ACA-028 --------------------------------------------------------------------------------------------
  async enrol(
    p: Principal,
    input: {
      yearId?: string | undefined;
      studentId: string;
      sectionId: string;
      enrolledOn?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, input.yearId);
    assertOpen(year);
    const on =
      input.enrolledOn ??
      (this.today() >= year.startsOn && this.today() <= year.endsOn ? this.today() : year.startsOn);
    if (!DAY.test(on))
      throw new ValidationError([{ field: 'enrolledOn', code: 'VALIDATION.DATE' }]);
    assertInYear(year, on, 'enrolledOn');
    if (!isUuid(input.studentId))
      throw new ValidationError([{ field: 'studentId', code: 'ACA.NOT_A_STUDENT' }]);
    const sec = await this.section(this.deps.db, inst.id, input.sectionId);
    const at = this.now();
    let publicId = '';
    await this.deps.db.transaction().execute(async (trx) => {
      const st = await trx
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .select(['m.id', 'm.first_name', 'm.last_name', 'm.status', 'ut.category'])
        .where('m.public_id', '=', uuidToBin(input.studentId))
        .where('m.institution_id', '=', inst.id)
        .forUpdate()
        .executeTakeFirst();
      if (!st || st.category !== 'STUDENT' || st.status !== 'ACTIVE') {
        throw new ValidationError([{ field: 'studentId', code: 'ACA.NOT_A_STUDENT' }]);
      }
      const exists = await trx
        .selectFrom('enrolments')
        .select('id')
        .where('institution_id', '=', inst.id)
        .where('student_profile_id', '=', st.id)
        .where('year_id', '=', year.id)
        .executeTakeFirst();
      if (exists)
        throw new CustomAPIError(409, 'ACA.ALREADY_ENROLLED', { params: { year: year.label } });
      const ins = await trx
        .insertInto('enrolments')
        .values({
          institution_id: inst.id,
          student_profile_id: st.id,
          year_id: year.id,
          section_id: sec.id,
          enrolled_on: on,
          created_by: this.by(p),
        })
        .executeTakeFirstOrThrow();
      const row = await trx
        .selectFrom('enrolments')
        .select('public_id')
        .where('id', '=', String(ins.insertId))
        .executeTakeFirstOrThrow();
      publicId = binToUuid(row.public_id);
      await this.change(trx, {
        institutionId: inst.id,
        studentId: String(st.id),
        yearId: year.id,
        kind: 'ENROLLED',
        from: null,
        to: sec.id,
        on,
        actor: this.by(p),
        at,
      });
      await this.tell(
        trx,
        inst.id,
        String(st.id),
        { name: nameOf(st.first_name, st.last_name), section: sec.label, year: year.label },
        at,
      );
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'STUDENT_ENROLLED',
        entityType: 'enrolment',
        entityRef: publicId,
        after: { section: sec.label, year: year.label, on },
      });
    });
    return this.one(p, publicId);
  }

  private async enrolmentRow(db: Db, institutionId: string, id: string, lock = false) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACA.ENROLMENT_NOT_FOUND');
    let q = db
      .selectFrom('enrolments as e')
      .innerJoin('academic_years as y', 'y.id', 'e.year_id')
      .innerJoin('member_profiles as m', 'm.id', 'e.student_profile_id')
      .innerJoin('sections as s', 's.id', 'e.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'e.id',
        'e.public_id',
        'e.student_profile_id',
        'e.section_id',
        'e.year_id',
        'y.public_id as year_public_id',
        'm.first_name',
        'm.last_name',
        's.class_id',
        's.name as section_name',
        'c.name as class_name',
      ])
      .where('e.public_id', '=', uuidToBin(id))
      .where('e.institution_id', '=', institutionId);
    if (lock) q = q.forUpdate();
    const e = await q.executeTakeFirst();
    if (!e) throw new CustomAPIError(404, 'ACA.ENROLMENT_NOT_FOUND');
    return e;
  }

  async one(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    const e = await this.enrolmentRow(this.deps.db, inst.id, id);
    const year = await yearFor(this.deps.db, inst.id, binToUuid(e.year_public_id));
    const list = await this.list(p, { yearId: year.publicId, sectionId: undefined });
    const item = list.items.find((x) => x.id === id.toLowerCase());
    const history = await this.deps.db
      .selectFrom('enrolment_changes as ch')
      .leftJoin('sections as fs', 'fs.id', 'ch.from_section_id')
      .leftJoin('classes as fc', 'fc.id', 'fs.class_id')
      .leftJoin('sections as ts', 'ts.id', 'ch.to_section_id')
      .leftJoin('classes as tc', 'tc.id', 'ts.class_id')
      .select([
        'ch.kind',
        'ch.effective_on',
        'ch.reason',
        'ch.approval_id',
        'ch.at',
        'fc.name as from_class',
        'fs.name as from_section',
        'tc.name as to_class',
        'ts.name as to_section',
      ])
      .where('ch.institution_id', '=', inst.id)
      .where('ch.student_profile_id', '=', e.student_profile_id)
      .where('ch.year_id', '=', e.year_id)
      .orderBy('ch.id')
      .execute();
    return {
      ...(item ?? {
        id: binToUuid(e.public_id),
        student: {
          id: '',
          name: nameOf(e.first_name, e.last_name),
          admissionNo: null,
          status: 'ACTIVE',
        },
        class: { id: '', name: e.class_name },
        section: { id: '', name: e.section_name },
        enrolledOn: null,
        outcome: null,
        moves: 0,
        correctionPending: null,
      }),
      year: yearView(year),
      history: history.map((h) => ({
        kind: h.kind,
        from: h.from_class ? `${h.from_class} ${h.from_section}` : null,
        to: h.to_class ? `${h.to_class} ${h.to_section}` : null,
        on: ymd(h.effective_on),
        reason: h.reason,
        approved: h.approval_id !== null,
        at: new Date(h.at).toISOString(),
      })),
    };
  }

  // --- ACA-029 --------------------------------------------------------------------------------------------
  async transfer(
    p: Principal,
    id: string,
    input: { sectionId: string; effectiveOn: string; reason: string },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const reason = this.reason(input.reason, 4, 200);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const e = await this.enrolmentRow(trx, inst.id, id, true);
      const year = await yearFor(trx, inst.id, binToUuid(e.year_public_id));
      assertOpen(year);
      if (!DAY.test(input.effectiveOn))
        throw new ValidationError([{ field: 'effectiveOn', code: 'VALIDATION.DATE' }]);
      assertInYear(year, input.effectiveOn, 'effectiveOn');
      const to = await this.section(trx, inst.id, input.sectionId);
      if (to.classId !== String(e.class_id)) {
        throw new ValidationError([{ field: 'sectionId', code: 'ACA.TRANSFER_SAME_CLASS' }]);
      }
      if (to.id === String(e.section_id)) return;
      await trx
        .updateTable('enrolments')
        .set({ section_id: to.id })
        .where('id', '=', e.id)
        .execute();
      await this.change(trx, {
        institutionId: inst.id,
        studentId: String(e.student_profile_id),
        yearId: String(e.year_id),
        kind: 'TRANSFERRED',
        from: String(e.section_id),
        to: to.id,
        on: input.effectiveOn,
        reason,
        actor: this.by(p),
        at,
      });
      await this.tell(
        trx,
        inst.id,
        String(e.student_profile_id),
        { name: nameOf(e.first_name, e.last_name), section: to.label, year: year.label },
        at,
      );
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'STUDENT_TRANSFERRED',
        entityType: 'enrolment',
        entityRef: id,
        before: { section: `${e.class_name} ${e.section_name}` },
        after: { section: to.label, on: input.effectiveOn },
        reason,
      });
    });
    return this.one(p, id);
  }

  // --- ACA-030: a correction into a closed year ------------------------------------------------------------
  async requestCorrection(
    p: Principal,
    input: { enrolmentId: string; sectionId: string; reason: string },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const reason = this.reason(input.reason, 10, 500);
    const by = this.by(p);
    if (!by) throw new NotFoundError();
    const at = this.now();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const e = await this.enrolmentRow(trx, inst.id, input.enrolmentId, true);
      const year = await yearFor(trx, inst.id, binToUuid(e.year_public_id));
      if (!year.closed) {
        throw new CustomAPIError(409, 'ACA.YEAR_STILL_OPEN', { params: { label: year.label } });
      }
      const to = await this.section(trx, inst.id, input.sectionId);
      if (to.id === String(e.section_id)) {
        throw new ValidationError([{ field: 'sectionId', code: 'VALIDATION.FORMAT' }]);
      }
      const waiting = await trx
        .selectFrom('approval_requests')
        .select('id')
        .where('module', '=', 'ACADEMIC_CORRECTION')
        .where('subject_ref', '=', e.public_id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (waiting) throw new CustomAPIError(409, 'ACA.CORRECTION_PENDING');
      const direct = this.deps.members
        ? await this.deps.members.adminSelfApplies(trx as unknown as Kysely<Database>, p)
        : false;
      const payload = {
        enrolment: input.enrolmentId.toLowerCase(),
        section: input.sectionId.toLowerCase(),
        reason,
      };
      const raised = await raiseApproval(trx, {
        institutionId: inst.id,
        module: 'ACADEMIC_CORRECTION',
        summary:
          `${nameOf(e.first_name, e.last_name)} — ${year.label}: ${e.class_name} ${e.section_name} → ${to.label} — ${reason}`.slice(
            0,
            300,
          ),
        payload,
        makerType: 'staff',
        makerRef: by,
        subjectType: 'enrolment',
        subjectRef: e.public_id,
        at,
        appliedDirectly: direct,
      });
      if (direct) await this.applyCorrection(trx, payload, at, null, by);
      return { approvalId: raised.id, appliedDirectly: direct };
    });
    return { ...out, enrolment: await this.one(p, input.enrolmentId) };
  }

  /** The approved correction (MKR-003): the closed year stays closed; the change row names the approval. */
  async applyCorrection(
    trx: Transaction<Database>,
    payload: Record<string, unknown>,
    at: Date,
    approvalId: string | null,
    checker: Buffer | null,
  ) {
    const id = String(payload['enrolment'] ?? '');
    const sectionId = String(payload['section'] ?? '');
    if (!isUuid(id) || !isUuid(sectionId)) throw new NotFoundError();
    const e = await trx
      .selectFrom('enrolments')
      .select(['id', 'institution_id', 'student_profile_id', 'year_id', 'section_id'])
      .where('public_id', '=', uuidToBin(id))
      .forUpdate()
      .executeTakeFirst();
    if (!e) throw new CustomAPIError(404, 'ACA.ENROLMENT_NOT_FOUND');
    const to = await this.section(trx, String(e.institution_id), sectionId);
    await trx.updateTable('enrolments').set({ section_id: to.id }).where('id', '=', e.id).execute();
    await this.change(trx, {
      institutionId: String(e.institution_id),
      studentId: String(e.student_profile_id),
      yearId: String(e.year_id),
      kind: 'CORRECTED',
      from: String(e.section_id),
      to: to.id,
      on: istBusinessDate(at),
      reason: String(payload['reason'] ?? ''),
      approvalId,
      actor: checker,
      at,
    });
  }

  /** What a correction changes, for the approvals queue. */
  async changeRows(db: Db, payload: Record<string, unknown>) {
    const id = String(payload['enrolment'] ?? '');
    const sectionId = String(payload['section'] ?? '');
    if (!isUuid(id) || !isUuid(sectionId)) return [];
    const e = await db
      .selectFrom('enrolments as e')
      .innerJoin('sections as s', 's.id', 'e.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .innerJoin('academic_years as y', 'y.id', 'e.year_id')
      .select(['c.name', 's.name as section', 'y.label', 'e.institution_id'])
      .where('e.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!e) return [];
    const to = await this.section(db, String(e.institution_id), sectionId).catch(() => null);
    return [
      { label: `Class-section · ${e.label}`, from: `${e.name} ${e.section}`, to: to?.label ?? '—' },
    ];
  }

  // --- ACA-031 … ACA-033: the roll-over ---------------------------------------------------------------------
  private async rolloverOf(db: Db, institutionId: string, id: string, lock = false) {
    if (!isUuid(id)) throw new NotFoundError();
    let q = db
      .selectFrom('rollovers')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', institutionId);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  /** ACA-031: the proposal from a year into the next (drawn once from the class order). */
  async proposal(p: Principal, f: { fromYearId?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const from = await yearFor(this.deps.db, inst.id, f.fromYearId);
    const to = await nextYear(this.deps.db, inst.id, from);
    if (!to) throw new CustomAPIError(409, 'ACA.NEXT_YEAR_NEEDED');
    let r = await this.deps.db
      .selectFrom('rollovers')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .where('from_year_id', '=', from.id)
      .where('to_year_id', '=', to.id)
      .executeTakeFirst();
    if (!r) {
      await this.deps.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('academic_years')
          .select('id')
          .where('id', '=', from.id)
          .forUpdate()
          .execute();
        const again = await trx
          .selectFrom('rollovers')
          .select('id')
          .where('institution_id', '=', inst.id)
          .where('from_year_id', '=', from.id)
          .where('to_year_id', '=', to.id)
          .executeTakeFirst();
        if (again) return;
        const ins = await trx
          .insertInto('rollovers')
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: inst.id,
            from_year_id: from.id,
            to_year_id: to.id,
            created_by: this.by(p),
            created_at: this.now(),
          })
          .executeTakeFirstOrThrow();
        await this.draw(trx, inst.id, String(ins.insertId), from);
      });
      r = await this.deps.db
        .selectFrom('rollovers')
        .selectAll()
        .where('institution_id', '=', inst.id)
        .where('from_year_id', '=', from.id)
        .where('to_year_id', '=', to.id)
        .executeTakeFirstOrThrow();
    }
    return this.rolloverView(inst.id, r, from, to);
  }

  /** Draws the items: next class in the order, the same section name where it exists; the last class leaves. */
  private async draw(
    trx: Transaction<Database>,
    institutionId: string,
    rolloverId: string,
    from: Year,
  ) {
    const classes = await trx
      .selectFrom('classes')
      .select(['id', 'sort_order'])
      .where('institution_id', '=', institutionId)
      .orderBy('sort_order')
      .execute();
    const sections = await trx
      .selectFrom('sections')
      .select(['id', 'class_id', 'name'])
      .where('institution_id', '=', institutionId)
      .orderBy('name')
      .execute();
    const enrolled = await trx
      .selectFrom('enrolments as e')
      .innerJoin('sections as s', 's.id', 'e.section_id')
      .innerJoin('member_profiles as m', 'm.id', 'e.student_profile_id')
      .select(['e.student_profile_id', 'e.section_id', 's.class_id', 's.name'])
      .where('e.institution_id', '=', institutionId)
      .where('e.year_id', '=', from.id)
      .where('m.status', '<>', 'INACTIVE')
      .execute();
    if (!enrolled.length) return;
    await trx
      .insertInto('rollover_items')
      .values(
        enrolled.map((e) => {
          const i = classes.findIndex((c) => String(c.id) === String(e.class_id));
          const next = classes[i + 1];
          const secs = next ? sections.filter((s) => String(s.class_id) === String(next.id)) : [];
          const to = secs.find((s) => s.name.toLowerCase() === e.name.toLowerCase()) ?? secs[0];
          return {
            rollover_id: rolloverId,
            student_profile_id: e.student_profile_id,
            from_section_id: e.section_id,
            outcome: (to ? 'PROMOTED' : 'LEFT') as RolloverOutcome,
            to_section_id: to ? String(to.id) : null,
          };
        }),
      )
      .execute();
  }

  private async rolloverView(
    institutionId: string,
    r: {
      id: string;
      public_id: Buffer;
      status: 'PROPOSED' | 'COMMITTED';
      row_version: number;
      committed_at: Date | null;
    },
    from: Year,
    to: Year,
  ) {
    const items = await this.deps.db
      .selectFrom('rollover_items as i')
      .innerJoin('member_profiles as m', 'm.id', 'i.student_profile_id')
      .innerJoin('sections as fs', 'fs.id', 'i.from_section_id')
      .innerJoin('classes as fc', 'fc.id', 'fs.class_id')
      .leftJoin('sections as ts', 'ts.id', 'i.to_section_id')
      .leftJoin('classes as tc', 'tc.id', 'ts.class_id')
      .select([
        'i.outcome',
        'i.amended',
        'm.public_id as student_public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'm.status',
        'fc.name as from_class',
        'fs.name as from_section',
        'fc.sort_order',
        'ts.public_id as to_section_public_id',
        'tc.name as to_class',
        'ts.name as to_section',
      ])
      .where('i.rollover_id', '=', r.id)
      .orderBy('fc.sort_order')
      .orderBy('fs.name')
      .orderBy('m.first_name')
      .execute();
    const count = (o: RolloverOutcome) => items.filter((i) => i.outcome === o).length;
    return {
      id: binToUuid(r.public_id),
      status: r.status,
      from: yearView(from),
      to: yearView(to),
      committedAt: r.committed_at ? new Date(r.committed_at).toISOString() : null,
      counts: { promoted: count('PROMOTED'), repeated: count('REPEATED'), left: count('LEFT') },
      items: items.map((i) => ({
        student: {
          id: binToUuid(i.student_public_id),
          name: nameOf(i.first_name, i.last_name),
          admissionNo: i.admission_no,
          status: i.status,
        },
        from: `${i.from_class} ${i.from_section}`,
        outcome: i.outcome,
        to: i.to_section_public_id
          ? { sectionId: binToUuid(i.to_section_public_id), label: `${i.to_class} ${i.to_section}` }
          : null,
        amended: !!Number(i.amended),
      })),
      version: r.row_version,
    };
  }

  /** A student of a roll-over of the institution, or 404 (looked up before a body is read). */
  async itemOf(p: Principal, rolloverId: string, studentId: string) {
    const inst = await institutionOf(this.deps.db, p);
    const r = await this.rolloverOf(this.deps.db, inst.id, rolloverId);
    if (!isUuid(studentId)) throw new NotFoundError();
    const item = await this.deps.db
      .selectFrom('rollover_items as i')
      .innerJoin('member_profiles as m', 'm.id', 'i.student_profile_id')
      .select('i.student_profile_id')
      .where('i.rollover_id', '=', r.id)
      .where('m.public_id', '=', uuidToBin(studentId))
      .executeTakeFirst();
    if (!item) throw new NotFoundError();
  }

  /** ACA-032: amend one student — promote into a section, repeat (a section of the same class) or leave. */
  async amend(
    p: Principal,
    rolloverId: string,
    studentId: string,
    expected: number,
    input: { outcome: RolloverOutcome; sectionId?: string | null | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    let years: { from: Year; to: Year } | null = null;
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.rolloverOf(trx, inst.id, rolloverId, true);
      if (r.status === 'COMMITTED') throw new CustomAPIError(409, 'ACA.ROLLOVER_COMMITTED');
      if (r.row_version !== expected) throw new PreconditionFailedError();
      if (!isUuid(studentId)) throw new NotFoundError();
      const item = await trx
        .selectFrom('rollover_items as i')
        .innerJoin('member_profiles as m', 'm.id', 'i.student_profile_id')
        .innerJoin('sections as s', 's.id', 'i.from_section_id')
        .select(['i.student_profile_id', 's.class_id'])
        .where('i.rollover_id', '=', r.id)
        .where('m.public_id', '=', uuidToBin(studentId))
        .executeTakeFirst();
      if (!item) throw new NotFoundError();
      let toSection: string | null = null;
      if (input.outcome !== 'LEFT') {
        const to = await this.section(trx, inst.id, input.sectionId ?? undefined).catch(() => null);
        if (!to) throw new ValidationError([{ field: 'sectionId', code: 'ACA.ROLLOVER_SECTION' }]);
        if (input.outcome === 'REPEATED' && to.classId !== String(item.class_id)) {
          throw new ValidationError([{ field: 'sectionId', code: 'ACA.ROLLOVER_SECTION' }]);
        }
        toSection = to.id;
      }
      await trx
        .updateTable('rollover_items')
        .set({ outcome: input.outcome, to_section_id: toSection, amended: 1 })
        .where('rollover_id', '=', r.id)
        .where('student_profile_id', '=', item.student_profile_id)
        .execute();
      await trx
        .updateTable('rollovers')
        .set({ row_version: sql<number>`row_version + 1` })
        .where('id', '=', r.id)
        .execute();
      years = {
        from: await yearFor(
          trx,
          inst.id,
          binToUuid(
            (
              await trx
                .selectFrom('academic_years')
                .select('public_id')
                .where('id', '=', r.from_year_id)
                .executeTakeFirstOrThrow()
            ).public_id,
          ),
        ),
        to: await yearFor(
          trx,
          inst.id,
          binToUuid(
            (
              await trx
                .selectFrom('academic_years')
                .select('public_id')
                .where('id', '=', r.to_year_id)
                .executeTakeFirstOrThrow()
            ).public_id,
          ),
        ),
      };
    });
    const r = await this.rolloverOf(this.deps.db, inst.id, rolloverId);
    return this.rolloverView(inst.id, r, years!['from'], years!['to']);
  }

  /** ACA-033: commit as a whole — new enrolments in the next year; leavers recorded; families told. */
  async commit(p: Principal, rolloverId: string, expected: number) {
    const inst = await institutionOf(this.deps.db, p);
    const at = this.now();
    let years: { from: Year; to: Year } | null = null;
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.rolloverOf(trx, inst.id, rolloverId, true);
      if (r.status === 'COMMITTED') throw new CustomAPIError(409, 'ACA.ROLLOVER_COMMITTED');
      if (r.row_version !== expected) throw new PreconditionFailedError();
      const yp = async (rowId: string) =>
        binToUuid(
          (
            await trx
              .selectFrom('academic_years')
              .select('public_id')
              .where('id', '=', rowId)
              .executeTakeFirstOrThrow()
          ).public_id,
        );
      const from = await yearFor(trx, inst.id, await yp(String(r.from_year_id)));
      const to = await yearFor(trx, inst.id, await yp(String(r.to_year_id)));
      assertOpen(to);
      years = { from, to };
      const items = await trx
        .selectFrom('rollover_items as i')
        .innerJoin('member_profiles as m', 'm.id', 'i.student_profile_id')
        .leftJoin('sections as s', 's.id', 'i.to_section_id')
        .leftJoin('classes as c', 'c.id', 's.class_id')
        .select([
          'i.student_profile_id',
          'i.from_section_id',
          'i.outcome',
          'i.to_section_id',
          'm.first_name',
          'm.last_name',
          'c.name as class_name',
          's.name as section_name',
        ])
        .where('i.rollover_id', '=', r.id)
        .execute();
      const by = this.by(p);
      for (const i of items) {
        if (i.outcome === 'LEFT') {
          await this.change(trx, {
            institutionId: inst.id,
            studentId: String(i.student_profile_id),
            yearId: from.id,
            kind: 'LEFT',
            from: String(i.from_section_id),
            to: null,
            on: from.endsOn,
            reason: 'Roll-over',
            actor: by,
            at,
          });
          continue;
        }
        const exists = await trx
          .selectFrom('enrolments')
          .select('id')
          .where('institution_id', '=', inst.id)
          .where('student_profile_id', '=', i.student_profile_id)
          .where('year_id', '=', to.id)
          .executeTakeFirst();
        if (exists) continue;
        await trx
          .insertInto('enrolments')
          .values({
            institution_id: inst.id,
            student_profile_id: i.student_profile_id,
            year_id: to.id,
            section_id: i.to_section_id!,
            enrolled_on: to.startsOn,
            outcome: i.outcome,
            created_by: by,
          })
          .execute();
        await this.change(trx, {
          institutionId: inst.id,
          studentId: String(i.student_profile_id),
          yearId: to.id,
          kind: 'ROLLED_OVER',
          from: String(i.from_section_id),
          to: String(i.to_section_id),
          on: to.startsOn,
          reason: i.outcome === 'REPEATED' ? 'Repeats the class' : 'Promoted',
          actor: by,
          at,
        });
        await this.tell(
          trx,
          inst.id,
          String(i.student_profile_id),
          {
            name: nameOf(i.first_name, i.last_name),
            section: `${i.class_name} ${i.section_name}`,
            year: to.label,
          },
          at,
        );
      }
      await trx
        .updateTable('rollovers')
        .set({
          status: 'COMMITTED',
          committed_by: by,
          committed_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', r.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'ROLLOVER_COMMITTED',
        entityType: 'rollover',
        entityRef: rolloverId,
        after: {
          from: from.label,
          to: to.label,
          promoted: items.filter((i) => i.outcome === 'PROMOTED').length,
          repeated: items.filter((i) => i.outcome === 'REPEATED').length,
          left: items.filter((i) => i.outcome === 'LEFT').length,
        },
      });
    });
    const r = await this.rolloverOf(this.deps.db, inst.id, rolloverId);
    return this.rolloverView(inst.id, r, years!['from'], years!['to']);
  }
}

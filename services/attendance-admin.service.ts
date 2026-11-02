/**
 * The front desk and the attendance set-up (SRS 21.8, 21.16; ATT-011…018; FR-ATT-04, FR-ATT-06; OQ-14;
 * OI-ATT-10, OI-ATT-11, OI-ATT-20, OI-ATT-21, OI-ATT-23; RC-38; prototype c.attendance, c.frontdesk).
 *
 * - **Attendance types** are the institution's places (library, lab, sick room …) with a cooling-off
 *   interval each (OI-ATT-11); a location reader is set up with one of them.
 * - **Visitors** are recorded with name, mobile (encrypted; shown masked), purpose and whom they meet,
 *   then checked out.
 * - **The front desk** records a member at an attendance type (RC-38: method MANUAL).
 * - **Auto-absent (OQ-14):** off until an institution sets a cut-off and whom it applies to. Once the
 *   cut-off has passed on a school day, the job `auto-absent` marks Absent every applicable member
 *   with no record that day — once per institution and day — and tells the families (OI-ATT-21).
 * - **Staff timings (client 2026-10-23):** the school's working day for staff by role
 *   (services/staff-timings.ts). Once a timing's absent time has passed on a school day, the same job
 *   marks Absent its staff with no record — once per timing and day; the school's cut-off leaves them
 *   to it.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { formatDate, istBusinessDate } from '../utils/format';
import type { FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import type { JobContext } from '../schedulers';
import { institutionOf } from './academic-year';
import type { AttendanceService } from './attendance.service';
import { recordAudit } from './audit.service';
import {
  NOT_STAFF_ROLES,
  STAFF_TIMING_CATEGORIES,
  minutesOf,
  timingErrors,
  timingIdsByProfile,
  type TimingTimes,
} from './staff-timings';

/** A staff timing as the console sends it (ATT-034/035). */
export interface StaffTimingInput extends TimingTimes {
  readonly name: string;
  readonly roleIds: readonly string[];
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MOBILE = /^[6-9]\d{9}$/;
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const istMinutes = (at: Date) => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(at)
    .split(':')
    .map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export class AttendanceAdminService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly attendance: AttendanceService;
      /** Absent in the worker (no field keys); only recording a visitor needs it. */
      readonly cipher?: FieldCipher;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- ATT-013 / ATT-014: attendance types ------------------------------------------------------------------
  async types(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const today = istBusinessDate(this.now());
    const rows = await this.deps.db
      .selectFrom('attendance_types as t')
      .select([
        't.public_id',
        't.name',
        't.cooldown_seconds',
        (eb) =>
          eb
            .selectFrom('location_attendance as la')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('la.attendance_type_id', '=', 't.id')
            .where('la.at', '>=', new Date(`${today}T00:00:00.000+05:30`))
            .as('today'),
        (eb) =>
          eb
            .selectFrom('terminals as r')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('r.institution_id', '=', 't.institution_id')
            .whereRef('r.location_type', '=', 't.name')
            .where('r.purpose', '=', 'LOCATION')
            .as('readers'),
      ])
      .where('t.institution_id', '=', inst.id)
      .orderBy('t.name')
      .execute();
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        name: r.name,
        cooldownSeconds: r.cooldown_seconds,
        checkInsToday: Number(r.today ?? 0),
        readers: Number(r.readers ?? 0),
      })),
    };
  }

  async createType(p: Principal, input: { name: string; cooldownSeconds?: number | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const name = input.name.trim();
    if (name.length < 2 || name.length > 40)
      throw new ValidationError([{ field: 'name', code: 'ATT.TYPE_NAME' }]);
    const cooldown = input.cooldownSeconds ?? 60;
    if (!Number.isInteger(cooldown) || cooldown < 10 || cooldown > 3600) {
      throw new ValidationError([{ field: 'cooldownSeconds', code: 'VALIDATION.FORMAT' }]);
    }
    const pub = newPublicIdPair();
    try {
      await this.deps.db
        .insertInto('attendance_types')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          name,
          cooldown_seconds: cooldown,
          created_at: this.now(),
        })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'ATT.TYPE_TAKEN', { params: { name } });
      }
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'ATTENDANCE_TYPE_CREATED',
      entityType: 'attendance_type',
      entityRef: pub.id,
      after: { name, cooldown },
    });
    return (await this.types(p)).items.find((t) => t.id === pub.id)!;
  }

  // --- ATT-015…017: visitors --------------------------------------------------------------------------------
  private visitorView(v: {
    public_id: Buffer;
    name: string;
    mobile_last4: string;
    purpose: string;
    to_meet: string | null;
    checked_in_at: Date | string;
    checked_out_at: Date | string | null;
  }) {
    return {
      id: binToUuid(v.public_id),
      name: v.name,
      mobile: `••••••${v.mobile_last4}`,
      purpose: v.purpose,
      toMeet: v.to_meet,
      checkedInAt: iso(v.checked_in_at),
      checkedOutAt: iso(v.checked_out_at),
      inside: !v.checked_out_at,
    };
  }

  async visitors(p: Principal, f: { date?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const date =
      f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : istBusinessDate(this.now());
    const start = new Date(`${date}T00:00:00.000+05:30`);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = await this.deps.db
      .selectFrom('visitors')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .where('checked_in_at', '>=', start)
      .where('checked_in_at', '<', end)
      .orderBy('checked_in_at', 'desc')
      .execute();
    const items = rows.map((v) => this.visitorView(v));
    return {
      date,
      counts: { total: items.length, inside: items.filter((v) => v.inside).length },
      items,
    };
  }

  async recordVisitor(
    p: Principal,
    input: { name: string; mobile: string; purpose: string; toMeet?: string | null | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const name = input.name.trim();
    const purpose = input.purpose.trim();
    const mobile = input.mobile.replace(/\D/g, '').slice(-10);
    if (
      name.length < 2 ||
      name.length > 80 ||
      !MOBILE.test(mobile) ||
      purpose.length < 3 ||
      purpose.length > 120
    ) {
      throw new ValidationError([{ field: 'name', code: 'ATT.VISITOR_DETAILS' }]);
    }
    if (!this.deps.cipher) throw new Error('Field encryption is not configured');
    const cipher = this.deps.cipher;
    const pub = newPublicIdPair();
    const at = this.now();
    await this.deps.db
      .insertInto('visitors')
      .values({
        public_id: pub.bin,
        institution_id: inst.id,
        name,
        mobile_enc: cipher.encrypt('visitor_mobile', mobile, pub.id),
        mobile_last4: mobile.slice(-4),
        purpose,
        to_meet: input.toMeet?.trim().slice(0, 80) || null,
        checked_in_at: at,
        recorded_by: this.by(p),
      })
      .execute();
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'VISITOR_RECORDED',
      entityType: 'visitor',
      entityRef: pub.id,
    });
    return this.visitor(inst.id, pub.id);
  }

  private async visitor(institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'ATT.VISITOR_NOT_FOUND');
    const v = await this.deps.db
      .selectFrom('visitors')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!v) throw new CustomAPIError(404, 'ATT.VISITOR_NOT_FOUND');
    return this.visitorView(v);
  }

  async checkOut(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    await this.visitor(inst.id, id);
    const r = await this.deps.db
      .updateTable('visitors')
      .set({ checked_out_at: this.now() })
      .where('public_id', '=', uuidToBin(id))
      .where('checked_out_at', 'is', null)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'ATT.VISITOR_OUT');
    return this.visitor(inst.id, id);
  }

  // --- ATT-018: the front desk records a member at an attendance type ----------------------------------------
  async captureLocation(p: Principal, input: { attendanceTypeId: string; memberId: string }) {
    const inst = await institutionOf(this.deps.db, p);
    const db = this.deps.db;
    const type = isUuid(input.attendanceTypeId)
      ? await db
          .selectFrom('attendance_types')
          .select(['id', 'name', 'cooldown_seconds'])
          .where('public_id', '=', uuidToBin(input.attendanceTypeId))
          .where('institution_id', '=', inst.id)
          .executeTakeFirst()
      : undefined;
    if (!type) throw new CustomAPIError(404, 'ATT.TYPE_NOT_FOUND');
    const m = isUuid(input.memberId)
      ? await db
          .selectFrom('member_profiles')
          .select(['id', 'first_name', 'last_name'])
          .where('public_id', '=', uuidToBin(input.memberId))
          .where('institution_id', '=', inst.id)
          .executeTakeFirst()
      : undefined;
    if (!m) throw new NotFoundError();
    const at = this.now();
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', String(m.id))
        .forUpdate()
        .execute();
      await this.deps.attendance.recordLocation(trx, {
        institutionId: inst.id,
        typeId: String(type.id),
        cooldown: type.cooldown_seconds,
        profileRowId: String(m.id),
        method: 'MANUAL',
        terminalId: null,
        by: this.by(p),
        at,
      });
    });
    return {
      member: { id: input.memberId.toLowerCase(), name: nameOf(m.first_name, m.last_name) },
      location: type.name,
      status: 'CHECK_IN',
      method: 'MANUAL',
      at: at.toISOString(),
    };
  }

  // --- ATT-011 / ATT-012: auto-absent ---------------------------------------------------------------------
  async autoAbsent(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const s = await this.deps.db
      .selectFrom('auto_absent_settings')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .executeTakeFirst();
    const school = await this.deps.db
      .selectFrom('auto_absent_runs')
      .select(['run_date', 'marked', 'skipped_holiday', 'ran_at'])
      .where('institution_id', '=', inst.id)
      .orderBy('run_date', 'desc')
      .limit(10)
      .execute();
    // The staff timings' runs (client 2026-10-23), with the timing's name.
    const staff = await this.deps.db
      .selectFrom('staff_absent_runs as r')
      .innerJoin('staff_timings as st', 'st.id', 'r.timing_id')
      .select(['r.run_date', 'r.marked', 'r.skipped_holiday', 'r.ran_at', 'st.name'])
      .where('r.institution_id', '=', inst.id)
      .orderBy('r.run_date', 'desc')
      .orderBy('r.ran_at', 'desc')
      .limit(30)
      .execute();
    const runs = [...school.map((r) => ({ ...r, name: null as string | null })), ...staff]
      .sort((a, b) => new Date(b.ran_at).getTime() - new Date(a.ran_at).getTime())
      .slice(0, 30);
    return {
      enabled: !!Number(s?.enabled ?? 0),
      cutoff: (s?.cutoff ?? '11:00:00').slice(0, 5),
      appliesTo: [
        ...(Number(s?.applies_students ?? 1) ? ['STUDENTS'] : []),
        ...(Number(s?.applies_staff ?? 0) ? ['STAFF'] : []),
      ],
      version: s?.row_version ?? 0,
      runs: runs.map((r) => ({
        date:
          typeof r.run_date === 'string' ? r.run_date.slice(0, 10) : istBusinessDate(r.run_date),
        marked: r.marked,
        skippedHoliday: !!Number(r.skipped_holiday),
        ranAt: iso(r.ran_at),
        /** The staff timing the run was for; null: the school's cut-off. */
        timing: r.name,
      })),
    };
  }

  async setAutoAbsent(
    p: Principal,
    expected: number,
    input: { enabled: boolean; cutoff: string; appliesTo: readonly ('STUDENTS' | 'STAFF')[] },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    if (!TIME.test(input.cutoff) || input.cutoff < '07:00' || input.cutoff > '18:00') {
      throw new ValidationError([{ field: 'cutoff', code: 'ATT.CUTOFF' }]);
    }
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const s = await trx
        .selectFrom('auto_absent_settings')
        .select(['row_version', 'enabled', 'cutoff'])
        .where('institution_id', '=', inst.id)
        .forUpdate()
        .executeTakeFirst();
      if ((s?.row_version ?? 0) !== expected) throw new PreconditionFailedError();
      const values = {
        enabled: input.enabled ? 1 : 0,
        cutoff: `${input.cutoff}:00`,
        applies_students: input.appliesTo.includes('STUDENTS') ? 1 : 0,
        applies_staff: input.appliesTo.includes('STAFF') ? 1 : 0,
        updated_by: this.by(p),
        updated_at: at,
      };
      if (s) {
        await trx
          .updateTable('auto_absent_settings')
          .set({ ...values, row_version: sql<number>`row_version + 1` })
          .where('institution_id', '=', inst.id)
          .execute();
      } else {
        await trx
          .insertInto('auto_absent_settings')
          .values({ institution_id: inst.id, ...values })
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'AUTO_ABSENT_CHANGED',
        entityType: 'auto_absent_settings',
        before: s ? { enabled: !!Number(s.enabled), cutoff: s.cutoff } : null,
        after: { enabled: input.enabled, cutoff: input.cutoff, appliesTo: input.appliesTo },
      });
    });
    return this.autoAbsent(p);
  }

  /** The job `auto-absent`: once a day per institution, after its cut-off, on a school day. */
  async run(ctx: Pick<JobContext, 'item'> & { scope?: { institutionId: string } | undefined }) {
    const at = this.now();
    const date = istBusinessDate(at);
    const minutes = istMinutes(at);
    let q = this.deps.db
      .selectFrom('auto_absent_settings')
      .selectAll()
      .where('enabled', '=', 1)
      .orderBy('institution_id');
    if (ctx.scope) q = q.where('institution_id', '=', ctx.scope.institutionId);
    for (const s of await q.execute()) {
      const id = String(s.institution_id);
      const cutoff = Number(s.cutoff.slice(0, 2)) * 60 + Number(s.cutoff.slice(3, 5));
      if (minutes < cutoff) {
        ctx.item({
          institutionId: id,
          status: 'SKIPPED',
          processed: 0,
          failed: 0,
          note: `Before the cut-off ${s.cutoff.slice(0, 5)}`,
        });
        continue;
      }
      try {
        const out = await this.markDay(id, date, s, at);
        ctx.item({
          institutionId: id,
          status: out === null ? 'SKIPPED' : 'SUCCESS',
          processed: out ?? 0,
          failed: 0,
          note: out === null ? 'Already run today, or not a school day' : `${out} marked absent`,
        });
      } catch {
        ctx.item({
          institutionId: id,
          status: 'FAILED',
          processed: 0,
          failed: 1,
          note: 'The run failed; the next run tries again',
        });
      }
    }
    await this.runStaffTimings(ctx, date, minutes, at);
  }

  /** Each staff timing whose absent time has passed (client 2026-10-23): its staff, once a day. */
  private async runStaffTimings(
    ctx: Pick<JobContext, 'item'> & { scope?: { institutionId: string } | undefined },
    date: string,
    minutes: number,
    at: Date,
  ) {
    let q = this.deps.db
      .selectFrom('staff_timings')
      .select(['id', 'institution_id', 'name', 'absent_time'])
      .orderBy('institution_id')
      .orderBy('id');
    if (ctx.scope) q = q.where('institution_id', '=', ctx.scope.institutionId);
    for (const t of await q.execute()) {
      const id = String(t.institution_id);
      if (minutes <= minutesOf(t.absent_time)) continue;
      try {
        const out = await this.markStaffTiming(id, String(t.id), date, at);
        if (out === null) continue;
        ctx.item({
          institutionId: id,
          status: 'SUCCESS',
          processed: out,
          failed: 0,
          note: `${t.name}: ${out} staff marked absent`,
        });
      } catch {
        ctx.item({
          institutionId: id,
          status: 'FAILED',
          processed: 0,
          failed: 1,
          note: `${t.name}: the run failed; the next run tries again`,
        });
      }
    }
  }

  /** Marks Absent a timing's staff with no record today; null when already done or no school. */
  private async markStaffTiming(institutionId: string, timingId: string, date: string, at: Date) {
    const db = this.deps.db;
    const holiday = (await this.deps.attendance.holidays(db, institutionId, date, date)).get(date);
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    return db.transaction().execute(async (trx) => {
      try {
        await trx
          .insertInto('staff_absent_runs')
          .values({
            institution_id: institutionId,
            timing_id: timingId,
            run_date: date,
            skipped_holiday: holiday || sunday ? 1 : 0,
            ran_at: at,
          })
          .execute();
      } catch (e) {
        if ((e as { errno?: number }).errno === 1062) return null;
        throw e;
      }
      if (holiday || sunday) return null;
      const year = await this.deps.attendance.openYearAt(trx, institutionId, date);
      if (!year || year.closed) return 0;
      const byProfile = await timingIdsByProfile(trx, institutionId);
      const members = (
        await this.unmarked(trx, institutionId, date, [...STAFF_TIMING_CATEGORIES], year.id)
      ).filter((m) => byProfile.get(String(m.id)) === timingId);
      const marked = await this.markAbsent(trx, institutionId, year.id, date, members, at);
      await trx
        .updateTable('staff_absent_runs')
        .set({ marked })
        .where('timing_id', '=', timingId)
        .where('run_date', '=', date)
        .execute();
      return marked;
    });
  }

  /** Marks the day for one institution; null when already done or not a school day. */
  private async markDay(
    institutionId: string,
    date: string,
    s: { applies_students: number; applies_staff: number },
    at: Date,
  ) {
    const db = this.deps.db;
    const holiday = (await this.deps.attendance.holidays(db, institutionId, date, date)).get(date);
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    return db.transaction().execute(async (trx) => {
      try {
        await trx
          .insertInto('auto_absent_runs')
          .values({
            institution_id: institutionId,
            run_date: date,
            skipped_holiday: holiday || sunday ? 1 : 0,
            ran_at: at,
          })
          .execute();
      } catch (e) {
        if ((e as { errno?: number }).errno === 1062) return null;
        throw e;
      }
      if (holiday || sunday) return null;
      const year = await this.deps.attendance.openYearAt(trx, institutionId, date);
      if (!year || year.closed) return 0;
      const cats = [
        ...(Number(s.applies_students) ? ['STUDENT'] : []),
        ...(Number(s.applies_staff) ? ['TEACHER', 'PRINCIPAL', 'STAFF'] : []),
      ];
      if (!cats.length) return 0;
      // Staff with a timing of their own are marked at its absent time (client 2026-10-23).
      const timed = Number(s.applies_staff)
        ? await timingIdsByProfile(trx, institutionId)
        : new Map<string, string>();
      const members = (await this.unmarked(trx, institutionId, date, cats, year.id)).filter(
        (m) => m.category === 'STUDENT' || !timed.has(String(m.id)),
      );
      const marked = await this.markAbsent(trx, institutionId, year.id, date, members, at);
      await trx
        .updateTable('auto_absent_runs')
        .set({ marked })
        .where('institution_id', '=', institutionId)
        .where('run_date', '=', date)
        .execute();
      return marked;
    });
  }

  /** The active members of these categories with no record on the date. */
  private unmarked(
    trx: Transaction<Database>,
    institutionId: string,
    date: string,
    cats: readonly string[],
    yearId: string,
  ) {
    return trx
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').on('en.year_id', '=', yearId),
      )
      .select(['m.id', 'm.first_name', 'm.account_id', 'ut.category', 'en.section_id'])
      .where('m.institution_id', '=', institutionId)
      .where('m.status', '=', 'ACTIVE')
      .where('ut.category', 'in', cats as never[])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('attendance_days as d')
              .select('d.id')
              .whereRef('d.profile_id', '=', 'm.id')
              .where('d.att_date', '=', date),
          ),
        ),
      )
      .execute();
  }

  /** Marks each Absent (a student only when enrolled this year) and tells them or the family. */
  private async markAbsent(
    trx: Transaction<Database>,
    institutionId: string,
    yearId: string,
    date: string,
    members: Awaited<ReturnType<AttendanceAdminService['unmarked']>>,
    at: Date,
  ) {
    let marked = 0;
    for (const m of members) {
      if (m.category === 'STUDENT' && !m.section_id) continue; // not enrolled this year
      const ins = await trx
        .insertInto('attendance_days')
        .values({
          institution_id: institutionId,
          year_id: yearId,
          profile_id: String(m.id),
          section_id: m.section_id ? String(m.section_id) : null,
          att_date: date,
          checkin_status: 'ABSENT',
          status: 'ABSENT',
          method: null,
          created_at: at,
          updated_at: at,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('attendance_events')
        .values({
          institution_id: institutionId,
          day_id: String(ins.insertId),
          action: 'AUTO-ABSENT',
          new_status: 'ABSENT',
          at,
        })
        .execute();
      await this.deps.attendance.tellAbsent(
        trx,
        institutionId,
        {
          rowId: String(m.id),
          first: m.first_name ?? '',
          student: m.category === 'STUDENT',
          accountId: m.account_id === null ? null : String(m.account_id),
        },
        date,
        at,
      );
      marked++;
    }
    return marked;
  }

  // --- ATT-033…036: staff timings (client 2026-10-23) ------------------------------------------------
  /** The roles a timing can be for: the school's roles, merchants' excepted. */
  private timingRoles(institutionId: string) {
    return this.deps.db
      .selectFrom('roles')
      .select(['id', 'public_id', 'name'])
      .where('scope', '=', 'INSTITUTION')
      .where('status', '=', 'ACTIVE')
      .where((eb) =>
        eb.or([eb('institution_id', 'is', null), eb('institution_id', '=', institutionId)]),
      )
      .where((eb) => eb.or([eb('code', 'is', null), eb('code', 'not in', NOT_STAFF_ROLES)]))
      .orderBy('name')
      .execute();
  }

  /** ATT-033: the school's staff timings, first made first, and the roles to choose from. */
  async staffTimings(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const db = this.deps.db;
    const [rows, links, roles, byProfile, staff] = await Promise.all([
      db
        .selectFrom('staff_timings')
        .selectAll()
        .where('institution_id', '=', inst.id)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('staff_timing_roles')
        .select(['timing_id', 'role_id'])
        .where('institution_id', '=', inst.id)
        .execute(),
      this.timingRoles(inst.id),
      timingIdsByProfile(db, inst.id),
      db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .select('m.id')
        .where('m.institution_id', '=', inst.id)
        .where('m.status', '=', 'ACTIVE')
        .where('ut.category', 'in', [...STAFF_TIMING_CATEGORIES])
        .execute(),
    ]);
    const roleById = new Map(roles.map((r) => [String(r.id), r]));
    const following = new Map<string, number>();
    for (const s of staff) {
      const t = byProfile.get(String(s.id));
      if (t) following.set(t, (following.get(t) ?? 0) + 1);
    }
    const timingOfRole = new Map(links.map((l) => [String(l.role_id), String(l.timing_id)]));
    const publicOf = new Map(rows.map((r) => [String(r.id), binToUuid(r.public_id)]));
    const hm = (t: string) => t.slice(0, 5);
    return {
      items: rows.map((r) => ({
        id: binToUuid(r.public_id),
        name: r.name,
        roles: links
          .filter((l) => String(l.timing_id) === String(r.id))
          .map((l) => roleById.get(String(l.role_id)))
          .filter((x) => x !== undefined)
          .map((x) => ({ id: binToUuid(x.public_id), name: x.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        loginTime: hm(r.login_time),
        logoutTime: hm(r.logout_time),
        lateLoginTime: hm(r.late_login_time),
        earlyLogoutTime: hm(r.early_logout_time),
        halfDayTime: hm(r.half_day_time),
        absentTime: hm(r.absent_time),
        /** Active staff who follow it. */
        staff: following.get(String(r.id)) ?? 0,
        version: r.row_version,
      })),
      roles: roles.map((r) => ({
        id: binToUuid(r.public_id),
        name: r.name,
        timingId: publicOf.get(timingOfRole.get(String(r.id)) ?? '') ?? null,
      })),
    };
  }

  /** The timing's name, roles and times checked; the roles' row ids. */
  private async checkTiming(institutionId: string, input: StaffTimingInput, own: string | null) {
    const errors: { field: string; code: string; params?: Record<string, string> }[] = [];
    const name = input.name.trim();
    if (name.length < 2 || name.length > 60)
      errors.push({ field: 'name', code: 'ATT.TIMING_NAME' });
    const roles = await this.timingRoles(institutionId);
    const ids = [...new Set(input.roleIds.map((r) => r.toLowerCase()))];
    const chosen = ids.map((id) => roles.find((r) => binToUuid(r.public_id) === id));
    if (!ids.length) errors.push({ field: 'roleIds', code: 'ATT.TIMING_ROLES' });
    else if (chosen.some((r) => !r)) errors.push({ field: 'roleIds', code: 'VALIDATION.FORMAT' });
    errors.push(...timingErrors(input));
    const roleIds = chosen.filter((r) => r !== undefined).map((r) => String(r.id));
    if (!errors.length) {
      // A role in one timing only.
      const taken = await this.deps.db
        .selectFrom('staff_timing_roles as sr')
        .innerJoin('staff_timings as st', 'st.id', 'sr.timing_id')
        .select(['sr.role_id', 'st.name'])
        .where('sr.institution_id', '=', institutionId)
        .where('sr.role_id', 'in', roleIds)
        .$if(own !== null, (q) => q.where('sr.timing_id', '!=', own!))
        .executeTakeFirst();
      if (taken) {
        errors.push({
          field: 'roleIds',
          code: 'ATT.TIMING_ROLE_TAKEN',
          params: {
            role: roles.find((r) => String(r.id) === String(taken.role_id))?.name ?? '',
            timing: taken.name,
          },
        });
      }
      const same = await this.deps.db
        .selectFrom('staff_timings')
        .select('id')
        .where('institution_id', '=', institutionId)
        .where('name', '=', name)
        .$if(own !== null, (q) => q.where('id', '!=', own!))
        .executeTakeFirst();
      if (same) errors.push({ field: 'name', code: 'ATT.TIMING_TAKEN', params: { name } });
    }
    if (errors.length) throw new ValidationError(errors);
    const t = (v: string) => `${v.trim()}:00`;
    return {
      roleIds,
      values: {
        name,
        login_time: t(input.loginTime),
        logout_time: t(input.logoutTime),
        late_login_time: t(input.lateLoginTime),
        early_logout_time: t(input.earlyLogoutTime),
        half_day_time: t(input.halfDayTime),
        absent_time: t(input.absentTime),
      },
    };
  }

  /** A role taken by another timing meanwhile, or the name: the unique keys' answer. */
  private duplicate(e: unknown, name: string): never {
    if ((e as { errno?: number }).errno === 1062) {
      const roles = String((e as { message?: string }).message ?? '').includes('role');
      throw new ValidationError([
        roles
          ? { field: 'roleIds', code: 'ATT.TIMING_ROLES_CHANGED' }
          : { field: 'name', code: 'ATT.TIMING_TAKEN', params: { name } },
      ]);
    }
    throw e;
  }

  /** ATT-034: a staff timing for one or more roles. */
  async createStaffTiming(p: Principal, input: StaffTimingInput) {
    const inst = await institutionOf(this.deps.db, p);
    const { roleIds, values } = await this.checkTiming(inst.id, input, null);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const ins = await trx
          .insertInto('staff_timings')
          .values({
            public_id: pub.bin,
            institution_id: inst.id,
            ...values,
            created_by: this.by(p),
            updated_by: this.by(p),
            created_at: at,
            updated_at: at,
          })
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('staff_timing_roles')
          .values(
            roleIds.map((r) => ({
              timing_id: String(ins.insertId),
              institution_id: inst.id,
              role_id: r,
            })),
          )
          .execute();
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'STAFF_TIMING_CREATED',
          entityType: 'staff_timing',
          entityRef: pub.id,
          after: { ...values, roles: roleIds.length },
        });
      });
    } catch (e) {
      this.duplicate(e, values.name);
    }
    return (await this.staffTimings(p)).items.find((t) => t.id === pub.id)!;
  }

  private async timingRow(institutionId: string, id: string) {
    const row = isUuid(id)
      ? await this.deps.db
          .selectFrom('staff_timings')
          .selectAll()
          .where('institution_id', '=', institutionId)
          .where('public_id', '=', uuidToBin(id))
          .executeTakeFirst()
      : undefined;
    if (!row) throw new NotFoundError('ATT.TIMING_NOT_FOUND');
    return row;
  }

  /** ATT-035: a staff timing changed (If-Match). */
  async updateStaffTiming(p: Principal, id: string, expected: number, input: StaffTimingInput) {
    const inst = await institutionOf(this.deps.db, p);
    const row = await this.timingRow(inst.id, id);
    const { roleIds, values } = await this.checkTiming(inst.id, input, String(row.id));
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom('staff_timings')
          .select('row_version')
          .where('id', '=', String(row.id))
          .forUpdate()
          .executeTakeFirst();
        if (!locked || locked.row_version !== expected) throw new PreconditionFailedError();
        await trx
          .updateTable('staff_timings')
          .set({
            ...values,
            updated_by: this.by(p),
            updated_at: this.now(),
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', String(row.id))
          .execute();
        await trx
          .deleteFrom('staff_timing_roles')
          .where('timing_id', '=', String(row.id))
          .execute();
        await trx
          .insertInto('staff_timing_roles')
          .values(
            roleIds.map((r) => ({
              timing_id: String(row.id),
              institution_id: inst.id,
              role_id: r,
            })),
          )
          .execute();
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'STAFF_TIMING_CHANGED',
          entityType: 'staff_timing',
          entityRef: id,
          before: { name: row.name, absent_time: row.absent_time },
          after: { ...values, roles: roleIds.length },
        });
      });
    } catch (e) {
      this.duplicate(e, values.name);
    }
    return (await this.staffTimings(p)).items.find((t) => t.id === id.toLowerCase())!;
  }

  /** ATT-036: a staff timing removed; its staff keep the school's rules from now on. */
  async deleteStaffTiming(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    const row = await this.timingRow(inst.id, id);
    await this.deps.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('staff_timings').where('id', '=', String(row.id)).execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'STAFF_TIMING_DELETED',
        entityType: 'staff_timing',
        entityRef: id,
        before: { name: row.name },
      });
    });
  }

  /** For tests and the console: the day's absent text. */
  absentLabel(date: string) {
    return formatDate(date);
  }
}

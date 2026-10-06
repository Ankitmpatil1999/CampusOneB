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
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../models/ringpe_models';
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
    const runs = await this.deps.db
      .selectFrom('auto_absent_runs')
      .select(['run_date', 'marked', 'skipped_holiday', 'ran_at'])
      .where('institution_id', '=', inst.id)
      .orderBy('run_date', 'desc')
      .limit(10)
      .execute();
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
      const members = await trx
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .leftJoin('enrolments as en', (j) =>
          j.onRef('en.student_profile_id', '=', 'm.id').on('en.year_id', '=', year.id),
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
      let marked = 0;
      for (const m of members) {
        if (m.category === 'STUDENT' && !m.section_id) continue; // not enrolled this year
        const ins = await trx
          .insertInto('attendance_days')
          .values({
            institution_id: institutionId,
            year_id: year.id,
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
      await trx
        .updateTable('auto_absent_runs')
        .set({ marked })
        .where('institution_id', '=', institutionId)
        .where('run_date', '=', date)
        .execute();
      return marked;
    });
  }

  /** For tests and the console: the day's absent text. */
  absentLabel(date: string) {
    return formatDate(date);
  }
}

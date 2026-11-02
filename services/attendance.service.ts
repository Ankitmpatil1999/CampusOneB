/**
 * Attendance (SRS 21.5–21.15; ATT-002, ATT-008…010, ATT-019…023, ATT-026; FR-ATT-02…07; CR-10, CR-13;
 * OI-ATT-05…24; RC-38; prototype t.gate, t.period, c.attendance, m.t.attendance, m.attendance,
 * m.pr.attendance).
 *
 * - **One record per member and day** (27.2): a student's tap makes them Present; a non-student's tap
 *   is Present up to the late cut-off and Late after it, and their second tap checks them out —
 *   Present after the half-day threshold, Half day before it. A closed record refuses further taps.
 *   The card is matched within the reader's institution (OI-ATT-06); one double-tap interval applies
 *   to every reader (OI-ATT-05).
 * - **Manual marking** (console and the class teacher's register) creates or overrides a record; the
 *   old and new status and the actor are kept (OI-ATT-13, RC-38). A date in a closed year, or in the
 *   future, is refused. Every Absent tells the family (OI-ATT-21).
 * - **Period attendance:** a tap at a class's period reader during a period of its timetable (Present
 *   by the start, Late after), or the period's teacher marking it.
 * - **Reports** are computed on the server for a date range (OI-ATT-12, OI-ATT-15/16) with the year
 *   taken from each record.
 * - **Staff at the front desk** (client 2026-10-22): a staff card on the desk's reader, or the desk
 *   checking a staff member in or out by name, records the day as the gate does; the principal, the
 *   console and the staff member's app read the same records.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import { KIND_CATEGORIES } from '../repositories/members.repository';
import type { CardsService } from './cards.service';
import type { CheckinStatus, Database, DailyStatus } from '../models/campusone_models';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { formatDate, formatTime, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { emit, rooms } from '../utils/outbox';
import type { Principal } from '../utils/principal';
import { assertOpen, institutionOf, yearFor, yearView, type Year } from './academic-year';
import { recordAudit } from './audit.service';
import { tellMembers } from './member-notices';
import { occurrences } from './calendar.service';
import { memberOf, principalOf, teacherOf } from './member-roles';
import { notify } from './notifications.service';
import { payrollMonth, type DayStatus, type LeaveType } from './payroll-attendance';
import type { SettingsService } from './settings.service';
import { loginStatus, logoutStatus, timingOf } from './staff-timings';

type Db = Kysely<Database> | Transaction<Database>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT'] as const;
/** Teachers, the principal and non-teaching staff (the front desk's staff attendance). */
const STAFF_CATEGORIES = ['TEACHER', 'PRINCIPAL', 'STAFF'] as const;
/** Teaching staff: payroll's Teaching filter (client 2026-10-22). */
const TEACHING: readonly string[] = ['TEACHER', 'PRINCIPAL'];
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d));
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const weekday = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};
/** Minutes after midnight in IST. */
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
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export interface MarkEntry {
  readonly memberId: string;
  readonly status: DailyStatus;
  readonly remark?: string | null | undefined;
}

export class AttendanceService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cards: CardsService;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async limit(l: LimitDefinition) {
    if (!this.deps.settings) return Number(l.value);
    const v = await this.deps.settings.values();
    return Number(v[l.key] ?? l.value);
  }

  /** The academic year holding a date, if any. */
  private async yearAt(db: Db, institutionId: string, date: string) {
    const y = await db
      .selectFrom('academic_years')
      .select(['id', 'public_id'])
      .where('institution_id', '=', institutionId)
      .where('starts_on', '<=', date)
      .where('ends_on', '>=', date)
      .executeTakeFirst();
    return y ? { id: String(y.id), publicId: binToUuid(y.public_id) } : null;
  }

  /** Holidays for everyone on the dates of [from, to] (Sundays are counted separately). */
  async holidays(db: Db, institutionId: string, from: string, to: string) {
    const rows = await db
      .selectFrom('calendar_entries')
      .select(['title', 'start_date', 'end_date', 'recurrence', 'repeat_until'])
      .where('institution_id', '=', institutionId)
      .where('type', '=', 'Holiday')
      .where('audience', '=', 'ALL')
      .where('deleted_at', 'is', null)
      .execute();
    const out = new Map<string, string>();
    for (const h of rows) {
      for (const o of occurrences(
        {
          start: ymd(h.start_date),
          end: ymd(h.end_date),
          recurrence: h.recurrence,
          until: h.repeat_until ? ymd(h.repeat_until) : null,
        },
        from,
        to,
      )) {
        for (let d = o.start < from ? from : o.start; d <= o.end && d <= to; d = addDays(d, 1)) {
          out.set(d, h.title);
        }
      }
    }
    return out;
  }

  /** The member, whether a student, and (for a student) the section of the year of the date. */
  private async who(db: Db, institutionId: string, profileRowId: string, date: string) {
    const m = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.account_id',
        'm.status',
        'ut.category',
      ])
      .where('m.id', '=', profileRowId)
      .where('m.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    const year = await this.yearAt(db, institutionId, date);
    const en =
      year && m.category === 'STUDENT'
        ? await db
            .selectFrom('enrolments as en')
            .innerJoin('sections as s', 's.id', 'en.section_id')
            .innerJoin('classes as c', 'c.id', 's.class_id')
            .select(['en.section_id', 's.name as section_name', 'c.name as class_name'])
            .where('en.student_profile_id', '=', profileRowId)
            .where('en.year_id', '=', year.id)
            .executeTakeFirst()
        : undefined;
    return {
      rowId: String(m.id),
      publicId: binToUuid(m.public_id),
      name: nameOf(m.first_name, m.last_name),
      first: m.first_name ?? '',
      accountId: m.account_id === null ? null : String(m.account_id),
      student: m.category === 'STUDENT',
      category: m.category,
      year,
      sectionId: en ? String(en.section_id) : null,
      classSection: en ? `${en.class_name} ${en.section_name}` : null,
    };
  }

  private async familyAccounts(db: Db, studentRowId: string) {
    const rows = await db
      .selectFrom('member_profiles as m')
      .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
      .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select(['m.account_id', 'm.own_account_id', 'gm.account_id as guardian_account'])
      .where('m.id', '=', studentRowId)
      .execute();
    return [
      ...new Set(
        rows
          .flatMap((r) => [r.account_id, r.own_account_id, r.guardian_account])
          .filter((a): a is string => a !== null && a !== undefined)
          .map(String),
      ),
    ];
  }

  /**
   * A check-in or check-out (gate, front desk, the teacher's reader): the person and, for a
   * student, the parents are told (client 2026-10-22; event CHECK_IN_OUT).
   */
  private async tellCheck(
    db: Db,
    institutionId: string,
    m: { rowId: string; first: string; student: boolean },
    action: 'IN' | 'OUT',
    at: Date,
    body: string,
  ) {
    await tellMembers(
      db,
      {
        institutionId,
        profileRowIds: [m.rowId],
        titleKey: action === 'IN' ? 'NTF.CHECKED_IN' : 'NTF.CHECKED_OUT',
        params: { name: m.first, time: formatTime(at) },
        body: body.slice(0, 200),
        link: m.student ? '/attendance' : '/me/attendance',
      },
      at,
    );
  }

  /** OI-ATT-21: the family is told of every Absent. */
  async tellAbsent(
    db: Db,
    institutionId: string,
    member: { rowId: string; first: string; student: boolean; accountId: string | null },
    date: string,
    at: Date,
  ) {
    const accounts = member.student
      ? await this.familyAccounts(db, member.rowId)
      : member.accountId
        ? [member.accountId]
        : [];
    // A student's parents are e-mailed even without the app (client 2026-10-16).
    if (!accounts.length && !member.student) return;
    await notify(
      db,
      {
        institutionId,
        accountIds: accounts,
        ...(member.student ? { about: [member.rowId] } : {}),
        surface: 'MEMBER',
        category: 'ACCOUNT',
        titleKey: 'NTF.ABSENT',
        params: { name: member.first, date: formatDate(date) },
        body: 'If this is wrong, please contact the class teacher.',
        link: '/attendance',
      },
      at,
    );
  }

  // --- ATT-002: a tap at a reader ----------------------------------------------------------------------------
  async tap(
    terminal: {
      id: string;
      institutionId: string;
      purpose: string;
      sectionId: string | null;
      locationType: string | null;
    },
    input: { cardToken: string },
  ) {
    const card = await this.deps.cards.activeCard(terminal.institutionId, input.cardToken);
    const at = this.now();
    await this.notTooSoon(String(card.id), at);
    const date = istBusinessDate(at);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', String(card.profile_id))
        .forUpdate()
        .execute();
      const m = await this.who(trx, terminal.institutionId, String(card.profile_id), date);
      if (terminal.purpose === 'PERIOD_ATTENDANCE')
        return this.periodTap(trx, terminal, m, date, at);
      if (terminal.purpose === 'LOCATION') return this.locationTap(trx, terminal, m, at);
      return this.gateTap(trx, terminal, m, date, at);
    });
    await this.deps.cards.touch(String(card.id));
    return out;
  }

  /**
   * A card tapped again within `att.checkoutGraceMinutes` of the check-in doesn't check out (client
   * 2026-10-26): a repeated scan is no second action. It says when the person checked in and from
   * when the card checks them out. A check-out chosen on the desk's screen isn't held back.
   */
  private async notLeavingYet(day: { check_in_at: Date | string | null }, name: string, at: Date) {
    if (!day.check_in_at) return;
    const grace = await this.limit(LIMITS.checkoutGraceMinutes);
    const checkedIn = new Date(day.check_in_at);
    const after = new Date(checkedIn.getTime() + grace * 60_000);
    if (grace > 0 && at.getTime() < after.getTime()) {
      throw new CustomAPIError(409, 'ATT.CHECKOUT_TOO_SOON', {
        params: { name, in: formatTime(checkedIn), after: formatTime(after) },
      });
    }
  }

  /** A card tapped again within `att.doubleTapSeconds` is refused (27.4). */
  private async notTooSoon(cardId: string, at: Date) {
    const gap = await this.limit(LIMITS.doubleTapSeconds);
    const last = await this.deps.db
      .selectFrom('cards')
      .select('last_tap_at')
      .where('id', '=', cardId)
      .executeTakeFirst();
    if (last?.last_tap_at && at.getTime() - new Date(last.last_tap_at).getTime() < gap * 1000) {
      throw new CustomAPIError(429, 'ATT.DOUBLE_TAP');
    }
  }

  // --- ATT-028: the teacher's own card reader on the web (client 2026-10-13) --------------------------
  /**
   * A student taps their card on the teacher's USB reader (the web console's Attendance page with
   * CampusOne Card Reader): today only, for a student of the class — the class teacher's daily
   * register — or of the teacher's period running now (from 10 minutes before it starts until it
   * ends, as at a classroom reader). Recorded as a card tap (method NFC, no terminal, the teacher
   * as the actor). A student already recorded is answered as such, not refused; a recorded Absent
   * becomes Present — the card shows they are here — with old → new kept.
   */
  async teacherTap(
    p: Principal,
    input: {
      cardToken: string;
      mode: 'DAILY' | 'PERIOD';
      classSectionId?: string | undefined;
      slotId?: string | undefined;
    },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const card = await this.deps.cards.activeCard(me.institutionId, input.cardToken);
    const at = this.now();
    await this.notTooSoon(String(card.id), at);
    const date = istBusinessDate(at);
    const by = this.by(p);
    const profileRowId = String(card.profile_id);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', profileRowId)
        .forUpdate()
        .execute();
      const m = await this.who(trx, me.institutionId, profileRowId, date);
      const student = { id: binToUuid(card.member_public_id), name: m.name };
      const enrolledIn = async (yearId: string, sectionId: string) => {
        const e = await trx
          .selectFrom('enrolments')
          .select('id')
          .where('year_id', '=', yearId)
          .where('section_id', '=', sectionId)
          .where('student_profile_id', '=', profileRowId)
          .executeTakeFirst();
        if (!e) throw new CustomAPIError(403, 'ATT.NOT_IN_CLASS', { params: { name: m.name } });
      };

      if (input.mode === 'DAILY') {
        // Any class the teacher teaches (client 2026-10-13: the first class of the day takes it
        // for students who missed the gate); without one named, the class teacher's own section.
        const { year, section } = input.classSectionId
          ? await this.taughtSection(trx, me, input.classSectionId, date)
          : await this.classTeacherSection(trx, p, undefined, date);
        assertOpen(await yearFor(trx, me.institutionId, year.publicId));
        await enrolledIn(year.id, String(section.id));
        const day = await trx
          .selectFrom('attendance_days')
          .selectAll()
          .where('profile_id', '=', profileRowId)
          .where('att_date', '=', date)
          .forUpdate()
          .executeTakeFirst();
        if (day && day.status !== 'ABSENT') {
          return { result: 'ALREADY' as const, status: day.status, student, at: at.toISOString() };
        }
        let dayId: string;
        if (!day) {
          const ins = await trx
            .insertInto('attendance_days')
            .values({
              institution_id: me.institutionId,
              year_id: m.year?.id ?? null,
              profile_id: profileRowId,
              section_id: m.sectionId,
              att_date: date,
              checkin_status: 'PRESENT',
              status: 'PRESENT',
              method: 'NFC',
              check_in_at: at,
              updated_by: by,
              created_at: at,
              updated_at: at,
            })
            .executeTakeFirstOrThrow();
          dayId = String(ins.insertId);
        } else {
          await trx
            .updateTable('attendance_days')
            .set({
              status: 'PRESENT',
              checkin_status: 'PRESENT',
              method: 'NFC',
              check_in_at: day.check_in_at ?? at,
              updated_by: by,
              updated_at: at,
              row_version: sql<number>`row_version + 1`,
            })
            .where('id', '=', day.id)
            .execute();
          dayId = day.id;
        }
        await trx
          .insertInto('attendance_events')
          .values({
            institution_id: me.institutionId,
            day_id: dayId,
            action: 'CHECK-IN',
            old_status: day?.status ?? null,
            new_status: 'PRESENT',
            actor: by,
            remark: "Card tapped on the teacher's reader",
            at,
          })
          .execute();
        await this.changed(trx, me.institutionId, date);
        await this.tellCheck(trx, me.institutionId, m, 'IN', at, 'Card tapped in class.');
        return { result: 'MARKED' as const, status: 'PRESENT', student, at: at.toISOString() };
      }

      if (!input.slotId) throw new NotFoundError();
      const slot = await this.slotOf(trx, me.institutionId, input.slotId, date);
      if (String(slot.teacher_profile_id) !== me.rowId) {
        throw new CustomAPIError(403, 'ATT.NOT_YOUR_PERIOD');
      }
      const year = await trx
        .selectFrom('academic_years')
        .select('public_id')
        .where('id', '=', String(slot.year_id))
        .executeTakeFirstOrThrow();
      assertOpen(await yearFor(trx, me.institutionId, binToUuid(year.public_id)));
      await enrolledIn(String(slot.year_id), String(slot.section_id));
      const pd = await trx
        .selectFrom('periods')
        .select(['name', 'starts_at', 'ends_at'])
        .where('id', '=', String(slot.period_id))
        .executeTakeFirstOrThrow();
      const minutes = istMinutes(at);
      const start = toMinutes(pd.starts_at);
      const end = toMinutes(pd.ends_at);
      if (!(start <= minutes + 10 && minutes < end)) {
        throw new CustomAPIError(409, 'ATT.OUTSIDE_PERIOD', {
          params: { start: clock(start), end: clock(end) },
        });
      }
      const existing = await trx
        .selectFrom('period_attendance')
        .select(['status'])
        .where('section_id', '=', String(slot.section_id))
        .where('period_id', '=', String(slot.period_id))
        .where('att_date', '=', date)
        .where('profile_id', '=', profileRowId)
        .executeTakeFirst();
      if (existing) {
        return {
          result: 'ALREADY' as const,
          status: existing.status,
          student,
          at: at.toISOString(),
        };
      }
      const status = minutes <= start ? 'PRESENT' : 'LATE';
      await trx
        .insertInto('period_attendance')
        .values({
          institution_id: me.institutionId,
          year_id: String(slot.year_id),
          section_id: String(slot.section_id),
          period_id: String(slot.period_id),
          subject_id: String(slot.subject_id),
          teacher_profile_id: String(slot.teacher_profile_id),
          att_date: date,
          profile_id: profileRowId,
          status,
          method: 'NFC',
          marked_by: by,
          at,
        })
        .execute();
      return { result: 'MARKED' as const, status, student, at: at.toISOString() };
    });
    await this.deps.cards.touch(String(card.id));
    return out;
  }

  private async gateTap(
    trx: Transaction<Database>,
    terminal: { id: string; institutionId: string },
    m: Awaited<ReturnType<AttendanceService['who']>>,
    date: string,
    at: Date,
  ) {
    const day = await trx
      .selectFrom('attendance_days')
      .selectAll()
      .where('profile_id', '=', m.rowId)
      .where('att_date', '=', date)
      .executeTakeFirst();
    const member = { name: m.name, classSection: m.classSection };
    // A staff member's own timing (client 2026-10-23), else the school's rules.
    const timing = await this.staffTiming(trx, terminal.institutionId, m);
    if (!day) {
      const { status, checkin } = await this.loginOf(timing, m.student, at);
      const ins = await trx
        .insertInto('attendance_days')
        .values({
          institution_id: terminal.institutionId,
          year_id: m.year?.id ?? null,
          profile_id: m.rowId,
          section_id: m.sectionId,
          att_date: date,
          checkin_status: checkin,
          status,
          method: 'NFC',
          check_in_at: at,
          terminal_id: terminal.id,
          created_at: at,
          updated_at: at,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('attendance_events')
        .values({
          institution_id: terminal.institutionId,
          day_id: String(ins.insertId),
          action: 'CHECK-IN',
          new_status: status,
          terminal_id: terminal.id,
          at,
        })
        .execute();
      await this.changed(trx, terminal.institutionId, date);
      await this.tellCheck(trx, terminal.institutionId, m, 'IN', at, 'Card tapped at the gate.');
      return { member, result: 'CHECKED_IN', status, at: at.toISOString() };
    }
    // A non-student's second tap checks them out; anything else is complete (27.3).
    if (m.student || !this.canCheckOut(day, timing)) {
      throw new CustomAPIError(409, 'ATT.ALREADY_COMPLETED');
    }
    await this.notLeavingYet(day, m.name, at);
    const status = await this.logoutOf(timing, day, at);
    await trx
      .updateTable('attendance_days')
      .set({ status, check_out_at: at, updated_at: at, row_version: sql<number>`row_version + 1` })
      .where('id', '=', day.id)
      .execute();
    await trx
      .insertInto('attendance_events')
      .values({
        institution_id: terminal.institutionId,
        day_id: day.id,
        action: 'CHECK-OUT',
        old_status: day.status,
        new_status: status,
        terminal_id: terminal.id,
        at,
      })
      .execute();
    await this.changed(trx, terminal.institutionId, date);
    await this.tellCheck(trx, terminal.institutionId, m, 'OUT', at, 'Card tapped at the gate.');
    return { member, result: 'CHECKED_OUT', status, at: at.toISOString() };
  }

  /** The timetable slot of a section running at a moment (with its period times). */
  private async slotNow(
    db: Db,
    institutionId: string,
    sectionId: string,
    date: string,
    minutes: number,
  ) {
    const year = await this.yearAt(db, institutionId, date);
    if (!year) return { slot: null, next: null };
    const slots = await db
      .selectFrom('timetable_slots as ts')
      .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
      .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
      .select([
        'ts.id',
        'ts.year_id',
        'ts.section_id',
        'ts.period_id',
        'ts.subject_id',
        'ts.teacher_profile_id',
        'pd.name',
        'pd.starts_at',
        'pd.ends_at',
        'sub.name as subject_name',
      ])
      .where('ts.section_id', '=', sectionId)
      .where('ts.year_id', '=', year.id)
      .where('ts.day', '=', weekday(date))
      .orderBy('pd.starts_at')
      .execute();
    const slot = slots.find(
      (s) => toMinutes(s.starts_at) <= minutes + 10 && minutes < toMinutes(s.ends_at),
    );
    return {
      slot: slot ?? null,
      next: slots.find((s) => toMinutes(s.starts_at) > minutes) ?? null,
    };
  }

  private async periodTap(
    trx: Transaction<Database>,
    terminal: { id: string; institutionId: string; sectionId: string | null },
    m: Awaited<ReturnType<AttendanceService['who']>>,
    date: string,
    at: Date,
  ) {
    if (!terminal.sectionId) throw new CustomAPIError(409, 'ATT.NO_PERIOD_NOW');
    if (!m.student || m.sectionId !== terminal.sectionId) {
      throw new CustomAPIError(403, 'ATT.NOT_IN_CLASS', { params: { name: m.name } });
    }
    const minutes = istMinutes(at);
    const { slot, next } = await this.slotNow(
      trx,
      terminal.institutionId,
      terminal.sectionId,
      date,
      minutes,
    );
    if (!slot) {
      if (next) {
        throw new CustomAPIError(409, 'ATT.OUTSIDE_PERIOD', {
          params: { start: clock(toMinutes(next.starts_at)), end: clock(toMinutes(next.ends_at)) },
        });
      }
      throw new CustomAPIError(409, 'ATT.NO_PERIOD_NOW');
    }
    const status = minutes <= toMinutes(slot.starts_at) ? 'PRESENT' : 'LATE';
    try {
      await trx
        .insertInto('period_attendance')
        .values({
          institution_id: terminal.institutionId,
          year_id: String(slot.year_id),
          section_id: String(slot.section_id),
          period_id: String(slot.period_id),
          subject_id: String(slot.subject_id),
          teacher_profile_id: String(slot.teacher_profile_id),
          att_date: date,
          profile_id: m.rowId,
          status,
          method: 'NFC',
          terminal_id: terminal.id,
          at,
        })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'ATT.PERIOD_COMPLETED');
      throw e;
    }
    return {
      member: { name: m.name, classSection: m.classSection },
      result: 'PERIOD_RECORDED',
      status,
      period: {
        name: slot.name,
        subject: slot.subject_name,
        startsAt: hm(slot.starts_at),
        endsAt: hm(slot.ends_at),
      },
      at: at.toISOString(),
    };
  }

  private async locationTap(
    trx: Transaction<Database>,
    terminal: { id: string; institutionId: string; locationType: string | null },
    m: Awaited<ReturnType<AttendanceService['who']>>,
    at: Date,
  ) {
    const type = terminal.locationType
      ? await trx
          .selectFrom('attendance_types')
          .select(['id', 'name', 'cooldown_seconds'])
          .where('institution_id', '=', terminal.institutionId)
          .where('name', '=', terminal.locationType)
          .executeTakeFirst()
      : undefined;
    if (!type) throw new CustomAPIError(404, 'ATT.TYPE_NOT_FOUND');
    await this.recordLocation(trx, {
      institutionId: terminal.institutionId,
      typeId: String(type.id),
      cooldown: type.cooldown_seconds,
      profileRowId: m.rowId,
      method: 'NFC',
      terminalId: terminal.id,
      by: null,
      at,
    });
    return {
      member: { name: m.name, classSection: m.classSection },
      result: 'LOCATION_RECORDED',
      status: 'CHECK_IN',
      location: type.name,
      at: at.toISOString(),
    };
  }

  /** A location check-in after the type's cooling-off interval (OI-ATT-11). */
  async recordLocation(
    db: Db,
    r: {
      institutionId: string;
      typeId: string;
      cooldown: number;
      profileRowId: string;
      method: 'NFC' | 'MANUAL';
      terminalId: string | null;
      by: Buffer | null;
      at: Date;
    },
  ) {
    const last = await db
      .selectFrom('location_attendance')
      .select('at')
      .where('profile_id', '=', r.profileRowId)
      .where('attendance_type_id', '=', r.typeId)
      .orderBy('at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (last) {
      const left = Math.ceil(r.cooldown - (r.at.getTime() - new Date(last.at).getTime()) / 1000);
      if (left > 0)
        throw new CustomAPIError(429, 'ATT.LOCATION_WAIT', { params: { seconds: left } });
    }
    await db
      .insertInto('location_attendance')
      .values({
        institution_id: r.institutionId,
        attendance_type_id: r.typeId,
        profile_id: r.profileRowId,
        method: r.method,
        terminal_id: r.terminalId,
        captured_by: r.by,
        at: r.at,
      })
      .execute();
  }

  /** The console's refresh (OI-ATT-22). */
  private async changed(db: Db, institutionId: string, date: string) {
    await emit(db, {
      institutionId,
      type: 'attendance.updated',
      rooms: [rooms.institutionConsole(institutionId)],
      data: { date },
    });
  }

  // --- manual marking (ATT-010 console, ATT-020 the class teacher) --------------------------------------
  /** Creates or overrides each member's record for the date; old → new is kept (OI-ATT-13). */
  private async mark(
    trx: Transaction<Database>,
    institutionId: string,
    by: Buffer | null,
    date: string,
    rows: readonly { profileRowId: string; status: DailyStatus; remark: string | null }[],
    at: Date,
  ) {
    let saved = 0;
    let overridden = 0;
    for (const r of rows) {
      const m = await this.who(trx, institutionId, r.profileRowId, date);
      const day = await trx
        .selectFrom('attendance_days')
        .selectAll()
        .where('profile_id', '=', r.profileRowId)
        .where('att_date', '=', date)
        .forUpdate()
        .executeTakeFirst();
      const checkin = r.status === 'HALF_DAY' ? 'PRESENT' : r.status;
      let dayId: string;
      if (!day) {
        const ins = await trx
          .insertInto('attendance_days')
          .values({
            institution_id: institutionId,
            year_id: m.year?.id ?? null,
            profile_id: r.profileRowId,
            section_id: m.sectionId,
            att_date: date,
            checkin_status: checkin,
            status: r.status,
            method: 'MANUAL',
            remark: r.remark,
            updated_by: by,
            created_at: at,
            updated_at: at,
          })
          .executeTakeFirstOrThrow();
        dayId = String(ins.insertId);
        saved++;
      } else {
        if (day.status === r.status && (day.remark ?? null) === r.remark) continue;
        await trx
          .updateTable('attendance_days')
          .set({
            status: r.status,
            checkin_status: day.status === r.status ? day.checkin_status : checkin,
            method: 'MANUAL',
            remark: r.remark,
            updated_by: by,
            updated_at: at,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', day.id)
          .execute();
        dayId = day.id;
        overridden++;
      }
      await trx
        .insertInto('attendance_events')
        .values({
          institution_id: institutionId,
          day_id: dayId,
          action: 'MANUAL-ATTENDANCE',
          old_status: day?.status ?? null,
          new_status: r.status,
          actor: by,
          remark: r.remark,
          at,
        })
        .execute();
      if (r.status === 'ABSENT' && day?.status !== 'ABSENT') {
        await this.tellAbsent(trx, institutionId, m, date, at);
      }
    }
    if (saved || overridden) await this.changed(trx, institutionId, date);
    return { saved, overridden };
  }

  private checkDate(date: string) {
    if (!DAY.test(date)) throw new ValidationError([{ field: 'date', code: 'VALIDATION.DATE' }]);
    if (date > istBusinessDate(this.now())) {
      throw new ValidationError([{ field: 'date', code: 'ATT.FUTURE_DATE' }]);
    }
  }

  private checkEntries(entries: readonly MarkEntry[]) {
    entries.forEach((e, i) => {
      if (!STATUSES.includes(e.status)) {
        throw new ValidationError([{ field: `entries.${i}.status`, code: 'VALIDATION.FORMAT' }]);
      }
      if (e.remark && e.remark.trim().length > 200) {
        throw new ValidationError([{ field: `entries.${i}.remark`, code: 'ATT.REMARK' }]);
      }
    });
  }

  /** ATT-010: the console marks members of the institution for a date (back-dated allowed). */
  async markDaily(p: Principal, input: { date: string; entries: readonly MarkEntry[] }) {
    const inst = await institutionOf(this.deps.db, p);
    this.checkDate(input.date);
    this.checkEntries(input.entries);
    const at = this.now();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const year = await this.yearAt(trx, inst.id, input.date);
      if (year) assertOpen(await yearFor(trx, inst.id, year.publicId));
      const rows = [];
      for (const [i, e] of input.entries.entries()) {
        const m = isUuid(e.memberId)
          ? await trx
              .selectFrom('member_profiles')
              .select('id')
              .where('public_id', '=', uuidToBin(e.memberId))
              .where('institution_id', '=', inst.id)
              .executeTakeFirst()
          : undefined;
        if (!m) {
          throw new ValidationError([
            { field: `entries.${i}.memberId`, code: 'ATT.MEMBER_NOT_FOUND', params: { n: i + 1 } },
          ]);
        }
        rows.push({
          profileRowId: String(m.id),
          status: e.status,
          remark: e.remark?.trim() || null,
        });
      }
      const r = await this.mark(trx, inst.id, this.by(p), input.date, rows, at);
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'ATTENDANCE_MARKED',
        entityType: 'attendance',
        after: { date: input.date, ...r },
      });
      return r;
    });
    return { date: input.date, ...out };
  }

  /** The class teacher's sections (or 403 ATT.NO_CLASSES). */
  private async classTeacherSection(
    db: Db,
    p: Principal,
    sectionId: string | undefined,
    date: string,
  ) {
    const me = await teacherOf(db, p);
    const year = await this.yearAt(db, me.institutionId, date);
    if (!year) throw new CustomAPIError(403, 'ATT.NO_CLASSES');
    const sections = await db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('sections as s', 's.id', 'ta.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.id', 's.public_id', 's.name', 'c.name as class_name'])
      .where('ta.teacher_profile_id', '=', me.rowId)
      .where('ta.year_id', '=', year.id)
      .where('ta.kind', '=', 'CLASS_TEACHER')
      .where('ta.ended_at', 'is', null)
      .execute();
    if (!sections.length) throw new CustomAPIError(403, 'ATT.NO_CLASSES');
    const s = sectionId
      ? sections.find(
          (x) => isUuid(sectionId) && binToUuid(x.public_id) === sectionId.toLowerCase(),
        )
      : sections[0];
    if (!s) throw new CustomAPIError(403, 'ACA.CLASS_TEACHER_ONLY');
    return { me, year, section: s, sections };
  }

  /** A section the teacher teaches this year, as class or subject teacher (or 403). */
  private async taughtSection(
    db: Db,
    me: { rowId: string; institutionId: string },
    sectionId: string,
    date: string,
  ) {
    const year = await this.yearAt(db, me.institutionId, date);
    if (!year) throw new CustomAPIError(403, 'ATT.NO_CLASSES');
    const section = isUuid(sectionId)
      ? await db
          .selectFrom('sections as s')
          .innerJoin('teacher_assignments as ta', 'ta.section_id', 's.id')
          .select(['s.id'])
          .where('s.public_id', '=', uuidToBin(sectionId))
          .where('s.institution_id', '=', me.institutionId)
          .where('ta.teacher_profile_id', '=', me.rowId)
          .where('ta.year_id', '=', year.id)
          .where('ta.ended_at', 'is', null)
          .where('ta.kind', 'in', ['CLASS_TEACHER', 'SUBJECT_TEACHER'])
          .executeTakeFirst()
      : undefined;
    if (!section) throw new CustomAPIError(403, 'ACA.NOT_ASSIGNED');
    return { year, section };
  }

  /** ATT-019: the daily register of a class (students, their status, approved leave, holiday). */
  async register(p: Principal, f: { sectionId?: string | undefined; date?: string | undefined }) {
    const date = f.date && DAY.test(f.date) ? f.date : istBusinessDate(this.now());
    const db = this.deps.db;
    const { me, year, section, sections } = await this.classTeacherSection(
      db,
      p,
      f.sectionId,
      date,
    );
    const rows = await db
      .selectFrom('enrolments as en')
      .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
      .leftJoin('attendance_days as d', (j) =>
        j.onRef('d.profile_id', '=', 'm.id').on('d.att_date', '=', date),
      )
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'd.status',
        'd.method',
        'd.check_in_at',
        'd.remark',
        (eb) =>
          eb
            .selectFrom('student_leaves as l')
            .select('l.id')
            .whereRef('l.student_profile_id', '=', 'm.id')
            .where('l.status', '=', 'APPROVED')
            .where('l.from_date', '<=', date)
            .where('l.to_date', '>=', date)
            .limit(1)
            .as('leave_id'),
      ])
      .where('en.year_id', '=', year.id)
      .where('en.section_id', '=', String(section.id))
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    const holiday = (await this.holidays(db, me.institutionId, date, date)).get(date) ?? null;
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      date,
      year: { id: year.publicId },
      section: { id: binToUuid(section.public_id), label: `${section.class_name} ${section.name}` },
      sections: sections.map((s) => ({
        id: binToUuid(s.public_id),
        label: `${s.class_name} ${s.name}`,
      })),
      holiday,
      sunday: weekday(date) === 7,
      counts: {
        students: rows.length,
        present: count('PRESENT'),
        late: count('LATE'),
        halfDay: count('HALF_DAY'),
        absent: count('ABSENT'),
        notMarked: rows.filter((r) => !r.status).length,
        onLeave: rows.filter((r) => r.leave_id).length,
      },
      items: rows.map((r) => ({
        student: {
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          admissionNo: r.admission_no,
        },
        status: r.status ?? null,
        method: r.method ?? null,
        checkInAt: iso(r.check_in_at),
        remark: r.remark ?? null,
        onApprovedLeave: !!r.leave_id,
      })),
    };
  }

  /** ATT-020: the class teacher saves the register (overrides kept). */
  async saveRegister(
    p: Principal,
    input: {
      sectionId: string;
      date: string;
      entries: readonly {
        studentId: string;
        status: DailyStatus;
        remark?: string | null | undefined;
      }[];
    },
  ) {
    this.checkDate(input.date);
    this.checkEntries(
      input.entries.map((e) => ({ memberId: e.studentId, status: e.status, remark: e.remark })),
    );
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const { me, year, section } = await this.classTeacherSection(
        trx,
        p,
        input.sectionId,
        input.date,
      );
      assertOpen(await yearFor(trx, me.institutionId, year.publicId));
      const roster = new Map(
        (
          await trx
            .selectFrom('enrolments as en')
            .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
            .select(['m.id', 'm.public_id'])
            .where('en.year_id', '=', year.id)
            .where('en.section_id', '=', String(section.id))
            .execute()
        ).map((r) => [binToUuid(r.public_id), String(r.id)]),
      );
      const rows = input.entries.map((e, i) => {
        const id = isUuid(e.studentId) ? roster.get(e.studentId.toLowerCase()) : undefined;
        if (!id) {
          throw new ValidationError([
            { field: `entries.${i}.studentId`, code: 'ATT.MEMBER_NOT_FOUND', params: { n: i + 1 } },
          ]);
        }
        return { profileRowId: id, status: e.status, remark: e.remark?.trim() || null };
      });
      const r = await this.mark(trx, me.institutionId, this.by(p), input.date, rows, at);
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'ATTENDANCE_REGISTER_SAVED',
        entityType: 'attendance',
        after: { date: input.date, section: `${section.class_name} ${section.name}`, ...r },
      });
      return { date: input.date, ...r };
    });
  }

  // --- period attendance (ATT-021 / ATT-022) -------------------------------------------------------------
  /** ATT-021: the teacher's periods on a date with how many were captured. */
  async myPeriods(p: Principal, f: { date?: string | undefined }) {
    const me = await teacherOf(this.deps.db, p);
    const date = f.date && DAY.test(f.date) ? f.date : istBusinessDate(this.now());
    const year = await this.yearAt(this.deps.db, me.institutionId, date);
    if (!year) return { date, items: [] };
    const rows = await this.deps.db
      .selectFrom('timetable_slots as ts')
      .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
      .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
      .innerJoin('sections as s', 's.id', 'ts.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'ts.id',
        'pd.public_id as period_public_id',
        'pd.name',
        'pd.starts_at',
        'pd.ends_at',
        'sub.name as subject_name',
        'sub.colour',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.name as class_name',
        (eb) =>
          eb
            .selectFrom('enrolments as en')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('en.section_id', '=', 'ts.section_id')
            .whereRef('en.year_id', '=', 'ts.year_id')
            .as('students'),
        (eb) =>
          eb
            .selectFrom('period_attendance as pa')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('pa.section_id', '=', 'ts.section_id')
            .whereRef('pa.period_id', '=', 'ts.period_id')
            .where('pa.att_date', '=', date)
            .as('captured'),
      ])
      .where('ts.teacher_profile_id', '=', me.rowId)
      .where('ts.year_id', '=', year.id)
      .where('ts.day', '=', weekday(date))
      .orderBy('pd.starts_at')
      .execute();
    const now = date === istBusinessDate(this.now()) ? istMinutes(this.now()) : null;
    return {
      date,
      items: rows.map((r) => ({
        slotId: `${binToUuid(r.section_public_id)}.${binToUuid(r.period_public_id)}`,
        period: { name: r.name, startsAt: hm(r.starts_at), endsAt: hm(r.ends_at) },
        subject: { name: r.subject_name, colour: r.colour },
        section: { id: binToUuid(r.section_public_id), label: `${r.class_name} ${r.section_name}` },
        students: Number(r.students ?? 0),
        captured: Number(r.captured ?? 0),
        state:
          now === null
            ? null
            : now >= toMinutes(r.ends_at)
              ? 'DONE'
              : now >= toMinutes(r.starts_at)
                ? 'NOW'
                : 'LATER',
      })),
    };
  }

  /** "<section id>.<period id>": the timetable slot of that section and period on the date's weekday. */
  async slotOf(db: Db, institutionId: string, slotId: string, date: string) {
    const [sectionId, periodId] = slotId.split('.');
    if (!sectionId || !periodId || !isUuid(sectionId) || !isUuid(periodId) || !DAY.test(date)) {
      throw new NotFoundError();
    }
    const year = await this.yearAt(db, institutionId, date);
    const slot = year
      ? await db
          .selectFrom('timetable_slots as ts')
          .innerJoin('sections as s', 's.id', 'ts.section_id')
          .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
          .select([
            'ts.id',
            'ts.year_id',
            'ts.section_id',
            'ts.period_id',
            'ts.subject_id',
            'ts.teacher_profile_id',
          ])
          .where('ts.institution_id', '=', institutionId)
          .where('ts.year_id', '=', year.id)
          .where('ts.day', '=', weekday(date))
          .where('s.public_id', '=', uuidToBin(sectionId))
          .where('pd.public_id', '=', uuidToBin(periodId))
          .executeTakeFirst()
      : undefined;
    if (!slot) throw new NotFoundError();
    return slot;
  }

  /** ATT-022: the period's teacher marks students present or late (absent removes a manual mark). */
  async markPeriod(
    p: Principal,
    slotId: string,
    input: {
      date: string;
      entries: readonly { studentId: string; status: 'PRESENT' | 'LATE' | 'ABSENT' }[];
    },
  ) {
    const me = await teacherOf(this.deps.db, p);
    this.checkDate(input.date);
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const slot = await this.slotOf(trx, me.institutionId, slotId, input.date);
      if (String(slot.teacher_profile_id) !== me.rowId)
        throw new CustomAPIError(403, 'ATT.NOT_YOUR_PERIOD');
      const year = await trx
        .selectFrom('academic_years')
        .select('public_id')
        .where('id', '=', String(slot.year_id))
        .executeTakeFirstOrThrow();
      assertOpen(await yearFor(trx, me.institutionId, binToUuid(year.public_id)));
      const roster = new Map(
        (
          await trx
            .selectFrom('enrolments as en')
            .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
            .select(['m.id', 'm.public_id'])
            .where('en.year_id', '=', String(slot.year_id))
            .where('en.section_id', '=', String(slot.section_id))
            .execute()
        ).map((r) => [binToUuid(r.public_id), String(r.id)]),
      );
      let saved = 0;
      for (const [i, e] of input.entries.entries()) {
        const id = isUuid(e.studentId) ? roster.get(e.studentId.toLowerCase()) : undefined;
        if (!id) {
          throw new ValidationError([
            { field: `entries.${i}.studentId`, code: 'ATT.MEMBER_NOT_FOUND', params: { n: i + 1 } },
          ]);
        }
        const existing = await trx
          .selectFrom('period_attendance')
          .select(['id', 'status', 'method'])
          .where('section_id', '=', String(slot.section_id))
          .where('period_id', '=', String(slot.period_id))
          .where('att_date', '=', input.date)
          .where('profile_id', '=', id)
          .executeTakeFirst();
        if (e.status === 'ABSENT') {
          if (existing?.method === 'MANUAL') {
            await trx.deleteFrom('period_attendance').where('id', '=', existing.id).execute();
            saved++;
          }
          continue;
        }
        if (existing) {
          if (existing.method === 'MANUAL' && existing.status !== e.status) {
            await trx
              .updateTable('period_attendance')
              .set({ status: e.status, marked_by: this.by(p), at })
              .where('id', '=', existing.id)
              .execute();
            saved++;
          }
          continue;
        }
        await trx
          .insertInto('period_attendance')
          .values({
            institution_id: me.institutionId,
            year_id: String(slot.year_id),
            section_id: String(slot.section_id),
            period_id: String(slot.period_id),
            subject_id: String(slot.subject_id),
            teacher_profile_id: String(slot.teacher_profile_id),
            att_date: input.date,
            profile_id: id,
            status: e.status,
            method: 'MANUAL',
            marked_by: this.by(p),
            at,
          })
          .execute();
        saved++;
      }
      await recordAudit(trx, {
        institutionId: me.institutionId,
        action: 'PERIOD_ATTENDANCE_MARKED',
        entityType: 'timetable_slot',
        entityRef: slotId,
        after: { date: input.date, saved },
      });
      return { date: input.date, saved };
    });
  }

  // --- views and reports ------------------------------------------------------------------------------------
  /** ATT-008: the day by section, and staff, for the year in context. */
  async overview(p: Principal, f: { date?: string | undefined; yearId?: string | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    const date = f.date && DAY.test(f.date) ? f.date : istBusinessDate(this.now());
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const db = this.deps.db;
    const sections = await db
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.section_id', '=', 's.id').on('en.year_id', '=', year.id),
      )
      .leftJoin('attendance_days as d', (j) =>
        j.onRef('d.profile_id', '=', 'en.student_profile_id').on('d.att_date', '=', date),
      )
      .select([
        's.public_id',
        's.name',
        'c.name as class_name',
        'c.sort_order',
        sql<number>`COUNT(en.id)`.as('students'),
        sql<number>`SUM(d.status = 'PRESENT')`.as('present'),
        sql<number>`SUM(d.status = 'LATE')`.as('late'),
        sql<number>`SUM(d.status = 'HALF_DAY')`.as('half_day'),
        sql<number>`SUM(d.status = 'ABSENT')`.as('absent'),
      ])
      .where('s.institution_id', '=', inst.id)
      .groupBy(['s.id', 's.public_id', 's.name', 'c.name', 'c.sort_order'])
      .orderBy('c.sort_order')
      .orderBy('s.name')
      .execute();
    const staff = await this.staffDay(db, inst.id, date);
    const holiday = (await this.holidays(db, inst.id, date, date)).get(date) ?? null;
    const items = sections.map((s) => {
      const students = Number(s.students ?? 0);
      const present = Number(s.present ?? 0);
      const late = Number(s.late ?? 0);
      const half = Number(s.half_day ?? 0);
      const absent = Number(s.absent ?? 0);
      return {
        section: { id: binToUuid(s.public_id), label: `${s.class_name} ${s.name}` },
        students,
        present,
        late,
        halfDay: half,
        absent,
        notMarked: Math.max(0, students - present - late - half - absent),
        percentage: students ? Math.round(((present + late + half) * 1000) / students) / 10 : null,
      };
    });
    const sum = (k: 'students' | 'present' | 'late' | 'halfDay' | 'absent' | 'notMarked') =>
      items.reduce((n, s) => n + s[k], 0);
    return {
      date,
      year: yearView(year),
      holiday,
      sunday: weekday(date) === 7,
      students: {
        total: sum('students'),
        present: sum('present'),
        late: sum('late'),
        halfDay: sum('halfDay'),
        absent: sum('absent'),
        notMarked: sum('notMarked'),
      },
      staff,
      sections: items,
    };
  }

  /** Teachers and other staff on a date: counts by status. */
  private async staffDay(db: Db, institutionId: string, date: string) {
    const rows = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('attendance_days as d', (j) =>
        j.onRef('d.profile_id', '=', 'm.id').on('d.att_date', '=', date),
      )
      .select(['ut.category', 'd.status'])
      .where('m.institution_id', '=', institutionId)
      .where('m.status', '!=', 'INACTIVE')
      .where('ut.category', 'in', ['TEACHER', 'PRINCIPAL', 'STAFF'])
      .execute();
    const group = (cats: string[]) => {
      const g = rows.filter((r) => cats.includes(r.category));
      return {
        total: g.length,
        present: g.filter((r) => r.status === 'PRESENT').length,
        late: g.filter((r) => r.status === 'LATE').length,
        halfDay: g.filter((r) => r.status === 'HALF_DAY').length,
        absent: g.filter((r) => r.status === 'ABSENT').length,
        notMarked: g.filter((r) => !r.status).length,
      };
    };
    return { teachers: group(['TEACHER', 'PRINCIPAL']), others: group(['STAFF']) };
  }

  /** ATT-009: members' attendance over a date range (summary per member and per day). */
  async report(
    p: Principal,
    f: {
      from?: string | undefined;
      to?: string | undefined;
      type?: 'STUDENT' | 'TEACHER' | 'STAFF' | 'ALL' | undefined;
      sectionId?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const today = istBusinessDate(this.now());
    const to = f.to && DAY.test(f.to) ? f.to : today;
    const from = f.from && DAY.test(f.from) ? f.from : addDays(to, -29);
    const max = await this.limit(LIMITS.attendanceReportMaxDays);
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    if (days < 1 || days > max)
      throw new ValidationError([{ field: 'from', code: 'ATT.RANGE', params: { days: max } }]);
    const db = this.deps.db;
    const type = f.type ?? 'STUDENT';
    let members = db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'ut.name as type_name',
        'ut.category',
      ])
      .where('m.institution_id', '=', inst.id)
      .where('m.status', '!=', 'INACTIVE');
    if (type === 'STUDENT') members = members.where('ut.category', '=', 'STUDENT');
    if (type === 'TEACHER') members = members.where('ut.category', 'in', ['TEACHER', 'PRINCIPAL']);
    if (type === 'STAFF') members = members.where('ut.category', '=', 'STAFF');
    if (type === 'ALL')
      members = members.where('ut.category', 'in', ['STUDENT', 'TEACHER', 'PRINCIPAL', 'STAFF']);
    if (f.sectionId && isUuid(f.sectionId)) {
      const sid = f.sectionId;
      members = members.where((eb) =>
        eb.exists(
          eb
            .selectFrom('enrolments as en')
            .innerJoin('sections as s', 's.id', 'en.section_id')
            .select('en.id')
            .whereRef('en.student_profile_id', '=', 'm.id')
            .where('s.public_id', '=', uuidToBin(sid)),
        ),
      );
    }
    if (f.cursor && /^\d+$/.test(f.cursor)) members = members.where('m.id', '>', f.cursor);
    const page = await members.orderBy('m.id').limit(101).execute();
    const list = page.slice(0, 100);
    const records = list.length
      ? await db
          .selectFrom('attendance_days')
          .select(['profile_id', 'att_date', 'status'])
          .where('institution_id', '=', inst.id)
          .where('att_date', '>=', from)
          .where('att_date', '<=', to)
          .where(
            'profile_id',
            'in',
            list.map((m) => String(m.id)),
          )
          .execute()
      : [];
    const holidays = await this.holidays(db, inst.id, from, to);
    let schoolDays = 0;
    for (let d = from; d <= to; d = addDays(d, 1))
      if (weekday(d) !== 7 && !holidays.has(d)) schoolDays++;
    const byMember = new Map<string, typeof records>();
    for (const r of records)
      byMember.set(String(r.profile_id), [...(byMember.get(String(r.profile_id)) ?? []), r]);
    return {
      from,
      to,
      type,
      schoolDays,
      items: list.map((m) => {
        const rs = byMember.get(String(m.id)) ?? [];
        const c = (s: string) => rs.filter((r) => r.status === s).length;
        const attended = c('PRESENT') + c('LATE') + c('HALF_DAY');
        return {
          member: {
            id: binToUuid(m.public_id),
            name: nameOf(m.first_name, m.last_name),
            admissionNo: m.admission_no,
            type: m.type_name,
          },
          present: c('PRESENT'),
          late: c('LATE'),
          halfDay: c('HALF_DAY'),
          absent: c('ABSENT'),
          notMarked: Math.max(0, schoolDays - rs.length),
          percentage: schoolDays ? Math.round((attended * 1000) / schoolDays) / 10 : null,
        };
      }),
      nextCursor: page.length > 100 ? String(list.at(-1)!.id) : null,
    };
  }

  /**
   * ATT-032: each staff member's month for payroll (client 2026-10-22) — days worked, approved leave
   * and loss of pay, with the days to check. Teachers, the principal and non-teaching staff employed
   * in the month, someone who left during it too; the rules are payroll-attendance.ts's.
   */
  async payroll(
    p: Principal,
    f: { month?: string | undefined; type?: 'ALL' | 'TEACHERS' | 'STAFF' | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const today = istBusinessDate(this.now());
    const month = f.month ?? today.slice(0, 7);
    const from = `${month}-01`;
    const next = new Date(`${from}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const to = addDays(next.toISOString().slice(0, 10), -1);
    const through = today < to ? today : to;
    const type = f.type ?? 'ALL';
    // Everyone on the payroll is staff as onboarding has it: management, crew and other staff too.
    const cats =
      type === 'TEACHERS'
        ? TEACHING
        : type === 'STAFF'
          ? KIND_CATEGORIES.STAFF.filter((c) => !TEACHING.includes(c))
          : KIND_CATEGORIES.STAFF;
    const db = this.deps.db;
    const rows = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('departments as dp', 'dp.id', 'm.department_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.employee_no',
        'm.joined_on',
        'm.status',
        'm.status_changed_at',
        'ut.name as type_name',
        'ut.category',
        'dp.name as department',
      ])
      .where('m.institution_id', '=', inst.id)
      .where('ut.category', 'in', cats as never[])
      // Who left before the month began isn't on its payroll; who joined after it ended neither.
      .where((eb) =>
        eb.or([
          eb('m.status', '!=', 'INACTIVE'),
          eb('m.status_changed_at', '>=', new Date(`${from}T00:00:00+05:30`)),
        ]),
      )
      .where((eb) => eb.or([eb('m.joined_on', 'is', null), eb('m.joined_on', '<=', to)]))
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    const ids = rows.map((r) => String(r.id));
    const [records, leaves, holidays] = await Promise.all([
      ids.length
        ? db
            .selectFrom('attendance_days')
            .select(['profile_id', 'att_date', 'status'])
            .where('institution_id', '=', inst.id)
            .where('att_date', '>=', from)
            .where('att_date', '<=', to)
            .where('profile_id', 'in', ids)
            .execute()
        : Promise.resolve([]),
      ids.length
        ? db
            .selectFrom('staff_leaves')
            .select(['profile_id', 'leave_type', 'from_date', 'to_date'])
            .where('institution_id', '=', inst.id)
            .where('final_status', '=', 'APPROVED')
            .where('from_date', '<=', to)
            .where('to_date', '>=', from)
            .where('profile_id', 'in', ids)
            .execute()
        : Promise.resolve([]),
      this.holidays(db, inst.id, from, to),
    ]);
    const statuses = new Map<string, Map<string, DayStatus>>();
    for (const r of records) {
      const m = statuses.get(String(r.profile_id)) ?? new Map<string, DayStatus>();
      m.set(ymd(r.att_date), r.status);
      statuses.set(String(r.profile_id), m);
    }
    const onLeave = new Map<string, Map<string, LeaveType>>();
    for (const l of leaves) {
      const m = onLeave.get(String(l.profile_id)) ?? new Map<string, LeaveType>();
      const start = ymd(l.from_date) < from ? from : ymd(l.from_date);
      for (let d = start; d <= ymd(l.to_date) && d <= to; d = addDays(d, 1)) m.set(d, l.leave_type);
      onLeave.set(String(l.profile_id), m);
    }
    let days = 0;
    let sundays = 0;
    let workingDays = 0;
    const offs: { date: string; title: string }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days++;
      if (weekday(d) === 7) sundays++;
      else if (holidays.has(d)) offs.push({ date: d, title: holidays.get(d)! });
      else workingDays++;
    }
    const items = rows.map((r) => {
      const joinedOn = r.joined_on ? ymd(r.joined_on) : null;
      const leftOn =
        r.status === 'INACTIVE' && r.status_changed_at
          ? istBusinessDate(new Date(r.status_changed_at))
          : null;
      return {
        member: {
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          employeeNo: r.employee_no,
          type: r.type_name,
          teaching: TEACHING.includes(r.category),
          department: r.department ?? null,
          joinedOn,
          leftOn,
        },
        ...payrollMonth({
          from,
          to,
          through,
          holidays,
          joinedOn,
          leftOn,
          statuses: statuses.get(String(r.id)) ?? new Map(),
          leave: onLeave.get(String(r.id)) ?? new Map(),
        }),
      };
    });
    return {
      month,
      from,
      to,
      /** The last day read: today in a running month; null before the month begins. */
      through: through >= from ? through : null,
      complete: today > to,
      days,
      workingDays,
      sundays,
      holidays: offs,
      counts: {
        staff: items.length,
        withLop: items.filter((i) => i.lopDays > 0).length,
        notMarked: items.reduce((n, i) => n + i.notMarked, 0),
      },
      items,
    };
  }

  /** ATT-023: a member's month (for: a child on the account) — each day and the summary. */
  async myMonth(p: Principal, f: { for?: string | undefined; month?: string | undefined }) {
    const me = await memberOf(this.deps.db, p, f.for);
    const today = istBusinessDate(this.now());
    const month = f.month && /^\d{4}-\d{2}$/.test(f.month) ? f.month : today.slice(0, 7);
    const from = `${month}-01`;
    const next = new Date(`${from}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const to = addDays(next.toISOString().slice(0, 10), -1);
    const db = this.deps.db;
    const records = await db
      .selectFrom('attendance_days')
      .select(['att_date', 'status', 'check_in_at', 'check_out_at', 'method'])
      .where('profile_id', '=', me.rowId)
      .where('att_date', '>=', from)
      .where('att_date', '<=', to)
      .execute();
    const byDate = new Map(records.map((r) => [ymd(r.att_date), r]));
    const holidays = await this.holidays(db, me.institutionId, from, to);
    // Approved leave: a student's, or a teacher's or staff member's own (ATT-023).
    const leaves =
      me.category === 'STUDENT'
        ? await db
            .selectFrom('student_leaves')
            .select(['from_date', 'to_date'])
            .where('student_profile_id', '=', me.rowId)
            .where('status', '=', 'APPROVED')
            .where('from_date', '<=', to)
            .where('to_date', '>=', from)
            .execute()
        : await db
            .selectFrom('staff_leaves')
            .select(['from_date', 'to_date'])
            .where('profile_id', '=', me.rowId)
            .where('final_status', '=', 'APPROVED')
            .where('from_date', '<=', to)
            .where('to_date', '>=', from)
            .execute();
    const onLeave = (d: string) => leaves.some((l) => ymd(l.from_date) <= d && ymd(l.to_date) >= d);
    const items = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = byDate.get(d);
      items.push({
        date: d,
        status: r?.status ?? null,
        checkInAt: iso(r?.check_in_at),
        checkOutAt: iso(r?.check_out_at),
        holiday: holidays.get(d) ?? null,
        sunday: weekday(d) === 7,
        onApprovedLeave: onLeave(d),
        future: d > today,
      });
    }
    const school = items.filter((i) => !i.sunday && !i.holiday && !i.future);
    const attended = school.filter((i) => i.status && i.status !== 'ABSENT').length;
    return {
      member: { name: me.name },
      month,
      summary: {
        schoolDays: school.length,
        present: school.filter((i) => i.status === 'PRESENT').length,
        late: school.filter((i) => i.status === 'LATE').length,
        halfDay: school.filter((i) => i.status === 'HALF_DAY').length,
        absent: school.filter((i) => i.status === 'ABSENT').length,
        notMarked: school.filter((i) => !i.status).length,
        percentage: school.length ? Math.round((attended * 1000) / school.length) / 10 : null,
      },
      items,
    };
  }

  /** ATT-026: the principal's day — students by section, and teachers and staff by name. */
  async principalDay(
    p: Principal,
    f: { date?: string | undefined; type?: 'STUDENTS' | 'TEACHERS' | 'STAFF' | undefined },
  ) {
    const me = await principalOf(this.deps.db, p);
    const date = f.date && DAY.test(f.date) ? f.date : istBusinessDate(this.now());
    const db = this.deps.db;
    const type = f.type ?? 'STUDENTS';
    const year = await yearFor(db, me.institutionId, undefined);
    if (type === 'STUDENTS') {
      const sections = await db
        .selectFrom('sections as s')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .leftJoin('enrolments as en', (j) =>
          j.onRef('en.section_id', '=', 's.id').on('en.year_id', '=', year.id),
        )
        .leftJoin('attendance_days as d', (j) =>
          j.onRef('d.profile_id', '=', 'en.student_profile_id').on('d.att_date', '=', date),
        )
        .select([
          's.public_id',
          's.name',
          'c.name as class_name',
          'c.sort_order',
          sql<number>`COUNT(en.id)`.as('students'),
          sql<number>`SUM(d.status IN ('PRESENT','LATE','HALF_DAY'))`.as('attended'),
          sql<number>`SUM(d.status = 'PRESENT')`.as('present'),
          sql<number>`SUM(d.status = 'LATE')`.as('late'),
          sql<number>`SUM(d.status = 'HALF_DAY')`.as('half_day'),
          sql<number>`SUM(d.status = 'ABSENT')`.as('absent'),
        ])
        .where('s.institution_id', '=', me.institutionId)
        .groupBy(['s.id', 's.public_id', 's.name', 'c.name', 'c.sort_order'])
        .orderBy('c.sort_order')
        .orderBy('s.name')
        .execute();
      return {
        date,
        type,
        items: sections.map((s) => ({
          section: { id: binToUuid(s.public_id), label: `${s.class_name} ${s.name}` },
          students: Number(s.students ?? 0),
          // Attended = on time + late + half day (client 2026-10-25: each count shown too).
          attended: Number(s.attended ?? 0),
          present: Number(s.present ?? 0),
          late: Number(s.late ?? 0),
          halfDay: Number(s.half_day ?? 0),
          absent: Number(s.absent ?? 0),
          percentage: Number(s.students ?? 0)
            ? Math.round((Number(s.attended ?? 0) * 1000) / Number(s.students)) / 10
            : null,
        })),
      };
    }
    const rows = await db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('attendance_days as d', (j) =>
        j.onRef('d.profile_id', '=', 'm.id').on('d.att_date', '=', date),
      )
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'ut.name as type_name',
        'd.status',
        'd.check_in_at',
        'd.check_out_at',
        (eb) =>
          eb
            .selectFrom('staff_leaves as l')
            .select('l.id')
            .whereRef('l.profile_id', '=', 'm.id')
            .where('l.final_status', '=', 'APPROVED')
            .where('l.from_date', '<=', date)
            .where('l.to_date', '>=', date)
            .limit(1)
            .as('leave_id'),
      ])
      .where('m.institution_id', '=', me.institutionId)
      .where('m.status', '!=', 'INACTIVE')
      // The principal with the teachers, as the console's attendance overview counts them.
      .where('ut.category', 'in', type === 'TEACHERS' ? ['TEACHER', 'PRINCIPAL'] : ['STAFF'])
      .orderBy('m.first_name')
      .execute();
    return {
      date,
      type,
      items: rows.map((r) => ({
        member: {
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          type: r.type_name,
        },
        status: r.status ?? null,
        checkInAt: iso(r.check_in_at),
        checkOutAt: iso(r.check_out_at),
        onApprovedLeave: !!r.leave_id,
      })),
    };
  }

  // --- staff attendance at the front desk (client 2026-10-22; ATT-029…031) ----------------------------------
  /**
   * ATT-029: teachers, the principal and non-teaching staff on a date — each one's status, check-in
   * and check-out times, how it was recorded and approved leave — for the front desk and the
   * console. The same records the gate readers, the principal and the staff member's own app read.
   */
  async staffRoster(
    p: Principal,
    f: { date?: string | undefined; type?: 'ALL' | 'TEACHERS' | 'STAFF' | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const date = f.date && DAY.test(f.date) ? f.date : istBusinessDate(this.now());
    const type = f.type ?? 'ALL';
    const cats =
      type === 'TEACHERS'
        ? ['TEACHER', 'PRINCIPAL']
        : type === 'STAFF'
          ? ['STAFF']
          : [...STAFF_CATEGORIES];
    const rows = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('attendance_days as d', (j) =>
        j.onRef('d.profile_id', '=', 'm.id').on('d.att_date', '=', date),
      )
      .select([
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'ut.name as type_name',
        'ut.category',
        'd.status',
        'd.check_in_at',
        'd.check_out_at',
        'd.method',
        'd.remark',
        (eb) =>
          eb
            .selectFrom('staff_leaves as l')
            .select('l.id')
            .whereRef('l.profile_id', '=', 'm.id')
            .where('l.final_status', '=', 'APPROVED')
            .where('l.from_date', '<=', date)
            .where('l.to_date', '>=', date)
            .limit(1)
            .as('leave_id'),
        (eb) =>
          eb
            .selectFrom('cards as c')
            .select('c.id')
            .whereRef('c.profile_id', '=', 'm.id')
            .where('c.status', '=', 'ACTIVE')
            .limit(1)
            .as('card_id'),
      ])
      .where('m.institution_id', '=', inst.id)
      .where('m.status', '!=', 'INACTIVE')
      .where('ut.category', 'in', cats as never[])
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .execute();
    const items = rows.map((r) => ({
      member: {
        id: binToUuid(r.public_id),
        name: nameOf(r.first_name, r.last_name),
        type: r.type_name,
        teaching: r.category !== 'STAFF',
        hasCard: !!r.card_id,
      },
      status: r.status ?? null,
      checkInAt: iso(r.check_in_at),
      checkOutAt: iso(r.check_out_at),
      method: r.method ?? null,
      remark: r.remark ?? null,
      onApprovedLeave: !!r.leave_id,
    }));
    const n = (s: string) => items.filter((i) => i.status === s).length;
    return {
      date,
      today: date === istBusinessDate(this.now()),
      counts: {
        total: items.length,
        present: n('PRESENT'),
        late: n('LATE'),
        halfDay: n('HALF_DAY'),
        absent: n('ABSENT'),
        onCampus: items.filter((i) => i.checkInAt && !i.checkOutAt).length,
        notMarked: items.filter((i) => !i.status).length,
      },
      items,
    };
  }

  /** The staff member a card or an id names, for the front desk (staff only). */
  private async staffMember(db: Db, institutionId: string, profileRowId: string, date: string) {
    const m = await this.who(db, institutionId, profileRowId, date);
    if (!STAFF_CATEGORIES.includes(m.category as (typeof STAFF_CATEGORIES)[number])) {
      throw new CustomAPIError(422, 'ATT.NOT_STAFF', { params: { name: m.name } });
    }
    return m;
  }

  /** A staff member's timing (client 2026-10-23): null for anyone else, or staff without one. */
  private async staffTiming(db: Db, institutionId: string, m: { rowId: string; category: string }) {
    return STAFF_CATEGORIES.includes(m.category as (typeof STAFF_CATEGORIES)[number])
      ? timingOf(db, institutionId, m.rowId)
      : null;
  }

  /**
   * A check-in: by the staff member's timing (Present, Late, Half day or Absent; client 2026-10-23),
   * else Present up to the school's late cut-off and Late after it (a student is Present).
   */
  private async loginOf(
    timing: Awaited<ReturnType<AttendanceService['staffTiming']>>,
    student: boolean,
    at: Date,
  ): Promise<{ status: DailyStatus; checkin: CheckinStatus }> {
    if (timing) return loginStatus(timing, istMinutes(at));
    const cutoff = await this.limit(LIMITS.attendanceLateCutoffMinutes);
    const status = student || istMinutes(at) <= cutoff ? 'PRESENT' : 'LATE';
    return { status, checkin: status };
  }

  /**
   * Whether the day can be checked out: checked in, not out, not Absent. A Half day only with a
   * timing (a late login; the school's rules make a Half day at the check-out).
   */
  private canCheckOut(
    day: { check_in_at: Date | null; check_out_at: Date | null; status: DailyStatus },
    timing: Awaited<ReturnType<AttendanceService['staffTiming']>>,
  ) {
    return (
      !!day.check_in_at &&
      !day.check_out_at &&
      day.status !== 'ABSENT' &&
      (day.status !== 'HALF_DAY' || !!timing)
    );
  }

  /**
   * A check-out: by the staff member's timing a Half day before the early logout time (client
   * 2026-10-23), else Present after the half-day hours and Half day before them.
   */
  private async logoutOf(
    timing: Awaited<ReturnType<AttendanceService['staffTiming']>>,
    day: { check_in_at: Date | null; status: DailyStatus },
    at: Date,
  ): Promise<DailyStatus> {
    if (timing) return logoutStatus(timing, istMinutes(at), day.status);
    const half = await this.limit(LIMITS.attendanceHalfDayMinutes);
    const minutes = (at.getTime() - new Date(day.check_in_at!).getTime()) / 60_000;
    return minutes >= half ? 'PRESENT' : 'HALF_DAY';
  }

  /**
   * A staff member checked in or out today as at the gate (27.3): the first check-in is Present up to
   * the late cut-off and Late after it; the check-out is Present after the half-day time, Half day
   * before it — or as the staff member's timing says (client 2026-10-23). At the front desk a day marked Absent (auto-absent, or by hand) without a check-in can
   * still be checked in — the person is here; old → new is kept. `AUTO` (a card) checks in, else out.
   */
  private async staffCheck(
    trx: Transaction<Database>,
    institutionId: string,
    m: Awaited<ReturnType<AttendanceService['who']>>,
    date: string,
    at: Date,
    o: {
      action: 'AUTO' | 'IN' | 'OUT';
      method: 'NFC' | 'MANUAL';
      actor: Buffer | null;
      remark: string;
    },
  ) {
    const day = await trx
      .selectFrom('attendance_days')
      .selectAll()
      .where('profile_id', '=', m.rowId)
      .where('att_date', '=', date)
      .forUpdate()
      .executeTakeFirst();
    const member = { id: m.publicId, name: m.name };
    // The staff member's own timing (client 2026-10-23), else the school's rules.
    const timing = await this.staffTiming(trx, institutionId, m);
    const canCheckIn = !day || !day.check_in_at;
    const canCheckOut = !!day && this.canCheckOut(day, timing);
    const action = o.action === 'AUTO' ? (canCheckIn ? 'IN' : 'OUT') : o.action;
    if (action === 'IN') {
      if (!canCheckIn) throw new CustomAPIError(409, 'ATT.ALREADY_CHECKED_IN');
      const { status, checkin } = await this.loginOf(timing, false, at);
      let dayId: string;
      if (!day) {
        const ins = await trx
          .insertInto('attendance_days')
          .values({
            institution_id: institutionId,
            year_id: m.year?.id ?? null,
            profile_id: m.rowId,
            section_id: null,
            att_date: date,
            checkin_status: checkin,
            status,
            method: o.method,
            check_in_at: at,
            updated_by: o.actor,
            created_at: at,
            updated_at: at,
          })
          .executeTakeFirstOrThrow();
        dayId = String(ins.insertId);
      } else {
        await trx
          .updateTable('attendance_days')
          .set({
            status,
            checkin_status: checkin,
            method: o.method,
            check_in_at: at,
            updated_by: o.actor,
            updated_at: at,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', day.id)
          .execute();
        dayId = day.id;
      }
      await trx
        .insertInto('attendance_events')
        .values({
          institution_id: institutionId,
          day_id: dayId,
          action: 'CHECK-IN',
          old_status: day?.status ?? null,
          new_status: status,
          actor: o.actor,
          remark: o.remark,
          at,
        })
        .execute();
      await this.changed(trx, institutionId, date);
      await this.tellCheck(trx, institutionId, m, 'IN', at, `${o.remark}.`);
      return { result: 'CHECKED_IN' as const, status, member, at: at.toISOString() };
    }
    if (!canCheckOut) {
      if (o.action === 'AUTO') {
        // A card tapped again after the day is complete: said, not refused.
        return {
          result: 'COMPLETE' as const,
          status: day!.status,
          member,
          at: at.toISOString(),
        };
      }
      throw new CustomAPIError(
        409,
        day?.check_in_at ? 'ATT.ALREADY_COMPLETED' : 'ATT.NOT_CHECKED_IN',
      );
    }
    // A card tap (AUTO) so soon after the check-in is a repeated scan, not a check-out.
    if (o.action === 'AUTO') await this.notLeavingYet(day!, m.name, at);
    const status = await this.logoutOf(timing, day!, at);
    await trx
      .updateTable('attendance_days')
      .set({
        status,
        check_out_at: at,
        updated_by: o.actor,
        updated_at: at,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', day!.id)
      .execute();
    await trx
      .insertInto('attendance_events')
      .values({
        institution_id: institutionId,
        day_id: day!.id,
        action: 'CHECK-OUT',
        old_status: day!.status,
        new_status: status,
        actor: o.actor,
        remark: o.remark,
        at,
      })
      .execute();
    await this.changed(trx, institutionId, date);
    await this.tellCheck(trx, institutionId, m, 'OUT', at, `${o.remark}.`);
    return { result: 'CHECKED_OUT' as const, status, member, at: at.toISOString() };
  }

  /**
   * ATT-030: a staff member taps their card on the front desk's USB reader (CampusOne Card Reader): the
   * first tap of the day checks them in, the next checks them out; a tap after that says the day is
   * complete. Students are refused (they tap at the gate or in class).
   */
  async deskTap(p: Principal, input: { cardToken: string }) {
    const inst = await institutionOf(this.deps.db, p);
    const card = await this.deps.cards.activeCard(inst.id, input.cardToken);
    const at = this.now();
    await this.notTooSoon(String(card.id), at);
    const date = istBusinessDate(at);
    const profileRowId = String(card.profile_id);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', profileRowId)
        .forUpdate()
        .execute();
      const m = await this.staffMember(trx, inst.id, profileRowId, date);
      return this.staffCheck(trx, inst.id, m, date, at, {
        action: 'AUTO',
        method: 'NFC',
        actor: this.by(p),
        remark: 'Card tapped at the front desk',
      });
    });
    await this.deps.cards.touch(String(card.id));
    return out;
  }

  /**
   * ATT-031: the front desk checks a staff member in or out by name (no card with them, or the
   * reader down), now; the reason is kept with the record. Back-dated corrections use manual
   * marking (ATT-010).
   */
  async deskCheck(
    p: Principal,
    input: { memberId: string; action: 'IN' | 'OUT'; remark?: string | null | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const remark = input.remark?.trim() || null;
    if (remark && remark.length > 200)
      throw new ValidationError([{ field: 'remark', code: 'ATT.REMARK' }]);
    const row = isUuid(input.memberId)
      ? await this.deps.db
          .selectFrom('member_profiles')
          .select('id')
          .where('public_id', '=', uuidToBin(input.memberId))
          .where('institution_id', '=', inst.id)
          .executeTakeFirst()
      : undefined;
    if (!row) throw new NotFoundError();
    const at = this.now();
    const date = istBusinessDate(at);
    return this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', String(row.id))
        .forUpdate()
        .execute();
      const m = await this.staffMember(trx, inst.id, String(row.id), date);
      const out = await this.staffCheck(trx, inst.id, m, date, at, {
        action: input.action,
        method: 'MANUAL',
        actor: this.by(p),
        remark: remark ?? `Checked ${input.action === 'IN' ? 'in' : 'out'} at the front desk`,
      });
      await recordAudit(trx, {
        institutionId: inst.id,
        action: input.action === 'IN' ? 'STAFF_CHECKED_IN' : 'STAFF_CHECKED_OUT',
        entityType: 'attendance',
        entityRef: m.publicId,
        after: { date, status: out.status, remark },
      });
      return out;
    });
  }

  /** For the teacher's roster and day, and the principal's overview: one date's statuses. */
  async statusesOn(db: Db, profileRowIds: readonly string[], date: string) {
    if (!profileRowIds.length) return new Map<string, DailyStatus>();
    const rows = await db
      .selectFrom('attendance_days')
      .select(['profile_id', 'status'])
      .where('att_date', '=', date)
      .where('profile_id', 'in', profileRowIds as string[])
      .execute();
    return new Map(rows.map((r) => [String(r.profile_id), r.status]));
  }

  /** The year of a date, for callers that check it is open. */
  async openYearAt(db: Db, institutionId: string, date: string): Promise<Year | null> {
    const y = await this.yearAt(db, institutionId, date);
    return y ? yearFor(db, institutionId, y.publicId) : null;
  }
}

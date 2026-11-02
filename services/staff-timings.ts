/**
 * Staff timings (client 2026-10-23; the Auto-absent page): the school's working day for staff, by
 * role — as many timings as it needs, a role in one only (migration 0088).
 *
 * - A login up to the late login time is Present, after it Late, after the half-day time a Half day,
 *   after the absent time Absent (the check-in time is kept).
 * - A logout before the early logout time makes the day a Half day.
 * - A staff member with no login by the absent time is marked Absent (the job `auto-absent`).
 *
 * Staff only (the Teacher, Principal and Staff user types). A staff member whose roles are in two
 * timings follows the one made first; one whose roles are in none keeps the school's rules (the late
 * cut-off, the half-day hours and the auto-absent cut-off).
 */
import type { Kysely, Transaction } from 'kysely';
import type { CheckinStatus, DailyStatus, Database } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export const STAFF_TIMING_CATEGORIES = ['TEACHER', 'PRINCIPAL', 'STAFF'] as const;

/** The roles a timing can't be for: merchants aren't staff. */
export const NOT_STAFF_ROLES: readonly string[] = ['MERCHANT', 'VENDOR_MERCHANT'];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "09:15" or "09:15:00" → minutes after midnight. */
export const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** A timing's times, in minutes after midnight (IST). */
export interface TimingMinutes {
  readonly id: string;
  readonly login: number;
  readonly logout: number;
  readonly lateLogin: number;
  readonly earlyLogout: number;
  readonly halfDay: number;
  readonly absent: number;
}

export const timingMinutes = (r: {
  id: string;
  login_time: string;
  logout_time: string;
  late_login_time: string;
  early_logout_time: string;
  half_day_time: string;
  absent_time: string;
}): TimingMinutes => ({
  id: String(r.id),
  login: minutesOf(r.login_time),
  logout: minutesOf(r.logout_time),
  lateLogin: minutesOf(r.late_login_time),
  earlyLogout: minutesOf(r.early_logout_time),
  halfDay: minutesOf(r.half_day_time),
  absent: minutesOf(r.absent_time),
});

/** What a login at `minutes` is under a timing: the day's status and the check-in status. */
export function loginStatus(
  t: TimingMinutes,
  minutes: number,
): { status: DailyStatus; checkin: CheckinStatus } {
  if (minutes <= t.lateLogin) return { status: 'PRESENT', checkin: 'PRESENT' };
  if (minutes <= t.halfDay) return { status: 'LATE', checkin: 'LATE' };
  if (minutes <= t.absent) return { status: 'HALF_DAY', checkin: 'LATE' };
  return { status: 'ABSENT', checkin: 'ABSENT' };
}

/** What a logout at `minutes` makes the day: a Half day before the early logout time. */
export function logoutStatus(t: TimingMinutes, minutes: number, current: DailyStatus): DailyStatus {
  return minutes < t.earlyLogout ? 'HALF_DAY' : current;
}

/** The six times of a timing as the console sends them ("HH:MM"). */
export interface TimingTimes {
  readonly loginTime: string;
  readonly logoutTime: string;
  readonly lateLoginTime: string;
  readonly earlyLogoutTime: string;
  readonly halfDayTime: string;
  readonly absentTime: string;
}

const LABEL: Record<keyof TimingTimes, string> = {
  loginTime: 'login time',
  logoutTime: 'logout time',
  lateLoginTime: 'late login time',
  earlyLogoutTime: 'early logout time',
  halfDayTime: 'half-day time',
  absentTime: 'absent time',
};

/**
 * The times in the day's order: login, late login, half day, absent, logout; the early logout
 * between the login and the logout. Each error is on the later field.
 */
export function timingErrors(t: TimingTimes) {
  const errors: { field: string; code: string; params?: Record<string, string> }[] = [];
  const keys = Object.keys(LABEL) as (keyof TimingTimes)[];
  for (const k of keys) {
    const v = t[k]?.trim() ?? '';
    if (!v) errors.push({ field: k, code: 'VALIDATION.REQUIRED' });
    else if (!TIME.test(v)) errors.push({ field: k, code: 'VALIDATION.FORMAT' });
  }
  if (errors.length) return errors;
  const m = (k: keyof TimingTimes) => minutesOf(t[k]);
  const after = (k: keyof TimingTimes, than: keyof TimingTimes) => {
    if (m(k) <= m(than)) {
      errors.push({ field: k, code: 'ATT.TIMING_AFTER', params: { after: LABEL[than] } });
    }
  };
  after('lateLoginTime', 'loginTime');
  after('halfDayTime', 'lateLoginTime');
  after('absentTime', 'halfDayTime');
  after('logoutTime', 'absentTime');
  after('earlyLogoutTime', 'loginTime');
  if (m('earlyLogoutTime') >= m('logoutTime')) {
    errors.push({
      field: 'earlyLogoutTime',
      code: 'ATT.TIMING_BEFORE',
      params: { before: LABEL.logoutTime },
    });
  }
  return errors;
}

const TIMING_COLUMNS = [
  'st.id',
  'st.login_time',
  'st.logout_time',
  'st.late_login_time',
  'st.early_logout_time',
  'st.half_day_time',
  'st.absent_time',
] as const;

/** The timing a staff member follows: of their roles' timings, the one made first; null if none. */
export async function timingOf(
  db: Db,
  institutionId: string,
  profileRowId: string,
): Promise<TimingMinutes | null> {
  const r = await db
    .selectFrom('staff_timings as st')
    .innerJoin('staff_timing_roles as sr', 'sr.timing_id', 'st.id')
    .innerJoin('profile_roles as pr', (j) =>
      j.onRef('pr.role_id', '=', 'sr.role_id').onRef('pr.institution_id', '=', 'st.institution_id'),
    )
    .select(TIMING_COLUMNS)
    .where('st.institution_id', '=', institutionId)
    .where('pr.profile_id', '=', profileRowId)
    .orderBy('st.id')
    .limit(1)
    .executeTakeFirst();
  return r ? timingMinutes(r) : null;
}

/** A school's staff by the timing they follow (profile row id → timing row id). */
export async function timingIdsByProfile(db: Db, institutionId: string) {
  const rows = await db
    .selectFrom('profile_roles as pr')
    .innerJoin('staff_timing_roles as sr', (j) =>
      j.onRef('sr.role_id', '=', 'pr.role_id').onRef('sr.institution_id', '=', 'pr.institution_id'),
    )
    .select(['pr.profile_id', (eb) => eb.fn.min('sr.timing_id').as('timing_id')])
    .where('pr.institution_id', '=', institutionId)
    .groupBy('pr.profile_id')
    .execute();
  return new Map(rows.map((r) => [String(r.profile_id), String(r.timing_id)]));
}

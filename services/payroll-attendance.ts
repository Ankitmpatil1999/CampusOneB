/**
 * A staff member's month for payroll (client 2026-10-22: Accounts runs payroll from attendance).
 *
 * - Every day of the month while employed is paid except loss of pay (LOP): Sundays and holidays,
 *   days worked (Present, Late, Half day) and days of approved leave (Casual, Medical, Earned — a
 *   request can't exceed the year's balance, so all approved leave is paid).
 * - LOP: an Absent day without approved leave (1), a Half day without approved leave (½). Approved
 *   leave covers a day the auto-absent routine marked Absent.
 * - Late arrivals are counted, not deducted.
 * - A school day with no record and no leave is "not marked": it is not deducted, and the report
 *   says so, for Accounts to check before running payroll.
 * - Days before joining or after leaving aren't payable. In a month still running, days after
 *   today aren't read yet and are counted as payable.
 */
export type DayStatus = 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT';
export type LeaveType = 'CASUAL' | 'MEDICAL' | 'EARNED';
export type ExceptionKind = 'LATE' | 'HALF_DAY' | 'ABSENT' | 'LEAVE' | 'NOT_MARKED';

export interface PayrollException {
  readonly date: string;
  readonly kind: ExceptionKind;
  /** The leave covering the day (LEAVE, or a half day on leave). */
  readonly leaveType: LeaveType | null;
}

export interface PayrollMonth {
  /** School days while employed, up to the last day read. */
  readonly workingDays: number;
  readonly present: number;
  readonly late: number;
  readonly halfDay: number;
  readonly paidLeave: number;
  readonly absent: number;
  readonly notMarked: number;
  readonly leave: { readonly casual: number; readonly medical: number; readonly earned: number };
  /** Days of the month before joining or after leaving. */
  readonly notEmployed: number;
  readonly lopDays: number;
  readonly payableDays: number;
  /** The days that aren't a plain Present, in date order. */
  readonly exceptions: readonly PayrollException[];
}

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const sunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;

export function payrollMonth(o: {
  /** The month's first and last days. */
  readonly from: string;
  readonly to: string;
  /** The last day read (today in a running month); before `from` when the month hasn't started. */
  readonly through: string;
  readonly holidays: ReadonlyMap<string, string>;
  readonly joinedOn: string | null;
  readonly leftOn: string | null;
  readonly statuses: ReadonlyMap<string, DayStatus>;
  readonly leave: ReadonlyMap<string, LeaveType>;
}): PayrollMonth {
  let days = 0;
  let workingDays = 0;
  let notEmployed = 0;
  const n = { present: 0, late: 0, halfDay: 0, paidLeave: 0, absent: 0, notMarked: 0 };
  const leave = { casual: 0, medical: 0, earned: 0 };
  let lop = 0;
  const exceptions: PayrollException[] = [];
  const note = (date: string, kind: ExceptionKind, leaveType: LeaveType | null = null) =>
    exceptions.push({ date, kind, leaveType });

  for (let d = o.from; d <= o.to; d = addDays(d, 1)) {
    days++;
    if ((o.joinedOn && d < o.joinedOn) || (o.leftOn && d > o.leftOn)) {
      notEmployed++;
      continue;
    }
    if (d > o.through || sunday(d) || o.holidays.has(d)) continue;
    workingDays++;
    const s = o.statuses.get(d);
    const lv = o.leave.get(d) ?? null;
    if (s === 'PRESENT') n.present++;
    else if (s === 'LATE') {
      n.late++;
      note(d, 'LATE');
    } else if (s === 'HALF_DAY') {
      n.halfDay++;
      if (!lv) lop += 0.5;
      note(d, 'HALF_DAY', lv);
    } else if (lv) {
      n.paidLeave++;
      leave[lv === 'CASUAL' ? 'casual' : lv === 'MEDICAL' ? 'medical' : 'earned']++;
      note(d, 'LEAVE', lv);
    } else if (s === 'ABSENT') {
      n.absent++;
      lop += 1;
      note(d, 'ABSENT');
    } else {
      n.notMarked++;
      note(d, 'NOT_MARKED');
    }
  }
  return {
    workingDays,
    ...n,
    leave,
    notEmployed,
    lopDays: lop,
    payableDays: days - notEmployed - lop,
    exceptions,
  };
}

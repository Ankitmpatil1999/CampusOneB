import { payrollMonth, type DayStatus, type LeaveType } from '../services/payroll-attendance';

/** October 2026: Thursday the 1st, Sundays the 4th, 11th, 18th and 25th; a holiday on the 2nd. */
const FROM = '2026-10-01';
const TO = '2026-10-31';
const holidays = new Map([['2026-10-02', 'Gandhi Jayanti']]);
const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;
const SUNDAYS = [4, 11, 18, 25];
/** Every school day of October Present, then the days given. */
const month = (over: Readonly<Record<number, DayStatus | null>> = {}) => {
  const m = new Map<string, DayStatus>();
  for (let n = 1; n <= 31; n++) {
    if (n === 2 || SUNDAYS.includes(n)) continue;
    const s = n in over ? over[n] : 'PRESENT';
    if (s) m.set(day(n), s);
  }
  return m;
};
const leave = (entries: Readonly<Record<number, LeaveType>>) =>
  new Map(Object.entries(entries).map(([n, t]) => [day(Number(n)), t]));
const base = { from: FROM, to: TO, through: TO, holidays, joinedOn: null, leftOn: null };

describe('payroll from attendance (client 2026-10-22)', () => {
  it('pays the month less loss of pay; leave covers an auto-absent day; lateness costs nothing', () => {
    const m = payrollMonth({
      ...base,
      statuses: month({
        5: 'LATE',
        6: 'HALF_DAY',
        7: 'ABSENT',
        8: 'ABSENT',
        9: null,
        12: null,
        13: 'HALF_DAY',
      }),
      leave: leave({ 8: 'CASUAL', 9: 'MEDICAL', 13: 'EARNED' }),
    });
    expect(m).toMatchObject({
      workingDays: 26,
      present: 19,
      late: 1,
      halfDay: 2,
      paidLeave: 2,
      absent: 1,
      notMarked: 1,
      leave: { casual: 1, medical: 1, earned: 0 },
      notEmployed: 0,
      // The half day without leave (½) and the absent day without leave (1).
      lopDays: 1.5,
      payableDays: 29.5,
    });
    expect(m.present + m.late + m.halfDay + m.paidLeave + m.absent + m.notMarked).toBe(
      m.workingDays,
    );
    expect(m.exceptions).toEqual([
      { date: day(5), kind: 'LATE', leaveType: null },
      { date: day(6), kind: 'HALF_DAY', leaveType: null },
      { date: day(7), kind: 'ABSENT', leaveType: null },
      { date: day(8), kind: 'LEAVE', leaveType: 'CASUAL' },
      { date: day(9), kind: 'LEAVE', leaveType: 'MEDICAL' },
      { date: day(12), kind: 'NOT_MARKED', leaveType: null },
      { date: day(13), kind: 'HALF_DAY', leaveType: 'EARNED' },
    ]);
  });

  it('pays nothing before joining, and reads a running month only up to today', () => {
    const m = payrollMonth({
      ...base,
      through: day(22),
      joinedOn: day(15),
      statuses: new Map(),
      leave: new Map(),
    });
    // 1st–14th before joining; the 15th–22nd less Sunday the 18th are seven school days, none marked.
    expect(m).toMatchObject({
      notEmployed: 14,
      workingDays: 7,
      notMarked: 7,
      lopDays: 0,
      payableDays: 17,
    });
  });

  it('pays nothing after leaving', () => {
    const m = payrollMonth({ ...base, leftOn: day(10), statuses: month(), leave: new Map() });
    // The 1st–10th less the holiday and Sunday the 4th: eight days worked.
    expect(m).toMatchObject({ notEmployed: 21, workingDays: 8, present: 8, payableDays: 10 });
  });

  it('reads nothing of a month not begun', () => {
    const m = payrollMonth({
      ...base,
      through: '2026-09-30',
      statuses: new Map(),
      leave: new Map(),
    });
    expect(m).toMatchObject({ workingDays: 0, lopDays: 0, payableDays: 31, exceptions: [] });
  });
});

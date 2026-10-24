import {
  loginStatus,
  logoutStatus,
  minutesOf,
  timingErrors,
  timingMinutes,
} from '../services/staff-timings';

/** Login 08:30, late after 08:45, half day after 11:00, absent after 13:00; out 16:30, early 16:00. */
const t = timingMinutes({
  id: '1',
  login_time: '08:30:00',
  logout_time: '16:30:00',
  late_login_time: '08:45:00',
  early_logout_time: '16:00:00',
  half_day_time: '11:00:00',
  absent_time: '13:00:00',
});
const at = (hhmm: string) => minutesOf(hhmm);
const times = {
  loginTime: '08:30',
  lateLoginTime: '08:45',
  halfDayTime: '11:00',
  absentTime: '13:00',
  earlyLogoutTime: '16:00',
  logoutTime: '16:30',
};

describe('staff timings (client 2026-10-23)', () => {
  it('reads a login by the late, half-day and absent times', () => {
    expect(loginStatus(t, at('07:50'))).toEqual({ status: 'PRESENT', checkin: 'PRESENT' });
    expect(loginStatus(t, at('08:45'))).toEqual({ status: 'PRESENT', checkin: 'PRESENT' });
    expect(loginStatus(t, at('08:46'))).toEqual({ status: 'LATE', checkin: 'LATE' });
    expect(loginStatus(t, at('11:00'))).toEqual({ status: 'LATE', checkin: 'LATE' });
    expect(loginStatus(t, at('11:01'))).toEqual({ status: 'HALF_DAY', checkin: 'LATE' });
    expect(loginStatus(t, at('13:00'))).toEqual({ status: 'HALF_DAY', checkin: 'LATE' });
    expect(loginStatus(t, at('13:01'))).toEqual({ status: 'ABSENT', checkin: 'ABSENT' });
  });

  it('makes a logout before the early logout time a Half day, and keeps the day otherwise', () => {
    expect(logoutStatus(t, at('15:59'), 'PRESENT')).toBe('HALF_DAY');
    expect(logoutStatus(t, at('15:59'), 'LATE')).toBe('HALF_DAY');
    expect(logoutStatus(t, at('16:00'), 'PRESENT')).toBe('PRESENT');
    expect(logoutStatus(t, at('17:10'), 'LATE')).toBe('LATE');
    expect(logoutStatus(t, at('17:10'), 'HALF_DAY')).toBe('HALF_DAY');
  });

  it('wants the times in the day’s order, each error on the later one', () => {
    expect(timingErrors(times)).toEqual([]);
    expect(timingErrors({ ...times, loginTime: '', absentTime: '1300' })).toEqual([
      { field: 'loginTime', code: 'VALIDATION.REQUIRED' },
      { field: 'absentTime', code: 'VALIDATION.FORMAT' },
    ]);
    expect(timingErrors({ ...times, lateLoginTime: '08:30' })).toEqual([
      { field: 'lateLoginTime', code: 'ATT.TIMING_AFTER', params: { after: 'login time' } },
    ]);
    expect(timingErrors({ ...times, halfDayTime: '13:30' })).toEqual([
      { field: 'absentTime', code: 'ATT.TIMING_AFTER', params: { after: 'half-day time' } },
    ]);
    expect(timingErrors({ ...times, earlyLogoutTime: '16:30' })).toEqual([
      { field: 'earlyLogoutTime', code: 'ATT.TIMING_BEFORE', params: { before: 'logout time' } },
    ]);
    expect(timingErrors({ ...times, earlyLogoutTime: '08:00' })).toEqual([
      { field: 'earlyLogoutTime', code: 'ATT.TIMING_AFTER', params: { after: 'login time' } },
    ]);
    expect(timingErrors({ ...times, logoutTime: '12:00', earlyLogoutTime: '11:30' })).toEqual([
      { field: 'logoutTime', code: 'ATT.TIMING_AFTER', params: { after: 'absent time' } },
    ]);
  });
});

/**
 * Attendance (27.2 / 27.3 §21, adopted; RC-38). One daily record per member and date with a check-in
 * status and a final status; every change is an audit event. RC-38: a person may override a daily
 * record (old → new kept, OI-ATT-13), the front desk captures location attendance (MANUAL, OI-ATT-10),
 * and a teacher marks period attendance (MANUAL, OI-ATT-08).
 */
import { NEW, type StatusDomain } from './types';

export const ATTENDANCE_CHECKIN: StatusDomain<'PRESENT' | 'LATE' | 'ABSENT'> = {
  domain: 'attendance_checkin',
  srsDomain: 'Daily attendance (check-in status)',
  rc: 'RC-38',
  values: [
    {
      code: 'PRESENT',
      registerValue: 'PRESENT',
      labelKey: 'status.attendanceCheckin.present',
      label: 'Present',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'LATE',
      registerValue: 'LATE',
      labelKey: 'status.attendanceCheckin.late',
      label: 'Late',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'ABSENT',
      registerValue: 'ABSENT',
      labelKey: 'status.attendanceCheckin.absent',
      label: 'Absent',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PRESENT',
      operation:
        'a student tap, a non-student tap at or before the late cut-off (att.late.cutoffMinutes) or a staff member’s late login time (their staff timing, client 2026-10-23), or a manual Present',
    },
    {
      from: NEW,
      to: 'LATE',
      operation:
        'a non-student tap after the late cut-off, a staff login after their timing’s late login time (also after its half-day time: the day is then a Half day), or a manual Late',
    },
    {
      from: NEW,
      to: 'ABSENT',
      operation:
        'a manual Absent, the auto-absent job, or a staff login after their timing’s absent time',
    },
    { from: 'PRESENT', to: 'ABSENT', operation: 'a manual override (RC-38, old → new kept)' },
    { from: 'LATE', to: 'ABSENT', operation: 'a manual override (RC-38)' },
    { from: 'ABSENT', to: 'PRESENT', operation: 'a manual override (RC-38)' },
    { from: 'ABSENT', to: 'LATE', operation: 'a manual override (RC-38)' },
    { from: 'PRESENT', to: 'LATE', operation: 'a manual override (RC-38)' },
    { from: 'LATE', to: 'PRESENT', operation: 'a manual override (RC-38)' },
  ],
};

export const ATTENDANCE: StatusDomain<'PRESENT' | 'HALF_DAY' | 'LATE' | 'ABSENT'> = {
  domain: 'attendance',
  srsDomain: 'Daily attendance (final status)',
  rc: 'RC-38',
  values: [
    {
      code: 'PRESENT',
      registerValue: 'PRESENT',
      labelKey: 'status.attendance.present',
      label: 'Present',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'HALF_DAY',
      registerValue: 'HALF-DAY',
      labelKey: 'status.attendance.halfDay',
      label: 'Half day',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'LATE',
      registerValue: 'LATE',
      labelKey: 'status.attendance.late',
      label: 'Late',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'ABSENT',
      registerValue: 'ABSENT',
      labelKey: 'status.attendance.absent',
      label: 'Absent',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PRESENT',
      operation: 'a student tap, a non-student tap at or before the cut-off, or a manual Present',
    },
    {
      from: NEW,
      to: 'LATE',
      operation: 'a non-student tap after the cut-off (carried until check-out), or a manual Late',
    },
    {
      from: NEW,
      to: 'ABSENT',
      operation:
        'a manual Absent, the auto-absent job (at the cut-off, or a staff timing’s absent time), or a staff login after their timing’s absent time',
    },
    {
      from: NEW,
      to: 'HALF_DAY',
      operation:
        'a manual Half day (RC-38), or a staff login after their timing’s half-day time (client 2026-10-23)',
    },
    {
      from: 'PRESENT',
      to: 'PRESENT',
      operation: 'a non-student check-out after att.halfDay.minutes or more',
    },
    {
      from: 'LATE',
      to: 'PRESENT',
      operation: 'a non-student check-out after att.halfDay.minutes or more, or a manual override',
    },
    {
      from: 'PRESENT',
      to: 'HALF_DAY',
      operation:
        'a non-student check-out before att.halfDay.minutes or before their staff timing’s early logout time, or a manual override',
    },
    {
      from: 'LATE',
      to: 'HALF_DAY',
      operation:
        'a non-student check-out before att.halfDay.minutes or before their staff timing’s early logout time, or a manual override',
    },
    {
      from: 'LATE',
      to: 'LATE',
      operation: 'a staff check-out at or after their timing’s early logout time',
    },
    {
      from: 'HALF_DAY',
      to: 'HALF_DAY',
      operation: 'a staff check-out after a half-day login (their staff timing)',
    },
    { from: 'PRESENT', to: 'ABSENT', operation: 'a manual override (RC-38)' },
    { from: 'LATE', to: 'ABSENT', operation: 'a manual override (RC-38)' },
    { from: 'HALF_DAY', to: 'ABSENT', operation: 'a manual override (RC-38)' },
    { from: 'ABSENT', to: 'PRESENT', operation: 'a manual override (RC-38)' },
    { from: 'ABSENT', to: 'LATE', operation: 'a manual override (RC-38)' },
    { from: 'ABSENT', to: 'HALF_DAY', operation: 'a manual override (RC-38)' },
    { from: 'HALF_DAY', to: 'PRESENT', operation: 'a manual override (RC-38)' },
    { from: 'HALF_DAY', to: 'LATE', operation: 'a manual override (RC-38)' },
    { from: 'PRESENT', to: 'LATE', operation: 'a manual override (RC-38)' },
  ],
};

export const PERIOD_ATTENDANCE: StatusDomain<'PRESENT' | 'LATE'> = {
  domain: 'period_attendance',
  srsDomain: 'Period attendance (status)',
  rc: 'RC-38',
  values: [
    {
      code: 'PRESENT',
      registerValue: 'PRESENT',
      labelKey: 'status.periodAttendance.present',
      label: 'Present',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'LATE',
      registerValue: 'LATE',
      labelKey: 'status.periodAttendance.late',
      label: 'Late',
      tone: 'warn',
      terminal: false,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PRESENT',
      operation:
        'a tap at the class’s period reader by the period start, or the teacher marks Present (RC-38)',
    },
    {
      from: NEW,
      to: 'LATE',
      operation:
        'a tap after the period start inside the period, or the teacher marks Late (RC-38)',
    },
    { from: 'PRESENT', to: 'LATE', operation: 'the teacher corrects a manual mark (RC-38)' },
    { from: 'LATE', to: 'PRESENT', operation: 'the teacher corrects a manual mark (RC-38)' },
  ],
};

export const LOCATION_ATTENDANCE: StatusDomain<'CHECK_IN'> = {
  domain: 'location_attendance',
  srsDomain: 'Location attendance (action)',
  rc: 'RC-38',
  values: [
    {
      code: 'CHECK_IN',
      registerValue: 'CHECK_IN',
      labelKey: 'status.locationAttendance.checkIn',
      label: 'Checked in',
      tone: 'ok',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'CHECK_IN',
      operation:
        'a tap at a location reader, or the front desk records it (RC-38), after the type’s cooling-off interval',
    },
  ],
};

export const ATTENDANCE_DOMAINS = [
  ATTENDANCE_CHECKIN,
  ATTENDANCE,
  PERIOD_ATTENDANCE,
  LOCATION_ATTENDANCE,
] as const;

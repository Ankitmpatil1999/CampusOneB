/**
 * Attendance (SRS 21.5–21.16; migration 0054): daily records with their events, period and location
 * attendance, attendance types, visitors and the auto-absent setting and runs.
 */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Day = ColumnType<Date | string, string, string>;
type Version = ColumnType<number, number | undefined, number>;

export type CheckinStatus = 'PRESENT' | 'LATE' | 'ABSENT';
export type DailyStatus = 'PRESENT' | 'HALF_DAY' | 'LATE' | 'ABSENT';
export type CaptureMethod = 'NFC' | 'MANUAL';
export type AttendanceAction = 'CHECK-IN' | 'CHECK-OUT' | 'MANUAL-ATTENDANCE' | 'AUTO-ABSENT';
export type PeriodStatus = 'PRESENT' | 'LATE';

export interface AttendanceTypesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  cooldown_seconds: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
}

export interface AttendanceDaysTable {
  id: Generated<string>;
  institution_id: Ref;
  year_id: Ref | null;
  profile_id: Ref;
  section_id: Ref | null;
  att_date: Day;
  checkin_status: CheckinStatus;
  status: DailyStatus;
  method: CaptureMethod | null;
  check_in_at: NullableTimestamp;
  check_out_at: NullableTimestamp;
  terminal_id: Ref | null;
  remark: string | null;
  updated_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface AttendanceEventsTable {
  id: Generated<string>;
  institution_id: Ref;
  day_id: Ref;
  action: AttendanceAction;
  old_status: DailyStatus | null;
  new_status: DailyStatus;
  actor: Buffer | null;
  terminal_id: Ref | null;
  remark: string | null;
  at: Timestamp;
}

export interface PeriodAttendanceTable {
  id: Generated<string>;
  institution_id: Ref;
  year_id: Ref;
  section_id: Ref;
  period_id: Ref;
  subject_id: Ref;
  teacher_profile_id: Ref;
  att_date: Day;
  profile_id: Ref;
  status: PeriodStatus;
  method: CaptureMethod;
  terminal_id: Ref | null;
  marked_by: Buffer | null;
  at: Timestamp;
}

export interface LocationAttendanceTable {
  id: Generated<string>;
  institution_id: Ref;
  attendance_type_id: Ref;
  profile_id: Ref;
  action: ColumnType<'CHECK_IN', 'CHECK_IN' | undefined, 'CHECK_IN'>;
  method: CaptureMethod;
  terminal_id: Ref | null;
  captured_by: Buffer | null;
  at: Timestamp;
}

export interface VisitorsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  mobile_enc: Buffer;
  mobile_last4: string;
  purpose: string;
  to_meet: string | null;
  checked_in_at: Timestamp;
  checked_out_at: NullableTimestamp;
  recorded_by: Buffer | null;
}

export interface AutoAbsentSettingsTable {
  institution_id: Ref;
  enabled: ColumnType<number, number | undefined, number>;
  cutoff: ColumnType<string, string | undefined, string>;
  applies_students: ColumnType<number, number | undefined, number>;
  applies_staff: ColumnType<number, number | undefined, number>;
  updated_by: Buffer | null;
  updated_at: Timestamp;
  row_version: Version;
}

export interface AutoAbsentRunsTable {
  id: Generated<string>;
  institution_id: Ref;
  run_date: Day;
  marked: ColumnType<number, number | undefined, number>;
  skipped_holiday: ColumnType<number, number | undefined, number>;
  ran_at: Timestamp;
}

export interface AttendanceTables {
  attendance_types: AttendanceTypesTable;
  attendance_days: AttendanceDaysTable;
  attendance_events: AttendanceEventsTable;
  period_attendance: PeriodAttendanceTable;
  location_attendance: LocationAttendanceTable;
  visitors: VisitorsTable;
  auto_absent_settings: AutoAbsentSettingsTable;
  auto_absent_runs: AutoAbsentRunsTable;
}

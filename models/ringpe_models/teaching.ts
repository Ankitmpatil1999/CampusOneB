/**
 * The academic structure: calendar, subjects, periods, teacher assignments, timetables, enrolment
 * history and roll-overs (migration 0048; SRS 20.2–20.10; CR-13).
 */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type DateOnly = ColumnType<Date | string, string, string>;
type NullableDate = ColumnType<Date | string | null, string | null | undefined, string | null>;
type Version = ColumnType<number, number | undefined, number>;
type Flag = ColumnType<number, number | boolean | undefined, number | boolean>;

export type CalendarAudience = 'ALL' | 'CLASS' | 'SECTION' | 'MEMBER';
export type Recurrence = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type TeacherAssignmentKind = 'CLASS_TEACHER' | 'SUBJECT_TEACHER' | 'COORDINATOR';
export type EnrolmentChangeKind = 'ENROLLED' | 'TRANSFERRED' | 'CORRECTED' | 'ROLLED_OVER' | 'LEFT';
export type RolloverOutcome = 'PROMOTED' | 'REPEATED' | 'LEFT';

export interface CalendarEntriesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  type: string;
  holiday_type: string | null;
  title: string;
  description: string | null;
  all_day: Flag;
  start_date: DateOnly;
  end_date: DateOnly;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  audience: ColumnType<CalendarAudience, CalendarAudience | undefined, CalendarAudience>;
  recurrence: ColumnType<Recurrence, Recurrence | undefined, Recurrence>;
  repeat_until: NullableDate;
  colour: ColumnType<string, string | undefined, string>;
  reminders: ColumnType<unknown, string, string>;
  attachment_file_id: Ref | null;
  source: ColumnType<'CONSOLE' | 'UPLOAD', 'CONSOLE' | 'UPLOAD' | undefined, 'CONSOLE' | 'UPLOAD'>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_by: Buffer | null;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
  deleted_by: Buffer | null;
  row_version: Version;
  live_key: ColumnType<string | null, never, never>;
}

export interface CalendarEntryTargetsTable {
  entry_id: Ref;
  kind: 'CLASS' | 'SECTION' | 'MEMBER';
  ref_id: Ref;
}

export interface SubjectsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  code: string;
  name: string;
  colour: string;
  row_version: Version;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ClassSubjectsTable {
  institution_id: Ref;
  class_id: Ref;
  subject_id: Ref;
}

export interface PeriodsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  starts_at: string;
  ends_at: string;
  is_break: Flag;
}

export interface TeacherAssignmentsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  kind: TeacherAssignmentKind;
  teacher_profile_id: Ref;
  class_id: Ref;
  section_id: Ref | null;
  subject_id: Ref | null;
  created_by: Buffer | null;
  created_at: Timestamp;
  ended_at: NullableTimestamp;
  ended_by: Buffer | null;
  live_class_teacher: ColumnType<string | null, never, never>;
  live_subject: ColumnType<string | null, never, never>;
  live_coordinator: ColumnType<string | null, never, never>;
}

export interface TimetableSlotsTable {
  id: Generated<string>;
  institution_id: Ref;
  year_id: Ref;
  section_id: Ref;
  day: number;
  period_id: Ref;
  subject_id: Ref;
  teacher_profile_id: Ref;
  updated_by: Buffer | null;
  updated_at: Timestamp;
}

export interface EnrolmentChangesTable {
  id: Generated<string>;
  institution_id: Ref;
  student_profile_id: Ref;
  year_id: Ref;
  kind: EnrolmentChangeKind;
  from_section_id: Ref | null;
  to_section_id: Ref | null;
  effective_on: DateOnly;
  reason: string | null;
  approval_id: Ref | null;
  actor_ref: Buffer | null;
  at: Timestamp;
}

export interface RolloversTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  from_year_id: Ref;
  to_year_id: Ref;
  status: ColumnType<
    'PROPOSED' | 'COMMITTED',
    'PROPOSED' | 'COMMITTED' | undefined,
    'PROPOSED' | 'COMMITTED'
  >;
  created_by: Buffer | null;
  created_at: Timestamp;
  committed_by: Buffer | null;
  committed_at: NullableTimestamp;
  row_version: Version;
}

export interface RolloverItemsTable {
  rollover_id: Ref;
  student_profile_id: Ref;
  from_section_id: Ref;
  outcome: RolloverOutcome;
  to_section_id: Ref | null;
  amended: Flag;
}

export type MarkStatus = 'CREATED' | 'VALID';

export interface ExamNamesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  created_at: Timestamp;
}

export interface ExamsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  exam_name_id: Ref;
  class_id: Ref;
  section_id: Ref;
  subject_id: Ref;
  exam_date: NullableDate;
  start_time: string | null;
  end_time: string | null;
  max_marks: number;
  pass_marks: number;
  published_at: NullableTimestamp;
  published_by: Buffer | null;
  withdrawn_at: NullableTimestamp;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
  live_key: ColumnType<string | null, never, never>;
}

export interface MarksTable {
  id: Generated<string>;
  institution_id: Ref;
  year_id: Ref;
  exam_id: Ref;
  student_profile_id: Ref;
  marks: ColumnType<string | null, number | string | null, number | string | null>;
  is_absent: Flag;
  status: ColumnType<MarkStatus, MarkStatus | undefined, MarkStatus>;
  entered_by: Buffer | null;
  entered_at: Timestamp;
  validated_by: Buffer | null;
  validated_at: NullableTimestamp;
}

export type HomeworkKind = 'HOMEWORK' | 'CLASSWORK';
export type HomeworkStudentStatus = 'NEW' | 'SEEN' | 'DONE';
export type SubmissionStatus = 'SUBMITTED' | 'REVIEWED';

export interface HomeworkTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  class_id: Ref;
  section_id: Ref;
  subject_id: Ref;
  teacher_profile_id: Ref;
  kind: HomeworkKind;
  title: string;
  instructions: string;
  due_at: Timestamp;
  file_id: Ref | null;
  link: string | null;
  whole_class: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface HomeworkStudentsTable {
  homework_id: Ref;
  student_profile_id: Ref;
  institution_id: Ref;
  year_id: Ref;
  status: ColumnType<
    HomeworkStudentStatus,
    HomeworkStudentStatus | undefined,
    HomeworkStudentStatus
  >;
  updated_at: Timestamp;
}

export interface HomeworkSubmissionsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  homework_id: Ref;
  student_profile_id: Ref;
  file_id: Ref | null;
  link: string | null;
  note: string | null;
  is_late: ColumnType<number, number | undefined, number>;
  status: ColumnType<SubmissionStatus, SubmissionStatus | undefined, SubmissionStatus>;
  submitted_at: Timestamp;
  grade: string | null;
  feedback: string | null;
  reviewed_by: Buffer | null;
  reviewed_at: NullableTimestamp;
  row_version: Version;
}

export type StudentLeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type StaffLeaveType = 'CASUAL' | 'MEDICAL' | 'EARNED';

export interface StudentLeavesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  student_profile_id: Ref;
  section_id: Ref;
  from_date: ColumnType<Date | string, string, string>;
  to_date: ColumnType<Date | string, string, string>;
  school_days: number;
  reason: string;
  file_id: Ref | null;
  applied_by: Buffer;
  status: ColumnType<StudentLeaveStatus, StudentLeaveStatus | undefined, StudentLeaveStatus>;
  decided_by_profile_id: Ref | null;
  decided_at: NullableTimestamp;
  remarks: string | null;
  cancelled_by: Buffer | null;
  cancelled_at: NullableTimestamp;
  created_at: Timestamp;
  row_version: Version;
}

export interface StaffLeavesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  profile_id: Ref;
  needs_coordinator: ColumnType<number, number | undefined, number>;
  leave_type: StaffLeaveType;
  from_date: ColumnType<Date | string, string, string>;
  to_date: ColumnType<Date | string, string, string>;
  days: number;
  reason: string;
  coordinator_status: 'APPROVED' | 'REJECTED' | null;
  coordinator_by: Buffer | null;
  coordinator_at: NullableTimestamp;
  coordinator_remarks: string | null;
  final_status: 'APPROVED' | 'REJECTED' | 'CANCELLED' | null;
  final_by_profile_id: Ref | null;
  final_at: NullableTimestamp;
  final_remarks: string | null;
  created_at: Timestamp;
  row_version: Version;
}

export interface TeachingTables {
  student_leaves: StudentLeavesTable;
  staff_leaves: StaffLeavesTable;
  homework: HomeworkTable;
  homework_students: HomeworkStudentsTable;
  homework_submissions: HomeworkSubmissionsTable;
  exam_names: ExamNamesTable;
  exams: ExamsTable;
  marks: MarksTable;
  calendar_entries: CalendarEntriesTable;
  calendar_entry_targets: CalendarEntryTargetsTable;
  subjects: SubjectsTable;
  class_subjects: ClassSubjectsTable;
  periods: PeriodsTable;
  teacher_assignments: TeacherAssignmentsTable;
  timetable_slots: TimetableSlotsTable;
  enrolment_changes: EnrolmentChangesTable;
  rollovers: RolloversTable;
  rollover_items: RolloverItemsTable;
}

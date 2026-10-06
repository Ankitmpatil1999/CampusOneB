/** Roles, tasks, staff profiles and operator accounts (migration 0012; SRS 6.4, 6.28, CR-05). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** A column with a database default: optional on insert. */
type WithDefault<T> = ColumnType<T, T | undefined, T>;
type DateOnly = ColumnType<string, string | undefined, string>;

export type RoleScope = 'INSTITUTION' | 'OPERATOR';
export type UserTypeCategory =
  | 'STUDENT'
  | 'PARENT'
  | 'TEACHER'
  | 'STAFF'
  | 'MERCHANT'
  | 'PRINCIPAL'
  | 'MANAGEMENT'
  | 'CREW'
  | 'OTHER';

export interface TasksTable {
  id: Generated<number>;
  scope: RoleScope;
  code: string;
  label_key: string;
  sort_order: number;
}

export interface SubTasksTable {
  id: Generated<number>;
  task_id: number;
  code: string;
  label_key: string | null;
  view_only: number;
}

export interface RolesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref | null;
  scope: RoleScope;
  code: string | null;
  name: string;
  description: string | null;
  status: WithDefault<'ACTIVE' | 'INACTIVE'>;
  read_only: WithDefault<number>;
  grants_seeded: WithDefault<number>;
  inst_key: ColumnType<string, never, never>;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RoleTasksTable {
  role_id: Ref;
  sub_task_id: number;
}

export interface UserTypesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  category: UserTypeCategory;
  status: WithDefault<'ACTIVE' | 'INACTIVE'>;
  created_by: Buffer | null;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MemberProfilesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  account_id: Ref | null;
  user_type_id: Ref;
  /** Number in the institution (trigger, migration 0021); shown as <short name>-00001. */
  member_seq: Generated<number>;
  department_id: Ref | null;
  first_name: string;
  last_name: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  date_of_birth: DateOnly | null;
  contact_mobile: string | null;
  contact_email: string | null;
  employee_no: string | null;
  admission_no: string | null;
  joined_on: DateOnly | null;
  status: WithDefault<'ACTIVE' | 'INACTIVE' | 'SUSPENDED'>;
  status_reason: string | null;
  status_changed_at: Timestamp | null;
  row_version: Generated<number>;
  created_at: Timestamp;
  created_by: Buffer | null;
  updated_at: Timestamp;
  txn_permission: ColumnType<number, number | boolean | undefined, number | boolean>;
  txn_permission_reason: string | null;
  txn_permission_changed_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

/** RC-22 academic year; one current year per institution (migration 0020). */
export interface AcademicYearsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  label: string;
  starts_on: DateOnly;
  ends_on: DateOnly;
  status: WithDefault<'OPEN' | 'CLOSED'>;
  is_current: WithDefault<number | boolean>;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ClassesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  sort_order: number;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SectionsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  class_id: Ref;
  name: string;
  capacity: number | null;
  created_at: Timestamp;
}

export interface EnrolmentsTable {
  id: Generated<string>;
  /** Database default (migration 0049). */
  public_id: Generated<Buffer>;
  institution_id: Ref;
  student_profile_id: Ref;
  year_id: Ref;
  section_id: Ref;
  /** The date the placement took effect (migration 0048). */
  enrolled_on: ColumnType<Date | string | null, string | null | undefined, string | null>;
  /** How a roll-over placed it (RC-23). */
  outcome: 'PROMOTED' | 'REPEATED' | null;
  created_at: Timestamp;
  created_by: Buffer | null;
}

export interface GuardianshipsTable {
  id: Generated<string>;
  institution_id: Ref;
  guardian_profile_id: Ref;
  ward_profile_id: Ref;
  relation: string;
  is_primary_contact: WithDefault<number | boolean>;
  created_at: Timestamp;
}

export interface MemberUploadsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  kind: 'MEMBERS' | 'STAFF' | 'PROFILE_UPDATE';
  file_name: string;
  status: WithDefault<'VALIDATED' | 'COMMITTED'>;
  rows_total: number;
  rows_accepted: number;
  rows_rejected: number;
  report: string;
  created_by: Buffer | null;
  created_at: Timestamp;
  committed_at: Timestamp | null;
  committed_count: number | null;
}

export interface ProfileRolesTable {
  institution_id: Ref;
  profile_id: Ref;
  role_id: Ref;
  created_at: Timestamp;
}

export interface OperatorAccountsTable {
  id: Generated<string>;
  public_id: Buffer;
  account_id: Ref;
  role_id: Ref;
  status: WithDefault<'ACTIVE' | 'INACTIVE'>;
  status_note: string | null;
  row_version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RoleTaskAssignmentsTable {
  role_id: Ref;
  task_id: number;
}

export interface RoleChangeLogTable {
  id: Generated<string>;
  public_id: Buffer;
  actor_account_id: Ref;
  role_id: Ref | null;
  operator_account_id: Ref | null;
  change_text: string;
  reason: string;
  created_at: Timestamp;
}

export interface AccessTables {
  role_task_assignments: RoleTaskAssignmentsTable;
  role_change_log: RoleChangeLogTable;
  tasks: TasksTable;
  sub_tasks: SubTasksTable;
  roles: RolesTable;
  role_tasks: RoleTasksTable;
  user_types: UserTypesTable;
  member_profiles: MemberProfilesTable;
  academic_years: AcademicYearsTable;
  classes: ClassesTable;
  sections: SectionsTable;
  enrolments: EnrolmentsTable;
  guardianships: GuardianshipsTable;
  member_uploads: MemberUploadsTable;
  profile_roles: ProfileRolesTable;
  operator_accounts: OperatorAccountsTable;
}

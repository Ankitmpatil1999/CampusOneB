/** The financial literacy quiz (migration 0061; SRS 28, CR-01). */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Flag = ColumnType<number, number | undefined, number>;
type Version = ColumnType<number, number | undefined, number>;

export type QuizTopicStatus = 'ACTIVE' | 'WITHDRAWN';
export type QuizAttemptStatus = 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED';

export interface QuizTopicsTable {
  id: Generated<string>;
  public_id: Buffer;
  name: string;
  description: string | null;
  icon: string | null;
  status: ColumnType<QuizTopicStatus, QuizTopicStatus | undefined, QuizTopicStatus>;
  sort_order: ColumnType<number, number | undefined, number>;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface QuizQuestionsTable {
  id: Generated<string>;
  public_id: Buffer;
  topic_id: Ref;
  bank: 'STAGING' | 'PUBLISHED';
  staging_id: Ref | null;
  text: string;
  explanation: string | null;
  in_use: Flag;
  created_by: Buffer | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface QuizOptionsTable {
  id: Generated<string>;
  public_id: Buffer;
  question_id: Ref;
  seq: number;
  text: string;
  is_correct: Flag;
}

export interface QuizAttemptsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  profile_id: Ref;
  topic_id: Ref;
  status: ColumnType<QuizAttemptStatus, QuizAttemptStatus | undefined, QuizAttemptStatus>;
  served: number;
  seconds_per_question: number;
  current_seq: ColumnType<number, number | undefined, number>;
  current_deadline_at: Timestamp;
  score: number | null;
  started_on: ColumnType<Date | string, string, string>;
  started_at: Timestamp;
  completed_at: NullableTimestamp;
  row_version: Version;
}

export interface QuizAttemptQuestionsTable {
  attempt_id: Ref;
  seq: number;
  question_id: Ref;
  option_order: string;
  chosen_option_id: Ref | null;
  correct: number | null;
  timed_out: Flag;
  answered_at: NullableTimestamp;
}

export interface QuizTables {
  quiz_topics: QuizTopicsTable;
  quiz_questions: QuizQuestionsTable;
  quiz_options: QuizOptionsTable;
  quiz_attempts: QuizAttemptsTable;
  quiz_attempt_questions: QuizAttemptQuestionsTable;
}

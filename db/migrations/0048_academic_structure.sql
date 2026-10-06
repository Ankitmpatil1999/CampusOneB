-- 0048_academic_structure.sql — forward-only migration (D-16). Phase 7.1: the academic structure
-- (SRS 20.2–20.10; ACA-004…033; CR-13 year-wise records; RC-23 roll-over; BR-52; prototype
-- c.calendar, c.structure, c.teachers, c.timetable, c.enrol).
--
-- - Every record that belongs to a year names it (RNG-ACA-438): calendar entries, teacher
--   assignments, timetable slots, enrolment changes and roll-overs.
-- - One class teacher per class-section and year, a subject teacher once per section and subject,
--   a coordinator once per class (unique keys over the live rows); a teacher is never in two places
--   in one period of a year, and a section has one lesson per day and period (unique keys).
-- - Enrolments keep their history: every enrolment, transfer, correction into a closed year and
--   roll-over writes a change row; nothing is overwritten (RNG-ACA-445).

CREATE TABLE calendar_entries (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  type                VARCHAR(20)      NOT NULL,                       -- Holiday, Exam, Event, PTM, Sports, Meeting
  holiday_type        VARCHAR(30)      NULL,
  title               VARCHAR(80)      NOT NULL,
  description         VARCHAR(500)     NULL,
  all_day             TINYINT(1)       NOT NULL DEFAULT 1,
  start_date          DATE             NOT NULL,
  end_date            DATE             NOT NULL,
  start_time          TIME             NULL,
  end_time            TIME             NULL,
  location            VARCHAR(100)     NULL,
  audience            ENUM('ALL','CLASS','SECTION','MEMBER') NOT NULL DEFAULT 'ALL',
  recurrence          ENUM('NONE','DAILY','WEEKLY','MONTHLY') NOT NULL DEFAULT 'NONE',
  repeat_until        DATE             NULL,
  colour              CHAR(7)          NOT NULL DEFAULT '#0C6F7D',
  reminders           JSON             NOT NULL,
  attachment_file_id  BIGINT UNSIGNED  NULL,
  source              ENUM('CONSOLE','UPLOAD') NOT NULL DEFAULT 'CONSOLE',
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_by          BINARY(16)       NULL,
  updated_at          DATETIME(3)      NOT NULL,
  deleted_at          DATETIME(3)      NULL,
  deleted_by          BINARY(16)       NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  live_key            VARCHAR(140) GENERATED ALWAYS AS
                        (IF(deleted_at IS NULL, CONCAT(year_id, ':', type, ':', start_date, ':', title), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_calendar_entries__public_id (public_id),
  UNIQUE KEY ux_calendar_entries__live (institution_id, live_key),   -- no duplicate (RNG-ACA-014)
  KEY ix_calendar_entries__year (institution_id, year_id, start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE calendar_entry_targets (
  entry_id            BIGINT UNSIGNED  NOT NULL,
  kind                ENUM('CLASS','SECTION','MEMBER') NOT NULL,
  ref_id              BIGINT UNSIGNED  NOT NULL,
  PRIMARY KEY (entry_id, kind, ref_id),
  CONSTRAINT fk_calendar_entry_targets__entry FOREIGN KEY (entry_id) REFERENCES calendar_entries (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE subjects (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  code                VARCHAR(5)       NOT NULL,
  name                VARCHAR(40)      NOT NULL,
  colour              CHAR(7)          NOT NULL DEFAULT '#2D5DA8',
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_subjects__public_id (public_id),
  UNIQUE KEY ux_subjects__code (institution_id, code),
  UNIQUE KEY ux_subjects__name (institution_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE class_subjects (
  institution_id      BIGINT UNSIGNED  NOT NULL,
  class_id            BIGINT UNSIGNED  NOT NULL,
  subject_id          BIGINT UNSIGNED  NOT NULL,
  PRIMARY KEY (class_id, subject_id),
  KEY ix_class_subjects__subject (institution_id, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE periods (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(30)      NOT NULL,
  starts_at           TIME             NOT NULL,
  ends_at             TIME             NOT NULL,
  is_break            TINYINT(1)       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY ux_periods__public_id (public_id),
  UNIQUE KEY ux_periods__name (institution_id, name),
  CONSTRAINT ck_periods__times CHECK (ends_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE teacher_assignments (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  kind                ENUM('CLASS_TEACHER','SUBJECT_TEACHER','COORDINATOR') NOT NULL,
  teacher_profile_id  BIGINT UNSIGNED  NOT NULL,
  class_id            BIGINT UNSIGNED  NOT NULL,
  section_id          BIGINT UNSIGNED  NULL,                          -- none for a coordinator
  subject_id          BIGINT UNSIGNED  NULL,                          -- a subject teacher's subject
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  ended_at            DATETIME(3)      NULL,
  ended_by            BINARY(16)       NULL,
  live_class_teacher  VARCHAR(45) GENERATED ALWAYS AS
                        (IF(kind = 'CLASS_TEACHER' AND ended_at IS NULL, CONCAT(year_id, ':', section_id), NULL)) STORED,
  live_subject        VARCHAR(90) GENERATED ALWAYS AS
                        (IF(kind = 'SUBJECT_TEACHER' AND ended_at IS NULL, CONCAT(year_id, ':', section_id, ':', subject_id, ':', teacher_profile_id), NULL)) STORED,
  live_coordinator    VARCHAR(70) GENERATED ALWAYS AS
                        (IF(kind = 'COORDINATOR' AND ended_at IS NULL, CONCAT(year_id, ':', class_id, ':', teacher_profile_id), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_teacher_assignments__public_id (public_id),
  UNIQUE KEY ux_teacher_assignments__class_teacher (live_class_teacher),   -- BR-52, RNG-ACA-441
  UNIQUE KEY ux_teacher_assignments__subject (live_subject),
  UNIQUE KEY ux_teacher_assignments__coordinator (live_coordinator),
  KEY ix_teacher_assignments__year (institution_id, year_id, kind),
  KEY ix_teacher_assignments__teacher (institution_id, teacher_profile_id, year_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE timetable_slots (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  section_id          BIGINT UNSIGNED  NOT NULL,
  day                 TINYINT UNSIGNED NOT NULL,                       -- 1 Monday … 6 Saturday
  period_id           BIGINT UNSIGNED  NOT NULL,
  subject_id          BIGINT UNSIGNED  NOT NULL,
  teacher_profile_id  BIGINT UNSIGNED  NOT NULL,
  updated_by          BINARY(16)       NULL,
  updated_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_timetable_slots__section (year_id, section_id, day, period_id),
  UNIQUE KEY ux_timetable_slots__teacher (year_id, teacher_profile_id, day, period_id), -- no clash in a year
  KEY ix_timetable_slots__inst (institution_id, year_id),
  CONSTRAINT ck_timetable_slots__day CHECK (day BETWEEN 1 AND 7)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE enrolments
  ADD COLUMN enrolled_on DATE NULL AFTER section_id,
  ADD COLUMN outcome ENUM('PROMOTED','REPEATED') NULL AFTER enrolled_on;   -- how a roll-over placed it (RC-23)

CREATE TABLE enrolment_changes (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  kind                ENUM('ENROLLED','TRANSFERRED','CORRECTED','ROLLED_OVER','LEFT') NOT NULL,
  from_section_id     BIGINT UNSIGNED  NULL,
  to_section_id       BIGINT UNSIGNED  NULL,
  effective_on        DATE             NOT NULL,
  reason              VARCHAR(500)     NULL,
  approval_id         BIGINT UNSIGNED  NULL,                           -- a correction into a closed year
  actor_ref           BINARY(16)       NULL,
  at                  DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY ix_enrolment_changes__student (institution_id, student_profile_id, year_id),
  KEY ix_enrolment_changes__year (institution_id, year_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rollovers (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  from_year_id        BIGINT UNSIGNED  NOT NULL,
  to_year_id          BIGINT UNSIGNED  NOT NULL,
  status              ENUM('PROPOSED','COMMITTED') NOT NULL DEFAULT 'PROPOSED',
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  committed_by        BINARY(16)       NULL,
  committed_at        DATETIME(3)      NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_rollovers__public_id (public_id),
  UNIQUE KEY ux_rollovers__years (institution_id, from_year_id, to_year_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rollover_items (
  rollover_id         BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  from_section_id     BIGINT UNSIGNED  NOT NULL,
  outcome             ENUM('PROMOTED','REPEATED','LEFT') NOT NULL,
  to_section_id       BIGINT UNSIGNED  NULL,                          -- none when the student leaves
  amended             TINYINT(1)       NOT NULL DEFAULT 0,
  PRIMARY KEY (rollover_id, student_profile_id),
  CONSTRAINT fk_rollover_items__rollover FOREIGN KEY (rollover_id) REFERENCES rollovers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

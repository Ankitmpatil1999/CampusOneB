-- 0051_exams_marks.sql — forward-only migration (D-16). Phase 7.2: exams and marks (SRS 20.11,
-- 20.17–20.22; ACA-034…041, ACA-052…054, ACA-063, ACA-070/071; CR-13 RNG-ACA-442; RC-37).
--
-- - Exam names are an institution list. An exam is one subject of one section in one academic year
--   (unique while not withdrawn), with an optional date and the maximum and pass marks.
-- - A mark carries the exam's year; the student must be enrolled in the exam's class, section and
--   year. A mark is Created when saved and Valid when validated (by the coordinator, or by the teacher
--   publishing); an edit returns it to Created (RC-37). Absent is recorded as such, not as zero.
-- - Publication makes the exam's valid marks visible to students and families.

CREATE TABLE exam_names (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(40)      NOT NULL,
  created_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_exam_names__public_id (public_id),
  UNIQUE KEY ux_exam_names__name (institution_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE exams (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  exam_name_id        BIGINT UNSIGNED  NOT NULL,
  class_id            BIGINT UNSIGNED  NOT NULL,
  section_id          BIGINT UNSIGNED  NOT NULL,
  subject_id          BIGINT UNSIGNED  NOT NULL,
  exam_date           DATE             NULL,                            -- none: Scheduled
  start_time          TIME             NULL,
  end_time            TIME             NULL,
  max_marks           SMALLINT UNSIGNED NOT NULL,
  pass_marks          SMALLINT UNSIGNED NOT NULL,
  published_at        DATETIME(3)      NULL,
  published_by        BINARY(16)       NULL,
  withdrawn_at        DATETIME(3)      NULL,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  live_key            VARCHAR(90) GENERATED ALWAYS AS
                        (IF(withdrawn_at IS NULL, CONCAT(year_id, ':', exam_name_id, ':', section_id, ':', subject_id), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_exams__public_id (public_id),
  UNIQUE KEY ux_exams__live (live_key),
  KEY ix_exams__year (institution_id, year_id, section_id),
  CONSTRAINT ck_exams__marks CHECK (max_marks > 0 AND pass_marks <= max_marks)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE marks (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  exam_id             BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  marks               DECIMAL(6,2)     NULL,                            -- none when absent
  is_absent           TINYINT(1)       NOT NULL DEFAULT 0,
  status              ENUM('CREATED','VALID') NOT NULL DEFAULT 'CREATED',
  entered_by          BINARY(16)       NULL,
  entered_at          DATETIME(3)      NOT NULL,
  validated_by        BINARY(16)       NULL,
  validated_at        DATETIME(3)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_marks__exam_student (exam_id, student_profile_id),
  KEY ix_marks__student (institution_id, student_profile_id, year_id),
  CONSTRAINT fk_marks__exam FOREIGN KEY (exam_id) REFERENCES exams (id),
  CONSTRAINT ck_marks__value CHECK ((is_absent = 1 AND marks IS NULL) OR (is_absent = 0 AND marks IS NOT NULL AND marks >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

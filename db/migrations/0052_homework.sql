-- 0052_homework.sql — forward-only migration (D-16). Phase 7.3: homework and classwork (SRS 20.13,
-- 20.15; ACA-048…051, ACA-067…069, ACA-075; FR-ACA-06; OI-ACA-30…34; CR-07; CR-13 RNG-ACA-442).
--
-- - Homework is set by a teacher assigned to the section (class teacher, or subject teacher of the
--   subject — OI-ACA-31) for the whole class or chosen enrolled students (OI-ACA-32), with a file
--   (≤ 2 MB, uploaded) or a link (OI-ACA-30). It carries the year.
-- - Each student it goes to has a record (27.2 NEW · SEEN · DONE): NEW when set, DONE on submission.
-- - A submission (27.2 submitted · reviewed) is one per student: a file or a link, late when after the
--   due time; the teacher's review records a grade and feedback and may be redone (reviewed → reviewed).

CREATE TABLE homework (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  class_id            BIGINT UNSIGNED  NOT NULL,
  section_id          BIGINT UNSIGNED  NOT NULL,
  subject_id          BIGINT UNSIGNED  NOT NULL,
  teacher_profile_id  BIGINT UNSIGNED  NOT NULL,
  kind                ENUM('HOMEWORK','CLASSWORK') NOT NULL,
  title               VARCHAR(80)      NOT NULL,
  instructions        VARCHAR(600)     NOT NULL,
  due_at              DATETIME(3)      NOT NULL,                       -- 11:59 PM IST on the due date
  file_id             BIGINT UNSIGNED  NULL,
  link                VARCHAR(300)     NULL,
  whole_class         TINYINT(1)       NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_homework__public_id (public_id),
  KEY ix_homework__section (institution_id, year_id, section_id, due_at),
  KEY ix_homework__teacher (institution_id, teacher_profile_id, created_at),
  CONSTRAINT ck_homework__material CHECK (file_id IS NULL OR link IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE homework_students (
  homework_id         BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  status              ENUM('NEW','SEEN','DONE') NOT NULL DEFAULT 'NEW',
  updated_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (homework_id, student_profile_id),
  KEY ix_homework_students__student (institution_id, student_profile_id, year_id),
  CONSTRAINT fk_homework_students__homework FOREIGN KEY (homework_id) REFERENCES homework (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE homework_submissions (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  homework_id         BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  file_id             BIGINT UNSIGNED  NULL,
  link                VARCHAR(300)     NULL,
  note                VARCHAR(300)     NULL,
  is_late             TINYINT(1)       NOT NULL DEFAULT 0,
  status              ENUM('SUBMITTED','REVIEWED') NOT NULL DEFAULT 'SUBMITTED',
  submitted_at        DATETIME(3)      NOT NULL,
  grade               VARCHAR(10)      NULL,
  feedback            VARCHAR(300)     NULL,
  reviewed_by         BINARY(16)       NULL,
  reviewed_at         DATETIME(3)      NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_homework_submissions__public_id (public_id),
  UNIQUE KEY ux_homework_submissions__once (homework_id, student_profile_id),
  KEY ix_homework_submissions__student (institution_id, student_profile_id, year_id),
  CONSTRAINT fk_homework_submissions__homework FOREIGN KEY (homework_id) REFERENCES homework (id),
  CONSTRAINT ck_homework_submissions__work CHECK (file_id IS NOT NULL OR link IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 0053_leave.sql — forward-only migration (D-16). Phase 7.4: student and staff leave (SRS 20.26–20.30;
-- ACA-042, ACA-043, ACA-055…059, ACA-061, ACA-062, ACA-072…074; FR-ACA-09/10; BR-53; OI-ACA-44…51;
-- CR-13 RNG-ACA-442).
--
-- - A student's leave (27.2 PENDING · APPROVED · REJECTED · CANCELLED) is asked by the student or a
--   guardian on the account, for school days inside the year, never overlapping another pending or
--   approved request (BR-53, OI-ACA-47), with an optional document (OI-ACA-44). The class teacher
--   decides; the family can withdraw it while pending (OI-ACA-45).
-- - A staff member's leave carries the two 27.2 statuses: the coordinator's (unset · APPROVED ·
--   REJECTED) and the final one (unset · APPROVED · REJECTED · CANCELLED). A teacher's request is
--   reviewed by the coordinator first; the principal decides only after the coordinator approved
--   (OI-ACA-51). A non-teaching staff member's request goes to the principal directly (example until
--   the non-teaching module is specified, Q16).
-- - Both carry the year and a short reference (SL-/TL- and the row number).

CREATE TABLE student_leaves (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  section_id          BIGINT UNSIGNED  NOT NULL,
  from_date           DATE             NOT NULL,
  to_date             DATE             NOT NULL,
  school_days         SMALLINT UNSIGNED NOT NULL,
  reason              VARCHAR(300)     NOT NULL,
  file_id             BIGINT UNSIGNED  NULL,
  applied_by          BINARY(16)       NOT NULL,                       -- the platform account
  status              ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  decided_by_profile_id BIGINT UNSIGNED NULL,
  decided_at          DATETIME(3)      NULL,
  remarks             VARCHAR(200)     NULL,
  cancelled_by        BINARY(16)       NULL,
  cancelled_at        DATETIME(3)      NULL,
  created_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_student_leaves__public_id (public_id),
  KEY ix_student_leaves__student (institution_id, student_profile_id, from_date),
  KEY ix_student_leaves__section (institution_id, year_id, section_id, status),
  CONSTRAINT ck_student_leaves__dates CHECK (to_date >= from_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_leaves (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  needs_coordinator   TINYINT(1)       NOT NULL DEFAULT 1,
  leave_type          ENUM('CASUAL','MEDICAL','EARNED') NOT NULL,
  from_date           DATE             NOT NULL,
  to_date             DATE             NOT NULL,
  days                SMALLINT UNSIGNED NOT NULL,
  reason              VARCHAR(250)     NOT NULL,
  coordinator_status  ENUM('APPROVED','REJECTED') NULL,
  coordinator_by      BINARY(16)       NULL,
  coordinator_at      DATETIME(3)      NULL,
  coordinator_remarks VARCHAR(400)     NULL,
  final_status        ENUM('APPROVED','REJECTED','CANCELLED') NULL,
  final_by_profile_id BIGINT UNSIGNED  NULL,
  final_at            DATETIME(3)      NULL,
  final_remarks       VARCHAR(400)     NULL,
  created_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_staff_leaves__public_id (public_id),
  KEY ix_staff_leaves__profile (institution_id, profile_id, from_date),
  KEY ix_staff_leaves__queue (institution_id, year_id, coordinator_status, final_status),
  CONSTRAINT ck_staff_leaves__dates CHECK (to_date >= from_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

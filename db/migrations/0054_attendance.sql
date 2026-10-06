-- 0054_attendance.sql — forward-only migration (D-16). Phase 7.5: attendance (SRS 21.5–21.16;
-- ATT-002, ATT-008…023, ATT-026; FR-ATT-02…07; CR-10, CR-13; OI-ATT-05…24; OQ-14; RC-38).
--
-- - One daily record per member and date (27.2 check-in status PRESENT · LATE · ABSENT; final status
--   PRESENT · HALF-DAY · LATE · ABSENT; method NFC · MANUAL · none), carrying the year (a student's
--   from the enrolment) and, for a student, the section. Every change is kept as an event (27.2 audit
--   actions CHECK-IN · CHECK-OUT · MANUAL-ATTENDANCE · AUTO-ABSENT) with the old and new status and
--   the actor or reader (OI-ATT-13).
-- - Period attendance: one record per member, timetable slot and date (PRESENT · LATE), by a tap at
--   the class's period reader or the teacher's marking.
-- - Location attendance: a check-in at an attendance type by a tap (NFC) or the front desk (MANUAL,
--   RC-38), with the cooling-off interval of the type (OI-ATT-11).
-- - Attendance types, visitors, and the per-institution auto-absent setting and its runs (OQ-14: off
--   until the institution sets it).

CREATE TABLE attendance_types (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(40)      NOT NULL,
  cooldown_seconds    SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  created_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_attendance_types__public_id (public_id),
  UNIQUE KEY ux_attendance_types__name (institution_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendance_days (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  section_id          BIGINT UNSIGNED  NULL,                          -- a student's section that day
  att_date            DATE             NOT NULL,
  checkin_status      ENUM('PRESENT','LATE','ABSENT') NOT NULL,
  status              ENUM('PRESENT','HALF_DAY','LATE','ABSENT') NOT NULL,
  method              ENUM('NFC','MANUAL') NULL,                      -- none: the auto-absent routine
  check_in_at         DATETIME(3)      NULL,
  check_out_at        DATETIME(3)      NULL,
  terminal_id         BIGINT UNSIGNED  NULL,                          -- the reader (CR-10)
  remark              VARCHAR(200)     NULL,
  updated_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_attendance_days__member_date (profile_id, att_date),
  KEY ix_attendance_days__date (institution_id, att_date, section_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendance_events (                       -- append-only
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  day_id              BIGINT UNSIGNED  NOT NULL,
  action              ENUM('CHECK-IN','CHECK-OUT','MANUAL-ATTENDANCE','AUTO-ABSENT') NOT NULL,
  old_status          ENUM('PRESENT','HALF_DAY','LATE','ABSENT') NULL,
  new_status          ENUM('PRESENT','HALF_DAY','LATE','ABSENT') NOT NULL,
  actor               BINARY(16)       NULL,
  terminal_id         BIGINT UNSIGNED  NULL,
  remark              VARCHAR(200)     NULL,
  at                  DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY ix_attendance_events__day (day_id, id),
  CONSTRAINT fk_attendance_events__day FOREIGN KEY (day_id) REFERENCES attendance_days (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE period_attendance (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  slot_id             BIGINT UNSIGNED  NOT NULL,                      -- timetable_slots.id
  att_date            DATE             NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  status              ENUM('PRESENT','LATE') NOT NULL,
  method              ENUM('NFC','MANUAL') NOT NULL,
  terminal_id         BIGINT UNSIGNED  NULL,
  marked_by           BINARY(16)       NULL,
  at                  DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_period_attendance__once (slot_id, att_date, profile_id),
  KEY ix_period_attendance__member (institution_id, profile_id, att_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE location_attendance (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  attendance_type_id  BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  action              ENUM('CHECK_IN') NOT NULL DEFAULT 'CHECK_IN',
  method              ENUM('NFC','MANUAL') NOT NULL,
  terminal_id         BIGINT UNSIGNED  NULL,
  captured_by         BINARY(16)       NULL,
  at                  DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY ix_location_attendance__member (profile_id, attendance_type_id, at),
  KEY ix_location_attendance__day (institution_id, at),
  CONSTRAINT fk_location_attendance__type FOREIGN KEY (attendance_type_id) REFERENCES attendance_types (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE visitors (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(80)      NOT NULL,
  mobile_enc          VARBINARY(256)   NOT NULL,                      -- personal data, encrypted
  mobile_last4        CHAR(4)          NOT NULL,
  purpose             VARCHAR(120)     NOT NULL,
  to_meet             VARCHAR(80)      NULL,
  checked_in_at       DATETIME(3)      NOT NULL,
  checked_out_at      DATETIME(3)      NULL,
  recorded_by         BINARY(16)       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_visitors__public_id (public_id),
  KEY ix_visitors__day (institution_id, checked_in_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auto_absent_settings (
  institution_id      BIGINT UNSIGNED  NOT NULL,
  enabled             TINYINT(1)       NOT NULL DEFAULT 0,
  cutoff              TIME             NOT NULL DEFAULT '11:00:00',
  applies_students    TINYINT(1)       NOT NULL DEFAULT 1,
  applies_staff       TINYINT(1)       NOT NULL DEFAULT 0,
  updated_by          BINARY(16)       NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (institution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auto_absent_runs (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  run_date            DATE             NOT NULL,
  marked              INT UNSIGNED     NOT NULL DEFAULT 0,
  skipped_holiday     TINYINT(1)       NOT NULL DEFAULT 0,
  ran_at              DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_auto_absent_runs__once (institution_id, run_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

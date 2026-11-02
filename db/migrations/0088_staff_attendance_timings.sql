-- 0088_staff_attendance_timings.sql — forward-only migration (D-16). Client 2026-10-23: on the
-- Auto-absent page, the school's staff timings — as many as it needs, each for one or more roles
-- (Teacher, Accountant, Front desk …; a role in one only):
--
-- * login and logout time: the working day;
-- * a login after the late login time is Late, after the half-day time a Half day, after the absent
--   time Absent; a staff member with no login by the absent time is marked Absent;
-- * a logout before the early logout time makes the day a Half day.
--
-- Staff only (Teacher, Principal and Staff user types); students keep the school's cut-off. A staff
-- member whose roles are in two timings follows the one made first; one whose roles are in none keeps
-- the school's rules (the late cut-off, the half-day hours and the auto-absent cut-off).
--
-- All three are school tables in the CUG database (db/cug-tables.ts). Roles are in the CampusOne
-- database beside it, which a migration cannot name, so role_id is kept by the service
-- (services/staff-timings.ts) rather than by a foreign key.

CREATE TABLE {{CUG}}.staff_timings (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(60)      NOT NULL,
  login_time          TIME             NOT NULL,
  logout_time         TIME             NOT NULL,
  late_login_time     TIME             NOT NULL,
  early_logout_time   TIME             NOT NULL,
  half_day_time       TIME             NOT NULL,
  absent_time         TIME             NOT NULL,
  created_by          BINARY(16)       NULL,
  updated_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_staff_timings__public (public_id),
  UNIQUE KEY ux_staff_timings__name (institution_id, name),
  CONSTRAINT fk_staff_timings__institution FOREIGN KEY (institution_id)
    REFERENCES {{CUG}}.institutions (id),
  CONSTRAINT ck_staff_timings__order CHECK (
    login_time < late_login_time AND late_login_time < half_day_time
    AND half_day_time < absent_time AND absent_time < logout_time
    AND login_time < early_logout_time AND early_logout_time < logout_time
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The roles a timing is for: a role in one timing per school.
CREATE TABLE {{CUG}}.staff_timing_roles (
  timing_id           BIGINT UNSIGNED  NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  role_id             BIGINT UNSIGNED  NOT NULL,              -- roles.id
  PRIMARY KEY (timing_id, role_id),
  UNIQUE KEY ux_staff_timing_roles__role (institution_id, role_id),
  CONSTRAINT fk_staff_timing_roles__timing FOREIGN KEY (timing_id)
    REFERENCES {{CUG}}.staff_timings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A timing's auto-absent run: once a school day, after its absent time.
CREATE TABLE {{CUG}}.staff_absent_runs (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  timing_id           BIGINT UNSIGNED  NOT NULL,
  run_date            DATE             NOT NULL,
  marked              INT UNSIGNED     NOT NULL DEFAULT 0,
  skipped_holiday     TINYINT(1)       NOT NULL DEFAULT 0,
  ran_at              DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_staff_absent_runs__once (timing_id, run_date),
  KEY ix_staff_absent_runs__institution (institution_id, run_date),
  CONSTRAINT fk_staff_absent_runs__timing FOREIGN KEY (timing_id)
    REFERENCES {{CUG}}.staff_timings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

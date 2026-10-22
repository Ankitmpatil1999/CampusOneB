-- 0082_transport_maps.sql — forward-only migration (D-16). Client 2026-10-21: Google Maps for
-- transport — the bus's live position from the driver's phone, road distances between stops, and the
-- transport fee by distance.
--
-- - transport_trip_positions: the phone's fixes while a trip runs (append-only; kept
--   trn.positions.retentionDays days, 30, then deleted by the job trip-generation). One fix per trip
--   and time (a resent batch adds nothing). transport_trips keeps the latest fix and the km run.
-- - transport_trip_stops.near_notified_at: the "bus is near your stop" notice went out (once).
-- - transport_fee_rules: per school — the rate per km of the round trip, per year, set by the
--   Institution Administrator (transport.fees); the day of the month the monthly dues fall on.
-- - transport_fee_charges: each calculation (distance, rate, yearly amount) behind a member's dues;
--   fee_records gets source TRANSPORT, the charge and the month a due covers.
-- - Sub-task transport.fees, granted to the Institution Administrator only (reserved).
--
-- School tables are in the CUG database ({{CUG}}, ADR-0019); tasks and roles stay in RingPe.

CREATE TABLE {{CUG}}.transport_trip_positions (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  trip_id             BIGINT UNSIGNED  NOT NULL,
  lat                 DECIMAL(9,6)     NOT NULL,
  lng                 DECIMAL(9,6)     NOT NULL,
  accuracy_m          SMALLINT UNSIGNED NULL,
  speed_kmph          DECIMAL(5,1)     NULL,
  heading             SMALLINT UNSIGNED NULL,
  recorded_at         DATETIME(3)      NOT NULL,                        -- the phone's fix time
  received_at         DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_trip_positions__fix (trip_id, recorded_at),
  KEY ix_transport_trip_positions__trip (institution_id, trip_id, recorded_at),
  KEY ix_transport_trip_positions__received (received_at),              -- the retention purge
  CONSTRAINT fk_transport_trip_positions__trip FOREIGN KEY (trip_id) REFERENCES {{CUG}}.transport_trips (id),
  CONSTRAINT ck_transport_trip_positions__lat CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT ck_transport_trip_positions__lng CHECK (lng BETWEEN -180 AND 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE {{CUG}}.transport_trips
  ADD COLUMN last_lat          DECIMAL(9,6)      NULL,
  ADD COLUMN last_lng          DECIMAL(9,6)      NULL,
  ADD COLUMN last_speed_kmph   DECIMAL(5,1)      NULL,
  ADD COLUMN last_heading      SMALLINT UNSIGNED NULL,
  ADD COLUMN last_position_at  DATETIME(3)       NULL,
  ADD COLUMN km_run            DECIMAL(7,2)      NOT NULL DEFAULT 0;

ALTER TABLE {{CUG}}.transport_trip_stops
  ADD COLUMN near_notified_at  DATETIME(3)       NULL;

CREATE TABLE {{CUG}}.transport_fee_rules (
  institution_id      BIGINT UNSIGNED  NOT NULL,
  rate_paise_per_km   BIGINT UNSIGNED  NOT NULL DEFAULT 0,              -- per km of the round trip, per year
  due_day             TINYINT UNSIGNED NOT NULL DEFAULT 5,
  active              TINYINT(1)       NOT NULL DEFAULT 0,
  updated_by          BINARY(16)       NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (institution_id),
  CONSTRAINT fk_transport_fee_rules__institution FOREIGN KEY (institution_id) REFERENCES {{CUG}}.institutions (id),
  CONSTRAINT ck_transport_fee_rules__due_day CHECK (due_day BETWEEN 1 AND 28)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE {{CUG}}.transport_fee_charges (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  allocation_id       BIGINT UNSIGNED  NOT NULL,
  distance_km         DECIMAL(6,2)     NOT NULL,                        -- the stop to the school, one way
  rate_paise_per_km   BIGINT UNSIGNED  NOT NULL,
  yearly_paise        BIGINT UNSIGNED  NOT NULL,                        -- distance × 2 × rate
  months              TINYINT UNSIGNED NOT NULL,                        -- months of the academic year
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_fee_charges__public_id (public_id),
  KEY ix_transport_fee_charges__member (institution_id, year_id, profile_id),
  CONSTRAINT fk_transport_fee_charges__institution FOREIGN KEY (institution_id) REFERENCES {{CUG}}.institutions (id),
  CONSTRAINT fk_transport_fee_charges__year FOREIGN KEY (year_id) REFERENCES {{CUG}}.academic_years (id),
  CONSTRAINT fk_transport_fee_charges__profile FOREIGN KEY (profile_id) REFERENCES {{CUG}}.member_profiles (id),
  CONSTRAINT fk_transport_fee_charges__allocation FOREIGN KEY (allocation_id) REFERENCES {{CUG}}.transport_allocations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A value added at the end of the ENUM is a metadata-only change (no rows are rewritten).
ALTER TABLE {{CUG}}.fee_records
  MODIFY COLUMN source ENUM('STRUCTURE','MANUAL','UPLOAD','TRANSPORT') NOT NULL,
  ADD COLUMN transport_charge_id BIGINT UNSIGNED NULL,
  ADD COLUMN transport_month     DATE            NULL,                  -- the month a transport due covers (its 1st)
  ADD KEY ix_fee_records__transport (institution_id, student_profile_id, year_id, transport_month),
  ADD CONSTRAINT fk_fee_records__transport_charge FOREIGN KEY (transport_charge_id) REFERENCES {{CUG}}.transport_fee_charges (id);

-- The console sub-task (config/registers/access.ts, reserved to the Institution Administrator) and
-- its grant to the existing Institution Administrator roles; the reference seed keeps the labels.
INSERT INTO sub_tasks (task_id, code, label_key, view_only)
SELECT id, 'transport.fees', 'subtask.institution.transport.fees', FALSE FROM tasks
 WHERE scope = 'INSTITUTION' AND code = 'transport'
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);
INSERT INTO role_tasks (role_id, sub_task_id)
SELECT r.id, st.id FROM roles r
  JOIN tasks t ON t.scope = 'INSTITUTION' AND t.code = 'transport'
  JOIN sub_tasks st ON st.task_id = t.id AND st.code = 'transport.fees'
 WHERE r.code = 'INSTITUTION_ADMIN' AND r.grants_seeded = TRUE
ON DUPLICATE KEY UPDATE role_tasks.sub_task_id = role_tasks.sub_task_id;

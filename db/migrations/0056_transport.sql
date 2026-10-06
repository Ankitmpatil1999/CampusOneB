-- 0056_transport.sql — forward-only migration (D-16). Phase 7.6: transport (SRS 22; TRN-001…034;
-- FR-TRN-01…07; BR-60…62; CR-09, CR-13; OI-TRN-05…30; RC-25).
--
-- - Masters: stops, routes with an ordered stop list (no repeats, sequence from 0), vehicles, crew
--   (driver or attendant, a member of the institution, unique employee reference — BR-60), sessions
--   (pickup or drop, a start time and the days of the week it runs — OI-TRN-09). Masters are
--   deactivated, never deleted (OI-TRN-29).
-- - A vehicle assignment puts a route and session on a vehicle with a driver and an attendant for a
--   date range inside the year, never double-booking the vehicle, either crew member or the
--   route-session pair (BR-61).
-- - A passenger allocation gives a member a route and stop for a date range inside the year, never two
--   at once; it is ended, not deleted.
-- - Trips are generated daily (job trip-generation): one per active assignment and date (27.2 SCHEDULED
--   · STARTED · COMPLETED · CANCELLED; RC-25), with its stops in travel order (UPCOMING · REACHED ·
--   DEPARTED · SKIPPED, in order — BR-62), a time-stamped event trail (OI-TRN-22) and the crew's
--   boarding record (RC-25: CHECKED_IN · CHECKED_OUT · NO_SHOW · MISSED; QR · NFC · MANUAL; deviation).

CREATE TABLE transport_stops (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(80)      NOT NULL,
  landmark            VARCHAR(100)     NULL,
  lat                 DECIMAL(9,6)     NULL,
  lng                 DECIMAL(9,6)     NULL,
  active              TINYINT(1)       NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_stops__public_id (public_id),
  UNIQUE KEY ux_transport_stops__name (institution_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_routes (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  code                VARCHAR(10)      NOT NULL,
  name                VARCHAR(80)      NOT NULL,
  description         VARCHAR(200)     NULL,
  route_type          ENUM('MORNING','EVENING','SPECIAL','EMERGENCY') NOT NULL DEFAULT 'MORNING',
  map_link            VARCHAR(300)     NULL,
  active              TINYINT(1)       NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_routes__public_id (public_id),
  UNIQUE KEY ux_transport_routes__code (institution_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_route_stops (
  route_id            BIGINT UNSIGNED  NOT NULL,
  seq                 SMALLINT UNSIGNED NOT NULL,                     -- 0, 1, 2 … (continuous)
  stop_id             BIGINT UNSIGNED  NOT NULL,
  arrival             TIME             NULL,
  departure           TIME             NULL,
  distance_km         DECIMAL(6,2)     NOT NULL DEFAULT 0,            -- from the previous stop
  PRIMARY KEY (route_id, seq),
  UNIQUE KEY ux_transport_route_stops__stop (route_id, stop_id),
  CONSTRAINT fk_transport_route_stops__route FOREIGN KEY (route_id) REFERENCES transport_routes (id),
  CONSTRAINT fk_transport_route_stops__stop FOREIGN KEY (stop_id) REFERENCES transport_stops (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_vehicles (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(40)      NOT NULL,                       -- "Bus 07"
  registration        VARCHAR(15)      NOT NULL,
  capacity            SMALLINT UNSIGNED NOT NULL,
  gps_enabled         TINYINT(1)       NOT NULL DEFAULT 0,
  gps_device          VARCHAR(60)      NULL,
  active              TINYINT(1)       NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_vehicles__public_id (public_id),
  UNIQUE KEY ux_transport_vehicles__registration (institution_id, registration),
  CONSTRAINT ck_transport_vehicles__capacity CHECK (capacity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_crew (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  role                ENUM('DRIVER','ATTENDANT') NOT NULL,
  licence_no          VARCHAR(30)      NULL,
  licence_expiry      DATE             NULL,
  employee_ref        VARCHAR(30)      NOT NULL,
  active              TINYINT(1)       NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_crew__public_id (public_id),
  UNIQUE KEY ux_transport_crew__profile (institution_id, profile_id),
  UNIQUE KEY ux_transport_crew__employee_ref (institution_id, employee_ref),   -- BR-60
  UNIQUE KEY ux_transport_crew__licence (institution_id, licence_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_sessions (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(40)      NOT NULL,
  direction           ENUM('PICKUP','DROP') NOT NULL,
  start_time          TIME             NOT NULL,
  end_time            TIME             NULL,
  days                SET('MON','TUE','WED','THU','FRI','SAT','SUN') NOT NULL,
  active              TINYINT(1)       NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_sessions__public_id (public_id),
  UNIQUE KEY ux_transport_sessions__name (institution_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_assignments (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  route_id            BIGINT UNSIGNED  NOT NULL,
  session_id          BIGINT UNSIGNED  NOT NULL,
  vehicle_id          BIGINT UNSIGNED  NOT NULL,
  driver_crew_id      BIGINT UNSIGNED  NOT NULL,
  attendant_crew_id   BIGINT UNSIGNED  NULL,
  effective_from      DATE             NOT NULL,
  effective_to        DATE             NOT NULL,
  active              TINYINT(1)       NOT NULL DEFAULT 1,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_assignments__public_id (public_id),
  KEY ix_transport_assignments__dates (institution_id, effective_from, effective_to),
  CONSTRAINT ck_transport_assignments__dates CHECK (effective_to >= effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_allocations (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  route_id            BIGINT UNSIGNED  NOT NULL,
  stop_id             BIGINT UNSIGNED  NOT NULL,
  effective_from      DATE             NOT NULL,
  effective_to        DATE             NOT NULL,
  active              TINYINT(1)       NOT NULL DEFAULT 1,
  end_reason          VARCHAR(200)     NULL,
  ended_by            BINARY(16)       NULL,
  ended_at            DATETIME(3)      NULL,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_allocations__public_id (public_id),
  KEY ix_transport_allocations__member (institution_id, profile_id, effective_from),
  KEY ix_transport_allocations__route (institution_id, route_id, stop_id),
  CONSTRAINT ck_transport_allocations__dates CHECK (effective_to >= effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_trips (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  assignment_id       BIGINT UNSIGNED  NOT NULL,
  route_id            BIGINT UNSIGNED  NOT NULL,
  session_id          BIGINT UNSIGNED  NOT NULL,
  vehicle_id          BIGINT UNSIGNED  NOT NULL,
  driver_crew_id      BIGINT UNSIGNED  NOT NULL,
  attendant_crew_id   BIGINT UNSIGNED  NULL,
  trip_date           DATE             NOT NULL,
  direction           ENUM('PICKUP','DROP') NOT NULL,
  planned_start       TIME             NOT NULL,
  status              ENUM('SCHEDULED','STARTED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
  started_at          DATETIME(3)      NULL,
  completed_at        DATETIME(3)      NULL,
  cancelled_at        DATETIME(3)      NULL,
  cancel_remarks      VARCHAR(300)     NULL,
  created_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_trips__public_id (public_id),
  UNIQUE KEY ux_transport_trips__once (assignment_id, trip_date),
  KEY ix_transport_trips__date (institution_id, trip_date, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_trip_stops (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  trip_id             BIGINT UNSIGNED  NOT NULL,
  seq                 SMALLINT UNSIGNED NOT NULL,                     -- travel order
  stop_id             BIGINT UNSIGNED  NOT NULL,
  planned_time        TIME             NULL,
  distance_km         DECIMAL(6,2)     NOT NULL DEFAULT 0,
  status              ENUM('UPCOMING','REACHED','DEPARTED','SKIPPED') NOT NULL DEFAULT 'UPCOMING',
  reached_at          DATETIME(3)      NULL,
  departed_at         DATETIME(3)      NULL,
  skip_remarks        VARCHAR(200)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_trip_stops__seq (trip_id, seq),
  CONSTRAINT fk_transport_trip_stops__trip FOREIGN KEY (trip_id) REFERENCES transport_trips (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_trip_events (                   -- append-only (OI-TRN-22)
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  trip_id             BIGINT UNSIGNED  NOT NULL,
  event               ENUM('SCHEDULED','STARTED','REACHED','DEPARTED','SKIPPED','COMPLETED','CANCELLED') NOT NULL,
  seq                 SMALLINT UNSIGNED NULL,
  actor               BINARY(16)       NULL,
  remarks             VARCHAR(300)     NULL,
  at                  DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY ix_transport_trip_events__trip (trip_id, id),
  CONSTRAINT fk_transport_trip_events__trip FOREIGN KEY (trip_id) REFERENCES transport_trips (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_boardings (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  trip_id             BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  status              ENUM('CHECKED_IN','CHECKED_OUT','NO_SHOW','MISSED') NOT NULL,
  method              ENUM('QR','NFC','MANUAL') NOT NULL DEFAULT 'MANUAL',
  stop_seq            SMALLINT UNSIGNED NULL,
  allocated_stop_id   BIGINT UNSIGNED  NULL,
  deviation           ENUM('YES','NO') NOT NULL DEFAULT 'NO',
  actor               BINARY(16)       NULL,
  at                  DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_transport_boardings__member (trip_id, profile_id),
  CONSTRAINT fk_transport_boardings__trip FOREIGN KEY (trip_id) REFERENCES transport_trips (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

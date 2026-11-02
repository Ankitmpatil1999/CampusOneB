-- 0024_portal.sql — forward-only migration (D-16). Phase 2.7 part 4: the customer portal (SAS-001…025;
-- FR-SAS-04…11, FR-INS-01…03; prototype s.*): self-serve sign-up, data exports and cancellation
-- requests. Institution detail changes from the portal go through the platform approvals (ADR-0015
-- point 5) and need no table of their own.

-- How the institution signed up and how it wants to start (prototype s.signup step 3).
ALTER TABLE institutions
  ADD COLUMN signup_source      ENUM('OPERATOR','PORTAL') NOT NULL DEFAULT 'OPERATOR' AFTER board,
  ADD COLUMN start_preference   ENUM('TRIAL','PAY') NULL AFTER signup_source,
  ADD COLUMN students_estimate  INT UNSIGNED NULL AFTER start_preference,
  ADD COLUMN terms_version      VARCHAR(20)  NULL AFTER students_estimate,
  ADD COLUMN terms_accepted_at  DATETIME(3)  NULL AFTER terms_version;

-- A full data export (FR-SAS-04, OI-SAS-05): one archive per request, private, signed links only,
-- removed after the retention window (setting sas.export.keepDays). RC-27.
CREATE TABLE data_exports (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  scope           ENUM('ALL') NOT NULL DEFAULT 'ALL',
  status          ENUM('PREPARING','READY','FAILED','EXPIRED') NOT NULL DEFAULT 'PREPARING',
  file_id         BIGINT UNSIGNED NULL,
  row_counts      JSON            NULL,
  requested_by    BINARY(16)      NOT NULL,
  requested_at    DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  ready_at        DATETIME(3)     NULL,
  expires_at      DATETIME(3)     NULL,
  error_code      VARCHAR(60)     NULL,
  -- One export at a time per institution while it is being prepared.
  running_key     BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'PREPARING', institution_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_data_exports__public_id (public_id),
  UNIQUE KEY ux_data_exports__running (running_key),
  KEY ix_data_exports__inst_requested (institution_id, requested_at),
  CONSTRAINT fk_data_exports__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_data_exports__file FOREIGN KEY (file_id) REFERENCES files (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A cancellation the institution asks for (FR-SAS-04, OQ-30): CampusOne confirms it with the
-- lifecycle action Cancel, or declines it; the institution can withdraw it while pending. RC-28.
CREATE TABLE cancellation_requests (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  effective_on    DATE            NOT NULL,
  reason          VARCHAR(300)    NOT NULL,
  status          ENUM('PENDING','CONFIRMED','DECLINED','WITHDRAWN') NOT NULL DEFAULT 'PENDING',
  requested_by    BINARY(16)      NOT NULL,
  requested_at    DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  resolved_by     BINARY(16)      NULL,
  resolved_at     DATETIME(3)     NULL,
  resolution      VARCHAR(300)    NULL,
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  open_key        BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'PENDING', institution_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_cancellation_requests__public_id (public_id),
  UNIQUE KEY ux_cancellation_requests__open (open_key),
  KEY ix_cancellation_requests__inst (institution_id, requested_at),
  CONSTRAINT fk_cancellation_requests__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_cancellation_requests__no_delete BEFORE DELETE ON cancellation_requests
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cancellation_requests are never deleted';

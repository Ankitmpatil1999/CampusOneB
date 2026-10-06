-- 0040_fee_collections.sql — forward-only migration (D-16). Phase 5.2: collecting fee records from
-- the student's campus wallet through the payment engine (SRS 13.3, 13.5, 13.15; FEE-010…023, job
-- fee-retry; OI-FEE-20/21 resolved: every collection posts the ledger).
--
-- - A fee collection is one successful tuition payment of a record (channel TUITION, RPTF), written in
--   the payment's own transaction; COLLECTED until the settlement run marks it SETTLED (STL).
-- - A short balance leaves one PENDING collection attempt per record (RNG-PAY-126), retried by the job
--   (Q14 M9) until it succeeds or the record is paid another way; each retry is its own engine attempt.
-- - Consent: a member's agreement to wallet collection, valid `fee.consent.validityMonths` (13.5),
--   required when the institution's feeConsent toggle is on.

CREATE TABLE fee_collection_attempts (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  record_id           BIGINT UNSIGNED  NOT NULL,
  status              ENUM('PENDING','SUCCEEDED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  tries               SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_failure_code   VARCHAR(64)      NULL,
  last_tried_at       DATETIME(3)      NULL,
  payment_attempt_id  BIGINT UNSIGNED  NULL,                        -- the latest engine attempt
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  closed_at           DATETIME(3)      NULL,
  live_key            BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'PENDING', record_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_collection_attempts__public_id (public_id),
  UNIQUE KEY ux_fee_collection_attempts__live (live_key),          -- one pending attempt per record
  KEY ix_fee_collection_attempts__inst_status (institution_id, status, last_tried_at),
  CONSTRAINT fk_fee_collection_attempts__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_collection_attempts__record FOREIGN KEY (record_id) REFERENCES fee_records (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_collections (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  record_id           BIGINT UNSIGNED  NOT NULL,
  payment_attempt_id  BIGINT UNSIGNED  NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  fine_paise          BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  source              ENUM('CONSOLE','JOB','MEMBER') NOT NULL,
  status              ENUM('COLLECTED','SETTLED') NOT NULL DEFAULT 'COLLECTED',
  settlement_ref      VARCHAR(40)      NULL,
  collected_at        DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_collections__public_id (public_id),
  UNIQUE KEY ux_fee_collections__attempt (payment_attempt_id),
  KEY ix_fee_collections__inst_record (institution_id, record_id),
  KEY ix_fee_collections__inst_collected (institution_id, collected_at),
  CONSTRAINT fk_fee_collections__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_collections__record FOREIGN KEY (record_id) REFERENCES fee_records (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_consents (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  account_id          BIGINT UNSIGNED  NOT NULL,                     -- who agreed (student or guardian)
  text_version        VARCHAR(20)      NOT NULL,
  agreed_at           DATETIME(3)      NOT NULL,
  valid_until         DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_consents__public_id (public_id),
  KEY ix_fee_consents__student (institution_id, student_profile_id, valid_until),
  CONSTRAINT fk_fee_consents__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_consents__student FOREIGN KEY (student_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_fee_consents__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The fee record a payment pays (the engine's tuition input, RNG-PAY-123).
ALTER TABLE payment_attempts
  ADD COLUMN fee_record_id BIGINT UNSIGNED NULL AFTER event_ref,
  ADD KEY ix_payment_attempts__fee_record (fee_record_id, status);

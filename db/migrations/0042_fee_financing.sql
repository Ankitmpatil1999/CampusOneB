-- 0042_fee_financing.sql — forward-only migration (D-16). Phase 5.3: members' dues and fee
-- financing (SRS 13.5, 13.11, 13.12; FR-FEE-06, FR-FEE-11; FEE-019…027, FEE-038, FEE-042).
--
-- - A consent keeps the exact text the member accepted (FR-FEE-06), not only its template version.
-- - Fee financing (OQ-03, an example contract until the partner is named): one live registration per
--   student (Pending or Success); the partner decides through its signed webhook. Financed records
--   are never debited from the wallet; the partner's payment marks them paid without a ledger posting
--   (the money goes from the partner to the school's bank, not through a campus wallet).

ALTER TABLE fee_consents
  ADD COLUMN accepted_text TEXT NULL AFTER text_version;

CREATE TABLE fee_financing_registrations (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  partner_ref         VARCHAR(40)      NOT NULL,                      -- what the partner quotes back
  partner_name        VARCHAR(120)     NOT NULL,
  status              ENUM('PENDING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
  requested_by_type   ENUM('STAFF','MEMBER') NOT NULL,
  requested_by        BINARY(16)       NULL,
  failure_reason      VARCHAR(300)     NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  decided_at          DATETIME(3)      NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  live_key            BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status IN ('PENDING','SUCCESS'), student_profile_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_financing_registrations__public_id (public_id),
  UNIQUE KEY ux_fee_financing_registrations__partner_ref (partner_ref),
  UNIQUE KEY ux_fee_financing_registrations__live (live_key),        -- one live registration per student
  KEY ix_fee_financing_registrations__inst_status (institution_id, status, created_at),
  CONSTRAINT fk_fee_financing_registrations__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_financing_registrations__student FOREIGN KEY (student_profile_id) REFERENCES member_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_financing_records (
  registration_id     BIGINT UNSIGNED  NOT NULL,
  record_id           BIGINT UNSIGNED  NOT NULL,
  PRIMARY KEY (registration_id, record_id),
  KEY ix_fee_financing_records__record (record_id),
  CONSTRAINT fk_fee_financing_records__registration FOREIGN KEY (registration_id) REFERENCES fee_financing_registrations (id),
  CONSTRAINT fk_fee_financing_records__record FOREIGN KEY (record_id) REFERENCES fee_records (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

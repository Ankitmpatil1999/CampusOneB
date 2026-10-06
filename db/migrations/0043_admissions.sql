-- 0043_admissions.sql — forward-only migration (D-16). Phase 5.4–5.5: admission links, the public
-- application form, the console's applications and admission fees (SRS 7.8, 19.2–19.12; CR-14;
-- INS-027…029, ADM-001…024; prototype p.admission, p.form, p.pay, p.done, p.status, c.admissionqr,
-- c.applications, c.admfees).
--
-- - An admission link is a random token the institution shares as a URL and QR (one live link per
--   institution; earlier ones are kept as history and stop working).
-- - An application: Draft → Submitted → Approved / Rejected (RC-21). Searchable facts are columns;
--   the rest of the form is one JSON document. The identity number is only its last 6 digits (Q16 e),
--   encrypted with a blind index for resume (ADR-0012), last 4 shown masked.
-- - Admission payments: one row per application and fee type (application fee, admission fee),
--   PENDING → PAID / FAILED (27.2 reduced); cash at the desk or online through the gateway adapter.
--   Neither touches a campus wallet, so nothing is posted to the ledger here (accounting, OQ-04).

CREATE TABLE admission_links (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  token               CHAR(43)         NOT NULL,                      -- 32 random bytes, base64url
  year_id             BIGINT UNSIGNED  NULL,                          -- preselected year, if any
  status              ENUM('ACTIVE','REPLACED') NOT NULL DEFAULT 'ACTIVE',
  expires_at          DATETIME(3)      NULL,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  replaced_at         DATETIME(3)      NULL,
  live_key            BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'ACTIVE', institution_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_admission_links__public_id (public_id),
  UNIQUE KEY ux_admission_links__token (token),
  UNIQUE KEY ux_admission_links__live (live_key),
  KEY ix_admission_links__inst (institution_id, created_at),
  CONSTRAINT fk_admission_links__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_admission_links__year FOREIGN KEY (year_id) REFERENCES academic_years (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admission_applications (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  application_no      VARCHAR(24)      NOT NULL,                      -- <prefix>/<yyyy>/<6 digits> (Q24)
  source              ENUM('PUBLIC','COUNSELLOR','IMPORT') NOT NULL,
  status              ENUM('DRAFT','SUBMITTED','APPROVED','REJECTED') NOT NULL DEFAULT 'DRAFT',
  year_id             BIGINT UNSIGNED  NOT NULL,
  class_id            BIGINT UNSIGNED  NULL,
  section_id          BIGINT UNSIGNED  NULL,                          -- set on approval (CR-09)
  mid_term            TINYINT(1)       NOT NULL DEFAULT 0,
  joining_date        DATE             NULL,
  first_name          VARCHAR(50)      NULL,
  middle_name         VARCHAR(50)      NULL,
  last_name           VARCHAR(50)      NULL,
  gender              ENUM('MALE','FEMALE','OTHER') NULL,
  dob                 DATE             NULL,
  id_number_enc       VARBINARY(255)   NULL,                          -- last 6 digits only (Q16 e)
  id_number_bidx      BINARY(32)       NULL,
  id_number_last4     CHAR(4)          NULL,
  primary_name        VARCHAR(100)     NULL,
  primary_relation    ENUM('FATHER','MOTHER','GUARDIAN') NULL,
  primary_mobile      CHAR(10)         NULL,
  primary_email       VARCHAR(254)     NULL,
  data                JSON             NOT NULL,                      -- the rest of the form
  step                TINYINT UNSIGNED NOT NULL DEFAULT 0,
  tc_mode             ENUM('TC','UNDERTAKING') NULL,                 -- mid-term (OI-ADM-27)
  tc_number           VARCHAR(40)      NULL,
  tc_date             DATE             NULL,
  tc_due              DATE             NULL,
  declared_at         DATETIME(3)      NULL,
  declared_by         VARCHAR(100)     NULL,
  submitted_at        DATETIME(3)      NULL,
  decided_at          DATETIME(3)      NULL,
  decided_by          BINARY(16)       NULL,
  rejection_reason    VARCHAR(40)      NULL,
  rejection_remarks   VARCHAR(500)     NULL,
  admission_no        VARCHAR(40)      NULL,
  member_profile_id   BIGINT UNSIGNED  NULL,
  payment_status      ENUM('PENDING','COMPLETED') NOT NULL DEFAULT 'PENDING',
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_admission_applications__public_id (public_id),
  UNIQUE KEY ux_admission_applications__no (institution_id, application_no),
  KEY ix_admission_applications__inst_status (institution_id, status, submitted_at),
  KEY ix_admission_applications__inst_year (institution_id, year_id, class_id),
  KEY ix_admission_applications__bidx (institution_id, id_number_bidx),
  KEY ix_admission_applications__mobile (institution_id, primary_mobile),
  CONSTRAINT fk_admission_applications__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_admission_applications__year FOREIGN KEY (year_id) REFERENCES academic_years (id),
  CONSTRAINT fk_admission_applications__class FOREIGN KEY (class_id) REFERENCES classes (id),
  CONSTRAINT fk_admission_applications__section FOREIGN KEY (section_id) REFERENCES sections (id),
  CONSTRAINT fk_admission_applications__member FOREIGN KEY (member_profile_id) REFERENCES member_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admission_application_seq (
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_number         SMALLINT UNSIGNED NOT NULL,
  last_no             INT UNSIGNED     NOT NULL,
  PRIMARY KEY (institution_id, year_number),
  CONSTRAINT fk_admission_application_seq__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admission_references (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  application_id      BIGINT UNSIGNED  NOT NULL,
  name                VARCHAR(100)     NOT NULL,
  relation            VARCHAR(60)      NULL,
  mobile              CHAR(10)         NOT NULL,
  email               VARCHAR(254)     NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_admission_references__public_id (public_id),
  KEY ix_admission_references__app (application_id),
  CONSTRAINT fk_admission_references__app FOREIGN KEY (application_id) REFERENCES admission_applications (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admission_documents (
  application_id      BIGINT UNSIGNED  NOT NULL,
  doc_type            ENUM('PHOTO','BIRTH','ADDRESS','REPORT','TC','OTHER') NOT NULL,
  file_id             BIGINT UNSIGNED  NOT NULL,
  added_at            DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (application_id, doc_type),
  CONSTRAINT fk_admission_documents__app FOREIGN KEY (application_id) REFERENCES admission_applications (id),
  CONSTRAINT fk_admission_documents__file FOREIGN KEY (file_id) REFERENCES files (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admission_payments (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  application_id      BIGINT UNSIGNED  NOT NULL,
  fee_type            ENUM('APPLICATION','ADMISSION') NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  status              ENUM('PENDING','PAID','FAILED') NOT NULL DEFAULT 'PENDING',
  mode                ENUM('ONLINE','CASH') NULL,
  gateway_order_id    VARCHAR(64)      NULL,
  gateway_payment_id  VARCHAR(64)      NULL,
  link_token_hash     BINARY(32)       NULL,                          -- ADM-023 payment link
  receipt_no          VARCHAR(30)      NULL,
  paid_by             VARCHAR(100)     NULL,
  collected_by        BINARY(16)       NULL,
  paid_at             DATETIME(3)      NULL,
  failure_reason      VARCHAR(200)     NULL,
  attempts            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_admission_payments__public_id (public_id),
  UNIQUE KEY ux_admission_payments__fee (application_id, fee_type),  -- collected once (FR-FEE-12)
  UNIQUE KEY ux_admission_payments__order (gateway_order_id),
  UNIQUE KEY ux_admission_payments__receipt (institution_id, receipt_no),
  KEY ix_admission_payments__inst (institution_id, fee_type, status, paid_at),
  CONSTRAINT fk_admission_payments__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_admission_payments__app FOREIGN KEY (application_id) REFERENCES admission_applications (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admission_imports (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  file_name           VARCHAR(200)     NOT NULL,
  rows_total          INT UNSIGNED     NOT NULL,
  rows_imported       INT UNSIGNED     NOT NULL,
  rows_rejected       INT UNSIGNED     NOT NULL,
  report              JSON             NOT NULL,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_admission_imports__public_id (public_id),
  KEY ix_admission_imports__inst (institution_id, created_at),
  CONSTRAINT fk_admission_imports__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

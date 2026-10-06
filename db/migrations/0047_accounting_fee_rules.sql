-- 0047_accounting_fee_rules.sql — forward-only migration (D-16). Phase 6.4: accounting vouchers
-- (SRS 13.13; FEE-034…037; OQ-04 / Q14 M15 example contract; RC-36) and the platform fee rule per
-- plan (STL-009; OI-SAS-02, OQ-06).
--
-- - An institution names its accounting company and maps the postings it wants in its books (tuition,
--   event payments, allowance funding, refunds) to a debit and a credit ledger. A job writes one
--   voucher per mapped ledger posting (a unique key) and sends it to the accounting package through
--   an adapter; a failure is retried, and an officer can retry it by hand.
-- - The platform fee rule of a plan is versioned and effective-dated; versions are never edited. The
--   settlement run takes the version in force on its date, else the platform settings.

CREATE TABLE accounting_settings (
  institution_id      BIGINT UNSIGNED  NOT NULL,
  company_name        VARCHAR(100)     NOT NULL,
  enabled             TINYINT(1)       NOT NULL DEFAULT 0,
  enabled_at          DATETIME(3)      NULL,                          -- postings from here on are sent
  updated_by          BINARY(16)       NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (institution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE accounting_mappings (
  institution_id      BIGINT UNSIGNED  NOT NULL,
  event               ENUM('TUITION','EVENT','ALLOWANCE_CREDIT','REFUND') NOT NULL,
  debit_ledger        VARCHAR(100)     NOT NULL,
  credit_ledger       VARCHAR(100)     NOT NULL,
  PRIMARY KEY (institution_id, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE accounting_vouchers (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  ledger_txn_id       BIGINT UNSIGNED  NOT NULL,
  reference           CHAR(35)         NOT NULL,                       -- the ledger reference (voucher number)
  event               ENUM('TUITION','EVENT','ALLOWANCE_CREDIT','REFUND') NOT NULL,
  voucher_date        DATE             NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  company_name        VARCHAR(100)     NOT NULL,
  debit_ledger        VARCHAR(100)     NOT NULL,
  credit_ledger       VARCHAR(100)     NOT NULL,
  narration           VARCHAR(200)     NULL,
  status              ENUM('PENDING','TRANSFERRED','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_error          VARCHAR(300)     NULL,
  next_attempt_at     DATETIME(3)      NULL,
  external_ref        VARCHAR(80)      NULL,
  transferred_at      DATETIME(3)      NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_accounting_vouchers__public_id (public_id),
  UNIQUE KEY ux_accounting_vouchers__txn (institution_id, ledger_txn_id), -- one voucher per posting
  KEY ix_accounting_vouchers__status (status, next_attempt_at),
  KEY ix_accounting_vouchers__inst (institution_id, voucher_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE platform_fee_rules (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  plan_id             BIGINT UNSIGNED  NOT NULL,
  version             INT UNSIGNED     NOT NULL,
  flat_paise          BIGINT UNSIGNED  NOT NULL,
  threshold_paise     BIGINT UNSIGNED  NOT NULL,
  boundary            ENUM('INCLUSIVE','EXCLUSIVE') NOT NULL,         -- is the threshold itself flat? (OQ-06)
  basis_points        INT UNSIGNED     NOT NULL,
  applies_to          JSON             NOT NULL,                       -- ledger types charged
  effective_from      DATE             NOT NULL,
  remarks             VARCHAR(300)     NOT NULL,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_platform_fee_rules__version (plan_id, version),
  KEY ix_platform_fee_rules__effective (plan_id, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

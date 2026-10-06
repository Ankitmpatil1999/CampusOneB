-- 0045_reconciliation.sql — forward-only migration (D-16). Phase 6.2: reconciliation (SRS 15;
-- REC-001…016; RC-19; Q14 M3, M16).
--
-- - External statements (sponsor-bank credits into virtual accounts, payout bank, gateway) are uploaded
--   whole or not at all; a file or a row seen before is refused. Each row is matched to the platform's
--   record; differences become mismatches to resolve.
-- - Refunds (Requested → Processed / Rejected) and chargebacks (Raised → Accepted / Disputed →
--   Completed) move money only through the ledger, as new pairs referencing the original (append-only).
-- - A refund or chargeback debited from a merchant's wallet becomes an adjustment line (sign −1) in its
--   next settlement (Q14 M3), so the payout never pays out money that went back.

ALTER TABLE settlement_lines
  ADD COLUMN sign TINYINT NOT NULL DEFAULT 1 AFTER txn_type;          -- −1: an adjustment (refund, chargeback)
ALTER TABLE settlements
  ADD COLUMN adjustment_paise BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER fee_paise,
  MODIFY COLUMN net_paise BIGINT NOT NULL DEFAULT 0;                  -- credits − fee − adjustments

CREATE TABLE recon_statements (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  kind                ENUM('VA_CREDITS','PAYOUTS','GATEWAY') NOT NULL,
  file_name           VARCHAR(200)     NOT NULL,
  sha256              CHAR(64)         NOT NULL,
  rows_total          INT UNSIGNED     NOT NULL,
  rows_matched        INT UNSIGNED     NOT NULL,
  rows_mismatched     INT UNSIGNED     NOT NULL,
  period_from         DATE             NULL,
  period_to           DATE             NULL,
  uploaded_by         BINARY(16)       NULL,
  uploaded_at         DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_recon_statements__public_id (public_id),
  UNIQUE KEY ux_recon_statements__file (kind, sha256),               -- the same file twice is refused
  KEY ix_recon_statements__kind (kind, uploaded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE recon_statement_rows (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  statement_id        BIGINT UNSIGNED  NOT NULL,
  kind                ENUM('VA_CREDITS','PAYOUTS','GATEWAY') NOT NULL,
  row_no              INT UNSIGNED     NOT NULL,
  row_key             VARCHAR(80)      NOT NULL,                       -- UTR / bank txn id / payment id
  txn_date            DATE             NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  status_text         VARCHAR(40)      NULL,
  raw                 JSON             NOT NULL,
  institution_id      BIGINT UNSIGNED  NULL,
  matched_type        VARCHAR(30)      NULL,                           -- bank_credit / settlement / admission_payment
  matched_id          BIGINT UNSIGNED  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_recon_statement_rows__key (kind, row_key),            -- a row seen before is refused
  KEY ix_recon_statement_rows__statement (statement_id, row_no),
  KEY ix_recon_statement_rows__inst (institution_id, txn_date),
  CONSTRAINT fk_recon_statement_rows__statement FOREIGN KEY (statement_id) REFERENCES recon_statements (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE recon_mismatches (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  statement_id        BIGINT UNSIGNED  NOT NULL,
  row_id              BIGINT UNSIGNED  NULL,
  institution_id      BIGINT UNSIGNED  NULL,
  kind                ENUM('MISSING_ON_PLATFORM','MISSING_IN_STATEMENT','AMOUNT','STATUS') NOT NULL,
  platform_type       VARCHAR(30)      NULL,
  platform_id         BIGINT UNSIGNED  NULL,
  platform_ref        VARCHAR(80)      NULL,
  statement_paise     BIGINT UNSIGNED  NULL,
  platform_paise      BIGINT UNSIGNED  NULL,
  status              ENUM('OPEN','RESOLVED') NOT NULL DEFAULT 'OPEN',
  resolution          ENUM('EXPLAINED','REFUND','CHARGEBACK','ADJUSTED') NULL,
  remarks             VARCHAR(500)     NULL,
  refund_id           BIGINT UNSIGNED  NULL,
  chargeback_id       BIGINT UNSIGNED  NULL,
  resolved_by         BINARY(16)       NULL,
  resolved_at         DATETIME(3)      NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_recon_mismatches__public_id (public_id),
  KEY ix_recon_mismatches__status (status, kind, created_at),
  KEY ix_recon_mismatches__inst (institution_id, status),
  CONSTRAINT fk_recon_mismatches__statement FOREIGN KEY (statement_id) REFERENCES recon_statements (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE refunds (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  ledger_txn_id       BIGINT UNSIGNED  NOT NULL,                       -- the original movement
  original_reference  CHAR(35)         NOT NULL,
  from_wallet_id      BIGINT UNSIGNED  NOT NULL,                       -- the wallet that was credited
  to_wallet_id        BIGINT UNSIGNED  NOT NULL,                       -- the wallet that paid
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  status              ENUM('REQUESTED','PROCESSED','REJECTED') NOT NULL DEFAULT 'REQUESTED',
  source              ENUM('MISMATCH','GRIEVANCE','MANUAL') NOT NULL,
  reason              VARCHAR(300)     NOT NULL,
  requested_by        BINARY(16)       NULL,
  requested_at        DATETIME(3)      NOT NULL,
  decided_by          BINARY(16)       NULL,
  decided_at          DATETIME(3)      NULL,
  decision_remarks    VARCHAR(500)     NULL,
  refund_reference    CHAR(35)         NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  live_key            BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status <> 'REJECTED', ledger_txn_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_refunds__public_id (public_id),
  UNIQUE KEY ux_refunds__live (live_key),                             -- one refund per movement
  KEY ix_refunds__status (status, requested_at),
  KEY ix_refunds__inst (institution_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE chargebacks (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  ledger_txn_id       BIGINT UNSIGNED  NOT NULL,
  original_reference  CHAR(35)         NOT NULL,
  wallet_id           BIGINT UNSIGNED  NOT NULL,                       -- the wallet that was credited
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  reason_code         VARCHAR(20)      NOT NULL,
  status              ENUM('RAISED','ACCEPTED','DISPUTED','COMPLETED') NOT NULL DEFAULT 'RAISED',
  remarks             VARCHAR(500)     NULL,
  raised_by           BINARY(16)       NULL,
  raised_at           DATETIME(3)      NOT NULL,
  decided_by          BINARY(16)       NULL,
  decided_at          DATETIME(3)      NULL,
  completed_by        BINARY(16)       NULL,
  completed_at        DATETIME(3)      NULL,
  outcome             ENUM('REVERSED','UPHELD') NULL,                -- on completion: money back, or the dispute won
  reversal_reference  CHAR(35)         NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_chargebacks__public_id (public_id),
  UNIQUE KEY ux_chargebacks__txn (ledger_txn_id),                     -- one chargeback per movement, ever
  KEY ix_chargebacks__status (status, raised_at),
  KEY ix_chargebacks__inst (institution_id, raised_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

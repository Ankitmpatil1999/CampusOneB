-- 0044_settlement.sql — forward-only migration (D-16). Phase 6.1: the nightly merchant settlement,
-- its two-stage approval and payout, and the daily wallet balance roll-over (SRS 14, 8.15;
-- STL-001…013; RNG-STL-045…075; Q14 M1–M4, M17).
--
-- - The run computes and moves nothing: a settlement holds the successful credits to the
--   institution's merchant wallets that no live settlement holds yet, with the platform fee per line.
-- - Money moves when the payout UTR is recorded: per merchant, the wallet is debited the gross, the
--   payout clearing credited the net and the platform fee account the fee (ledger pairs).
-- - One live (non-failed) settlement per institution and date. A line is live in one settlement at a
--   time; a failed settlement's lines become free again and the next run collects them once (M17).
-- - wallet_day_balances keeps each wallet's opening and closing balance per business date (8.15).

CREATE TABLE settlements (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  settlement_no       VARCHAR(40)      NOT NULL,
  settlement_date     DATE             NOT NULL,                      -- the window's end date (IST)
  window_to           DATETIME(3)      NOT NULL,
  status              ENUM('PENDING','APPROVAL_STAGE_1','APPROVED','FAILED') NOT NULL DEFAULT 'PENDING',
  line_count          INT UNSIGNED     NOT NULL DEFAULT 0,
  merchant_count      INT UNSIGNED     NOT NULL DEFAULT 0,
  gross_paise         BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  fee_paise           BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  net_paise           BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  recollected_count   INT UNSIGNED     NOT NULL DEFAULT 0,             -- lines of failed settlements (M17)
  files               JSON             NULL,                           -- the four statements' file ids
  stage1_by           BINARY(16)       NULL,
  stage1_at           DATETIME(3)      NULL,
  stage1_remarks      VARCHAR(500)     NULL,
  final_by            BINARY(16)       NULL,
  final_at            DATETIME(3)      NULL,
  final_remarks       VARCHAR(500)     NULL,
  rejected_by         BINARY(16)       NULL,
  rejected_at         DATETIME(3)      NULL,
  rejection_remarks   VARCHAR(500)     NULL,
  payout_utr          VARCHAR(22)      NULL,                           -- write-once (RNG-STL-052)
  payout_paise        BIGINT UNSIGNED  NULL,
  payout_at           DATETIME(3)      NULL,
  payout_by           BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  live_key            VARCHAR(40) GENERATED ALWAYS AS
                        (IF(status <> 'FAILED', CONCAT(institution_id, ':', settlement_date), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_settlements__public_id (public_id),
  UNIQUE KEY ux_settlements__no (settlement_no),
  UNIQUE KEY ux_settlements__live (live_key),
  UNIQUE KEY ux_settlements__utr (payout_utr),
  KEY ix_settlements__inst_date (institution_id, settlement_date),
  KEY ix_settlements__status (status, settlement_date),
  CONSTRAINT fk_settlements__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE settlement_lines (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  settlement_id       BIGINT UNSIGNED  NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  merchant_profile_id BIGINT UNSIGNED  NOT NULL,
  ledger_txn_id       BIGINT UNSIGNED  NOT NULL,
  posted_on           DATE             NOT NULL,
  reference           CHAR(35)         NOT NULL,
  txn_type            VARCHAR(24)      NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  fee_paise           BIGINT UNSIGNED  NOT NULL,
  net_paise           BIGINT UNSIGNED  NOT NULL,
  remarks             VARCHAR(140)     NULL,
  txn_at              DATETIME(3)      NOT NULL,
  recollected         TINYINT(1)       NOT NULL DEFAULT 0,             -- from a failed settlement (M17)
  active              TINYINT(1)       NOT NULL DEFAULT 1,             -- 0: its settlement failed, or carried forward
  carried             TINYINT(1)       NOT NULL DEFAULT 0,             -- merchant suspended at payout (M4)
  payout_reference    CHAR(35)         NULL,
  live_txn            BIGINT UNSIGNED GENERATED ALWAYS AS (IF(active = 1, ledger_txn_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_settlement_lines__public_id (public_id),
  UNIQUE KEY ux_settlement_lines__live (live_txn),                    -- a credit is live in one settlement
  KEY ix_settlement_lines__settlement (settlement_id, merchant_profile_id),
  KEY ix_settlement_lines__merchant (institution_id, merchant_profile_id, txn_at),
  KEY ix_settlement_lines__txn (ledger_txn_id),
  CONSTRAINT fk_settlement_lines__settlement FOREIGN KEY (settlement_id) REFERENCES settlements (id),
  CONSTRAINT fk_settlement_lines__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_settlement_lines__merchant FOREIGN KEY (merchant_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT ck_settlement_lines__net CHECK (net_paise + fee_paise = amount_paise)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE wallet_day_balances (
  wallet_id           BIGINT UNSIGNED  NOT NULL,
  business_date       DATE             NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  opening_paise       BIGINT           NOT NULL,
  closing_paise       BIGINT           NOT NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (wallet_id, business_date),
  KEY ix_wallet_day_balances__inst (institution_id, business_date),
  CONSTRAINT fk_wallet_day_balances__wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

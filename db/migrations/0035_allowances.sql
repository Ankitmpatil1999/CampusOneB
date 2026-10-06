-- 0035_allowances.sql — forward-only migration (D-16). Phase 4.3: allowances (SRS 10; ALW-001…005,
-- job allowance-cycle).
--
-- - A grant gives one student an amount from a start date (the 1st of a month) to an expiry date,
--   with optional daily limits (count, amount). It is Active while in force and Inactive once it has
--   expired or was cancelled before its credit (27.2 "allowance definition"; Q14 M13 recommendation:
--   the definition is set inactive at expiry). `ended_reason` says which.
-- - One allowance per student at a time (BR-40): a student's grants don't overlap. The service checks
--   it under the allowance wallet's row lock, so the next period can be issued in advance (renewal =
--   a new grant; the job expires before it credits, so periods can follow each other).
-- - Money moves only through the ledger (OQ-10 resolved, RC-13): the 00:05 job credits the
--   allowance wallet from the institution's ALLOWANCE_FUNDING account (ALLOWANCE_CREDIT, RPAC) and
--   returns an unspent balance at expiry (ALLOWANCE_EXPIRY, RPAE). Payments from the allowance wallet
--   go through the payment engine (ALLOWANCE_PAYMENT, RPAW) to the merchant's wallet (Q14 M6
--   recommendation: settled like other payments).

ALTER TABLE ledger_accounts
  MODIFY kind ENUM('WALLET','BANK_POOL','PAYOUT_CLEARING','PLATFORM_FEE','HELD_SUSPENSE',
                   'REFUND_CLEARING','CHARGEBACK_CLEARING','COUPON_REIMBURSEMENT','ADJUSTMENT',
                   'ALLOWANCE_FUNDING') NOT NULL;

ALTER TABLE ledger_transactions
  MODIFY type ENUM('PAYMENT','TRANSFER','BANK_CREDIT','TUITION','ALLOWANCE_CREDIT','ALLOWANCE_PAYMENT',
                   'COUPON_REDEMPTION','EVENT','REFUND','REVERSAL','CHARGEBACK','SETTLEMENT_PAYOUT',
                   'PLATFORM_FEE','ADJUSTMENT','HOLD_RELEASE','ALLOWANCE_EXPIRY') NOT NULL;

CREATE TABLE allowance_grants (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id                 BINARY(16)      NOT NULL,
  institution_id            BIGINT UNSIGNED NOT NULL,
  profile_id                BIGINT UNSIGNED NOT NULL,
  wallet_id                 BIGINT UNSIGNED NOT NULL,   -- the student's allowance wallet
  name                      VARCHAR(40)     NULL,       -- e.g. "Term 2 pocket money"
  amount_paise              BIGINT UNSIGNED NOT NULL,
  start_date                DATE            NOT NULL,   -- the 1st of a month, after the issue date
  expiry_date               DATE            NOT NULL,   -- after the start date
  daily_count_limit         SMALLINT UNSIGNED NULL,     -- payments a day (NULL = none)
  daily_amount_limit_paise  BIGINT UNSIGNED NULL,       -- amount a day (NULL = none)
  status                    ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  ended_reason              ENUM('EXPIRED','CANCELLED') NULL,
  credited_at               DATETIME(3)     NULL,
  credit_txn_id             BIGINT UNSIGNED NULL,
  expired_at                DATETIME(3)     NULL,
  expired_paise             BIGINT UNSIGNED NULL,       -- balance returned at expiry
  expiry_txn_id             BIGINT UNSIGNED NULL,
  cancel_reason             VARCHAR(200)    NULL,
  row_version               INT UNSIGNED    NOT NULL DEFAULT 1,
  created_by                BINARY(16)      NULL,
  created_at                DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at                DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_allowance_grants__public_id (public_id),
  KEY ix_allowance_grants__inst_status (institution_id, status, start_date),
  KEY ix_allowance_grants__inst_profile (institution_id, profile_id, status),
  KEY ix_allowance_grants__start (start_date, status),            -- the job's credit step
  KEY ix_allowance_grants__expiry (expiry_date, status),          -- the job's expiry step
  CONSTRAINT fk_allowance_grants__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_allowance_grants__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_allowance_grants__wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT ck_allowance_grants__amount CHECK (amount_paise > 0),
  CONSTRAINT ck_allowance_grants__dates CHECK (expiry_date > start_date),
  CONSTRAINT ck_allowance_grants__ended CHECK ((status = 'ACTIVE') = (ended_reason IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

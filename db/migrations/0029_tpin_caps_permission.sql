-- 0029_tpin_caps_permission.sql — forward-only migration (D-16). Phase 3.2: the member's daily
-- spending cap (6.13, FR-IDN-14, OI-IDN-15) and the transaction permission of an institution
-- profile (6.29, BR-13): the payment engine refuses a payer without it (V5). The transaction PIN
-- uses account_credentials (kind TPIN: Argon2id, wrong-attempt counter, lock, previous PIN).

ALTER TABLE member_profiles
  ADD COLUMN txn_permission          BOOLEAN      NOT NULL DEFAULT TRUE AFTER status_changed_at,
  ADD COLUMN txn_permission_reason   VARCHAR(300) NULL AFTER txn_permission,
  ADD COLUMN txn_permission_changed_at DATETIME(3) NULL AFTER txn_permission_reason;

CREATE TABLE spending_caps (
  account_id          BIGINT UNSIGNED NOT NULL,
  enabled             BOOLEAN         NOT NULL DEFAULT FALSE,
  daily_amount_paise  BIGINT UNSIGNED NULL,
  daily_count         SMALLINT UNSIGNED NULL,
  row_version         INT UNSIGNED    NOT NULL DEFAULT 1,
  updated_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (account_id),
  CONSTRAINT fk_spending_caps__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT ck_spending_caps__values CHECK (
    NOT enabled OR (daily_amount_paise > 0 AND daily_count > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

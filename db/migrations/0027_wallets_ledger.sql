-- 0027_wallets_ledger.sql — forward-only migration (D-16). Phase 3.1: wallets, balances, virtual
-- accounts and the double-entry ledger (docs/04 §3.3, §9.1; ADR-0004; RNG-GOV-015…017; RC-02).
--
-- - Every institution profile has a campus wallet (a merchant profile's is its merchant wallet) and
--   an allowance wallet. Numbers follow 27.4 (campus 9 digits from 555500001, allowance 15 digits
--   from 565656000000001), pending the bank (C-11, Q14 M12).
-- - A virtual account is the institution's corporate code + the campus wallet number.
-- - The ledger is append-only (triggers) and partitioned by month; each transaction's entries
--   balance; the idempotency guard lives in its own table because a partitioned table can't carry it.
-- - Only the ledger posts; balances change in the same transaction as the entries.

CREATE TABLE wallet_number_sequences (
  kind        ENUM('CAMPUS','ALLOWANCE','PERSONAL') NOT NULL,
  next_value  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE wallets (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          BINARY(16)      NOT NULL,
  institution_id     BIGINT UNSIGNED NULL,           -- NULL only for a personal wallet (Q16)
  wallet_no          VARCHAR(19)     NOT NULL,
  kind               ENUM('CAMPUS','ALLOWANCE','PERSONAL','MERCHANT') NOT NULL,
  owner_profile_id   BIGINT UNSIGNED NULL,
  owner_account_id   BIGINT UNSIGNED NULL,
  status             ENUM('ACTIVE','INACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',  -- RC-02
  status_reason      VARCHAR(300)    NULL,
  status_changed_at  DATETIME(3)     NULL,
  row_version        INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_wallets__public_id (public_id),
  UNIQUE KEY ux_wallets__wallet_no (wallet_no),
  UNIQUE KEY ux_wallets__owner_kind (institution_id, owner_profile_id, kind),
  KEY ix_wallets__account (owner_account_id),
  CONSTRAINT fk_wallets__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_wallets__profile FOREIGN KEY (owner_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_wallets__account FOREIGN KEY (owner_account_id) REFERENCES platform_accounts (id),
  CONSTRAINT ck_wallets__owner CHECK (
    (kind = 'PERSONAL' AND owner_account_id IS NOT NULL AND institution_id IS NULL)
    OR (kind <> 'PERSONAL' AND owner_profile_id IS NOT NULL AND institution_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE wallet_balances (
  wallet_id           BIGINT UNSIGNED NOT NULL,
  available_paise     BIGINT          NOT NULL DEFAULT 0,
  held_paise          BIGINT          NOT NULL DEFAULT 0,
  row_version         INT UNSIGNED    NOT NULL DEFAULT 1,
  last_ledger_txn_id  BIGINT UNSIGNED NULL,
  updated_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (wallet_id),
  CONSTRAINT fk_wallet_balances__wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT ck_wallet_balances__available CHECK (available_paise >= 0),
  CONSTRAINT ck_wallet_balances__held CHECK (held_paise >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE virtual_accounts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id  BIGINT UNSIGNED NOT NULL,
  wallet_id       BIGINT UNSIGNED NOT NULL,
  corporate_code  VARCHAR(8)      NOT NULL,
  va_number       VARCHAR(32)     NOT NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_virtual_accounts__va (va_number),
  UNIQUE KEY ux_virtual_accounts__wallet (wallet_id),
  KEY ix_virtual_accounts__inst (institution_id),
  CONSTRAINT fk_virtual_accounts__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_virtual_accounts__wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The chart of accounts: one account per wallet, plus the institution's own accounts.
CREATE TABLE ledger_accounts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id  BIGINT UNSIGNED NULL,
  kind            ENUM('WALLET','BANK_POOL','PAYOUT_CLEARING','PLATFORM_FEE','HELD_SUSPENSE',
                       'REFUND_CLEARING','CHARGEBACK_CLEARING','COUPON_REIMBURSEMENT','ADJUSTMENT') NOT NULL,
  wallet_id       BIGINT UNSIGNED NULL,
  name            VARCHAR(80)     NOT NULL,
  scope_key       VARCHAR(48) GENERATED ALWAYS AS (
    CONCAT(COALESCE(institution_id, 0), ':', kind, ':', COALESCE(wallet_id, 0))) STORED,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_ledger_accounts__scope (scope_key),
  UNIQUE KEY ux_ledger_accounts__wallet (wallet_id),
  CONSTRAINT fk_ledger_accounts__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_ledger_accounts__wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT ck_ledger_accounts__wallet CHECK ((kind = 'WALLET') = (wallet_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ledger_transactions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  posted_on          DATE            NOT NULL,      -- business date in India
  public_id          BINARY(16)      NOT NULL,
  institution_id     BIGINT UNSIGNED NULL,
  reference          CHAR(35)        NOT NULL,      -- 27.4: RPEP / RPET / RPAW … (pay.reference)
  type               ENUM('PAYMENT','TRANSFER','BANK_CREDIT','TUITION','ALLOWANCE_CREDIT','ALLOWANCE_PAYMENT',
                          'COUPON_REDEMPTION','EVENT','REFUND','REVERSAL','CHARGEBACK','SETTLEMENT_PAYOUT',
                          'PLATFORM_FEE','ADJUSTMENT','HOLD_RELEASE') NOT NULL,
  channel            VARCHAR(24)     NOT NULL,      -- registered channel code (no FK on partitioned tables)
  amount_paise       BIGINT UNSIGNED NOT NULL,
  idempotency_key    VARCHAR(100)    NOT NULL,
  business_ref_type  VARCHAR(40)     NULL,
  business_ref_id    BIGINT UNSIGNED NULL,
  reversal_of_txn_id BIGINT UNSIGNED NULL,
  narration          VARCHAR(140)    NULL,
  posted_at          DATETIME(3)     NOT NULL,
  actor_ref          BINARY(16)      NULL,
  correlation_id     BINARY(16)      NOT NULL,
  PRIMARY KEY (id, posted_on),
  UNIQUE KEY ux_ledger_txn__public_id (public_id, posted_on),
  UNIQUE KEY ux_ledger_txn__reference (reference, posted_on),
  KEY ix_ledger_txn__inst_posted (institution_id, posted_at),
  KEY ix_ledger_txn__inst_business (institution_id, business_ref_type, business_ref_id),
  CONSTRAINT ck_ledger_txn__amount CHECK (amount_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE COLUMNS (posted_on) (
  PARTITION p202610 VALUES LESS THAN ('2026-11-01'),
  PARTITION p202611 VALUES LESS THAN ('2026-12-01'),
  PARTITION p202612 VALUES LESS THAN ('2027-01-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
);

CREATE TABLE ledger_entries (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  posted_on           DATE            NOT NULL,
  institution_id      BIGINT UNSIGNED NULL,
  ledger_txn_id       BIGINT UNSIGNED NOT NULL,
  account_id          BIGINT UNSIGNED NOT NULL,
  wallet_id           BIGINT UNSIGNED NULL,
  direction           ENUM('D','C')   NOT NULL,
  amount_paise        BIGINT UNSIGNED NOT NULL,
  balance_after_paise BIGINT          NULL,
  narration           VARCHAR(140)    NULL,
  PRIMARY KEY (id, posted_on),
  KEY ix_ledger_entries__inst_wallet_posted_id (institution_id, wallet_id, posted_on, id),
  KEY ix_ledger_entries__wallet_id (wallet_id, id),
  KEY ix_ledger_entries__txn (ledger_txn_id),
  KEY ix_ledger_entries__account (account_id, posted_on),
  CONSTRAINT ck_ledger_entries__amount CHECK (amount_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE COLUMNS (posted_on) (
  PARTITION p202610 VALUES LESS THAN ('2026-11-01'),
  PARTITION p202611 VALUES LESS THAN ('2026-12-01'),
  PARTITION p202612 VALUES LESS THAN ('2027-01-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
);

CREATE TABLE ledger_idempotency (
  institution_id   BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- 0 for platform postings
  idempotency_key  VARCHAR(100)    NOT NULL,
  ledger_txn_id    BIGINT UNSIGNED NOT NULL,
  posted_on        DATE            NOT NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_ledger_txn__no_update BEFORE UPDATE ON ledger_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
CREATE TRIGGER trg_ledger_txn__no_delete BEFORE DELETE ON ledger_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
CREATE TRIGGER trg_ledger_entries__no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
CREATE TRIGGER trg_ledger_entries__no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
CREATE TRIGGER trg_ledger_idempotency__no_delete BEFORE DELETE ON ledger_idempotency FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_idempotency is append-only';

-- Wallets for the profiles that exist (27.4 numbering; allowance wallets start Inactive, RC-02).
INSERT INTO wallets (public_id, institution_id, wallet_no, kind, owner_profile_id, status)
SELECT UUID_TO_BIN(UUID()), p.institution_id,
       CAST(555500000 + ROW_NUMBER() OVER (ORDER BY p.id) AS CHAR),
       IF(ut.category = 'MERCHANT', 'MERCHANT', 'CAMPUS'), p.id,
       IF(p.status = 'ACTIVE', 'ACTIVE', IF(p.status = 'SUSPENDED', 'SUSPENDED', 'INACTIVE'))
FROM member_profiles p JOIN user_types ut ON ut.id = p.user_type_id;

INSERT INTO wallets (public_id, institution_id, wallet_no, kind, owner_profile_id, status)
SELECT UUID_TO_BIN(UUID()), p.institution_id,
       CAST(565656000000000 + ROW_NUMBER() OVER (ORDER BY p.id) AS CHAR), 'ALLOWANCE', p.id, 'INACTIVE'
FROM member_profiles p JOIN user_types ut ON ut.id = p.user_type_id
WHERE ut.category <> 'MERCHANT';

INSERT INTO wallet_number_sequences (kind, next_value)
SELECT 'CAMPUS', 555500001 + COUNT(*) FROM wallets WHERE kind IN ('CAMPUS', 'MERCHANT');
INSERT INTO wallet_number_sequences (kind, next_value)
SELECT 'ALLOWANCE', 565656000000001 + COUNT(*) FROM wallets WHERE kind = 'ALLOWANCE';
INSERT INTO wallet_number_sequences (kind, next_value) VALUES ('PERSONAL', 888888800000001);

INSERT INTO wallet_balances (wallet_id) SELECT id FROM wallets;
INSERT INTO ledger_accounts (institution_id, kind, wallet_id, name)
SELECT institution_id, 'WALLET', id, CONCAT('Wallet ', wallet_no) FROM wallets;

INSERT INTO virtual_accounts (institution_id, wallet_id, corporate_code, va_number)
SELECT w.institution_id, w.id, i.corporate_code, CONCAT(i.corporate_code, w.wallet_no)
FROM wallets w JOIN institutions i ON i.id = w.institution_id
WHERE w.kind IN ('CAMPUS', 'MERCHANT') AND i.corporate_code IS NOT NULL;

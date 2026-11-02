-- 0030_payments.sql — forward-only migration (D-16). Phase 3.3: merchants, their static QR codes,
-- dynamic QR / NFC payment requests and the payment engine's record (SRS 9.2–9.6, 9.11, 12.1–12.3;
-- docs/03 §8, docs/04 §3.4).
--
-- - A merchant is a member profile of a MERCHANT user type with one `merchants` row: display name,
--   sub-type, the 27.4 code MER…, the settlement bank account (encrypted, blind index, last 4) and the
--   channels it accepts. Its status is the profile's (RC-01); its wallet is opened by the profile
--   trigger (kind MERCHANT, 0028).
-- - A static QR code carries an opaque random token (printed on the counter card, so not a secret:
--   the payer still confirms with the PIN). A code is generated once per merchant and kind
--   (prototype c.merchants) and is Active or Inactive (OI-PAY-01: an Inactive code refuses
--   payments). A lost code is re-issued by the CampusOne operator (OQ-17), kept in `reissued_from_id`.
-- - A payment request (dynamic QR or NFC) is single-use and expires after `pay.request.ttlSeconds`
--   (120 s). Expiry is derived from `expires_at`, never stored (27.2); CANCELLED is RC-28.
-- - `payment_attempts` is the engine record (27.2 "Payment (engine record)"): written `PENDING`
--   after the pre-checks, then `SUCCESS` (ledger posted) or `FAILURE` with the failed validation
--   and its message code. A pre-check refusal writes none (RNG-PAY-123). UQ on the idempotency key
--   makes a retried payment return the first attempt. Not partitioned yet (about 4,000 payments a
--   day at the Q11 estimate); partitioning follows expand → migrate → contract when volume needs.

CREATE TABLE merchants (
  profile_id           BIGINT UNSIGNED  NOT NULL,
  institution_id       BIGINT UNSIGNED  NOT NULL,
  unique_id            VARCHAR(24)      NOT NULL,                  -- 27.4 §9: MER + 3 + 3 + 5-digit id + MMYY
  display_name         VARCHAR(50)      NOT NULL,
  sub_type             ENUM('REGULAR','VENDOR') NOT NULL DEFAULT 'REGULAR',
  holder_name          VARCHAR(120)     NULL,
  bank_name            VARCHAR(120)     NULL,
  acct_enc             VARBINARY(512)   NULL,                      -- ADR-0012 envelope ciphertext
  acct_bidx            BINARY(32)       NULL,
  acct_last4           CHAR(4)          NULL,
  ifsc                 CHAR(11)         NULL,
  cheque_file_id       BIGINT UNSIGNED  NULL,
  logo_file_id         BIGINT UNSIGNED  NULL,
  accepts_allowance    BOOLEAN          NOT NULL DEFAULT FALSE,    -- regular merchants only (27.2 sub-type)
  accepts_coupon       BOOLEAN          NOT NULL DEFAULT FALSE,
  dynamic_qr_enabled   BOOLEAN          NOT NULL DEFAULT FALSE,
  nfc_enabled          BOOLEAN          NOT NULL DEFAULT FALSE,
  is_fee_account       BOOLEAN          NOT NULL DEFAULT FALSE,    -- the institution's tuition-fee merchant
  row_version          INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by           BINARY(16)       NULL,
  created_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (profile_id),
  UNIQUE KEY ux_merchants__unique_id (institution_id, unique_id),
  KEY ix_merchants__inst_name (institution_id, display_name),
  KEY ix_merchants__bidx (acct_bidx),
  CONSTRAINT fk_merchants__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_merchants__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_merchants__cheque FOREIGN KEY (cheque_file_id) REFERENCES files (id),
  CONSTRAINT fk_merchants__logo FOREIGN KEY (logo_file_id) REFERENCES files (id),
  CONSTRAINT ck_merchants__ifsc CHECK (ifsc IS NULL OR ifsc REGEXP '^[A-Z]{4}0[A-Z0-9]{6}$'),
  CONSTRAINT ck_merchants__vendor CHECK (sub_type = 'REGULAR' OR (accepts_allowance = FALSE AND accepts_coupon = FALSE)),
  CONSTRAINT ck_merchants__bank CHECK ((acct_enc IS NULL) = (acct_bidx IS NULL) AND (acct_enc IS NULL) = (ifsc IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE merchant_qr_codes (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)       NOT NULL,
  institution_id       BIGINT UNSIGNED  NOT NULL,
  merchant_profile_id  BIGINT UNSIGNED  NOT NULL,
  kind                 ENUM('PAYMENT','ALLOWANCE','COUPON') NOT NULL,
  token                CHAR(26)         NOT NULL,                  -- random [A-Z2-7], the QR payload's code
  status               ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  status_reason        VARCHAR(300)     NULL,
  reissued_from_id     BIGINT UNSIGNED  NULL,
  created_by           BINARY(16)       NULL,
  created_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  status_changed_at    DATETIME(3)      NULL,
  row_version          INT UNSIGNED     NOT NULL DEFAULT 1,
  active_key           VARCHAR(40) GENERATED ALWAYS AS (
    IF(status = 'ACTIVE', CONCAT(merchant_profile_id, ':', kind), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_merchant_qr_codes__public_id (public_id),
  UNIQUE KEY ux_merchant_qr_codes__token (token),
  UNIQUE KEY ux_merchant_qr_codes__active (active_key),            -- one Active code per merchant and kind
  KEY ix_merchant_qr_codes__inst_merchant (institution_id, merchant_profile_id, kind),
  CONSTRAINT fk_merchant_qr_codes__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_merchant_qr_codes__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id),
  CONSTRAINT fk_merchant_qr_codes__reissued FOREIGN KEY (reissued_from_id) REFERENCES merchant_qr_codes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payment_requests (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)       NOT NULL,
  institution_id       BIGINT UNSIGNED  NOT NULL,
  merchant_profile_id  BIGINT UNSIGNED  NOT NULL,
  kind                 ENUM('DYNAMIC_QR','NFC') NOT NULL,
  instrument           ENUM('WALLET','ALLOWANCE') NOT NULL DEFAULT 'WALLET',
  amount_paise         BIGINT UNSIGNED  NOT NULL,
  token                CHAR(26)         NOT NULL,                  -- the dynamic QR payload's code
  nonce_hash           BINARY(32)       NULL,                      -- NFC: SHA-256 of the one-time nonce
  status               ENUM('PENDING','SUCCESS','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  expires_at           DATETIME(3)      NOT NULL,
  consumed_at          DATETIME(3)      NULL,
  payer_profile_id     BIGINT UNSIGNED  NULL,                      -- bound at redemption
  payment_attempt_id   BIGINT UNSIGNED  NULL,
  failure_code         VARCHAR(64)      NULL,
  created_by           BINARY(16)       NULL,
  created_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  row_version          INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_payment_requests__public_id (public_id),
  UNIQUE KEY ux_payment_requests__token (token),
  UNIQUE KEY ux_payment_requests__nonce (nonce_hash),
  KEY ix_payment_requests__inst_merchant (institution_id, merchant_profile_id, status, expires_at),
  CONSTRAINT fk_payment_requests__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_payment_requests__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id),
  CONSTRAINT fk_payment_requests__payer FOREIGN KEY (payer_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT ck_payment_requests__amount CHECK (amount_paise > 0),
  CONSTRAINT ck_payment_requests__nonce CHECK ((kind = 'NFC') = (nonce_hash IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payment_attempts (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)       NOT NULL,
  institution_id       BIGINT UNSIGNED  NOT NULL,
  reference            CHAR(35)         NOT NULL,                  -- RPEP… (RNG-PAY-128); the ledger's too
  channel              VARCHAR(24)      NOT NULL,                  -- PAYMENT_CHANNELS code
  mode                 TINYINT UNSIGNED NULL,                      -- legacy payment mode 1–8 (RNG-PAY-129)
  instrument           ENUM('WALLET','ALLOWANCE') NOT NULL DEFAULT 'WALLET',
  payer_profile_id     BIGINT UNSIGNED  NOT NULL,
  payee_profile_id     BIGINT UNSIGNED  NOT NULL,
  payer_wallet_id      BIGINT UNSIGNED  NULL,
  payee_wallet_id      BIGINT UNSIGNED  NULL,
  amount_paise         BIGINT UNSIGNED  NOT NULL,
  status               ENUM('PENDING','SUCCESS','FAILURE') NOT NULL DEFAULT 'PENDING',
  failed_check         VARCHAR(4)       NULL,                      -- V1…V13
  failure_code         VARCHAR(64)      NULL,                      -- the message key
  failure_params       JSON             NULL,
  remarks              VARCHAR(140)     NULL,
  qr_code_id           BIGINT UNSIGNED  NULL,
  request_id           BIGINT UNSIGNED  NULL,
  event_ref            VARCHAR(40)      NULL,
  order_ref            VARCHAR(40)      NULL,
  asset_ref            VARCHAR(40)      NULL,
  invoice_no           VARCHAR(40)      NULL,
  ledger_txn_id        BIGINT UNSIGNED  NULL,
  idempotency_key      VARCHAR(100)     NOT NULL,
  actor_ref            BINARY(16)       NULL,
  attempted_at         DATETIME(3)      NOT NULL,
  completed_at         DATETIME(3)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_payment_attempts__public_id (public_id),
  UNIQUE KEY ux_payment_attempts__reference (reference),
  UNIQUE KEY ux_payment_attempts__idem (institution_id, idempotency_key),
  KEY ix_payment_attempts__payer (institution_id, payer_profile_id, attempted_at),
  KEY ix_payment_attempts__payee (institution_id, payee_profile_id, attempted_at),
  KEY ix_payment_attempts__status (institution_id, status, attempted_at),
  KEY ix_payment_attempts__pending (payer_profile_id, status),     -- the pending guard (G4)
  KEY ix_payment_attempts__invoice (institution_id, payee_profile_id, invoice_no, status),
  CONSTRAINT fk_payment_attempts__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_payment_attempts__payer FOREIGN KEY (payer_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_payment_attempts__payee FOREIGN KEY (payee_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT ck_payment_attempts__amount CHECK (amount_paise > 0),
  CONSTRAINT ck_payment_attempts__failure CHECK ((status = 'FAILURE') = (failure_code IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE payment_requests
  ADD CONSTRAINT fk_payment_requests__attempt FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id);

-- A payment record is never deleted (RNG-GOV-015); its status moves forward only from PENDING.
CREATE TRIGGER trg_payment_attempts__no_delete BEFORE DELETE ON payment_attempts FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_attempts is append-only';
CREATE TRIGGER trg_payment_attempts__forward BEFORE UPDATE ON payment_attempts FOR EACH ROW
BEGIN
  IF OLD.status <> 'PENDING' OR OLD.amount_paise <> NEW.amount_paise
     OR OLD.payer_profile_id <> NEW.payer_profile_id OR OLD.payee_profile_id <> NEW.payee_profile_id
     OR OLD.reference <> NEW.reference THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_attempts: only a PENDING record may change status';
  END IF;
END;

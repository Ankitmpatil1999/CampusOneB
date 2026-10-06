-- 0010_personal_details.sql — forward-only migration (D-16). SRS 6.11 (Edit Profile), 6.38.5
-- (CR-06), 17 (maker-checker core); IDN-015…023; RNG-IDN-111…117, RNG-IDN-383…392.
-- One record of each kind per account (RNG-IDN-113). Bank account numbers are encrypted with a
-- blind index (ADR-0012). Identity fields change only through an approved correction request.

CREATE TABLE ref_income_bands (                     -- income categories (6.11; prototype bands)
  code         VARCHAR(24)  NOT NULL,
  label_key    VARCHAR(120) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order   SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ref_occupations (                      -- occupations (6.11)
  code         VARCHAR(24)  NOT NULL,
  label_key    VARCHAR(120) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order   SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ref_address_proof_types (              -- address-proof documents (6.11)
  code         VARCHAR(24)  NOT NULL,
  label_key    VARCHAR(120) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order   SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE ref_relations
  ADD COLUMN active     BOOLEAN           NOT NULL DEFAULT TRUE AFTER usage_scope,
  ADD COLUMN sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 100 AFTER active;

CREATE TABLE account_addresses (                    -- contact data, editable (OI-IDN-40)
  account_id      BIGINT UNSIGNED NOT NULL,
  line1           VARCHAR(200)    NOT NULL,
  line2           VARCHAR(200)    NULL,
  city            VARCHAR(80)     NOT NULL,
  state           VARCHAR(80)     NULL,
  pin_code        CHAR(6)         NOT NULL,
  proof_type      VARCHAR(24)     NOT NULL,
  proof_file_id   BIGINT UNSIGNED NOT NULL,
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (account_id),
  CONSTRAINT fk_account_addresses__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_account_addresses__proof_type FOREIGN KEY (proof_type) REFERENCES ref_address_proof_types (code),
  CONSTRAINT fk_account_addresses__file FOREIGN KEY (proof_file_id) REFERENCES files (id),
  CONSTRAINT ck_account_addresses__pin CHECK (pin_code REGEXP '^[0-9]{6}$')       -- 27.4 §5
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE account_bank_accounts (                -- personal-wallet bank account (6.11)
  account_id         BIGINT UNSIGNED NOT NULL,
  holder_name        VARCHAR(120)    NOT NULL,
  bank_name          VARCHAR(120)    NOT NULL,
  acct_enc           VARBINARY(512)  NOT NULL,      -- ADR-0012 envelope ciphertext
  acct_bidx          BINARY(32)      NOT NULL,
  acct_last4         CHAR(4)         NOT NULL,
  ifsc               CHAR(11)        NOT NULL,
  change_reason      VARCHAR(24)     NULL,          -- on replacement (6.11 "Account Update Reason")
  verified_at        DATETIME(3)     NULL,          -- set once the ₹1 check passed; NULL = not verified
  verification_ref   VARCHAR(60)     NULL,
  row_version        INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (account_id),
  KEY ix_account_bank_accounts__bidx (acct_bidx),
  CONSTRAINT fk_account_bank_accounts__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT ck_account_bank_accounts__ifsc CHECK (ifsc REGEXP '^[A-Z]{4}0[A-Z0-9]{6}$')   -- RNG-IDN-114
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE account_nominees (                     -- one nominee per account (RNG-IDN-113)
  account_id     BIGINT UNSIGNED  NOT NULL,
  name           VARCHAR(100)     NOT NULL,
  relation_code  VARCHAR(24)      NOT NULL,
  dob            DATE             NOT NULL,
  share_pct      TINYINT UNSIGNED NOT NULL DEFAULT 100,
  row_version    INT UNSIGNED     NOT NULL DEFAULT 1,
  created_at     DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at     DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (account_id),
  CONSTRAINT fk_account_nominees__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_account_nominees__relation FOREIGN KEY (relation_code) REFERENCES ref_relations (code),
  CONSTRAINT ck_account_nominees__share CHECK (share_pct BETWEEN 1 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE account_income (                       -- occupation and income category (6.11)
  account_id       BIGINT UNSIGNED NOT NULL,
  occupation_code  VARCHAR(24)     NOT NULL,
  band_code        VARCHAR(24)     NOT NULL,
  row_version      INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (account_id),
  CONSTRAINT fk_account_income__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_account_income__occupation FOREIGN KEY (occupation_code) REFERENCES ref_occupations (code),
  CONSTRAINT fk_account_income__band FOREIGN KEY (band_code) REFERENCES ref_income_bands (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE approval_requests (                    -- maker-checker core (section 17; docs/04 §3)
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          BINARY(16)      NOT NULL,
  institution_id     BIGINT UNSIGNED NULL,          -- NULL = platform-level (decided in the back office)
  module             VARCHAR(40)     NOT NULL,      -- RC-07 module names (PII_CORRECTION, …)
  action             ENUM('CREATE','UPDATE','DELETE') NOT NULL,
  summary            VARCHAR(300)    NOT NULL,
  payload            JSON            NOT NULL,      -- opaque; the effect handler re-validates
  maker_type         VARCHAR(20)     NOT NULL,      -- member | staff | operator
  maker_ref          BINARY(16)      NOT NULL,
  status             ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',  -- 27.2
  checker_ref        BINARY(16)      NULL,
  remarks            VARCHAR(500)    NULL,
  decided_at         DATETIME(3)     NULL,
  effect_error_code  VARCHAR(60)     NULL,
  row_version        INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_approval_requests__public_id (public_id),
  KEY ix_approval_requests__inst_status_module_created (institution_id, status, module, created_at),
  CONSTRAINT fk_approval_requests__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT ck_approval_requests__checker CHECK (checker_ref IS NULL OR checker_ref <> maker_ref)  -- maker ≠ checker
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pii_correction_requests (              -- CR-06 correction path (RNG-IDN-388…391)
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)      NOT NULL,
  account_id           BIGINT UNSIGNED NOT NULL,
  institution_id       BIGINT UNSIGNED NULL,        -- set for an institution profile's fields (2.5)
  field                ENUM('FULL_NAME','DOB','GENDER','PAN','ID_NUMBER') NOT NULL,
  current_masked       VARCHAR(160)    NOT NULL,    -- what the member saw (masked where personal)
  proposed_enc         VARBINARY(1024) NOT NULL,    -- the corrected value, encrypted (ADR-0012)
  reason               VARCHAR(300)    NOT NULL,
  evidence_file_id     BIGINT UNSIGNED NOT NULL,
  approval_request_id  BIGINT UNSIGNED NOT NULL,    -- the request's status is this one (RC-07)
  open_key             VARCHAR(40) GENERATED ALWAYS AS (IF(applied_at IS NULL AND closed_at IS NULL, CONCAT(account_id, ':', field), NULL)) STORED,
  applied_at           DATETIME(3)     NULL,
  closed_at            DATETIME(3)     NULL,        -- rejected
  created_at           DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_pii_correction_requests__public_id (public_id),
  UNIQUE KEY ux_pii_correction_requests__open (open_key),   -- one open request per field
  KEY ix_pii_correction_requests__account (account_id, created_at),
  CONSTRAINT fk_pcr__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_pcr__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pcr__evidence FOREIGN KEY (evidence_file_id) REFERENCES files (id),
  CONSTRAINT fk_pcr__approval FOREIGN KEY (approval_request_id) REFERENCES approval_requests (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Records are never deleted (CR-08, NFR-06): correction requests and approvals are permanent.
CREATE TRIGGER trg_pii_correction_requests__no_delete BEFORE DELETE ON pii_correction_requests
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pii_correction_requests is append-only';

CREATE TRIGGER trg_approval_requests__no_delete BEFORE DELETE ON approval_requests
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_requests are never deleted';

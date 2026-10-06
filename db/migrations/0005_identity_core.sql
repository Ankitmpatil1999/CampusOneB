-- 0005_identity_core.sql — forward-only migration (D-16). Source: docs/04 §3.2, ADR-0010/0011/0012.
-- Platform accounts and what signs them in: credentials, social identities, consents, devices,
-- sessions, refresh tokens and one-time codes. Status values are build-register codes (docs/01c).

CREATE TABLE platform_accounts (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id               BINARY(16)      NOT NULL,
  mobile                  CHAR(10)        NOT NULL,       -- BR-01 account key (sign-in id, not encrypted)
  email                   VARCHAR(254)    NULL,
  email_verified_at       DATETIME(3)     NULL,
  first_name              VARCHAR(60)     NOT NULL,
  middle_name             VARCHAR(60)     NULL,
  last_name               VARCHAR(60)     NULL,
  gender                  ENUM('MALE','FEMALE','OTHER') NULL,
  dob                     DATE            NULL,
  pan_enc                 VARBINARY(512)  NULL,           -- ADR-0012 envelope ciphertext
  pan_bidx                BINARY(32)      NULL,
  pan_last4               CHAR(4)         NULL,
  id_doc_type             VARCHAR(24)     NULL,
  id_doc_enc              VARBINARY(512)  NULL,
  id_doc_bidx             BINARY(32)      NULL,
  id_doc_last4            CHAR(4)         NULL,
  kyc_level               ENUM('MIN','FULL') NOT NULL DEFAULT 'MIN',                   -- 27.2 KYC display
  status                  ENUM('ACTIVE','DEACTIVATED') NOT NULL DEFAULT 'ACTIVE',     -- 27.2 platform account 1 / 0
  txn_permission          BOOLEAN         NOT NULL DEFAULT TRUE,                      -- 27.2 flag 1 / 0
  signin_lock             ENUM('UNLOCKED','LOCKED') NOT NULL DEFAULT 'UNLOCKED',      -- RC-03
  failed_signins          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until            DATETIME(3)     NULL,           -- member temporary lock-out (Q13)
  abandoned_code_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,   -- staff code challenges abandoned (RNG-IDN-380)
  preferred_lang          VARCHAR(8)      NOT NULL DEFAULT 'en',
  row_version             INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at              DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  created_by              BINARY(16)      NULL,
  updated_at              DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_by              BINARY(16)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_platform_accounts__public_id (public_id),
  UNIQUE KEY ux_platform_accounts__mobile (mobile),
  UNIQUE KEY ux_platform_accounts__email (email),
  UNIQUE KEY ux_platform_accounts__pan_bidx (pan_bidx),
  KEY ix_platform_accounts__status (status),
  CONSTRAINT ck_platform_accounts__mobile CHECK (mobile REGEXP '^[6-9][0-9]{9}$'),   -- 27.4 §5
  CONSTRAINT fk_platform_accounts__lang FOREIGN KEY (preferred_lang) REFERENCES languages (code),
  CONSTRAINT fk_platform_accounts__id_doc FOREIGN KEY (id_doc_type) REFERENCES ref_id_document_types (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE account_credentials (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id        BIGINT UNSIGNED NOT NULL,
  kind              ENUM('PASSWORD','TPIN','SECURITY_ANSWER') NOT NULL,
  hash              VARCHAR(255)    NOT NULL,       -- Argon2id encoded (parameters inside)
  question_code     VARCHAR(40)     NULL,           -- SECURITY_ANSWER only
  failed_attempts   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until      DATETIME(3)     NULL,
  previous_hash     VARCHAR(255)    NULL,           -- TPIN "not the previous PIN" rule (6.12)
  must_change       BOOLEAN         NOT NULL DEFAULT FALSE,   -- generated staff passwords (IDN-053)
  set_at            DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  row_version       INT UNSIGNED    NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_account_credentials__account_kind (account_id, kind),
  CONSTRAINT fk_account_credentials__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE social_identities (                    -- CR-03
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id        BIGINT UNSIGNED NOT NULL,
  provider          VARCHAR(30)     NOT NULL,
  subject_hash      BINARY(32)      NOT NULL,       -- HMAC of the provider subject (never the raw id)
  email             VARCHAR(254)    NULL,
  linked_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_social_identities__provider_subject (provider, subject_hash),
  KEY ix_social_identities__account (account_id),
  CONSTRAINT fk_social_identities__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE consents (                             -- 27.2 consent / terms record; append-only
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id        BIGINT UNSIGNED NOT NULL,
  kind              ENUM('TERMS','PRIVACY','DATA_PROCESSING','GUARDIAN') NOT NULL,
  version           VARCHAR(20)     NOT NULL,
  accepted_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  ip                VARBINARY(16)   NULL,
  device_id         BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_consents__account_kind (account_id, kind),
  CONSTRAINT fk_consents__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_consents__no_update BEFORE UPDATE ON consents FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';
CREATE TRIGGER trg_consents__no_delete BEFORE DELETE ON consents FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';

CREATE TABLE devices (                              -- 27.2 registered device 1 / 0
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id         BINARY(16)      NOT NULL,
  account_id        BIGINT UNSIGNED NOT NULL,
  install_id_hash   BINARY(32)      NOT NULL,
  model             VARCHAR(80)     NULL,
  os                VARCHAR(40)     NULL,
  app_version       VARCHAR(20)     NULL,
  risk_flags        SET('ROOT','EMULATOR','DEBUG') NOT NULL DEFAULT '',
  status            ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  active_key        BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'ACTIVE', account_id, NULL)) STORED,
  bound_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  inactivated_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_devices__public_id (public_id),
  UNIQUE KEY ux_devices__one_active (active_key),  -- one bound device per account (6.15)
  KEY ix_devices__account (account_id, status),
  CONSTRAINT fk_devices__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (                             -- 27.3 session: (none) → active → ended
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)      NOT NULL,
  account_id          BIGINT UNSIGNED NOT NULL,
  surface             ENUM('MEMBER','CONSOLE','OPS','PORTAL','TERMINAL') NOT NULL,
  institution_id      BIGINT UNSIGNED NULL,
  profile_id          BIGINT UNSIGNED NULL,       -- member profile (FK added with member_profiles)
  device_id           BIGINT UNSIGNED NULL,
  ip                  VARBINARY(16)   NULL,
  ua_hash             BINARY(32)      NULL,
  started_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  last_seen_at        DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  absolute_expires_at DATETIME(3)     NOT NULL,   -- SRS 6.35 / 27.4 §6 lifetime per surface
  ended_at            DATETIME(3)     NULL,
  end_reason          VARCHAR(40)     NULL,       -- SIGN_OUT, OTHER_DEVICE_LOGIN, REFRESH_REUSE, PASSWORD_CHANGED, …
  active_key          VARCHAR(40)     GENERATED ALWAYS AS (IF(ended_at IS NULL, CONCAT(account_id, ':', surface), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_sessions__public_id (public_id),
  UNIQUE KEY ux_sessions__one_active (active_key),   -- BR-05: one session per account per surface
  KEY ix_sessions__account_surface (account_id, surface, ended_at),
  CONSTRAINT fk_sessions__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_sessions__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_sessions__device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE refresh_tokens (                       -- RC-26 refresh token ACTIVE · ROTATED · REVOKED
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id          BIGINT UNSIGNED NOT NULL,
  family_id           BINARY(16)      NOT NULL,
  token_hash          BINARY(32)      NOT NULL,   -- SHA-256 of the opaque token
  status              ENUM('ACTIVE','ROTATED','REVOKED') NOT NULL DEFAULT 'ACTIVE',
  issued_at           DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at          DATETIME(3)     NOT NULL,   -- idle limit (staff surfaces) capped by the session
  rotated_at          DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_refresh_tokens__hash (token_hash),
  KEY ix_refresh_tokens__family (family_id, status),
  KEY ix_refresh_tokens__session (session_id, status),
  CONSTRAINT fk_refresh_tokens__session FOREIGN KEY (session_id) REFERENCES sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE otp_challenges (                       -- hashed one-time codes (golden rule)
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id         BINARY(16)      NOT NULL,
  account_id        BIGINT UNSIGNED NULL,
  purpose           ENUM('SIGNUP','DEVICE','CONSOLE_2FA','OPS_2FA','PORTAL_2FA','RECOVERY','TPIN_RESET','ADMISSION_RESUME','PORTAL_SIGNUP') NOT NULL,
  channel           ENUM('SMS','EMAIL') NOT NULL,
  destination_hash  BINARY(32)      NOT NULL,       -- blind index of the mobile / e-mail
  code_hash         BINARY(32)      NOT NULL,       -- HMAC of the code (never stored in clear)
  attempts          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts      TINYINT UNSIGNED NOT NULL,
  resends           TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_resends       TINYINT UNSIGNED NOT NULL,
  resend_after_at   DATETIME(3)     NOT NULL,
  expires_at        DATETIME(3)     NOT NULL,
  consumed_at       DATETIME(3)     NULL,           -- verified (RC-03 Verified)
  abandoned_at      DATETIME(3)     NULL,           -- wrong-code limit reached (RC-03 Abandoned)
  created_at        DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_otp_challenges__public_id (public_id),
  KEY ix_otp_challenges__destination (destination_hash, purpose, created_at),
  KEY ix_otp_challenges__expires (expires_at),
  CONSTRAINT fk_otp_challenges__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

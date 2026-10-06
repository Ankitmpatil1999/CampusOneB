-- 0033_terminals_cards.sql — forward-only migration (D-16). Phase 4.1: readers and POS terminals
-- (CR-10, SRS 6.38.8, 21.x; INS-030…034, IDN-040/041) and campus NFC cards (21.2–21.4; ATT-003…007,
-- ATT-024/025).
--
-- - A terminal belongs to one institution and has one purpose (RC-16: attendance, period attendance,
--   location, coupon, balance check, card issue; plus POS). The console issues a one-time pairing code
--   (stored hashed, 10 minutes); pairing binds the device fingerprint and issues a device secret,
--   stored encrypted, that signs every sign-in challenge. Disabling a terminal ends its sessions.
-- - Name, location and purpose changes are kept (captured records show the name in force).
-- - A card carries a server-generated token (27.4 `NFC…`, 16 characters) and the hardware UID; one
--   Active card per member. Inactive cards keep their token and reason (lost, damaged, stolen,
--   defective, expired — 27.2); a re-issue writes a new card and counts the re-issues.

CREATE TABLE terminals (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)       NOT NULL,
  institution_id       BIGINT UNSIGNED  NOT NULL,
  name                 VARCHAR(60)      NOT NULL,
  location             VARCHAR(100)     NULL,
  purpose              ENUM('ATTENDANCE','PERIOD_ATTENDANCE','LOCATION','COUPON','BALANCE_CHECK','CARD_ISSUE','POS') NOT NULL,
  merchant_profile_id  BIGINT UNSIGNED  NULL,                     -- coupon counter / POS: the merchant
  section_id           BIGINT UNSIGNED  NULL,                     -- period attendance: the class section
  location_type        VARCHAR(40)      NULL,                     -- location attendance: gate, library, …
  status               ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  status_reason        VARCHAR(300)     NULL,
  device_fingerprint   VARCHAR(128)     NULL,
  device_secret_enc    VARBINARY(512)   NULL,
  paired_at            DATETIME(3)      NULL,
  pairing_code_hash    BINARY(32)       NULL,
  pairing_expires_at   DATETIME(3)      NULL,
  last_seen_at         DATETIME(3)      NULL,
  row_version          INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by           BINARY(16)       NULL,
  created_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_terminals__public_id (public_id),
  UNIQUE KEY ux_terminals__pairing (pairing_code_hash),
  KEY ix_terminals__inst_purpose (institution_id, purpose, status),
  CONSTRAINT fk_terminals__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_terminals__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id),
  CONSTRAINT fk_terminals__section FOREIGN KEY (section_id) REFERENCES sections (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE terminal_changes (                       -- the name, location and purpose in force over time
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  terminal_id   BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(60)     NOT NULL,
  location      VARCHAR(100)    NULL,
  purpose       VARCHAR(20)     NOT NULL,
  changed_by    BINARY(16)      NULL,
  changed_at    DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY ix_terminal_changes__terminal (terminal_id, changed_at),
  CONSTRAINT fk_terminal_changes__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE terminal_nonces (                        -- a signed sign-in challenge is accepted once
  terminal_id   BIGINT UNSIGNED NOT NULL,
  nonce         VARCHAR(80)     NOT NULL,
  used_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (terminal_id, nonce),
  KEY ix_terminal_nonces__used (used_at),
  CONSTRAINT fk_terminal_nonces__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE cards (
  id                 BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id          BINARY(16)       NOT NULL,
  institution_id     BIGINT UNSIGNED  NOT NULL,
  profile_id         BIGINT UNSIGNED  NOT NULL,
  token              CHAR(16)         NOT NULL,                   -- NFC + 13 [A-Z0-9] (27.4)
  hardware_uid       VARCHAR(32)      NULL,
  status             ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  issue_reason       ENUM('NEW_REGISTRATION','LOST','DAMAGED','STOLEN','DEFECTIVE','EXPIRED') NOT NULL,
  reissue_count      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status_reason      VARCHAR(300)     NULL,
  blocked_at         DATETIME(3)      NULL,
  issued_by_terminal BIGINT UNSIGNED  NULL,
  issued_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  last_tap_at        DATETIME(3)      NULL,
  row_version        INT UNSIGNED     NOT NULL DEFAULT 1,
  active_key         VARCHAR(30) GENERATED ALWAYS AS (IF(status = 'ACTIVE', CAST(profile_id AS CHAR), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_cards__public_id (public_id),
  UNIQUE KEY ux_cards__token (token),
  UNIQUE KEY ux_cards__active (active_key),                        -- one Active card per member
  KEY ix_cards__inst_profile (institution_id, profile_id),
  KEY ix_cards__uid (hardware_uid),
  CONSTRAINT fk_cards__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_cards__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_cards__terminal FOREIGN KEY (issued_by_terminal) REFERENCES terminals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE card_writes (                            -- a re-issue authorised in the console (ATT-007)
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id  BIGINT UNSIGNED NOT NULL,
  profile_id      BIGINT UNSIGNED NOT NULL,
  reason          ENUM('LOST','DAMAGED','STOLEN','DEFECTIVE','EXPIRED') NOT NULL,
  code_hash       BINARY(32)      NOT NULL,
  expires_at      DATETIME(3)     NOT NULL,
  used_at         DATETIME(3)     NULL,
  created_by      BINARY(16)      NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_card_writes__code (code_hash),
  KEY ix_card_writes__profile (institution_id, profile_id, used_at),
  CONSTRAINT fk_card_writes__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_card_writes__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

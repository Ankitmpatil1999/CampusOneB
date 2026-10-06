-- 0002_reference_registers.sql — forward-only migration (D-16). Source: docs/04-data-model.md §9.
-- Status values are the upper-case codes of the build register (docs/01c).

CREATE TABLE ref_status_values (
  domain       VARCHAR(48)  NOT NULL,            -- e.g. 'wallet', 'member', 'settlement'
  code         VARCHAR(40)  NOT NULL,            -- stored value (must equal the ENUM value)
  label_key    VARCHAR(120) NOT NULL,            -- i18n key of the displayed label (RNG-GOV-011)
  tone         ENUM('ok','warn','bad','info','neutral','brand','violet','accent') NOT NULL,
  is_terminal  BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order   SMALLINT     NOT NULL DEFAULT 0,
  register_value VARCHAR(80) NULL,               -- the 27.2 stored value this code maps to (NULL for an RC addition)
  srs_ref      VARCHAR(160) NULL,                -- 27.2 domain name
  rc_ref       VARCHAR(8)   NULL,                -- register change that added the value (01c Part C)
  PRIMARY KEY (domain, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ref_status_transitions (
  domain       VARCHAR(48)  NOT NULL,
  from_code    VARCHAR(40)  NOT NULL,
  to_code      VARCHAR(40)  NOT NULL,
  operation    VARCHAR(200) NOT NULL,            -- the one path allowed to make the change (RNG-GOV-010)
  register_ref VARCHAR(160) NULL,                -- 27.3 domain name or register change
  PRIMARY KEY (domain, from_code, to_code),
  CONSTRAINT fk_rst_from FOREIGN KEY (domain, from_code) REFERENCES ref_status_values (domain, code),
  CONSTRAINT fk_rst_to   FOREIGN KEY (domain, to_code)   REFERENCES ref_status_values (domain, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ref_payment_channels (
  code         VARCHAR(24)  NOT NULL,            -- TRANSFER, STATIC_QR, ALLOWANCE, TUITION, POS_QR, DYNAMIC_QR, NFC, EVENT (+ POS_NFC per Q14 M7)
  legacy_mode  TINYINT UNSIGNED NULL,            -- payment mode number of RNG-PAY-129 (1–8; 9 pending)
  label_key    VARCHAR(120) NOT NULL,
  PRIMARY KEY (code),
  UNIQUE KEY ux_ref_payment_channels__legacy_mode (legacy_mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ref_id_document_types (
  code         VARCHAR(24)  NOT NULL,            -- AADHAAR, DRIVING_LICENCE, VOTER_ID, PASSPORT (OI-IDN-02)
  label_key    VARCHAR(120) NOT NULL,
  number_regex VARCHAR(200) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ref_relations (
  code         VARCHAR(24)  NOT NULL,            -- MOTHER, FATHER, GUARDIAN, SPOUSE, … (nominee and guardian relations, OI-IDN-13)
  label_key    VARCHAR(120) NOT NULL,
  usage_scope  SET('guardian','nominee','reference') NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE languages (
  code         VARCHAR(8)   NOT NULL,
  name         VARCHAR(40)  NOT NULL,
  native_name  VARCHAR(40)  NOT NULL,
  enabled      BOOLEAN      NOT NULL DEFAULT FALSE,
  is_default   BOOLEAN      NOT NULL DEFAULT FALSE,
  default_key  TINYINT GENERATED ALWAYS AS (IF(is_default, 1, NULL)) STORED,
  PRIMARY KEY (code),
  UNIQUE KEY ux_languages__default (default_key)   -- exactly one default
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

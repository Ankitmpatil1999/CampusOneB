-- 0007_member_signup.sql — forward-only migration (D-16). SRS 6.2, 6.3, 6.8; OI-IDN-02.
-- Masters the sign-up wizard needs (security questions, consent and terms texts), the
-- identity-document number rules, sign-in timestamps and a context binding on one-time codes.

CREATE TABLE ref_security_questions (               -- security-question master (6.2 Step 5, 6.8)
  code         VARCHAR(24)  NOT NULL,
  label_key    VARCHAR(120) NOT NULL,
  text_en      VARCHAR(200) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order   SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE consent_documents (                    -- consent and terms texts by version (RNG-IDN-017)
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind         ENUM('CONSENT','TERMS') NOT NULL,
  version      VARCHAR(20)  NOT NULL,
  title_en     VARCHAR(150) NOT NULL,
  body_en      TEXT         NOT NULL,
  is_draft     BOOLEAN      NOT NULL DEFAULT TRUE,  -- TRUE until the client supplies the final text
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  published_at DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_consent_documents__kind_version (kind, version),
  KEY ix_consent_documents__kind_active (kind, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE ref_id_document_types
  ADD COLUMN sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 100 AFTER active;

ALTER TABLE platform_accounts
  ADD COLUMN last_signin_at    DATETIME(3) NULL AFTER preferred_lang,
  ADD COLUMN current_signin_at DATETIME(3) NULL AFTER last_signin_at;

-- A one-time code may be bound to what it confirms (e.g. the device being bound): the request that
-- verifies the code must present the same context (hash only).
ALTER TABLE otp_challenges
  ADD COLUMN context_hash BINARY(32) NULL AFTER destination_hash;

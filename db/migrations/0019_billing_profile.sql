-- 0019_billing_profile.sql — forward-only migration (D-16). Phase 2.7: RingPe's own details printed
-- on GST invoices and shown to schools paying by bank transfer (docs/07 Q25, Q26). Until the client
-- supplies them, the reference seed writes clearly marked example values (`is_example`); operators
-- replace them in Plans & billing → Billing rules.

CREATE TABLE platform_billing_profile (
  id                 TINYINT UNSIGNED NOT NULL,       -- always 1 (one profile for the platform)
  legal_name         VARCHAR(120)     NOT NULL,
  gstin              CHAR(15)         NOT NULL,
  address            VARCHAR(300)     NOT NULL,
  state_code         CHAR(2)          NOT NULL,       -- GST state code of the supplier (place of supply)
  sac_code           VARCHAR(8)       NOT NULL,
  payee_name         VARCHAR(120)     NOT NULL,
  payee_bank         VARCHAR(80)      NOT NULL,
  payee_account_no   VARCHAR(20)      NOT NULL,
  payee_ifsc         CHAR(11)         NOT NULL,
  is_example         BOOLEAN          NOT NULL DEFAULT TRUE,
  row_version        INT UNSIGNED     NOT NULL DEFAULT 1,
  updated_at         DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_by         BINARY(16)       NULL,
  PRIMARY KEY (id),
  CONSTRAINT ck_platform_billing_profile__one CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 0014_institutions.sql — forward-only migration (D-16). Phase 2.4: institutions (SRS 7.2–7.5, 7.12.1;
-- FR-INS-01…06, FR-SAS-05/10/11; prototype o.institutions, o.features, c.institution, c.roles,
-- c.fields). Source: docs/04-data-model.md §3.1–3.2.

-- Registration takes name, address and city (prototype); the PIN code and office contacts are
-- completed from the console (OI-ONB-01). The state is not asked anywhere in the prototype.
ALTER TABLE institutions
  MODIFY state    VARCHAR(80) NULL,
  MODIFY pin_code CHAR(6)     NULL,
  ADD COLUMN office_phone            VARCHAR(15)     NULL AFTER pin_code,
  ADD COLUMN office_email            VARCHAR(254)    NULL AFTER office_phone,
  ADD COLUMN fee_merchant_profile_id BIGINT UNSIGNED NULL AFTER shadow_account_ref;   -- FR-INS-06 (INS-013)

CREATE TABLE institution_contacts (                  -- primary and secondary contact (FR-INS-01, FR-SAS-11)
  institution_id  BIGINT UNSIGNED NOT NULL,
  kind            ENUM('PRIMARY','SECONDARY') NOT NULL,
  name            VARCHAR(100)    NOT NULL,
  email           VARCHAR(254)    NULL,
  mobile_enc      VARBINARY(512)  NULL,            -- ADR-0012 envelope ciphertext
  mobile_last4    CHAR(4)         NULL,
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id, kind),
  CONSTRAINT fk_institution_contacts__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE institution_settings (                  -- 1:1 per institution (7.2, 7.5)
  institution_id           BIGINT UNSIGNED  NOT NULL,
  consent_validity_months  TINYINT UNSIGNED NOT NULL DEFAULT 3,   -- fee consent (OI-FEE-11)
  logo_file_id             BIGINT UNSIGNED  NULL,
  brand_color              CHAR(7)          NULL,                 -- #RRGGBB for public branding (INS-035)
  updated_at               DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id),
  CONSTRAINT ck_institution_settings__consent CHECK (consent_validity_months BETWEEN 1 AND 36),
  CONSTRAINT ck_institution_settings__color CHECK (brand_color IS NULL OR brand_color REGEXP '^#[0-9A-F]{6}$'),
  CONSTRAINT fk_institution_settings__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_institution_settings__logo FOREIGN KEY (logo_file_id) REFERENCES files (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE feature_toggles (                       -- 7.5 feature permissions (FR-INS-04, OI-ONB-08)
  institution_id  BIGINT UNSIGNED NOT NULL,
  feature_key     VARCHAR(30)     NOT NULL,        -- register: config/registers/institution.ts
  enabled         BOOLEAN         NOT NULL DEFAULT FALSE,
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id, feature_key),
  CONSTRAINT fk_feature_toggles__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE notification_channel_settings (         -- 7.5 channel switches (OI-ONB-09)
  institution_id  BIGINT UNSIGNED NOT NULL,
  channel         ENUM('IN_APP','EMAIL','SMS','WHATSAPP') NOT NULL,
  enabled         BOOLEAN         NOT NULL,
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id, channel),
  CONSTRAINT ck_notification_channel_settings__inapp CHECK (channel <> 'IN_APP' OR enabled),   -- always on
  CONSTRAINT fk_notification_channel_settings__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE feature_change_log (                    -- who, when, from → to, why (append-only, FR-INS-04)
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id  BIGINT UNSIGNED NOT NULL,
  feature_key     VARCHAR(30)     NOT NULL,        -- a feature, or channel.<CHANNEL>
  from_value      BOOLEAN         NOT NULL,
  to_value        BOOLEAN         NOT NULL,
  reason          VARCHAR(300)    NULL,
  actor_ref       BINARY(16)      NULL,            -- NULL = SYSTEM (dependency or plan change)
  changed_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY ix_feature_change_log__inst_changed (institution_id, changed_at),
  CONSTRAINT fk_feature_change_log__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_feature_change_log__no_update BEFORE UPDATE ON feature_change_log
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';
CREATE TRIGGER trg_feature_change_log__no_delete BEFORE DELETE ON feature_change_log
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';

CREATE TABLE onboarding_checklist_steps (            -- RC-10 Pending · Complete (a row = Complete)
  institution_id  BIGINT UNSIGNED NOT NULL,
  step_key        VARCHAR(20)     NOT NULL,        -- register: details, plan, bank, toggles, usertypes, year, feeacct, branding, firstusers
  done_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  done_by         BINARY(16)      NULL,            -- NULL = SYSTEM (completed by the step's own screen)
  note            VARCHAR(300)    NULL,
  PRIMARY KEY (institution_id, step_key),
  CONSTRAINT fk_onboarding_checklist_steps__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Plans (FR-SAS-05): the prototype's plans as draft data operators edit in 2.7 (prices: Q14 · M14).
CREATE TABLE plans (
  id            SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id     BINARY(16)        NOT NULL,
  code          VARCHAR(20)       NOT NULL,
  name          VARCHAR(60)       NOT NULL,
  description   VARCHAR(300)      NULL,
  cycle         ENUM('MONTHLY','ANNUAL') NOT NULL,
  price_paise   BIGINT UNSIGNED   NOT NULL,
  trial_days    SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  row_version   INT UNSIGNED      NOT NULL DEFAULT 1,
  created_at    DATETIME(3)       NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at    DATETIME(3)       NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_plans__public_id (public_id),
  UNIQUE KEY ux_plans__code (code),
  UNIQUE KEY ux_plans__name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE plan_modules (                          -- modules a plan entitles (feature locks, FR-SAS-05)
  plan_id     SMALLINT UNSIGNED NOT NULL,
  module_key  VARCHAR(30)       NOT NULL,
  PRIMARY KEY (plan_id, module_key),
  CONSTRAINT fk_plan_modules__plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE plan_allowances (                       -- members, messages and storage per plan
  plan_id        SMALLINT UNSIGNED NOT NULL,
  allowance_key  ENUM('MEMBERS','SMS','WHATSAPP','STORAGE_GB') NOT NULL,
  quantity       INT UNSIGNED      NOT NULL,
  PRIMARY KEY (plan_id, allowance_key),
  CONSTRAINT fk_plan_allowances__plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The institution's current plan. The subscription period (RC-09 Trial · Active · Grace …) starts
-- with plans and billing (2.7); until then `status` stays NULL ("no period yet").
CREATE TABLE subscriptions (
  institution_id           BIGINT UNSIGNED   NOT NULL,
  plan_id                  SMALLINT UNSIGNED NOT NULL,
  status                   ENUM('TRIAL','ACTIVE','GRACE','SUSPENDED','CANCELLED') NULL,
  trial_ends_on            DATE              NULL,
  current_period_start_on  DATE              NULL,
  current_period_end_on    DATE              NULL,
  renews_on                DATE              NULL,
  row_version              INT UNSIGNED      NOT NULL DEFAULT 1,
  created_at               DATETIME(3)       NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at               DATETIME(3)       NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id),
  KEY ix_subscriptions__plan (plan_id),
  CONSTRAINT fk_subscriptions__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_subscriptions__plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The lifecycle history is append-only (RNG-SAS-019).
CREATE TRIGGER trg_institution_lifecycle_events__no_update BEFORE UPDATE ON institution_lifecycle_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';
CREATE TRIGGER trg_institution_lifecycle_events__no_delete BEFORE DELETE ON institution_lifecycle_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';

-- Departments of a user type (7.3, FR-INS-03, OI-ONB-04).
CREATE TABLE departments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  user_type_id    BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(60)     NOT NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_departments__public_id (public_id),
  UNIQUE KEY ux_departments__inst_type_name (institution_id, user_type_id, name),
  KEY ix_departments__user_type (user_type_id),
  CONSTRAINT fk_departments__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_departments__user_type FOREIGN KEY (user_type_id) REFERENCES user_types (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE member_profiles
  ADD COLUMN department_id BIGINT UNSIGNED NULL AFTER user_type_id,
  ADD KEY ix_member_profiles__department (department_id),
  ADD CONSTRAINT fk_member_profiles__department FOREIGN KEY (department_id) REFERENCES departments (id);

ALTER TABLE institutions
  ADD CONSTRAINT fk_institutions__fee_merchant FOREIGN KEY (fee_merchant_profile_id) REFERENCES member_profiles (id);

ALTER TABLE user_types ADD COLUMN created_by BINARY(16) NULL AFTER status;

-- Institution-defined fields (CR-12, RNG-ONB-101…115; prototype c.fields; OI-ONB-14/15/16).
CREATE TABLE custom_field_definitions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,        -- the immutable reference (RNG-ONB-103)
  institution_id  BIGINT UNSIGNED NOT NULL,
  entity          ENUM('MEMBER','FEE_STRUCTURE','ADMISSION_APPLICATION','MERCHANT') NOT NULL,
  label           VARCHAR(40)     NOT NULL,
  data_type       ENUM('TEXT','LONG_TEXT','NUMBER','DATE','DROPDOWN','MULTI_SELECT','YES_NO','EMAIL','PHONE') NOT NULL,
  is_required     BOOLEAN         NOT NULL DEFAULT FALSE,
  is_unique       BOOLEAN         NOT NULL DEFAULT FALSE,
  list_column     BOOLEAN         NOT NULL DEFAULT FALSE,
  filterable      BOOLEAN         NOT NULL DEFAULT FALSE,
  position        SMALLINT UNSIGNED NOT NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',     -- RC-11
  no_id_doc_ack_at DATETIME(3)    NOT NULL,         -- RNG-ONB-114 acknowledgement
  deactivated_at  DATETIME(3)     NULL,
  created_by      BINARY(16)      NULL,
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_custom_field_definitions__public_id (public_id),
  UNIQUE KEY ux_custom_field_definitions__inst_entity_label (institution_id, entity, label),
  KEY ix_custom_field_definitions__inst_entity_status (institution_id, entity, status, position),
  CONSTRAINT ck_custom_field_definitions__filter CHECK (NOT filterable OR data_type IN ('DROPDOWN','MULTI_SELECT','YES_NO')),
  CONSTRAINT ck_custom_field_definitions__unique CHECK (NOT is_unique OR data_type NOT IN ('YES_NO','MULTI_SELECT')),
  CONSTRAINT fk_custom_field_definitions__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE custom_field_options (                  -- options of a Dropdown / Multi-select field (RNG-ONB-105)
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id  BIGINT UNSIGNED NOT NULL,
  field_id        BIGINT UNSIGNED NOT NULL,
  label           VARCHAR(60)     NOT NULL,
  position        SMALLINT UNSIGNED NOT NULL,
  active          BOOLEAN         NOT NULL DEFAULT TRUE,   -- a removed option keeps captured values
  PRIMARY KEY (id),
  UNIQUE KEY ux_custom_field_options__field_label (field_id, label),
  KEY ix_custom_field_options__inst_field (institution_id, field_id),
  CONSTRAINT fk_custom_field_options__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_custom_field_options__field FOREIGN KEY (field_id) REFERENCES custom_field_definitions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE custom_field_values (                   -- values captured on the entity forms (filled from 2.5)
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id  BIGINT UNSIGNED NOT NULL,
  field_id        BIGINT UNSIGNED NOT NULL,
  entity_ref      BINARY(16)      NOT NULL,        -- public id of the member, fee structure, application or merchant
  value_text      VARCHAR(2000)   NULL,
  value_number    DECIMAL(20,6)   NULL,
  value_date      DATE            NULL,
  value_bool      BOOLEAN         NULL,
  unique_key      VARCHAR(255)    NULL,            -- normalised value when the field is unique
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_custom_field_values__inst_field_entity (institution_id, field_id, entity_ref),
  UNIQUE KEY ux_custom_field_values__unique (institution_id, field_id, unique_key),
  KEY ix_custom_field_values__field (field_id),
  CONSTRAINT fk_custom_field_values__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_custom_field_values__field FOREIGN KEY (field_id) REFERENCES custom_field_definitions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE custom_field_value_options (            -- selected options of a Dropdown / Multi-select value
  value_id   BIGINT UNSIGNED NOT NULL,
  option_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (value_id, option_id),
  CONSTRAINT fk_custom_field_value_options__value FOREIGN KEY (value_id) REFERENCES custom_field_values (id),
  CONSTRAINT fk_custom_field_value_options__option FOREIGN KEY (option_id) REFERENCES custom_field_options (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

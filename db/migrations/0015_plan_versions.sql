-- 0015_plan_versions.sql — forward-only migration (D-16). Phase 2.7: plans that operators add and change
-- (FR-SAS-05; SAS-027…029; prototype o.plans; client 2026-10-03 "give a provision to change and add
-- the plans"). Expand + migrate: every change to a plan's terms is a new version; a subscription keeps
-- its version until renewal ("changes apply from each institution's next renewal"). 0016 contracts.

CREATE TABLE plan_versions (                         -- the terms of a plan at one version (append-only)
  id                   INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  plan_id              SMALLINT UNSIGNED NOT NULL,
  version              SMALLINT UNSIGNED NOT NULL,
  cycle                ENUM('MONTHLY','ANNUAL') NOT NULL,
  price_paise          BIGINT UNSIGNED   NOT NULL,
  trial_days           SMALLINT UNSIGNED NOT NULL,
  members              INT UNSIGNED      NOT NULL,   -- usage allowances
  sms_per_month        INT UNSIGNED      NOT NULL,
  whatsapp_per_month   INT UNSIGNED      NOT NULL,
  storage_gb           INT UNSIGNED      NOT NULL,
  fee_flat_paise       BIGINT UNSIGNED   NOT NULL,   -- platform fee on merchant transactions (BR-17, OQ-06):
  fee_threshold_paise  BIGINT UNSIGNED   NOT NULL,   --   flat fee up to and including the threshold,
  fee_percent_bp       SMALLINT UNSIGNED NOT NULL,   --   percentage (basis points, 50 = 0.5 %) above it
  created_at           DATETIME(3)       NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  created_by           BINARY(16)        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_plan_versions__plan_version (plan_id, version),
  CONSTRAINT ck_plan_versions__price CHECK (price_paise > 0),
  CONSTRAINT ck_plan_versions__fee CHECK (fee_percent_bp <= 500 AND fee_threshold_paise > 0),
  CONSTRAINT fk_plan_versions__plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_plan_versions__no_update BEFORE UPDATE ON plan_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'plan_versions is append-only';
CREATE TRIGGER trg_plan_versions__no_delete BEFORE DELETE ON plan_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'plan_versions is append-only';

CREATE TABLE plan_version_modules (                  -- modules a version entitles (feature locks)
  plan_version_id  INT UNSIGNED NOT NULL,
  module_key       VARCHAR(30)  NOT NULL,
  PRIMARY KEY (plan_version_id, module_key),
  CONSTRAINT fk_plan_version_modules__version FOREIGN KEY (plan_version_id) REFERENCES plan_versions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE plans
  ADD COLUMN current_version_id INT UNSIGNED NULL AFTER description,
  ADD COLUMN created_by BINARY(16) NULL AFTER row_version,
  ADD CONSTRAINT fk_plans__current_version FOREIGN KEY (current_version_id) REFERENCES plan_versions (id);

ALTER TABLE subscriptions
  ADD COLUMN plan_version_id INT UNSIGNED NULL AFTER plan_id,
  ADD CONSTRAINT fk_subscriptions__plan_version FOREIGN KEY (plan_version_id) REFERENCES plan_versions (id);

-- Migrate: today's terms become version 1 with the default platform fee (₹1.00 up to ₹100, else 0.5 %).
INSERT INTO plan_versions (plan_id, version, cycle, price_paise, trial_days, members, sms_per_month,
                           whatsapp_per_month, storage_gb, fee_flat_paise, fee_threshold_paise, fee_percent_bp)
SELECT p.id, 1, p.cycle, p.price_paise, p.trial_days,
       COALESCE((SELECT a.quantity FROM plan_allowances a WHERE a.plan_id = p.id AND a.allowance_key = 'MEMBERS'), 0),
       COALESCE((SELECT a.quantity FROM plan_allowances a WHERE a.plan_id = p.id AND a.allowance_key = 'SMS'), 0),
       COALESCE((SELECT a.quantity FROM plan_allowances a WHERE a.plan_id = p.id AND a.allowance_key = 'WHATSAPP'), 0),
       COALESCE((SELECT a.quantity FROM plan_allowances a WHERE a.plan_id = p.id AND a.allowance_key = 'STORAGE_GB'), 0),
       100, 10000, 50
  FROM plans p;

INSERT INTO plan_version_modules (plan_version_id, module_key)
SELECT v.id, m.module_key FROM plan_modules m JOIN plan_versions v ON v.plan_id = m.plan_id AND v.version = 1;

UPDATE plans p JOIN plan_versions v ON v.plan_id = p.id AND v.version = 1 SET p.current_version_id = v.id;
UPDATE subscriptions s JOIN plans p ON p.id = s.plan_id SET s.plan_version_id = p.current_version_id;

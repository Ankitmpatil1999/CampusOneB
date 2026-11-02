-- 0065_payment_gateways.sql — forward-only migration (D-16). Client request 2026-10-09.
-- Each school collects online with its own payment gateway account, and may have several. The
-- Institution Administrator and the Accountant add them in the console (task "gateways"). Every
-- credential is stored encrypted at field level (AES-256-GCM, envelope keys; purpose pg_*, the
-- gateway's public id as associated data) and never returned; only a masked hint of the key id is
-- readable. One active gateway per school is the default for new payments. A payment keeps the
-- gateway it was taken with, so its verification and webhook use that gateway's keys.

CREATE TABLE institution_payment_gateways (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  provider            VARCHAR(20)      NOT NULL,      -- register PAYMENT_GATEWAY_PROVIDERS (RAZORPAY)
  label               VARCHAR(80)      NOT NULL,      -- e.g. "School fees account"
  key_id_enc          VARBINARY(512)   NOT NULL,      -- encrypted (pg_key_id)
  key_secret_enc      VARBINARY(512)   NOT NULL,      -- encrypted (pg_key_secret)
  webhook_secret_enc  VARBINARY(512)   NULL,          -- encrypted (pg_webhook_secret)
  merchant_id_enc     VARBINARY(512)   NULL,          -- encrypted (pg_merchant_id)
  key_id_hint         VARCHAR(24)      NOT NULL,      -- masked for display, e.g. rzp_test_••••eK0
  environment         ENUM('TEST','LIVE') NOT NULL,   -- from the key id (rzp_test_ / rzp_live_)
  status              ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  is_default          BOOLEAN          NOT NULL DEFAULT FALSE,
  default_key         BIGINT UNSIGNED  GENERATED ALWAYS AS (IF(is_default AND status = 'ACTIVE', institution_id, NULL)) STORED,
  last_checked_at     DATETIME(3)      NULL,          -- the last credential check
  last_check_ok       BOOLEAN          NULL,
  last_check_note     VARCHAR(200)     NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by          BINARY(16)       NULL,
  updated_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_institution_payment_gateways__public (public_id),
  UNIQUE KEY ux_institution_payment_gateways__default (default_key),  -- one default per school
  KEY ix_institution_payment_gateways__inst (institution_id, status),
  CONSTRAINT fk_institution_payment_gateways__inst FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The gateway a payment was taken with (NULL: CampusOne's own gateway, or the test checkout).
ALTER TABLE admission_payments
  ADD COLUMN gateway_id BIGINT UNSIGNED NULL AFTER gateway_payment_id,
  ADD CONSTRAINT fk_admission_payments__gateway FOREIGN KEY (gateway_id) REFERENCES institution_payment_gateways (id);

-- The console task (config/registers/access.ts) and its grant to the existing Institution
-- Administrator and Accountant roles; the reference seed keeps the labels and order current.
INSERT INTO tasks (scope, code, label_key, sort_order)
VALUES ('INSTITUTION', 'gateways', 'task.institution.gateways', 0)
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);
INSERT INTO sub_tasks (task_id, code, label_key, view_only)
SELECT id, 'gateways.view', 'subtask.institution.gateways.view', TRUE FROM tasks
 WHERE scope = 'INSTITUTION' AND code = 'gateways'
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);
INSERT INTO sub_tasks (task_id, code, label_key, view_only)
SELECT id, 'gateways.edit', 'subtask.institution.gateways.edit', FALSE FROM tasks
 WHERE scope = 'INSTITUTION' AND code = 'gateways'
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);
INSERT INTO role_task_assignments (role_id, task_id)
SELECT r.id, t.id FROM roles r JOIN tasks t ON t.scope = 'INSTITUTION' AND t.code = 'gateways'
 WHERE r.code IN ('INSTITUTION_ADMIN', 'ACCOUNTANT') AND r.grants_seeded = TRUE
ON DUPLICATE KEY UPDATE role_task_assignments.task_id = role_task_assignments.task_id;
INSERT INTO role_tasks (role_id, sub_task_id)
SELECT r.id, st.id FROM roles r
  JOIN tasks t ON t.scope = 'INSTITUTION' AND t.code = 'gateways'
  JOIN sub_tasks st ON st.task_id = t.id
 WHERE r.code IN ('INSTITUTION_ADMIN', 'ACCOUNTANT') AND r.grants_seeded = TRUE
ON DUPLICATE KEY UPDATE role_tasks.sub_task_id = role_tasks.sub_task_id;

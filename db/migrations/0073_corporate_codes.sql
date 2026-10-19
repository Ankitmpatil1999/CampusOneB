-- 0073_corporate_codes.sql — forward-only migration (D-16). Client instruction 2026-10-13/14: a school
-- can have several corporate codes (one per bank account it collects into: Axis, SBI, …), each with
-- its bank name and IFSC, and its classes map to them (e.g. Nursery–9th → the Axis code, 10th–12th →
-- the SBI code). One code is the school's default, for everyone a class mapping doesn't cover.
--
-- A wallet's VAN is not stored: it is the code of the owner's class (this academic year) — or the
-- default — followed by the wallet number, put together when shown and when a bank pays
-- (services/vans.ts). `virtual_accounts` is no longer read (expand → migrate → contract: dropped later).
--
-- Each school's existing code becomes its first code and its default, so the VANs parents already
-- have stay the same until classes are mapped. Bank name and IFSC are filled in later.

CREATE TABLE institution_corporate_codes (
  id                BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id         BINARY(16)       NOT NULL,
  institution_id    BIGINT UNSIGNED  NOT NULL,
  bank_name         VARCHAR(100)     NULL,          -- e.g. Axis Bank (filled later for carried-over codes)
  ifsc              CHAR(11)         NULL,
  corporate_code    VARCHAR(10)      NOT NULL,      -- allotted by the bank; up to ins.corporateCode.maxLength
  pool_account_ref  VARCHAR(40)      NULL,          -- the school's account the bank pools the money into
  status            ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  is_default        BOOLEAN          NOT NULL DEFAULT FALSE,
  default_key       BIGINT UNSIGNED  GENERATED ALWAYS AS (IF(is_default, institution_id, NULL)) STORED,
  row_version       INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by        BINARY(16)       NULL,
  updated_by        BINARY(16)       NULL,
  created_at        DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at        DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_institution_corporate_codes__public (public_id),
  UNIQUE KEY ux_institution_corporate_codes__code (corporate_code),   -- a VAN names one code
  UNIQUE KEY ux_institution_corporate_codes__default (default_key),   -- one default per school
  KEY ix_institution_corporate_codes__inst (institution_id, status),
  CONSTRAINT fk_institution_corporate_codes__inst FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Whole classes (all their sections) map to one of the school's codes; an unmapped class uses the default.
CREATE TABLE class_corporate_codes (
  class_id           BIGINT UNSIGNED NOT NULL,
  institution_id     BIGINT UNSIGNED NOT NULL,
  corporate_code_id  BIGINT UNSIGNED NOT NULL,
  updated_by         BINARY(16)      NULL,
  updated_at         DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (class_id),
  KEY ix_class_corporate_codes__inst_code (institution_id, corporate_code_id),
  CONSTRAINT fk_class_corporate_codes__class FOREIGN KEY (class_id) REFERENCES classes (id),
  CONSTRAINT fk_class_corporate_codes__code FOREIGN KEY (corporate_code_id)
    REFERENCES institution_corporate_codes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The code each bank credit came in on (settlement and reconciliation per bank).
ALTER TABLE bank_credits
  ADD COLUMN corporate_code_id BIGINT UNSIGNED NULL AFTER va_number,
  ADD CONSTRAINT fk_bank_credits__corporate_code FOREIGN KEY (corporate_code_id)
    REFERENCES institution_corporate_codes (id);

-- Each school's existing code: its first code and its default.
INSERT INTO institution_corporate_codes (public_id, institution_id, corporate_code, pool_account_ref, is_default)
SELECT UUID_TO_BIN(UUID()), id, corporate_code, pool_account_ref, TRUE
  FROM institutions WHERE corporate_code IS NOT NULL;

-- The console task (config/registers/access.ts) and its grant to the existing Institution
-- Administrator roles; the reference seed keeps the labels and order current.
INSERT INTO tasks (scope, code, label_key, sort_order)
VALUES ('INSTITUTION', 'corpcodes', 'task.institution.corpcodes', 0)
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);
INSERT INTO sub_tasks (task_id, code, label_key, view_only)
SELECT id, 'corpcodes.view', 'subtask.institution.corpcodes.view', TRUE FROM tasks
 WHERE scope = 'INSTITUTION' AND code = 'corpcodes'
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);
INSERT INTO sub_tasks (task_id, code, label_key, view_only)
SELECT id, 'corpcodes.edit', 'subtask.institution.corpcodes.edit', FALSE FROM tasks
 WHERE scope = 'INSTITUTION' AND code = 'corpcodes'
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);
INSERT INTO role_task_assignments (role_id, task_id)
SELECT r.id, t.id FROM roles r JOIN tasks t ON t.scope = 'INSTITUTION' AND t.code = 'corpcodes'
 WHERE r.code = 'INSTITUTION_ADMIN' AND r.grants_seeded = TRUE
ON DUPLICATE KEY UPDATE role_task_assignments.task_id = role_task_assignments.task_id;
INSERT INTO role_tasks (role_id, sub_task_id)
SELECT r.id, st.id FROM roles r
  JOIN tasks t ON t.scope = 'INSTITUTION' AND t.code = 'corpcodes'
  JOIN sub_tasks st ON st.task_id = t.id
 WHERE r.code = 'INSTITUTION_ADMIN' AND r.grants_seeded = TRUE
ON DUPLICATE KEY UPDATE role_tasks.sub_task_id = role_tasks.sub_task_id;

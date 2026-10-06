-- 0013_role_tasks_and_changes.sql — forward-only migration (D-16). Phase 2.3: roles screen
-- (prototype o.roles; SRS 6.28, RNG-GOV-001/032, OI-GOV-01).
--
-- A role is assigned tasks (they open menu pages) and granted sub-tasks inside them (every action
-- checks its sub-task). Operator tasks move to the prototype's tasks (OPTASKS); the operator rows
-- seeded by 0012 are reference data and are re-seeded right after this migration.

CREATE TABLE role_task_assignments (                -- tasks assigned to a role (menus)
  role_id  BIGINT UNSIGNED   NOT NULL,
  task_id  SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, task_id),
  KEY ix_role_task_assignments__task (task_id),
  CONSTRAINT fk_role_task_assignments__role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_task_assignments__task FOREIGN KEY (task_id) REFERENCES tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE role_change_log (                      -- the roles screen's change record (append-only)
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)      NOT NULL,
  actor_account_id     BIGINT UNSIGNED NOT NULL,
  role_id              BIGINT UNSIGNED NULL,
  operator_account_id  BIGINT UNSIGNED NULL,
  change_text          VARCHAR(300)    NOT NULL,
  reason               VARCHAR(300)    NOT NULL,
  created_at           DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_role_change_log__public_id (public_id),
  KEY ix_role_change_log__created (created_at),
  CONSTRAINT fk_role_change_log__actor FOREIGN KEY (actor_account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_role_change_log__role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_change_log__operator FOREIGN KEY (operator_account_id) REFERENCES operator_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_role_change_log__no_update BEFORE UPDATE ON role_change_log
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_change_log is append-only';
CREATE TRIGGER trg_role_change_log__no_delete BEFORE DELETE ON role_change_log
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_change_log is append-only';

ALTER TABLE sub_tasks ADD COLUMN label_key VARCHAR(100) NULL AFTER code;
ALTER TABLE roles
  ADD COLUMN description VARCHAR(160) NULL AFTER name,
  ADD COLUMN grants_seeded BOOLEAN NOT NULL DEFAULT FALSE AFTER read_only;   -- a re-seed never re-grants what an operator removed

ALTER TABLE operator_accounts
  ADD COLUMN status_note VARCHAR(200) NULL AFTER status;

-- Operator tasks re-seeded from the prototype's catalogue.
DELETE rt FROM role_tasks rt
  JOIN sub_tasks st ON st.id = rt.sub_task_id
  JOIN tasks t ON t.id = st.task_id
  WHERE t.scope = 'OPERATOR';
DELETE st FROM sub_tasks st JOIN tasks t ON t.id = st.task_id WHERE t.scope = 'OPERATOR';
DELETE FROM tasks WHERE scope = 'OPERATOR';

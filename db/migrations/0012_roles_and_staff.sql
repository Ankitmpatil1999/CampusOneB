-- 0012_roles_and_staff.sql — forward-only migration (D-16). Phase 2.3: staff sign-in, roles and tasks.
-- SRS 6.4 (console sign-in), 6.28 (roles → tasks → sub-tasks), 6.38.4 (CR-05 second factor);
-- docs/04 §3.2; docs/01 §6 (catalogue). Institution profiles start here with the columns sign-in
-- needs; members (2.5) extends them.

CREATE TABLE tasks (                                -- 6.28 task catalogue, per scope
  id          SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope       ENUM('INSTITUTION','OPERATOR') NOT NULL,
  code        VARCHAR(24)     NOT NULL,             -- e.g. members, settle
  label_key   VARCHAR(80)     NOT NULL,
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY ux_tasks__scope_code (scope, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sub_tasks (                            -- what the server checks on every route
  id          SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id     SMALLINT UNSIGNED NOT NULL,
  code        VARCHAR(48)     NOT NULL,             -- task.subtask, e.g. members.view
  view_only   BOOLEAN         NOT NULL DEFAULT FALSE, -- a *.view grant (Management is read-only, C-03)
  PRIMARY KEY (id),
  UNIQUE KEY ux_sub_tasks__task_code (task_id, code),
  CONSTRAINT fk_sub_tasks__task FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT ck_sub_tasks__code CHECK (code REGEXP '^[a-z0-9-]+[.][a-z0-9-]+$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE roles (                                -- institution role templates and operator roles
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NULL,             -- NULL = platform template / operator role
  scope           ENUM('INSTITUTION','OPERATOR') NOT NULL,
  code            VARCHAR(40)     NULL,             -- seeded roles (INSTITUTION_ADMIN, PLATFORM_ADMIN …)
  name            VARCHAR(80)     NOT NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  read_only       BOOLEAN         NOT NULL DEFAULT FALSE,   -- Management (C-03)
  inst_key        BIGINT UNSIGNED AS (IFNULL(institution_id, 0)) STORED,
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_roles__public_id (public_id),
  UNIQUE KEY ux_roles__scope_inst_name (scope, inst_key, name),
  UNIQUE KEY ux_roles__code (code),
  CONSTRAINT fk_roles__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT ck_roles__operator_platform CHECK (scope = 'INSTITUTION' OR institution_id IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE role_tasks (                           -- role → sub-task grants
  role_id      BIGINT UNSIGNED   NOT NULL,
  sub_task_id  SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, sub_task_id),
  KEY ix_role_tasks__sub_task (sub_task_id),
  CONSTRAINT fk_role_tasks__role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_tasks__sub_task FOREIGN KEY (sub_task_id) REFERENCES sub_tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_types (                           -- 6.16 user types per institution (OI-ONB-04)
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(60)     NOT NULL,
  category        ENUM('STUDENT','PARENT','TEACHER','STAFF','MERCHANT','PRINCIPAL','MANAGEMENT','CREW','OTHER') NOT NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_user_types__public_id (public_id),
  UNIQUE KEY ux_user_types__inst_name (institution_id, name),
  CONSTRAINT fk_user_types__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE member_profiles (                      -- a person's profile in one institution (BR-01)
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  account_id      BIGINT UNSIGNED NULL,             -- NULL for members without a phone (BR-02)
  user_type_id    BIGINT UNSIGNED NOT NULL,
  first_name      VARCHAR(60)     NOT NULL,
  last_name       VARCHAR(60)     NULL,
  employee_no     VARCHAR(30)     NULL,
  admission_no    VARCHAR(30)     NULL,
  status          ENUM('ACTIVE','INACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',  -- RC-01, CR-08
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_member_profiles__public_id (public_id),
  UNIQUE KEY ux_member_profiles__inst_admission (institution_id, admission_no),
  UNIQUE KEY ux_member_profiles__inst_employee (institution_id, employee_no),
  KEY ix_member_profiles__inst_type_status (institution_id, user_type_id, status),
  KEY ix_member_profiles__account (account_id),
  CONSTRAINT fk_member_profiles__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_member_profiles__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_member_profiles__user_type FOREIGN KEY (user_type_id) REFERENCES user_types (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE profile_roles (                        -- institution roles held by a profile
  institution_id  BIGINT UNSIGNED NOT NULL,
  profile_id      BIGINT UNSIGNED NOT NULL,
  role_id         BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (profile_id, role_id),
  KEY ix_profile_roles__inst_role (institution_id, role_id),
  CONSTRAINT fk_profile_roles__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_profile_roles__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_profile_roles__role FOREIGN KEY (role_id) REFERENCES roles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE operator_accounts (                    -- platform operators (back office), one role each
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id    BINARY(16)      NOT NULL,
  account_id   BIGINT UNSIGNED NOT NULL,
  role_id      BIGINT UNSIGNED NOT NULL,
  status       ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  row_version  INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at   DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at   DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_operator_accounts__public_id (public_id),
  UNIQUE KEY ux_operator_accounts__account (account_id),
  CONSTRAINT fk_operator_accounts__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_operator_accounts__role FOREIGN KEY (role_id) REFERENCES roles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

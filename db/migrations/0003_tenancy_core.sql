-- 0003_tenancy_core.sql — forward-only migration (D-16). Source: docs/04-data-model.md §9.
-- Status values are the upper-case codes of the build register (docs/01c).

CREATE TABLE institutions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)      NOT NULL,
  identifier          VARCHAR(24)     NOT NULL,     -- 27.4 §7: RPE + 3 + 3 + 5-digit id + MMYY
  name                VARCHAR(150)    NOT NULL,
  short_name          VARCHAR(6)      NOT NULL,
  board               VARCHAR(40)     NULL,
  address_line1       VARCHAR(200)    NOT NULL,
  address_line2       VARCHAR(200)    NULL,
  city                VARCHAR(80)     NOT NULL,
  state               VARCHAR(80)     NOT NULL,
  pin_code            CHAR(6)         NOT NULL,
  time_zone           VARCHAR(40)     NOT NULL DEFAULT 'Asia/Kolkata',
  status              ENUM('PENDING_ACTIVATION','ACTIVE','SUSPENDED','CANCELLED') NOT NULL DEFAULT 'PENDING_ACTIVATION', -- RC-08
  suspended_at        DATETIME(3)     NULL,
  cancelled_at        DATETIME(3)     NULL,
  retention_until_on  DATE            NULL,
  corporate_code      VARCHAR(10)     NULL,
  pool_account_ref    VARCHAR(40)     NULL,
  shadow_account_ref  VARCHAR(40)     NULL,
  name_address_key    CHAR(64)        NOT NULL,     -- SHA-256 of normalised name + address (uniqueness)
  row_version         INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  created_by          BINARY(16)      NULL,
  updated_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_by          BINARY(16)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_institutions__public_id (public_id),
  UNIQUE KEY ux_institutions__identifier (identifier),
  UNIQUE KEY ux_institutions__name_address (name_address_key),
  UNIQUE KEY ux_institutions__corporate_code (corporate_code),
  KEY ix_institutions__status (status),
  CONSTRAINT ck_institutions__pin CHECK (pin_code REGEXP '^[0-9]{6}$'),          -- 27.4 §5 postal code
  CONSTRAINT ck_institutions__short CHECK (short_name REGEXP '^[A-Z0-9]{2,6}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE institution_lifecycle_events (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id    BIGINT UNSIGNED NOT NULL,
  action            VARCHAR(40)     NOT NULL,       -- REGISTERED, ACTIVATED, SUSPENDED, REACTIVATED, CANCELLED, PLAN_CHANGE (RNG-SAS-019)
  from_status       VARCHAR(40)     NULL,
  to_status         VARCHAR(40)     NULL,
  reason            VARCHAR(500)    NOT NULL,
  actor_ref         BINARY(16)      NULL,           -- NULL = SYSTEM
  occurred_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  notified_at       DATETIME(3)     NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY ix_ile__institution_occurred (institution_id, occurred_at),
  CONSTRAINT fk_ile__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

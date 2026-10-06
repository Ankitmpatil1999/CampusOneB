-- 0004_governance.sql — forward-only migration (D-16). Source: docs/04-data-model.md §9.
-- Status values are the upper-case codes of the build register (docs/01c).

CREATE TABLE audit_log (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_on      DATE            NOT NULL,
  occurred_at      DATETIME(3)     NOT NULL,
  institution_id   BIGINT UNSIGNED NULL,           -- NULL for platform-level actions
  actor_type       ENUM('member','console','operator','portal','terminal','partner','system') NOT NULL,
  actor_ref        BINARY(16)      NULL,
  action           VARCHAR(80)     NOT NULL,       -- e.g. MEMBER_STATUS_CHANGE
  entity_type      VARCHAR(60)     NOT NULL,
  entity_ref       BINARY(16)      NULL,
  before_state     JSON            NULL,           -- masked snapshot
  after_state      JSON            NULL,           -- masked snapshot
  reason           VARCHAR(500)    NULL,
  ip               VARBINARY(16)   NULL,
  correlation_id   BINARY(16)      NOT NULL,
  PRIMARY KEY (id, occurred_on),
  KEY ix_audit_log__inst_occurred (institution_id, occurred_at),
  KEY ix_audit_log__entity (institution_id, entity_type, entity_ref, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE COLUMNS (occurred_on) (
  PARTITION p202610 VALUES LESS THAN ('2026-11-01'),
  PARTITION p202611 VALUES LESS THAN ('2026-12-01'),
  PARTITION p202612 VALUES LESS THAN ('2027-01-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
);

CREATE TRIGGER trg_audit_log__no_update BEFORE UPDATE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
CREATE TRIGGER trg_audit_log__no_delete BEFORE DELETE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';

CREATE TABLE cross_institution_access_record (       -- CR-18, RNG-GOV-033/035
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id         BINARY(16)      NOT NULL,
  access_no         VARCHAR(20)     NOT NULL,      -- ACC-YY-NNNN
  parent_access_id  BIGINT UNSIGNED NULL,          -- drill-through points at its comparison
  kind              ENUM('Comparison','Drill-through','Leaderboard','Support lookup') NOT NULL,
  actor_ref         BINARY(16)      NOT NULL,
  actor_role        VARCHAR(80)     NOT NULL,
  selection         VARCHAR(300)    NOT NULL,      -- stated selection (named list / by status / page opened)
  period_from_on    DATE            NULL,
  period_to_on      DATE            NULL,
  outcome           ENUM('Returned','Refused') NOT NULL,
  reason            VARCHAR(500)    NOT NULL,
  note              VARCHAR(500)    NULL,
  occurred_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  correlation_id    BINARY(16)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_xiar__public_id (public_id),
  UNIQUE KEY ux_xiar__access_no (access_no),
  KEY ix_xiar__occurred (occurred_at),
  KEY ix_xiar__actor (actor_ref, occurred_at),
  CONSTRAINT fk_xiar__parent FOREIGN KEY (parent_access_id) REFERENCES cross_institution_access_record (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE cross_institution_access_institutions (   -- which institutions an access read (3NF instead of a list column)
  access_id       BIGINT UNSIGNED NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (access_id, institution_id),
  KEY ix_xiai__institution (institution_id, access_id),
  CONSTRAINT fk_xiai__access FOREIGN KEY (access_id) REFERENCES cross_institution_access_record (id),
  CONSTRAINT fk_xiai__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE cross_institution_access_figures (        -- figures read (members, wallets, collections, settlement, attendance, comms, …)
  access_id       BIGINT UNSIGNED NOT NULL,
  figure_key      VARCHAR(40)     NOT NULL,
  PRIMARY KEY (access_id, figure_key),
  CONSTRAINT fk_xiaf__access FOREIGN KEY (access_id) REFERENCES cross_institution_access_record (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_xiar__no_update BEFORE UPDATE ON cross_institution_access_record FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cross_institution_access_record is append-only';
CREATE TRIGGER trg_xiar__no_delete BEFORE DELETE ON cross_institution_access_record FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cross_institution_access_record is append-only';

CREATE TABLE job_runs (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  job_id           VARCHAR(40)     NOT NULL,       -- e.g. settlement-run
  period_key       VARCHAR(32)     NOT NULL,       -- e.g. 2026-09-30
  trigger_kind     ENUM('SCHEDULE','MANUAL','CATCH_UP') NOT NULL,
  requested_by     BINARY(16)      NULL,
  reason           VARCHAR(500)    NULL,
  scope_institution_id BIGINT UNSIGNED NULL,       -- institution-scoped manual runs
  status           ENUM('STARTED','SUCCESS','PARTIAL_FAILURE','FAILED') NOT NULL DEFAULT 'STARTED', -- RC-26
  processed        INT UNSIGNED    NOT NULL DEFAULT 0,
  failed           INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped          INT UNSIGNED    NOT NULL DEFAULT 0,
  started_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  ended_at         DATETIME(3)     NULL,
  correlation_id   BINARY(16)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_job_runs__public_id (public_id),
  KEY ix_job_runs__job_started (job_id, started_at),
  KEY ix_job_runs__job_period (job_id, period_key, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE job_run_items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_run_id       BIGINT UNSIGNED NOT NULL,
  institution_id   BIGINT UNSIGNED NULL,
  status           ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL,                               -- RC-26
  items_processed  INT UNSIGNED    NOT NULL DEFAULT 0,
  items_failed     INT UNSIGNED    NOT NULL DEFAULT 0,
  note             VARCHAR(500)    NULL,
  error_code       VARCHAR(80)     NULL,
  started_at       DATETIME(3)     NOT NULL,
  ended_at         DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_job_run_items__run_inst (job_run_id, institution_id),
  KEY ix_job_run_items__inst (institution_id, started_at),
  CONSTRAINT fk_jri__run FOREIGN KEY (job_run_id) REFERENCES job_runs (id),
  CONSTRAINT fk_jri__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE outbox_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id         BINARY(16)      NOT NULL,       -- consumers dedupe on it
  institution_id   BIGINT UNSIGNED NULL,
  aggregate_type   VARCHAR(60)     NOT NULL,
  aggregate_ref    BINARY(16)      NULL,
  event_type       VARCHAR(80)     NOT NULL,
  payload          JSON            NOT NULL,       -- opaque; no secrets, PII minimised
  status           ENUM('PENDING','DISPATCHED','DEAD') NOT NULL DEFAULT 'PENDING',             -- RC-26
  attempts         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  available_at     DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  last_error       VARCHAR(500)    NULL,
  correlation_id   BINARY(16)      NOT NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  dispatched_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_outbox__event_id (event_id),
  KEY ix_outbox__status_available_id (status, available_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE idempotency_records (                   -- API-level replay protection (Idempotency-Key header)
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope_key        VARCHAR(64)     NOT NULL,       -- institution public id, or 'platform' / 'public:<ip-hash>'
  principal_ref    BINARY(16)      NULL,
  idempotency_key  VARCHAR(100)    NOT NULL,
  method           VARCHAR(8)      NOT NULL,
  route            VARCHAR(200)    NOT NULL,
  request_hash     CHAR(64)        NOT NULL,
  status           ENUM('IN_PROGRESS','COMPLETED') NOT NULL DEFAULT 'IN_PROGRESS',            -- RC-26
  response_status  SMALLINT UNSIGNED NULL,
  response_body    JSON            NULL,           -- masked; no secrets
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_idem__scope_principal_key (scope_key, principal_ref, idempotency_key),
  KEY ix_idem__expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE webhook_receipts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  partner_client_id VARCHAR(64)    NOT NULL,
  partner_event_id VARCHAR(100)    NOT NULL,
  received_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  signature_ok     BOOLEAN         NOT NULL,
  source_ip        VARBINARY(16)   NOT NULL,
  body_sha256      CHAR(64)        NOT NULL,
  body_encrypted   MEDIUMBLOB      NULL,           -- raw body kept encrypted for disputes (never logged); off-row storage
  outcome          VARCHAR(40)     NOT NULL,
  response_code    VARCHAR(10)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_webhook_receipts__event (partner_client_id, partner_event_id),
  KEY ix_webhook_receipts__received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE files (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NULL,
  purpose          VARCHAR(40)     NOT NULL,       -- logo, homework, application_document, statement, export, receipt, …
  object_key       VARCHAR(300)    NOT NULL,
  original_name    VARCHAR(200)    NOT NULL,
  mime_type        VARCHAR(100)    NOT NULL,
  size_bytes       INT UNSIGNED    NOT NULL,
  sha256           CHAR(64)        NOT NULL,
  scan_status      ENUM('PENDING','CLEAN','INFECTED','ERROR') NOT NULL DEFAULT 'PENDING',      -- RC-26
  owner_type       VARCHAR(60)     NULL,
  owner_ref        BINARY(16)      NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  created_by       BINARY(16)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_files__public_id (public_id),
  UNIQUE KEY ux_files__object_key (object_key),
  KEY ix_files__inst_owner (institution_id, owner_type, owner_ref),
  CONSTRAINT ck_files__size CHECK (size_bytes <= 2097152 OR purpose IN ('statement','export','receipt')),   -- CR-07 for uploads
  CONSTRAINT fk_files__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

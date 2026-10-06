-- 0057_request_log_channels.sql — forward-only migration (D-16). Phase 8.1: the log analyser and the
-- messaging channel switches (SRS 6.31, 18.5; IDN-075/076, INT-009/010; FR-PLT-03; NFR-01; OI-INT-04/08).
--
-- - request_log: one row per API request — method, route, path, status, latency, surface, the actor and
--   institution, the correlation id, query parameter NAMES and the problem code of a refusal. Never
--   bodies or query values (OI-INT-08); the address is kept without its last part. Partitioned by
--   month (high-volume log); kept for `logs.retentionDays`.
-- - messaging_channels: the platform's switch per channel (in-app, SMS, e-mail, WhatsApp, push) and the
--   template set in use. The provider itself is configuration (credentials stay in the vault); a
--   channel whose provider isn't integrated can't be switched on.

CREATE TABLE request_log (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  logged_on           DATE             NOT NULL,
  at                  DATETIME(3)      NOT NULL,
  correlation_id      VARCHAR(64)      NULL,
  method              VARCHAR(8)       NOT NULL,
  route               VARCHAR(200)     NOT NULL,
  path                VARCHAR(300)     NOT NULL,
  status              SMALLINT UNSIGNED NOT NULL,
  latency_ms          INT UNSIGNED     NOT NULL,
  surface             VARCHAR(16)      NULL,
  actor               BINARY(16)       NULL,
  institution         BINARY(16)       NULL,                           -- the institution's public id
  ip_prefix           VARCHAR(45)      NULL,
  user_agent          VARCHAR(200)     NULL,
  query_keys          VARCHAR(300)     NULL,
  problem_code        VARCHAR(80)      NULL,
  PRIMARY KEY (id, logged_on),
  KEY ix_request_log__at (logged_on, at),
  KEY ix_request_log__correlation (correlation_id),
  KEY ix_request_log__actor (actor, at),
  KEY ix_request_log__route (route, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE COLUMNS (logged_on) (
  PARTITION p202610 VALUES LESS THAN ('2026-11-01'),
  PARTITION p202611 VALUES LESS THAN ('2026-12-01'),
  PARTITION p202612 VALUES LESS THAN ('2027-01-01'),
  PARTITION p202701 VALUES LESS THAN ('2027-02-01'),
  PARTITION p202702 VALUES LESS THAN ('2027-03-01'),
  PARTITION p202703 VALUES LESS THAN ('2027-04-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
);

CREATE TABLE messaging_channels (
  channel             ENUM('IN_APP','SMS','EMAIL','WHATSAPP','PUSH') NOT NULL,
  enabled             TINYINT(1)       NOT NULL DEFAULT 0,
  template_set        VARCHAR(40)      NOT NULL DEFAULT 'default',
  updated_by          BINARY(16)       NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO messaging_channels (channel, enabled, updated_at) VALUES
  ('IN_APP', 1, UTC_TIMESTAMP(3)),
  ('SMS', 1, UTC_TIMESTAMP(3)),
  ('EMAIL', 1, UTC_TIMESTAMP(3)),
  ('WHATSAPP', 0, UTC_TIMESTAMP(3)),
  ('PUSH', 0, UTC_TIMESTAMP(3));

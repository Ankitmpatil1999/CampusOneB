-- 0058_announcements_comm_log.sql — forward-only migration (D-16). Phase 8.2: announcements and the
-- communication log (SRS 23.2–23.6, 18.5, 18.6; COM-001…006, COM-011…013, COM-022…024; FR-COM-01…04;
-- BR-70; CR-16 RNG-COM-172…186; RC-24; OI-COM-02…17).
--
-- - Categories are a platform list (the prototype's seven with their colours).
-- - An announcement (27.2 dispatch status QUEUED · PROCESSING · COMPLETED · FAILED) carries an explicit
--   high-importance flag (OI-COM-03), several target groups (OI-COM-04), the channels chosen from those
--   the platform and the institution have on (BR-70, OI-COM-09), the year, and its source (console,
--   principal, class teacher). It may wait for a send time; it can be edited until it is sent and only
--   withdrawn after (OI-COM-08).
-- - Its recipients are resolved once and kept (OI-COM-10), with each member's own acknowledgement
--   (27.2 IN-APP · EMAIL; OI-COM-11/12).
-- - The communication log (27.2 SUCCESS · SKIPPED · FAILED; RC-24 kind) records every send per
--   recipient and channel — never the message body (CR-16). Partitioned by month; purged by retention.

CREATE TABLE announcement_categories (
  code                VARCHAR(8)       NOT NULL,
  label               VARCHAR(30)      NOT NULL,
  colour              CHAR(7)          NOT NULL,
  sort_order          SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO announcement_categories (code, label, colour, sort_order) VALUES
  ('ACA', 'Academics', '#5E4BB0', 1),
  ('EVT', 'Events', '#B4582B', 2),
  ('HOL', 'Holiday', '#8C3B3B', 3),
  ('FEE', 'Fees', '#8A6A12', 4),
  ('TRN', 'Transport', '#0C6F7D', 5),
  ('GEN', 'General', '#3C6E71', 6),
  ('SAF', 'Safety', '#C8372F', 7);

CREATE TABLE announcements (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NULL,
  seq                 INT UNSIGNED     NOT NULL,                       -- ANN-<year>-<seq>
  source              ENUM('CONSOLE','PRINCIPAL','TEACHER') NOT NULL,
  section_id          BIGINT UNSIGNED  NULL,                           -- a class announcement
  title               VARCHAR(120)     NOT NULL,
  body                VARCHAR(2000)    NOT NULL,
  category_code       VARCHAR(8)       NOT NULL,
  important           TINYINT(1)       NOT NULL DEFAULT 0,
  ack_required        TINYINT(1)       NOT NULL DEFAULT 0,
  channels            SET('IN_APP','SMS','EMAIL','WHATSAPP','PUSH') NOT NULL,
  targets             JSON             NOT NULL,
  attachment_file_id  BIGINT UNSIGNED  NULL,
  send_at             DATETIME(3)      NOT NULL,
  status              ENUM('QUEUED','PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'QUEUED',
  recipients          INT UNSIGNED     NOT NULL DEFAULT 0,
  sent_success        INT UNSIGNED     NOT NULL DEFAULT 0,
  sent_skipped        INT UNSIGNED     NOT NULL DEFAULT 0,
  sent_failed         INT UNSIGNED     NOT NULL DEFAULT 0,
  dispatched_at       DATETIME(3)      NULL,
  failure_reason      VARCHAR(300)     NULL,
  withdrawn_at        DATETIME(3)      NULL,
  withdraw_reason     VARCHAR(300)     NULL,
  created_by          BINARY(16)       NULL,
  created_by_profile_id BIGINT UNSIGNED NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_announcements__public_id (public_id),
  UNIQUE KEY ux_announcements__seq (institution_id, seq),
  KEY ix_announcements__list (institution_id, year_id, created_at),
  KEY ix_announcements__due (status, send_at),
  CONSTRAINT fk_announcements__category FOREIGN KEY (category_code) REFERENCES announcement_categories (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE announcement_recipients (
  announcement_id     BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  delivered_at        DATETIME(3)      NULL,
  acknowledged_at     DATETIME(3)      NULL,
  ack_channel         ENUM('IN-APP','EMAIL') NULL,
  PRIMARY KEY (announcement_id, profile_id),
  KEY ix_announcement_recipients__member (institution_id, profile_id, announcement_id),
  CONSTRAINT fk_announcement_recipients__announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE comm_log (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  logged_on           DATE             NOT NULL,
  at                  DATETIME(3)      NOT NULL,
  institution_id      BIGINT UNSIGNED  NULL,
  kind                ENUM('ANNOUNCEMENT','DIRECT_MESSAGE','NOTIFICATION','OTP','TRANSACTIONAL') NOT NULL,
  channel             ENUM('IN_APP','SMS','EMAIL','WHATSAPP','PUSH') NOT NULL,
  recipient_profile_id BIGINT UNSIGNED NULL,
  recipient_account_id BIGINT UNSIGNED NULL,
  recipient_masked    VARCHAR(80)      NULL,
  raiser              BINARY(16)       NULL,                            -- the account that raised it; none: a system event
  outcome             ENUM('SUCCESS','SKIPPED','FAILED') NOT NULL,
  reason              VARCHAR(200)     NULL,
  ref_type            VARCHAR(30)      NULL,
  ref_id              VARCHAR(40)      NULL,
  PRIMARY KEY (id, logged_on),
  KEY ix_comm_log__inst (institution_id, logged_on, at),
  KEY ix_comm_log__ref (ref_type, ref_id),
  KEY ix_comm_log__recipient (recipient_profile_id, at)
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

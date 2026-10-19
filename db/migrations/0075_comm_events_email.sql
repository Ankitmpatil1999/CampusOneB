-- 0075_comm_events_email.sql — forward-only migration (D-16). Client 2026-10-16: "implement the e-mail
-- trigger configuration as in the old application" and phone alerts as the old app showed them.
--
-- - institution_comm_events: per school and event (config/registers/comm-events.ts), whether the
--   in-app notice is also e-mailed and whether it raises the phone alert. No row = the register's
--   default (every event on, client).
-- - email_outbox: e-mailed notices waiting to be sent. A row is written in the same transaction as
--   the notice, so the e-mail exists exactly when the change does; the API's relay sends it after
--   the commit and deletes it, retries a failed send (1, 5, 15, 60 minutes) and keeps it as FAILED
--   after `com.email.maxAttempts` with the address masked. A notice about a student goes to the
--   student and the parents as people (their account's e-mail, else the e-mail the school keeps),
--   so a parent without the app is e-mailed too, as in the earlier application; one per address.
-- - fee_records.reminded_on: the last day a fee reminder was sent (fee-reminders), so a re-run on
--   the same day sends nothing twice.

CREATE TABLE institution_comm_events (
  institution_id  BIGINT UNSIGNED NOT NULL,
  event_key       VARCHAR(30)     NOT NULL,
  email_enabled   BOOLEAN         NOT NULL,
  alert_enabled   BOOLEAN         NOT NULL,
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  updated_by      BINARY(16)      NULL,
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id, event_key),
  CONSTRAINT fk_institution_comm_events__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE email_outbox (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id   BIGINT UNSIGNED NULL,
  account_id       BIGINT UNSIGNED NULL,            -- the person's account, when they have one
  profile_id       BIGINT UNSIGNED NULL,            -- the person at the school, when known
  to_email         VARCHAR(254)    NOT NULL,        -- masked once given up (FAILED)
  event_key        VARCHAR(30)     NOT NULL,
  notification_ref BINARY(16)      NULL,            -- the in-app notice's public id
  subject          VARCHAR(200)    NOT NULL,
  body             VARCHAR(300)    NOT NULL,
  status           ENUM('PENDING','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at  DATETIME(3)     NOT NULL,
  last_error       VARCHAR(300)    NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY ix_email_outbox__due (status, next_attempt_at),
  KEY ix_email_outbox__institution (institution_id, created_at),
  CONSTRAINT fk_email_outbox__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id),
  CONSTRAINT fk_email_outbox__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE fee_records
  ADD COLUMN reminded_on DATE NULL AFTER paid_at;

-- 0076_push_notices.sql — forward-only migration (D-16). Client 2026-10-19: notices reach the phone
-- while the app is closed or the phone is locked, through Firebase Cloud Messaging (OQ-26: push).
--
-- - session_push_tokens: the phone's Firebase registration token for a signed-in member session.
--   Only an active session's token is used, so signing out, a sign-in elsewhere or the session's
--   expiry stops the pushes without anything else to do. One row per token: a phone that signs in
--   as someone else takes its token away from the earlier session. The language is the app's, so
--   the push is worded as the app is.
-- - push_outbox: pushed notices waiting to be sent, written in the same transaction as the notice
--   (only for an account with a token then). The API's relay sends them after the commit to every
--   active session's token, deletes the row, retries a failed send (1, 5, 15, 60 minutes) and
--   keeps it as FAILED after five attempts (deleted 90 days later). Every outcome is in
--   the communication log (CR-16), without the token.

CREATE TABLE session_push_tokens (
  session_id   BIGINT UNSIGNED NOT NULL,
  account_id   BIGINT UNSIGNED NOT NULL,
  token        VARCHAR(1024)   NOT NULL,              -- never logged
  token_hash   BINARY(32)      NOT NULL,              -- SHA-256 of the token: one row per phone
  platform     ENUM('ANDROID','IOS') NOT NULL,
  lang_code    VARCHAR(10)     NOT NULL DEFAULT 'en',
  updated_at   DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (session_id),
  UNIQUE KEY ux_session_push_tokens__token (token_hash),
  KEY ix_session_push_tokens__account (account_id),
  CONSTRAINT fk_session_push_tokens__session FOREIGN KEY (session_id) REFERENCES sessions (id),
  CONSTRAINT fk_session_push_tokens__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE push_outbox (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id   BIGINT UNSIGNED NULL,
  account_id       BIGINT UNSIGNED NOT NULL,
  event_key        VARCHAR(30)     NULL,             -- config/registers/comm-events.ts
  notification_ref BINARY(16)      NOT NULL,         -- the in-app notice's public id
  title_key        VARCHAR(80)     NOT NULL,
  params           JSON            NULL,
  body             VARCHAR(300)    NOT NULL,
  link             VARCHAR(300)    NULL,
  status           ENUM('PENDING','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at  DATETIME(3)     NOT NULL,
  last_error       VARCHAR(300)    NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY ix_push_outbox__due (status, next_attempt_at),
  KEY ix_push_outbox__institution (institution_id, created_at),
  CONSTRAINT fk_push_outbox__account FOREIGN KEY (account_id) REFERENCES platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

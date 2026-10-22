-- 0076_staff_app_and_push.sql — forward-only migration (D-16). The RingPe app for school staff
-- (client 2026-10-19: Accounts, Co-ordinator, Counsellor) and push notifications:
--
-- * sessions.staff_app: a console session of the staff app, beside the web console's. Signing in on
--   the phone ends only the account's earlier phone session, not the web one, and the other way
--   round (BR-05 now holds per surface and client). Existing sessions are web sessions.
-- * session_push_tokens: the phone's Firebase Cloud Messaging token for a signed-in session — the
--   member app's, or the staff app's console session. Only an active session's token is used, so
--   signing out, a sign-in elsewhere or the session's expiry stops the pushes without anything else
--   to do. One row per token: a phone that signs in as someone else takes its token away from the
--   earlier session. The language is the app's, so the push is worded as the app is. (The same
--   table as the member app's pushes on the corporate-codes branch, 0076_push_notices.sql.)

ALTER TABLE sessions
  ADD COLUMN staff_app TINYINT(1) NOT NULL DEFAULT 0 AFTER surface,
  DROP INDEX ux_sessions__one_active,
  DROP COLUMN active_key;

ALTER TABLE sessions
  ADD COLUMN active_key VARCHAR(48)
    GENERATED ALWAYS AS (IF(ended_at IS NULL,
      CONCAT(account_id, ':', surface, IF(staff_app = 1, ':APP', '')), NULL)) STORED,
  ADD UNIQUE KEY ux_sessions__one_active (active_key);

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

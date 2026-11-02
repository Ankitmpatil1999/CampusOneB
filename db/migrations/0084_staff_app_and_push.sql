-- 0081_staff_app_and_push.sql — forward-only migration (D-16). The CampusOne app for school staff
-- (client 2026-10-19: Accounts, Co-ordinator, Counsellor) and its push notifications:
--
-- * sessions.staff_app: a console session of the staff app, beside the web console's. Signing in on
--   the phone ends only the account's earlier phone session, not the web one, and the other way
--   round (BR-05 now holds per surface and client). Existing sessions are web sessions.
-- * push_outbox.surface: the phones a pushed notice goes to — the member app's (MEMBER, as 0079), or
--   the staff app's console session for a console notice (CONSOLE). The staff app registers its
--   token in session_push_tokens (0079) for its console session (COM-037).

ALTER TABLE sessions
  ADD COLUMN staff_app TINYINT(1) NOT NULL DEFAULT 0 AFTER surface,
  DROP INDEX ux_sessions__one_active,
  DROP COLUMN active_key;

ALTER TABLE sessions
  ADD COLUMN active_key VARCHAR(48)
    GENERATED ALWAYS AS (IF(ended_at IS NULL,
      CONCAT(account_id, ':', surface, IF(staff_app = 1, ':APP', '')), NULL)) STORED,
  ADD UNIQUE KEY ux_sessions__one_active (active_key);

ALTER TABLE push_outbox
  ADD COLUMN surface ENUM('MEMBER','CONSOLE') NOT NULL DEFAULT 'MEMBER' AFTER account_id;

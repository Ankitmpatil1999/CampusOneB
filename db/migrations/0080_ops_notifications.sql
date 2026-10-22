-- 0080_ops_notifications.sql — forward-only migration (D-16). Client 2026-10-21: in-app notices on
-- the web as in the app. The back office gets its own bell: notices for platform operators (a
-- platform request waiting for a checker, the answer to an operator's own request) are kept on the
-- OPS surface, beside the institution console's (CONSOLE) and the member app's (MEMBER).
--
-- A value added at the end of the ENUM is a metadata-only change (no rows are rewritten).
ALTER TABLE notifications
  MODIFY COLUMN surface ENUM('CONSOLE','MEMBER','OPS') NOT NULL;

-- 0023_approval_direct.sql — forward-only migration (D-16). ADR-0015: an Institution Administrator's
-- own request takes effect at once and is still recorded as an approval request, marked as applied
-- directly (no checker), so the approvals screen and the history show it.

ALTER TABLE approval_requests
  ADD COLUMN applied_directly BOOLEAN NOT NULL DEFAULT FALSE AFTER effect_error_code,
  ADD CONSTRAINT ck_approval_requests__direct CHECK (NOT applied_directly OR (status = 'APPROVED' AND checker_ref IS NULL));

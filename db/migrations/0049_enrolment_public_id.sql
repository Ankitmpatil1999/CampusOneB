-- 0049_enrolment_public_id.sql — forward-only migration (D-16). Phase 7.1: an enrolment gets a
-- public id so the console can name it (ACA-029 transfers, ACA-030 corrections). Existing rows get
-- one now; new rows get one by default, so every existing insert path keeps working.

ALTER TABLE enrolments ADD COLUMN public_id BINARY(16) NULL AFTER id;
UPDATE enrolments SET public_id = UUID_TO_BIN(UUID(), 1) WHERE public_id IS NULL;
ALTER TABLE enrolments
  MODIFY COLUMN public_id BINARY(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
  ADD UNIQUE KEY ux_enrolments__public_id (public_id);

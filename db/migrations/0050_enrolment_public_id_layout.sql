-- 0050_enrolment_public_id_layout.sql — forward-only migration (D-16). Corrects 0049: an id made with
-- UUID_TO_BIN(UUID(), 1) has its time fields swapped and does not read back as a valid UUID. The ids
-- are reissued in the standard layout (nothing refers to them yet) and the default follows.

UPDATE enrolments SET public_id = UUID_TO_BIN(UUID());
ALTER TABLE enrolments MODIFY COLUMN public_id BINARY(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID()));

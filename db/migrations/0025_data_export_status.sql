-- 0025_data_export_status.sql — forward-only migration (D-16). The data-export statuses follow the
-- status register that already has them (RC-26 data_export: Requested, Preparing, Ready, Expired,
-- Failed) instead of the values 0024 wrote. The table is new and empty.

ALTER TABLE data_exports
  DROP INDEX ux_data_exports__running,
  DROP COLUMN running_key;

ALTER TABLE data_exports
  MODIFY COLUMN status ENUM('REQUESTED','RUNNING','READY','EXPIRED','FAILED') NOT NULL DEFAULT 'REQUESTED',
  ADD COLUMN running_key BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status IN ('REQUESTED','RUNNING'), institution_id, NULL)) STORED,
  ADD UNIQUE KEY ux_data_exports__running (running_key);

-- 0041_fee_uploads.sql — forward-only migration (D-16). Phase 5.2: fee sheet uploads (SRS 13.3,
-- FR-FEE-03, OI-FEE-05…07; FEE-014/015; prototype c.feerecords "Upload fee sheet").
--
-- - One row per student: the total is split into equal whole-rupee instalments with the remainder on
--   the last; a missing due date becomes the academic year's last day.
-- - Every row is checked and reported first; nothing is created until the upload is committed (all
--   rows when none was rejected, or the accepted rows only), in one transaction.
-- - A row marked paid is recorded as history (PAID, with its date and reference): no collection is
--   attempted and nothing is posted to the ledger at upload (OI-FEE-06).

CREATE TABLE fee_uploads (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  file_name           VARCHAR(200)     NOT NULL,
  status              ENUM('VALIDATED','COMMITTED') NOT NULL DEFAULT 'VALIDATED',
  rows_total          INT UNSIGNED     NOT NULL,
  rows_accepted       INT UNSIGNED     NOT NULL,
  rows_rejected       INT UNSIGNED     NOT NULL,
  records_planned     INT UNSIGNED     NOT NULL,
  report              JSON             NOT NULL,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  committed_at        DATETIME(3)      NULL,
  committed_count     INT UNSIGNED     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_uploads__public_id (public_id),
  KEY ix_fee_uploads__inst_created (institution_id, created_at),
  CONSTRAINT fk_fee_uploads__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_uploads__year FOREIGN KEY (year_id) REFERENCES academic_years (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE fee_records
  ADD COLUMN upload_id      BIGINT UNSIGNED NULL AFTER version_id,
  ADD COLUMN paid_reference VARCHAR(40)     NULL AFTER paid_at,          -- paid history from a sheet
  ADD KEY ix_fee_records__upload (upload_id),
  ADD CONSTRAINT fk_fee_records__upload FOREIGN KEY (upload_id) REFERENCES fee_uploads (id);

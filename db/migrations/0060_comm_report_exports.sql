-- 0060_comm_report_exports.sql — forward-only migration (D-16). Phase 8.4: the communication report and
-- report exports (SRS 23.18.1 CR-16 RNG-COM-172…186, 18.6; COM-007, COM-008, RPT-004, RPT-005;
-- OI-GAS-17).
--
-- - Every log row carries the subject or first line of what was sent (RNG-COM-174/182): an
--   announcement's title, a notification's title, "One-time code" for a code (never the code,
--   RNG-COM-179). A direct message has none: it is private to its participants (RNG-COM-178).
-- - A log write that fails never fails the send; it is counted per institution and day and the report
--   shows the gap (RNG-COM-183).
-- - A report export (status register: data export, RC-26) is prepared off the request from exactly the
--   rows the filters select, kept private and downloaded through a short-lived signed link until it
--   expires; the same role and institution checks apply as to the report (RNG-COM-180).

ALTER TABLE comm_log ADD COLUMN subject VARCHAR(160) NULL;

CREATE TABLE comm_log_gaps (
  institution_id      BIGINT UNSIGNED  NOT NULL DEFAULT 0,             -- 0: no institution
  day                 DATE             NOT NULL,
  failures            INT UNSIGNED     NOT NULL DEFAULT 0,
  PRIMARY KEY (institution_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE report_exports (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NULL,                           -- none: an operator export
  report              VARCHAR(40)      NOT NULL,
  params              JSON             NOT NULL,
  format              ENUM('CSV')      NOT NULL DEFAULT 'CSV',
  status              ENUM('REQUESTED','RUNNING','READY','EXPIRED','FAILED') NOT NULL DEFAULT 'REQUESTED',
  file_id             BIGINT UNSIGNED  NULL,
  row_count           INT UNSIGNED     NULL,
  truncated           TINYINT(1)       NOT NULL DEFAULT 0,
  requested_by        BINARY(16)       NOT NULL,
  requested_at        DATETIME(3)      NOT NULL,
  started_at          DATETIME(3)      NULL,
  ready_at            DATETIME(3)      NULL,
  expires_at          DATETIME(3)      NULL,
  error_code          VARCHAR(60)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_report_exports__public_id (public_id),
  KEY ix_report_exports__inst_requested (institution_id, requested_at),
  CONSTRAINT fk_report_exports__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_report_exports__file FOREIGN KEY (file_id) REFERENCES files (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

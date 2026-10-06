-- 0039_fee_structures.sql — forward-only migration (D-16). Phase 5.1: fee heads, entry fees, fee
-- structures with dated versions, assignment to students and the fee records it raises (SRS 13.2,
-- 13.19 CR-11/CR-12; FEE-001…009; prototype c.fees).
--
-- - Fee heads are an institution master (OI-FEE-25, disposition B), seeded on first use.
-- - Entry fees stay one per-year configuration beside the structures (OI-FEE-29).
-- - A structure (name unique per institution and year) is held as versions: DRAFT → PENDING (sent to
--   a checker) → ACTIVE → SUPERSEDED (RNG-FEE-161/162; RC-31). One open version (draft or pending)
--   and one active version at a time. A version carries its classes, its heads with annual amounts
--   (mandatory or optional) and its instalments with a share and a due date (prototype c.fees).
-- - One formula (RNG-FEE-164/165): a head's part in an instalment is its amount × the share, whole
--   rupees, the remainder on the last instalment; an instalment is the sum of its mandatory parts;
--   the total is the sum of the heads. Stored totals are the server's.
-- - Assignment raises one fee record per instalment per student from the ACTIVE version, keeping the
--   version and the head breakdown (RNG-FEE-163/168); one assignment per student and year
--   (RNG-FEE-169); instalments already past their due date are not raised (BR-30, Q14 M10).

CREATE TABLE fee_heads (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)       NOT NULL,
  institution_id  BIGINT UNSIGNED  NOT NULL,
  name            VARCHAR(30)      NOT NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_by      BINARY(16)       NULL,
  created_at      DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_heads__public_id (public_id),
  UNIQUE KEY ux_fee_heads__name (institution_id, name),
  CONSTRAINT fk_fee_heads__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE entry_fees (
  institution_id         BIGINT UNSIGNED  NOT NULL,
  year_id                BIGINT UNSIGNED  NOT NULL,
  application_fee_paise  BIGINT UNSIGNED  NOT NULL,
  application_mandatory  TINYINT(1)       NOT NULL DEFAULT 1,
  admission_fee_paise    BIGINT UNSIGNED  NOT NULL,
  row_version            INT UNSIGNED     NOT NULL DEFAULT 1,
  updated_by             BINARY(16)       NULL,
  created_at             DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at             DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (institution_id, year_id),
  CONSTRAINT fk_entry_fees__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_entry_fees__year FOREIGN KEY (year_id) REFERENCES academic_years (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_structures (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)       NOT NULL,
  institution_id  BIGINT UNSIGNED  NOT NULL,
  year_id         BIGINT UNSIGNED  NOT NULL,
  name            VARCHAR(60)      NOT NULL,
  created_by      BINARY(16)       NULL,
  created_at      DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_structures__public_id (public_id),
  UNIQUE KEY ux_fee_structures__name (institution_id, year_id, name),
  CONSTRAINT fk_fee_structures__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_structures__year FOREIGN KEY (year_id) REFERENCES academic_years (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_structure_versions (
  id               BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)       NOT NULL,
  institution_id   BIGINT UNSIGNED  NOT NULL,
  structure_id     BIGINT UNSIGNED  NOT NULL,
  version_no       SMALLINT UNSIGNED NOT NULL,
  state            ENUM('DRAFT','PENDING','ACTIVE','SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
  total_paise      BIGINT UNSIGNED  NOT NULL,                     -- mandatory heads
  optional_paise   BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  late_fine_paise  BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  approval_id      BIGINT UNSIGNED  NULL,
  returned_remarks VARCHAR(500)     NULL,                          -- a checker's rejection
  created_by       BINARY(16)       NULL,
  created_at       DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  submitted_by     BINARY(16)       NULL,
  submitted_at     DATETIME(3)      NULL,
  activated_at     DATETIME(3)      NULL,
  superseded_at    DATETIME(3)      NULL,
  row_version      INT UNSIGNED     NOT NULL DEFAULT 1,
  open_key         BIGINT UNSIGNED GENERATED ALWAYS AS (IF(state IN ('DRAFT','PENDING'), structure_id, NULL)) STORED,
  active_key       BIGINT UNSIGNED GENERATED ALWAYS AS (IF(state = 'ACTIVE', structure_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_structure_versions__public_id (public_id),
  UNIQUE KEY ux_fee_structure_versions__no (structure_id, version_no),
  UNIQUE KEY ux_fee_structure_versions__open (open_key),           -- one draft or pending at a time
  UNIQUE KEY ux_fee_structure_versions__active (active_key),       -- one active at a time
  KEY ix_fee_structure_versions__inst (institution_id, state),
  CONSTRAINT fk_fee_structure_versions__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_structure_versions__structure FOREIGN KEY (structure_id) REFERENCES fee_structures (id),
  CONSTRAINT fk_fee_structure_versions__approval FOREIGN KEY (approval_id) REFERENCES approval_requests (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_structure_classes (
  version_id  BIGINT UNSIGNED NOT NULL,
  class_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (version_id, class_id),
  KEY ix_fee_structure_classes__class (class_id),
  CONSTRAINT fk_fee_structure_classes__version FOREIGN KEY (version_id) REFERENCES fee_structure_versions (id),
  CONSTRAINT fk_fee_structure_classes__class FOREIGN KEY (class_id) REFERENCES classes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_structure_heads (
  version_id    BIGINT UNSIGNED  NOT NULL,
  head_id       BIGINT UNSIGNED  NOT NULL,
  optional      TINYINT(1)       NOT NULL DEFAULT 0,
  amount_paise  BIGINT UNSIGNED  NOT NULL,
  sort_order    SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (version_id, head_id),
  CONSTRAINT fk_fee_structure_heads__version FOREIGN KEY (version_id) REFERENCES fee_structure_versions (id),
  CONSTRAINT fk_fee_structure_heads__head FOREIGN KEY (head_id) REFERENCES fee_heads (id),
  CONSTRAINT ck_fee_structure_heads__amount CHECK (amount_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_structure_instalments (
  version_id    BIGINT UNSIGNED  NOT NULL,
  seq           SMALLINT UNSIGNED NOT NULL,
  label         VARCHAR(30)      NOT NULL,
  due_date      DATE             NOT NULL,
  share_bp      SMALLINT UNSIGNED NOT NULL,                       -- 5000 = 50 %
  amount_paise  BIGINT UNSIGNED  NOT NULL,                       -- mandatory parts, server-computed
  PRIMARY KEY (version_id, seq),
  CONSTRAINT fk_fee_structure_instalments__version FOREIGN KEY (version_id) REFERENCES fee_structure_versions (id),
  CONSTRAINT ck_fee_structure_instalments__share CHECK (share_bp > 0 AND share_bp <= 10000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_assignments (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  structure_id        BIGINT UNSIGNED  NOT NULL,
  version_id          BIGINT UNSIGNED  NOT NULL,
  optional_heads      JSON             NULL,                         -- head ids the student takes
  status              ENUM('ACTIVE','REPLACED') NOT NULL DEFAULT 'ACTIVE',
  assigned_by         BINARY(16)       NULL,
  assigned_at         DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  live_key            VARCHAR(40) GENERATED ALWAYS AS (IF(status = 'ACTIVE', CONCAT(student_profile_id, ':', year_id), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_assignments__public_id (public_id),
  UNIQUE KEY ux_fee_assignments__live (live_key),                  -- one per student and year
  KEY ix_fee_assignments__inst_structure (institution_id, structure_id, status),
  CONSTRAINT fk_fee_assignments__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_assignments__year FOREIGN KEY (year_id) REFERENCES academic_years (id),
  CONSTRAINT fk_fee_assignments__student FOREIGN KEY (student_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_fee_assignments__structure FOREIGN KEY (structure_id) REFERENCES fee_structures (id),
  CONSTRAINT fk_fee_assignments__version FOREIGN KEY (version_id) REFERENCES fee_structure_versions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_records (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  year_id             BIGINT UNSIGNED  NOT NULL,
  student_profile_id  BIGINT UNSIGNED  NOT NULL,
  source              ENUM('STRUCTURE','MANUAL','UPLOAD') NOT NULL,
  assignment_id       BIGINT UNSIGNED  NULL,
  version_id          BIGINT UNSIGNED  NULL,
  instalment_seq      SMALLINT UNSIGNED NOT NULL,
  label               VARCHAR(30)      NOT NULL,
  due_date            DATE             NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  late_fine_paise     BIGINT UNSIGNED  NOT NULL DEFAULT 0,            -- charged once when overdue
  fine_applied        TINYINT(1)       NOT NULL DEFAULT 0,
  paid_paise          BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  status              ENUM('DUE','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED') NOT NULL DEFAULT 'DUE',
  financed            TINYINT(1)       NOT NULL DEFAULT 0,
  remarks             VARCHAR(300)     NULL,
  paid_at             DATETIME(3)      NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_records__public_id (public_id),
  UNIQUE KEY ux_fee_records__instalment (institution_id, student_profile_id, year_id, instalment_seq), -- OI-FEE-04
  KEY ix_fee_records__inst_year_status (institution_id, year_id, status, due_date),
  KEY ix_fee_records__version (version_id),
  CONSTRAINT fk_fee_records__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_records__year FOREIGN KEY (year_id) REFERENCES academic_years (id),
  CONSTRAINT fk_fee_records__student FOREIGN KEY (student_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_fee_records__assignment FOREIGN KEY (assignment_id) REFERENCES fee_assignments (id),
  CONSTRAINT fk_fee_records__version FOREIGN KEY (version_id) REFERENCES fee_structure_versions (id),
  CONSTRAINT ck_fee_records__amount CHECK (amount_paise > 0 AND paid_paise <= amount_paise + late_fine_paise)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fee_record_heads (
  record_id     BIGINT UNSIGNED NOT NULL,
  head_id       BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(30)     NOT NULL,                          -- as charged
  amount_paise  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (record_id, head_id),
  CONSTRAINT fk_fee_record_heads__record FOREIGN KEY (record_id) REFERENCES fee_records (id),
  CONSTRAINT fk_fee_record_heads__head FOREIGN KEY (head_id) REFERENCES fee_heads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

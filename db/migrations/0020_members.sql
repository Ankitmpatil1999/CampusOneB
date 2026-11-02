-- 0020_members.sql — forward-only migration (D-16). Phase 2.5: members in the console (6.18–6.26;
-- IDN-044…059; prototype c.members, c.onboard, c.search) and the academic structure students are
-- placed in (20.4; RC-22 academic year Open · Closed with one current year; CR-13).

-- Academic years: one current year per institution (RC-22; a designation, not a status).
CREATE TABLE academic_years (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NOT NULL,
  label            VARCHAR(9)      NOT NULL,        -- 2026-27
  starts_on        DATE            NOT NULL,
  ends_on          DATE            NOT NULL,
  status           ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',   -- RC-22
  is_current       BOOLEAN         NOT NULL DEFAULT FALSE,
  current_key      BIGINT UNSIGNED GENERATED ALWAYS AS (IF(is_current, institution_id, NULL)) STORED,
  row_version      INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_academic_years__public_id (public_id),
  UNIQUE KEY ux_academic_years__inst_label (institution_id, label),
  UNIQUE KEY ux_academic_years__current (current_key),
  CONSTRAINT ck_academic_years__dates CHECK (ends_on > starts_on),
  CONSTRAINT fk_academic_years__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE classes (                                -- grades (20.4; CR-09)
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(40)     NOT NULL,
  sort_order       SMALLINT UNSIGNED NOT NULL,
  row_version      INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_classes__public_id (public_id),
  UNIQUE KEY ux_classes__inst_name (institution_id, name),
  KEY ix_classes__inst_order (institution_id, sort_order),
  CONSTRAINT fk_classes__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sections (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NOT NULL,
  class_id         BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(20)     NOT NULL,
  capacity         SMALLINT UNSIGNED NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_sections__public_id (public_id),
  UNIQUE KEY ux_sections__class_name (class_id, name),
  KEY ix_sections__inst (institution_id, class_id),
  CONSTRAINT fk_sections__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_sections__class FOREIGN KEY (class_id) REFERENCES classes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A student's grade and section for a year (CR-09, CR-13): one per student and year.
CREATE TABLE enrolments (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED NOT NULL,
  student_profile_id  BIGINT UNSIGNED NOT NULL,
  year_id             BIGINT UNSIGNED NOT NULL,
  section_id          BIGINT UNSIGNED NOT NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  created_by          BINARY(16)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_enrolments__inst_student_year (institution_id, student_profile_id, year_id),
  KEY ix_enrolments__inst_year_section (institution_id, year_id, section_id),
  CONSTRAINT fk_enrolments__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_enrolments__student FOREIGN KEY (student_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_enrolments__year FOREIGN KEY (year_id) REFERENCES academic_years (id),
  CONSTRAINT fk_enrolments__section FOREIGN KEY (section_id) REFERENCES sections (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Parents and their children in the institution (6.20).
CREATE TABLE guardianships (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id       BIGINT UNSIGNED NOT NULL,
  guardian_profile_id  BIGINT UNSIGNED NOT NULL,
  ward_profile_id      BIGINT UNSIGNED NOT NULL,
  relation             VARCHAR(20)     NOT NULL,     -- ref_relations code
  is_primary_contact   BOOLEAN         NOT NULL DEFAULT FALSE,
  created_at           DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_guardianships__pair (institution_id, guardian_profile_id, ward_profile_id),
  KEY ix_guardianships__ward (institution_id, ward_profile_id),
  CONSTRAINT fk_guardianships__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_guardianships__guardian FOREIGN KEY (guardian_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_guardianships__ward FOREIGN KEY (ward_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT ck_guardianships__not_self CHECK (guardian_profile_id <> ward_profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Member details captured at onboarding. A profile without a CampusOne account yet keeps the contact
-- mobile; the profile links when that mobile signs up (BR-01, BR-02).
ALTER TABLE member_profiles
  ADD COLUMN member_seq        INT UNSIGNED NULL AFTER user_type_id,      -- shown as <short name>-00001
  ADD COLUMN gender            ENUM('MALE','FEMALE','OTHER') NULL AFTER last_name,
  ADD COLUMN date_of_birth     DATE         NULL AFTER gender,
  ADD COLUMN contact_mobile    CHAR(10)     NULL AFTER date_of_birth,
  ADD COLUMN contact_email     VARCHAR(254) NULL AFTER contact_mobile,
  ADD COLUMN joined_on         DATE         NULL AFTER admission_no,       -- year of association / joining
  ADD COLUMN status_reason     VARCHAR(300) NULL AFTER status,
  ADD COLUMN status_changed_at DATETIME(3)  NULL AFTER status_reason,
  ADD COLUMN created_by        BINARY(16)   NULL AFTER created_at,
  ADD KEY ix_member_profiles__inst_mobile (institution_id, contact_mobile),
  ADD KEY ix_member_profiles__inst_name (institution_id, first_name, last_name);

UPDATE member_profiles m
  JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY id) AS n FROM member_profiles) x
    ON x.id = m.id
   SET m.member_seq = x.n
 WHERE m.member_seq IS NULL;

ALTER TABLE member_profiles
  MODIFY COLUMN member_seq INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY ux_member_profiles__inst_seq (institution_id, member_seq);

-- A spreadsheet being onboarded (6.18, RNG-GOV-019): validated first, committed as a whole or the
-- accepted rows only. The row report is working data for the screen.
CREATE TABLE member_uploads (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NOT NULL,
  kind             ENUM('MEMBERS','STAFF','PROFILE_UPDATE') NOT NULL,
  file_name        VARCHAR(200)    NOT NULL,
  status           ENUM('VALIDATED','COMMITTED') NOT NULL DEFAULT 'VALIDATED',
  rows_total       INT UNSIGNED    NOT NULL,
  rows_accepted    INT UNSIGNED    NOT NULL,
  rows_rejected    INT UNSIGNED    NOT NULL,
  report           JSON            NOT NULL,
  created_by       BINARY(16)      NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  committed_at     DATETIME(3)     NULL,
  committed_count  INT UNSIGNED    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_member_uploads__public_id (public_id),
  KEY ix_member_uploads__inst_created (institution_id, created_at),
  CONSTRAINT fk_member_uploads__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every institution starts with a current academic year (Indian school year, April–March).
INSERT INTO academic_years (public_id, institution_id, label, starts_on, ends_on, status, is_current)
SELECT UUID_TO_BIN(UUID()), i.id,
       CONCAT(y.start_year, '-', LPAD(MOD(y.start_year + 1, 100), 2, '0')),
       MAKEDATE(y.start_year, 1) + INTERVAL 3 MONTH,
       MAKEDATE(y.start_year + 1, 1) + INTERVAL 3 MONTH - INTERVAL 1 DAY,
       'OPEN', TRUE
  FROM institutions i
  JOIN (SELECT IF(MONTH(UTC_DATE()) >= 4, YEAR(UTC_DATE()), YEAR(UTC_DATE()) - 1) AS start_year) y
 WHERE NOT EXISTS (SELECT 1 FROM academic_years a WHERE a.institution_id = i.id);

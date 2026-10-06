-- 0022_approvals_notifications.sql — forward-only migration (D-16). Phase 2.6: the maker-checker
-- queue (section 17; MKR-001…005), corrections of an institution profile's identity fields (CR-06;
-- IDN-057) and in-app notifications (COM-009/010/014/015).

-- Approval requests get a number per scope (shown as APR-0001; each institution and the platform
-- count separately) and the record they are about, so pending requests are found without reading
-- the payload. Requests are raised under the institution row lock; the unique key catches the rest.
ALTER TABLE approval_requests
  ADD COLUMN request_seq   INT UNSIGNED    NULL AFTER public_id,
  ADD COLUMN seq_scope     BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(institution_id, 0)) STORED AFTER request_seq,
  ADD COLUMN subject_type  VARCHAR(30)     NULL AFTER summary,      -- member | account
  ADD COLUMN subject_ref   BINARY(16)      NULL AFTER subject_type, -- the member or account public id
  ADD KEY ix_approval_requests__subject (institution_id, subject_ref, status),
  ADD KEY ix_approval_requests__inst_status_created (institution_id, status, created_at, id);

UPDATE approval_requests a
JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(institution_id, 0) ORDER BY id) AS n
      FROM approval_requests) x ON x.id = a.id
SET a.request_seq = x.n;

UPDATE approval_requests
SET subject_type = 'member',
    subject_ref = UNHEX(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.member')), '-', ''))
WHERE module IN ('MEMBER_SUSPENSION', 'MEMBER_DELINK')
  AND JSON_EXTRACT(payload, '$.member') IS NOT NULL;

ALTER TABLE approval_requests
  ADD UNIQUE KEY ux_approval_requests__seq (seq_scope, request_seq);

CREATE TRIGGER trg_approval_requests__seq BEFORE INSERT ON approval_requests
FOR EACH ROW
  SET NEW.request_seq = IF(
    NEW.request_seq IS NULL OR NEW.request_seq = 0,
    (SELECT COALESCE(MAX(r.request_seq), 0) + 1 FROM approval_requests r
      WHERE r.seq_scope = COALESCE(NEW.institution_id, 0)),
    NEW.request_seq
  );

-- Corrections of an institution profile (name, date of birth, gender, admission number, employee
-- ID) as well as of an account. One open request per field of the profile or account.
ALTER TABLE pii_correction_requests
  DROP INDEX ux_pii_correction_requests__open,
  DROP COLUMN open_key;

ALTER TABLE pii_correction_requests
  MODIFY COLUMN account_id BIGINT UNSIGNED NULL,
  ADD COLUMN profile_id BIGINT UNSIGNED NULL AFTER account_id,
  MODIFY COLUMN field ENUM('FULL_NAME','DOB','GENDER','PAN','ID_NUMBER','ADMISSION_NO','EMPLOYEE_NO') NOT NULL,
  ADD COLUMN open_key VARCHAR(48) GENERATED ALWAYS AS (
    IF(applied_at IS NULL AND closed_at IS NULL,
       IF(profile_id IS NULL, CONCAT('a', account_id, ':', field), CONCAT('p', profile_id, ':', field)),
       NULL)) STORED,
  ADD UNIQUE KEY ux_pii_correction_requests__open (open_key),
  ADD KEY ix_pii_correction_requests__profile (profile_id, created_at),
  ADD CONSTRAINT fk_pcr__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  ADD CONSTRAINT ck_pcr__subject CHECK (account_id IS NOT NULL OR profile_id IS NOT NULL);

-- In-app notifications (docs/04 §3.9: monthly partitions). The title is a message key rendered in
-- the reader's language; the body is the request's own text (a summary or a checker's remarks).
CREATE TABLE notifications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_on      DATE            NOT NULL,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NULL,
  account_id      BIGINT UNSIGNED NOT NULL,        -- the platform account it is for
  surface         ENUM('CONSOLE','MEMBER') NOT NULL,
  category        VARCHAR(30)     NOT NULL,        -- APPROVAL, CORRECTION, JOB, TICKET, …
  title_key       VARCHAR(80)     NOT NULL,        -- message register key
  params          JSON            NULL,
  body            VARCHAR(300)    NOT NULL,
  link            VARCHAR(200)    NULL,            -- where the console or app opens it
  read_at         DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id, created_on),
  KEY ix_notifications__recipient (account_id, surface, institution_id, id),
  KEY ix_notifications__unread (account_id, surface, read_at),
  KEY ix_notifications__public (public_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE COLUMNS (created_on) (
  PARTITION p202610 VALUES LESS THAN ('2026-11-01'),
  PARTITION p202611 VALUES LESS THAN ('2026-12-01'),
  PARTITION p202612 VALUES LESS THAN ('2027-01-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
);

-- 0087_admission_accounts.sql — forward-only migration (D-16). Client 2026-10-23: the student, the
-- father, the mother, the guardian and the local guardian get their RingPe accounts as soon as the
-- admission form has their mobile number (when it is submitted, or a submitted one changes) — nobody
-- signs up themselves. The login details go out only once the admission is approved (or the student
-- is uploaded as an existing student): a one-time password, changed on the first sign-in.
--
-- Both tables are school tables in the CUG database (db/cug-tables.ts). The accounts they name are in
-- the RingPe database beside it, which a migration cannot name, so those two columns are kept by the
-- service (services/admission-accounts.ts) rather than by a foreign key.
--
-- * admission_accounts: whose account each person on an application has — one the admission made
--   (created) or one that person already had (not created: their own password stays) — and when
--   the login details were sent, so they go out once.

CREATE TABLE {{CUG}}.admission_accounts (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id      BIGINT UNSIGNED NOT NULL,
  person              ENUM('STUDENT','FATHER','MOTHER','GUARDIAN','LOCAL_GUARDIAN') NOT NULL,
  account_id          BIGINT UNSIGNED NOT NULL,                -- platform_accounts.id
  created             TINYINT(1)      NOT NULL DEFAULT 0,      -- made by the admission
  credentials_sent_at DATETIME(3)     NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_admission_accounts__person (application_id, person),
  KEY ix_admission_accounts__account (account_id),
  CONSTRAINT fk_admission_accounts__application FOREIGN KEY (application_id)
    REFERENCES {{CUG}}.admission_applications (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- * member_profiles.own_account_id: a student's own login, a platform_accounts.id (client
--   2026-10-23). The family still holds the child's profile (account_id, CR-04); the student signs in
--   to their own account and reaches only this profile — never chat (the messaging service refuses
--   students).
ALTER TABLE {{CUG}}.member_profiles
  ADD COLUMN own_account_id BIGINT UNSIGNED NULL AFTER account_id,
  ADD KEY ix_member_profiles__own_account (own_account_id);

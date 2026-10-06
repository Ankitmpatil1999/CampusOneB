-- 0008_translations_and_genders.sql — forward-only migration (D-16). FR-PLT-01, SRS 6.30, OI-GAS-20.
-- Client decisions of 2026-10-02:
--   * translations: machine drafts for the seven languages now, reviewed later in the back office
--     (IDN-073/074); a reviewed or edited text is never overwritten by a re-seed;
--   * gender: Male or Female only.

CREATE TABLE translations (                         -- texts of a language, by register / screen key
  lang_code    VARCHAR(8)   NOT NULL,
  msg_key      VARCHAR(120) NOT NULL,
  text         TEXT         NOT NULL,
  source       ENUM('MACHINE','HUMAN') NOT NULL,    -- MACHINE = draft from the seed, HUMAN = edited
  reviewed_at  DATETIME(3)  NULL,
  reviewed_by  BINARY(16)   NULL,
  row_version  INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at   DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (lang_code, msg_key),
  CONSTRAINT fk_translations__language FOREIGN KEY (lang_code) REFERENCES languages (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- No account holds OTHER yet (sign-up offered it only in development).
ALTER TABLE platform_accounts
  MODIFY COLUMN gender ENUM('MALE','FEMALE') NULL;

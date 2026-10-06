-- 0061_quiz.sql — forward-only migration (D-16). Phase 8.6: the financial literacy quiz (SRS 28, CR-01;
-- FIN-001…017; OI-FIN-01…27).
--
-- - One platform question bank kept by operators (OI-FIN-04/20): topics with a unique name; questions
--   with exactly four options and one correct, first in the staging bank, then published from it in one
--   transaction; a published question staging no longer holds is withdrawn, never deleted (OI-FIN-16/19).
-- - An attempt records the questions served and every answer, with the server's clock per question:
--   the questions are answered in order, each within its time (setting, 120 s); a late answer counts as
--   timed out; the server scores the attempt — the device never receives the correct answers before
--   the end (OI-FIN-07/08/11/13). Attempts are limited per topic and day (setting; OI-FIN-12). An
--   attempt left unfinished past its last deadline expires and doesn't count (OI-FIN-26).
-- - Statuses: topic ACTIVE · WITHDRAWN; attempt IN_PROGRESS · COMPLETED · EXPIRED (register change RC-39).

CREATE TABLE quiz_topics (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  name                VARCHAR(60)      NOT NULL,
  description         VARCHAR(200)     NULL,
  icon                VARCHAR(30)      NULL,
  status              ENUM('ACTIVE','WITHDRAWN') NOT NULL DEFAULT 'ACTIVE',
  sort_order          SMALLINT         NOT NULL DEFAULT 0,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_quiz_topics__public_id (public_id),
  UNIQUE KEY ux_quiz_topics__name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_questions (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  topic_id            BIGINT UNSIGNED  NOT NULL,
  bank                ENUM('STAGING','PUBLISHED') NOT NULL,
  staging_id          BIGINT UNSIGNED  NULL,                           -- a published copy's staging question
  text                VARCHAR(500)     NOT NULL,
  explanation         VARCHAR(500)     NULL,
  in_use              TINYINT(1)       NOT NULL DEFAULT 1,             -- 0: a withdrawn published question
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  staging_text_key    VARCHAR(520) GENERATED ALWAYS AS (IF(bank = 'STAGING', CONCAT(topic_id, ':', text), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_quiz_questions__public_id (public_id),
  UNIQUE KEY ux_quiz_questions__staging_text (staging_text_key),     -- one staging question per text in a topic
  UNIQUE KEY ux_quiz_questions__published (staging_id),
  KEY ix_quiz_questions__topic (topic_id, bank, in_use),
  CONSTRAINT fk_quiz_questions__topic FOREIGN KEY (topic_id) REFERENCES quiz_topics (id),
  CONSTRAINT fk_quiz_questions__staging FOREIGN KEY (staging_id) REFERENCES quiz_questions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_options (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  question_id         BIGINT UNSIGNED  NOT NULL,
  seq                 TINYINT UNSIGNED NOT NULL,                       -- 1…4, the order shown (a, b, c, d)
  text                VARCHAR(200)     NOT NULL,
  is_correct          TINYINT(1)       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY ux_quiz_options__public_id (public_id),
  UNIQUE KEY ux_quiz_options__seq (question_id, seq),
  CONSTRAINT fk_quiz_options__question FOREIGN KEY (question_id) REFERENCES quiz_questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_attempts (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  topic_id            BIGINT UNSIGNED  NOT NULL,
  status              ENUM('IN_PROGRESS','COMPLETED','EXPIRED') NOT NULL DEFAULT 'IN_PROGRESS',
  served              TINYINT UNSIGNED NOT NULL,
  seconds_per_question SMALLINT UNSIGNED NOT NULL,
  current_seq         TINYINT UNSIGNED NOT NULL DEFAULT 1,             -- the question open now
  current_deadline_at DATETIME(3)      NOT NULL,                       -- when it times out
  score               TINYINT UNSIGNED NULL,
  started_on          DATE             NOT NULL,                       -- IST day, for the daily limit
  started_at          DATETIME(3)      NOT NULL,
  completed_at        DATETIME(3)      NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_quiz_attempts__public_id (public_id),
  KEY ix_quiz_attempts__member (institution_id, profile_id, topic_id, started_on),
  KEY ix_quiz_attempts__board (institution_id, status, completed_at),
  CONSTRAINT fk_quiz_attempts__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_quiz_attempts__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_quiz_attempts__topic FOREIGN KEY (topic_id) REFERENCES quiz_topics (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_attempt_questions (
  attempt_id          BIGINT UNSIGNED  NOT NULL,
  seq                 TINYINT UNSIGNED NOT NULL,
  question_id         BIGINT UNSIGNED  NOT NULL,
  option_order        VARCHAR(40)      NOT NULL,                       -- the options' ids in the order shown
  chosen_option_id    BIGINT UNSIGNED  NULL,
  correct             TINYINT(1)       NULL,
  timed_out           TINYINT(1)       NOT NULL DEFAULT 0,
  answered_at         DATETIME(3)      NULL,
  PRIMARY KEY (attempt_id, seq),
  CONSTRAINT fk_quiz_attempt_questions__attempt FOREIGN KEY (attempt_id) REFERENCES quiz_attempts (id),
  CONSTRAINT fk_quiz_attempt_questions__question FOREIGN KEY (question_id) REFERENCES quiz_questions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

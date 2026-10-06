-- 0064_comm_log_daily.sql — forward-only migration (D-16). Phase 9.2 (load test).
-- The communication report's totals over a month of log (60,000 rows) took about half a second,
-- counted afresh on every read (docs/reports/load-phase-9.md). A finished day never changes — rows are
-- written with the day they happen and the purge removes whole days — so its totals are counted once,
-- by the first report that needs them, and kept here; today's are counted live. The purge deletes a
-- day's totals with its rows. Totals filtered by raiser or recipient are still counted live.

CREATE TABLE comm_log_daily (                         -- one finished day's attempts per kind, channel, outcome
  institution_id      BIGINT UNSIGNED  NOT NULL,
  day                 DATE             NOT NULL,
  kind                ENUM('ANNOUNCEMENT','DIRECT_MESSAGE','NOTIFICATION','OTP','TRANSACTIONAL') NOT NULL,
  channel             ENUM('IN_APP','SMS','EMAIL','WHATSAPP','PUSH') NOT NULL,
  outcome             ENUM('SUCCESS','SKIPPED','FAILED') NOT NULL,
  n                   INT UNSIGNED     NOT NULL,
  PRIMARY KEY (institution_id, day, kind, channel, outcome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE comm_log_daily_done (                    -- the days counted (a quiet day has no totals rows)
  institution_id      BIGINT UNSIGNED  NOT NULL,
  day                 DATE             NOT NULL,
  PRIMARY KEY (institution_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

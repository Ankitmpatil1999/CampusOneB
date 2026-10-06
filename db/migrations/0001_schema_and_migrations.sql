-- 0001_schema_and_migrations.sql — forward-only migration (D-16). Source: docs/04-data-model.md §9.
-- Status values are the upper-case codes of the build register (docs/01c).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      VARCHAR(64)  NOT NULL,
  description  VARCHAR(200) NOT NULL,
  checksum     CHAR(64)     NOT NULL,
  applied_at   DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  applied_by   VARCHAR(64)  NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

#!/bin/bash
# Least-privilege users (docs/04 §8): the application has no DDL; the migrator owns the schema;
# reports are read-only. Runs once when the container initialises an empty data directory.
set -euo pipefail

mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS 'campusone_app'@'%'      IDENTIFIED BY '${CAMPUSONE_APP_PASSWORD}';
CREATE USER IF NOT EXISTS 'campusone_migrator'@'%' IDENTIFIED BY '${CAMPUSONE_MIGRATOR_PASSWORD}';
CREATE USER IF NOT EXISTS 'campusone_report'@'%'   IDENTIFIED BY '${CAMPUSONE_REPORT_PASSWORD}';

-- Phase 1 grants. Table-level restrictions (ledger append-only, wallet_balances via the ledger
-- role) are applied by the migrations that create those tables (docs/04 §9.1).
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON campusone.* TO 'campusone_app'@'%';
GRANT ALL PRIVILEGES ON campusone.* TO 'campusone_migrator'@'%';
GRANT SELECT ON campusone.* TO 'campusone_report'@'%';
-- The CUG database (migration 0081 creates it and moves the school tables there).
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON campusone_cug.* TO 'campusone_app'@'%';
GRANT ALL PRIVILEGES ON campusone_cug.* TO 'campusone_migrator'@'%';
GRANT SELECT ON campusone_cug.* TO 'campusone_report'@'%';

-- Integration tests create and drop throwaway schemas campusone_it_*.
GRANT ALL PRIVILEGES ON \`campusone\_it\_%\`.* TO 'campusone_migrator'@'%';
FLUSH PRIVILEGES;
SQL

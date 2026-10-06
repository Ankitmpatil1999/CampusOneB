#!/bin/bash
# Least-privilege users (docs/04 §8): the application has no DDL; the migrator owns the schema;
# reports are read-only. Runs once when the container initialises an empty data directory.
set -euo pipefail

mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS 'ringpe_app'@'%'      IDENTIFIED BY '${RINGPE_APP_PASSWORD}';
CREATE USER IF NOT EXISTS 'ringpe_migrator'@'%' IDENTIFIED BY '${RINGPE_MIGRATOR_PASSWORD}';
CREATE USER IF NOT EXISTS 'ringpe_report'@'%'   IDENTIFIED BY '${RINGPE_REPORT_PASSWORD}';

-- Phase 1 grants. Table-level restrictions (ledger append-only, wallet_balances via the ledger
-- role) are applied by the migrations that create those tables (docs/04 §9.1).
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON ringpe.* TO 'ringpe_app'@'%';
GRANT ALL PRIVILEGES ON ringpe.* TO 'ringpe_migrator'@'%';
GRANT SELECT ON ringpe.* TO 'ringpe_report'@'%';

-- Integration tests create and drop throwaway schemas ringpe_it_*.
GRANT ALL PRIVILEGES ON \`ringpe\_it\_%\`.* TO 'ringpe_migrator'@'%';
FLUSH PRIVILEGES;
SQL

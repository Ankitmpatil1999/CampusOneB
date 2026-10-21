-- One-time setup for a MySQL server installed directly on the workstation (the Windows service
-- MySQL80), when Docker is not available (Q4). Run as an administrator, e.g. in MySQL Workbench,
-- after replacing the three CHANGE-ME passwords. Then put the same passwords in RingPe_Backend_API/.env.
--
-- Also set in my.ini under [mysqld] and restart the service (append-only triggers need it when
-- binary logging is on):
--   log_bin_trust_function_creators = 1

-- Two databases (migration 0081): RingPe (the platform) and CUG (the schools), on this server.
CREATE DATABASE IF NOT EXISTS ringpe CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS ringpe_cug CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'ringpe_app'@'localhost'      IDENTIFIED BY 'CHANGE-ME-app';
CREATE USER IF NOT EXISTS 'ringpe_migrator'@'localhost' IDENTIFIED BY 'CHANGE-ME-migrator';
CREATE USER IF NOT EXISTS 'ringpe_report'@'localhost'   IDENTIFIED BY 'CHANGE-ME-report';

GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON ringpe.* TO 'ringpe_app'@'localhost';
GRANT ALL PRIVILEGES ON ringpe.* TO 'ringpe_migrator'@'localhost';
GRANT SELECT ON ringpe.* TO 'ringpe_report'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON ringpe_cug.* TO 'ringpe_app'@'localhost';
GRANT ALL PRIVILEGES ON ringpe_cug.* TO 'ringpe_migrator'@'localhost';
GRANT SELECT ON ringpe_cug.* TO 'ringpe_report'@'localhost';

-- Integration tests (TEST_DB_MIGRATOR_URL) create and drop throwaway schemas ringpe_it_* (and their
-- ringpe_it_*_cug databases, which the same pattern covers).
GRANT ALL PRIVILEGES ON `ringpe\_it\_%`.* TO 'ringpe_migrator'@'localhost';
FLUSH PRIVILEGES;

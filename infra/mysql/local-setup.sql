-- One-time setup for a MySQL server installed directly on the workstation (the Windows service
-- MySQL80), when Docker is not available (Q4). Run as an administrator, e.g. in MySQL Workbench,
-- after replacing the three CHANGE-ME passwords. Then put the same passwords in CampusOne_Backend_API/.env.
--
-- Also set in my.ini under [mysqld] and restart the service (append-only triggers need it when
-- binary logging is on):
--   log_bin_trust_function_creators = 1

-- Two databases (migration 0081): CampusOne (the platform) and CUG (the schools), on this server.
CREATE DATABASE IF NOT EXISTS campusone CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS campusone_cug CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'campusone_app'@'localhost'      IDENTIFIED BY 'CHANGE-ME-app';
CREATE USER IF NOT EXISTS 'campusone_migrator'@'localhost' IDENTIFIED BY 'CHANGE-ME-migrator';
CREATE USER IF NOT EXISTS 'campusone_report'@'localhost'   IDENTIFIED BY 'CHANGE-ME-report';

GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON campusone.* TO 'campusone_app'@'localhost';
GRANT ALL PRIVILEGES ON campusone.* TO 'campusone_migrator'@'localhost';
GRANT SELECT ON campusone.* TO 'campusone_report'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON campusone_cug.* TO 'campusone_app'@'localhost';
GRANT ALL PRIVILEGES ON campusone_cug.* TO 'campusone_migrator'@'localhost';
GRANT SELECT ON campusone_cug.* TO 'campusone_report'@'localhost';

-- Integration tests (TEST_DB_MIGRATOR_URL) create and drop throwaway schemas campusone_it_* (and their
-- campusone_it_*_cug databases, which the same pattern covers).
GRANT ALL PRIVILEGES ON `campusone\_it\_%`.* TO 'campusone_migrator'@'localhost';
FLUSH PRIVILEGES;

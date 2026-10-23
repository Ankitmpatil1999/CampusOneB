-- 0085_accountant_attendance_reports.sql — forward-only migration (D-16). Client 2026-10-22: Accounts
-- reads the attendance reports — students, teachers and non-teaching staff — on the web console's
-- Attendance page, the Daily attendance report and the staff app. Read only: attendance.view, never
-- attendance.mark or attendance.config.
--
-- Seeded roles keep their grants once seeded (grants_seeded), so the change to the role template
-- (config/registers/access.ts) is applied here to the roles already in the database; a fresh
-- database gets it from the seed, which also keeps the role's description current.

INSERT INTO role_task_assignments (role_id, task_id)
SELECT r.id, t.id FROM roles r JOIN tasks t ON t.scope = r.scope AND t.code = 'attendance'
WHERE r.scope = 'INSTITUTION' AND r.code = 'ACCOUNTANT' AND r.grants_seeded = TRUE
ON DUPLICATE KEY UPDATE role_task_assignments.task_id = role_task_assignments.task_id;

INSERT INTO role_tasks (role_id, sub_task_id)
SELECT r.id, st.id
FROM roles r
  JOIN tasks t ON t.scope = r.scope AND t.code = 'attendance'
  JOIN sub_tasks st ON st.task_id = t.id AND st.code = 'attendance.view'
WHERE r.scope = 'INSTITUTION' AND r.code = 'ACCOUNTANT' AND r.grants_seeded = TRUE
ON DUPLICATE KEY UPDATE role_tasks.sub_task_id = role_tasks.sub_task_id;

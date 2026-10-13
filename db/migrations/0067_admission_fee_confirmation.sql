-- 0065_admission_fee_confirmation.sql — forward-only migration (D-16). Admission process changes
-- (client 2026-10-09):
-- - every admission fee paid (online or cash) waits for Accounts to confirm its receipt;
-- - the admission number and section are assigned (the application approved or rejected) by the
--   Co-ordinator — and the Institution Administrator — only, once Accounts has confirmed both fees;
-- - submitted applications are visible to the Counsellor, the Co-ordinator and Accounts.
-- Seeded roles keep their grants once seeded (grants_seeded), so the change to the role templates
-- is applied here to the roles already in the database; a fresh database gets it from the seed.

ALTER TABLE admission_payments
  ADD COLUMN confirmed_at        DATETIME(3)  NULL AFTER paid_at,          -- Accounts confirmed receipt
  ADD COLUMN confirmed_by        BINARY(16)   NULL AFTER confirmed_at;     -- the account that did

-- The application's payment status: PENDING (a fee is not paid yet), PAID (every fee paid, waiting
-- for Accounts), CONFIRMED (every fee confirmed, or none to pay). COMPLETED (a fee paid) is replaced.
ALTER TABLE admission_applications
  MODIFY COLUMN payment_status ENUM('PENDING','COMPLETED','PAID','CONFIRMED') NOT NULL DEFAULT 'PENDING';

UPDATE admission_applications a
  LEFT JOIN entry_fees f ON f.institution_id = a.institution_id AND f.year_id = a.year_id
SET a.payment_status = IF(
  COALESCE(f.application_fee_paise, 0) = 0 AND COALESCE(f.admission_fee_paise, 0) = 0,
  'CONFIRMED',
  IF(
    (COALESCE(f.application_fee_paise, 0) = 0 OR EXISTS (
       SELECT 1 FROM admission_payments p
       WHERE p.application_id = a.id AND p.fee_type = 'APPLICATION' AND p.status = 'PAID'))
    AND (COALESCE(f.admission_fee_paise, 0) = 0 OR EXISTS (
       SELECT 1 FROM admission_payments p
       WHERE p.application_id = a.id AND p.fee_type = 'ADMISSION' AND p.status = 'PAID')),
    'PAID',
    'PENDING'
  )
);

ALTER TABLE admission_applications
  MODIFY COLUMN payment_status ENUM('PENDING','PAID','CONFIRMED') NOT NULL DEFAULT 'PENDING';

-- The new sub-task (the reference seed writes it too; on a fresh database there are no tasks yet).
INSERT INTO sub_tasks (task_id, code, label_key, view_only)
SELECT id, 'admfees.verify', 'subtask.institution.admfees.verify', FALSE
FROM tasks WHERE scope = 'INSTITUTION' AND code = 'admfees'
ON DUPLICATE KEY UPDATE label_key = VALUES(label_key);

-- Approving is reserved to the Co-ordinator and the Institution Administrator: no other role keeps it.
DELETE rt FROM role_tasks rt
  JOIN roles r ON r.id = rt.role_id
  JOIN sub_tasks st ON st.id = rt.sub_task_id
WHERE r.scope = 'INSTITUTION'
  AND st.code IN ('admissions.approve', 'admfees.verify')
  AND NOT (st.code = 'admissions.approve' AND r.code IN ('INSTITUTION_ADMIN', 'ACADEMIC_COORDINATOR'))
  AND NOT (st.code = 'admfees.verify' AND r.code IN ('INSTITUTION_ADMIN', 'ACCOUNTANT'));

-- Applications open for the Co-ordinator (to decide them) and for Accounts (to see them).
INSERT INTO role_task_assignments (role_id, task_id)
SELECT r.id, t.id FROM roles r JOIN tasks t ON t.scope = r.scope AND t.code = 'admissions'
WHERE r.scope = 'INSTITUTION' AND r.code IN ('ACADEMIC_COORDINATOR', 'ACCOUNTANT')
ON DUPLICATE KEY UPDATE role_task_assignments.task_id = role_task_assignments.task_id;

INSERT INTO role_tasks (role_id, sub_task_id)
SELECT r.id, st.id
FROM roles r
  JOIN tasks t ON t.scope = r.scope
  JOIN sub_tasks st ON st.task_id = t.id
WHERE r.scope = 'INSTITUTION'
  AND (
    (r.code = 'ACADEMIC_COORDINATOR'
       AND st.code IN ('admissions.view', 'admissions.edit', 'admissions.approve'))
    OR (r.code = 'ACCOUNTANT' AND st.code IN ('admissions.view', 'admfees.verify'))
    OR (r.code = 'INSTITUTION_ADMIN' AND st.code = 'admfees.verify')
  )
ON DUPLICATE KEY UPDATE role_tasks.sub_task_id = role_tasks.sub_task_id;

-- 0026_approval_error_params.sql — forward-only migration (D-16). The reason an approved change was
-- refused is shown in the drawer with its values ("Admission number already exists: TVPS/2026/0001"),
-- so the message parameters are kept next to the code.

ALTER TABLE approval_requests
  ADD COLUMN effect_error_params JSON NULL AFTER effect_error_code;

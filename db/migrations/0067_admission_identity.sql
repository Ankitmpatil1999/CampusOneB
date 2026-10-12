-- 0067_admission_identity.sql — forward-only migration (D-16). The admission form asks for the
-- student's Aadhaar number (required) and PAN (optional), the primary contact's Aadhaar number and
-- PAN (both required), and the family's consent to use what is collected to register their RingPe
-- account (client 2026-10-12; this replaces the last-6-digits identity number of Q16 e).
-- Each number is kept encrypted (AES-256-GCM, its own purpose key) with only its last four
-- characters in clear for masked display; the student's Aadhaar also has a blind index, so the same
-- child is not entered twice for a year.

ALTER TABLE admission_applications
  ADD COLUMN student_aadhaar_enc     VARBINARY(255) NULL AFTER id_number_last4,
  ADD COLUMN student_aadhaar_bidx    BINARY(32)     NULL AFTER student_aadhaar_enc,
  ADD COLUMN student_aadhaar_last4   CHAR(4)        NULL AFTER student_aadhaar_bidx,
  ADD COLUMN student_pan_enc         VARBINARY(255) NULL AFTER student_aadhaar_last4,
  ADD COLUMN student_pan_last4       CHAR(4)        NULL AFTER student_pan_enc,
  ADD COLUMN primary_aadhaar_enc     VARBINARY(255) NULL AFTER primary_email,
  ADD COLUMN primary_aadhaar_last4   CHAR(4)        NULL AFTER primary_aadhaar_enc,
  ADD COLUMN primary_pan_enc         VARBINARY(255) NULL AFTER primary_aadhaar_last4,
  ADD COLUMN primary_pan_last4       CHAR(4)        NULL AFTER primary_pan_enc,
  ADD COLUMN registration_consent_at DATETIME(3)    NULL AFTER declared_by,
  ADD KEY ix_admission_applications__aadhaar (institution_id, student_aadhaar_bidx);

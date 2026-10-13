-- 0072_admission_parent_ids.sql — forward-only migration (D-16). The Aadhaar number and PAN, with
-- the front and back of each card, are required for the father and the mother — not only for the
-- primary contact — for a guardian who is the primary contact, and for the local guardian of a
-- hostel student (client 2026-10-13). Each person's numbers get their own encrypted columns (the
-- last four characters in clear, for masked display), and their cards their own document types.
--
-- What was kept as the primary contact's moves to that person. The numbers keep the encryption
-- context they were sealed with ("<application>:primary"); nothing reads them back in full. The
-- primary_aadhaar_* / primary_pan_* columns and the PRIMARY_* document types are no longer written;
-- they stay for now so that an older build on the same database keeps running.

ALTER TABLE admission_documents
  MODIFY COLUMN doc_type ENUM(
    'PHOTO', 'BIRTH', 'ADDRESS', 'REPORT', 'TC', 'OTHER',
    'STUDENT_AADHAAR_FRONT', 'STUDENT_AADHAAR_BACK', 'STUDENT_PAN_FRONT', 'STUDENT_PAN_BACK',
    'PRIMARY_AADHAAR_FRONT', 'PRIMARY_AADHAAR_BACK', 'PRIMARY_PAN_FRONT', 'PRIMARY_PAN_BACK',
    'FATHER_AADHAAR_FRONT', 'FATHER_AADHAAR_BACK', 'FATHER_PAN_FRONT', 'FATHER_PAN_BACK',
    'MOTHER_AADHAAR_FRONT', 'MOTHER_AADHAAR_BACK', 'MOTHER_PAN_FRONT', 'MOTHER_PAN_BACK',
    'GUARDIAN_AADHAAR_FRONT', 'GUARDIAN_AADHAAR_BACK', 'GUARDIAN_PAN_FRONT', 'GUARDIAN_PAN_BACK',
    'LOCAL_GUARDIAN_AADHAAR_FRONT', 'LOCAL_GUARDIAN_AADHAAR_BACK',
    'LOCAL_GUARDIAN_PAN_FRONT', 'LOCAL_GUARDIAN_PAN_BACK'
  ) NOT NULL;

ALTER TABLE admission_applications
  ADD COLUMN father_aadhaar_enc           VARBINARY(255) NULL AFTER primary_pan_last4,
  ADD COLUMN father_aadhaar_last4         CHAR(4)        NULL AFTER father_aadhaar_enc,
  ADD COLUMN father_pan_enc               VARBINARY(255) NULL AFTER father_aadhaar_last4,
  ADD COLUMN father_pan_last4             CHAR(4)        NULL AFTER father_pan_enc,
  ADD COLUMN mother_aadhaar_enc           VARBINARY(255) NULL AFTER father_pan_last4,
  ADD COLUMN mother_aadhaar_last4         CHAR(4)        NULL AFTER mother_aadhaar_enc,
  ADD COLUMN mother_pan_enc               VARBINARY(255) NULL AFTER mother_aadhaar_last4,
  ADD COLUMN mother_pan_last4             CHAR(4)        NULL AFTER mother_pan_enc,
  ADD COLUMN guardian_aadhaar_enc         VARBINARY(255) NULL AFTER mother_pan_last4,
  ADD COLUMN guardian_aadhaar_last4       CHAR(4)        NULL AFTER guardian_aadhaar_enc,
  ADD COLUMN guardian_pan_enc             VARBINARY(255) NULL AFTER guardian_aadhaar_last4,
  ADD COLUMN guardian_pan_last4           CHAR(4)        NULL AFTER guardian_pan_enc,
  ADD COLUMN local_guardian_aadhaar_enc   VARBINARY(255) NULL AFTER guardian_pan_last4,
  ADD COLUMN local_guardian_aadhaar_last4 CHAR(4)        NULL AFTER local_guardian_aadhaar_enc,
  ADD COLUMN local_guardian_pan_enc       VARBINARY(255) NULL AFTER local_guardian_aadhaar_last4,
  ADD COLUMN local_guardian_pan_last4     CHAR(4)        NULL AFTER local_guardian_pan_enc;

UPDATE admission_applications
   SET father_aadhaar_enc = primary_aadhaar_enc, father_aadhaar_last4 = primary_aadhaar_last4,
       father_pan_enc = primary_pan_enc, father_pan_last4 = primary_pan_last4
 WHERE primary_relation = 'FATHER';

UPDATE admission_applications
   SET mother_aadhaar_enc = primary_aadhaar_enc, mother_aadhaar_last4 = primary_aadhaar_last4,
       mother_pan_enc = primary_pan_enc, mother_pan_last4 = primary_pan_last4
 WHERE primary_relation = 'MOTHER';

UPDATE admission_applications
   SET guardian_aadhaar_enc = primary_aadhaar_enc, guardian_aadhaar_last4 = primary_aadhaar_last4,
       guardian_pan_enc = primary_pan_enc, guardian_pan_last4 = primary_pan_last4
 WHERE primary_relation = 'GUARDIAN';

-- PRIMARY_AADHAAR_FRONT → FATHER_AADHAAR_FRONT (the primary contact's relation, then the rest).
UPDATE admission_documents d
  JOIN admission_applications a ON a.id = d.application_id
   SET d.doc_type = CONCAT(a.primary_relation, SUBSTRING(d.doc_type, 8))
 WHERE d.doc_type IN ('PRIMARY_AADHAAR_FRONT', 'PRIMARY_AADHAAR_BACK',
                      'PRIMARY_PAN_FRONT', 'PRIMARY_PAN_BACK')
   AND a.primary_relation IS NOT NULL;

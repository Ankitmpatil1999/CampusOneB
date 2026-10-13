-- 0071_admission_cards_and_mobiles.sql — forward-only migration (D-16). The admission form takes
-- the front and back of the Aadhaar card and the PAN card — the primary contact's (required) and the
-- student's (optional) — as documents; and mobile numbers with a country code (client 2026-10-13):
-- an Indian number stays its 10 digits, another is kept in international form (+971501234567, at
-- most 16 characters).

ALTER TABLE admission_documents
  MODIFY COLUMN doc_type ENUM(
    'PHOTO', 'BIRTH', 'ADDRESS', 'REPORT', 'TC', 'OTHER',
    'STUDENT_AADHAAR_FRONT', 'STUDENT_AADHAAR_BACK', 'STUDENT_PAN_FRONT', 'STUDENT_PAN_BACK',
    'PRIMARY_AADHAAR_FRONT', 'PRIMARY_AADHAAR_BACK', 'PRIMARY_PAN_FRONT', 'PRIMARY_PAN_BACK'
  ) NOT NULL;

ALTER TABLE admission_applications
  MODIFY COLUMN primary_mobile VARCHAR(16) NULL;

ALTER TABLE admission_references
  MODIFY COLUMN mobile VARCHAR(16) NOT NULL;

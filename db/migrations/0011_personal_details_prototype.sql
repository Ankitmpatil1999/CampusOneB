-- 0011_personal_details_prototype.sql — forward-only migration (D-16). Client 2026-10-03 on m.kyc:
-- "please follow the prototype". The prototype's sheets do not ask for the proof's document type,
-- the bank name or the nominee's date of birth, and take the occupation as text, so those columns
-- become optional and the occupation becomes free text (the ref_occupations list stays as a master).

ALTER TABLE account_addresses MODIFY COLUMN proof_type VARCHAR(24) NULL;
ALTER TABLE account_bank_accounts MODIFY COLUMN bank_name VARCHAR(120) NULL;
ALTER TABLE account_nominees MODIFY COLUMN dob DATE NULL;

ALTER TABLE account_income DROP FOREIGN KEY fk_account_income__occupation;
ALTER TABLE account_income DROP INDEX fk_account_income__occupation;
ALTER TABLE account_income CHANGE COLUMN occupation_code occupation VARCHAR(100) NOT NULL;

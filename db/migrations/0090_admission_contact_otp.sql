-- 0090_admission_contact_otp.sql — forward-only migration (D-16). Client 2026-10-27: the primary
-- contact's mobile on an admission form is verified with a one-time code — the family on the public
-- form, the office at the console or in the staff app ("Send code", the parent reads it out) — before
-- the application is submitted or approved. Approval then makes only that verified contact a Parent
-- member of the school; the other parents on the form keep their CampusOne accounts only.
--
-- * otp_challenges.purpose: ADMISSION_CONTACT, a code to the primary contact's mobile (CampusOne
--   database; every earlier value kept, 0009).
ALTER TABLE otp_challenges
  MODIFY COLUMN purpose ENUM('SIGNUP','DEVICE','CONSOLE_2FA','OPS_2FA','PORTAL_2FA','RECOVERY',
                             'TPIN_RESET','ADMISSION_RESUME','PORTAL_SIGNUP','EMAIL_CHANGE',
                             'ADMISSION_CONTACT') NOT NULL;

-- * admission_applications (CUG database): the mobile the code was verified for, and when. The
--   contact is verified only while this is the application's primary_mobile — another contact or
--   another number un-verifies it without a write.
ALTER TABLE {{CUG}}.admission_applications
  ADD COLUMN contact_verified_mobile VARCHAR(16) NULL AFTER primary_email,
  ADD COLUMN contact_verified_at DATETIME(3) NULL AFTER contact_verified_mobile;

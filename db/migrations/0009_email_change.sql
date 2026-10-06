-- 0009_email_change.sql — forward-only migration (D-16). SRS 6.9, FR-IDN-08, OI-IDN-10; IDN-018/019.
-- A changed e-mail takes effect only after the code sent to the new address is confirmed
-- (prototype m.security: "We'll send a code to the new address to verify it").

ALTER TABLE otp_challenges
  MODIFY COLUMN purpose ENUM('SIGNUP','DEVICE','CONSOLE_2FA','OPS_2FA','PORTAL_2FA','RECOVERY',
                             'TPIN_RESET','ADMISSION_RESUME','PORTAL_SIGNUP','EMAIL_CHANGE') NOT NULL;

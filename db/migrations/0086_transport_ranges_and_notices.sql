-- 0085_transport_ranges_and_notices.sql — forward-only migration (D-16). Client 2026-10-22:
--
-- * The transport fee by distance range as well as per km: transport_fee_rules.mode (PER_KM, as
--   0082, or RANGE) and its ranges (JSON [{uptoKm, yearlyPaise}], each from the one before it);
--   transport_fee_charges.mode records which one a charge used.
-- * Today's bus to everyone with transport, every school day (job transport-daily-notice):
--   transport_allocations.daily_notice_on is the day it was last sent, so a re-run sends nothing
--   twice.
-- * E-mailed notices carry longer texts — the class placement e-mail has each person's app sign-in
--   details: email_outbox.body up to 1,000 characters (a RingPe table).
-- * "Pay online" in the app (FEE-058): a family's own link to the school's payment page is kept as
--   an APP payment request; a notice and its push carry a payment page's full address (its signed
--   token included) as their link, up to 600 characters.
--
-- School tables are in the CUG database ({{CUG}}, ADR-0019).

ALTER TABLE {{CUG}}.transport_fee_rules
  ADD COLUMN mode   ENUM('PER_KM','RANGE') NOT NULL DEFAULT 'PER_KM' AFTER institution_id,
  ADD COLUMN ranges JSON NULL AFTER rate_paise_per_km;

ALTER TABLE {{CUG}}.transport_fee_charges
  ADD COLUMN mode ENUM('PER_KM','RANGE') NOT NULL DEFAULT 'PER_KM' AFTER distance_km;

ALTER TABLE {{CUG}}.transport_allocations
  ADD COLUMN daily_notice_on DATE NULL;

ALTER TABLE email_outbox
  MODIFY body VARCHAR(1000) NOT NULL;

ALTER TABLE {{CUG}}.fee_payment_requests
  MODIFY channel ENUM('LINK','QR','DESK','APP') NOT NULL;

ALTER TABLE notifications
  MODIFY link VARCHAR(600) NULL;

ALTER TABLE push_outbox
  MODIFY link VARCHAR(600) NULL;

-- 0083_collect_fees.sql — forward-only migration (D-16). Client 2026-10-22: "Collect fees" offers
-- Pay now, Send link and Record cash, on the admission fees and on the fee collection alike.
--
-- - Pay now opens the school's payment gateway at the accounts desk for an instalment's outstanding
--   amount — no link is created or sent. The order is kept as a payment request of channel DESK, so
--   the gateway's webhook settles it as it settles a link's (the page may close before the
--   checkout's answer arrives).
-- - Send link shares the payment link in the app as well as by SMS and e-mail: the in-app notice
--   carries the whole link (a signed token makes it some 350 characters), so a notice's text may be
--   longer than 300 characters.
--
-- School tables are in the CUG database ({{CUG}}, ADR-0019); notifications stay in RingPe.

ALTER TABLE {{CUG}}.fee_payment_requests
  MODIFY channel ENUM('LINK','QR','DESK') NOT NULL;

ALTER TABLE notifications
  MODIFY body VARCHAR(1000) NOT NULL;

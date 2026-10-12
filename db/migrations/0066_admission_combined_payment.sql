-- 0066_admission_combined_payment.sql — forward-only migration (D-16). A family that chooses on the
-- form to pay the admission fee now pays it with the application fee in one gateway order (client
-- 2026-10-09): the order is recorded on both fee rows, each still paid with its own receipt and
-- confirmed by Accounts on its own. An order is therefore no longer unique to one row.

ALTER TABLE admission_payments
  DROP INDEX ux_admission_payments__order,
  ADD KEY ix_admission_payments__order (gateway_order_id);

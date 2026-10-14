-- 0074_deactivate_parent_vans.sql — forward-only migration (D-16). The virtual accounts opened for
-- parents — the father, the mother or a guardian — before 0073 are deactivated (client 2026-10-14):
-- a bank credit to one is refused as an invalid virtual account (WAL-012, BNK-002). Only students,
-- staff, teachers and merchants keep an active virtual account. The parents' wallets stay as they
-- are, with any balance.

UPDATE virtual_accounts v
JOIN wallets w ON w.id = v.wallet_id
JOIN member_profiles m ON m.id = w.owner_profile_id
JOIN user_types ut ON ut.id = m.user_type_id
SET v.status = 'INACTIVE'
WHERE ut.category = 'PARENT' AND v.status = 'ACTIVE';

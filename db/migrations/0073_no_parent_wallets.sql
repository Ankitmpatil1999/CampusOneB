-- 0073_no_parent_wallets.sql — forward-only migration (D-16). A parent — the father, the mother or a
-- guardian — gets no wallet and no virtual account of their own (client 2026-10-13): only the
-- student's campus wallet has a virtual account. A new Parent profile now opens nothing, and a
-- corporate code set later opens virtual accounts for the other campus and merchant wallets only.
--
-- Wallets and virtual accounts already opened for parents are left as they are (they may hold money
-- or have movements); the ledger keeps them as before.

DROP TRIGGER IF EXISTS trg_member_profiles__wallets;
CREATE TRIGGER trg_member_profiles__wallets AFTER INSERT ON member_profiles
FOR EACH ROW
BEGIN
  DECLARE v_category VARCHAR(20);
  DECLARE v_no BIGINT UNSIGNED;
  DECLARE v_code VARCHAR(8);
  DECLARE v_wallet BIGINT UNSIGNED;

  SELECT category INTO v_category FROM user_types WHERE id = NEW.user_type_id;

  IF NOT (v_category <=> 'PARENT') THEN
    SELECT next_value INTO v_no FROM wallet_number_sequences WHERE kind = 'CAMPUS' FOR UPDATE;
    UPDATE wallet_number_sequences SET next_value = next_value + 1 WHERE kind = 'CAMPUS';
    INSERT INTO wallets (public_id, institution_id, wallet_no, kind, owner_profile_id, status)
    VALUES (UUID_TO_BIN(UUID()), NEW.institution_id, CAST(v_no AS CHAR),
            IF(v_category = 'MERCHANT', 'MERCHANT', 'CAMPUS'), NEW.id, NEW.status);
    SET v_wallet = LAST_INSERT_ID();
    INSERT INTO wallet_balances (wallet_id) VALUES (v_wallet);
    INSERT INTO ledger_accounts (institution_id, kind, wallet_id, name)
    VALUES (NEW.institution_id, 'WALLET', v_wallet, CONCAT('Wallet ', v_no));
    SELECT corporate_code INTO v_code FROM institutions WHERE id = NEW.institution_id;
    IF v_code IS NOT NULL THEN
      INSERT INTO virtual_accounts (institution_id, wallet_id, corporate_code, va_number)
      VALUES (NEW.institution_id, v_wallet, v_code, CONCAT(v_code, v_no));
    END IF;

    IF v_category <> 'MERCHANT' THEN
      SELECT next_value INTO v_no FROM wallet_number_sequences WHERE kind = 'ALLOWANCE' FOR UPDATE;
      UPDATE wallet_number_sequences SET next_value = next_value + 1 WHERE kind = 'ALLOWANCE';
      INSERT INTO wallets (public_id, institution_id, wallet_no, kind, owner_profile_id, status)
      VALUES (UUID_TO_BIN(UUID()), NEW.institution_id, CAST(v_no AS CHAR), 'ALLOWANCE', NEW.id, 'INACTIVE');
      SET v_wallet = LAST_INSERT_ID();
      INSERT INTO wallet_balances (wallet_id) VALUES (v_wallet);
      INSERT INTO ledger_accounts (institution_id, kind, wallet_id, name)
      VALUES (NEW.institution_id, 'WALLET', v_wallet, CONCAT('Wallet ', v_no));
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS trg_institutions__virtual_accounts;
CREATE TRIGGER trg_institutions__virtual_accounts AFTER UPDATE ON institutions
FOR EACH ROW
BEGIN
  IF NEW.corporate_code IS NOT NULL AND NOT (OLD.corporate_code <=> NEW.corporate_code) THEN
    INSERT INTO virtual_accounts (institution_id, wallet_id, corporate_code, va_number)
    SELECT w.institution_id, w.id, NEW.corporate_code, CONCAT(NEW.corporate_code, w.wallet_no)
    FROM wallets w
    LEFT JOIN virtual_accounts v ON v.wallet_id = w.id
    LEFT JOIN member_profiles m ON m.id = w.owner_profile_id
    LEFT JOIN user_types ut ON ut.id = m.user_type_id
    WHERE w.institution_id = NEW.id AND w.kind IN ('CAMPUS', 'MERCHANT') AND v.id IS NULL
      AND NOT (ut.category <=> 'PARENT');
  END IF;
END;

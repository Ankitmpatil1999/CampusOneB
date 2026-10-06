-- 0028_wallet_triggers.sql — forward-only migration (D-16). Every institution profile gets its
-- wallets however it is created (console, sheet, staff, registration, portal sign-up, seeds), and a
-- wallet follows its holder's status (RC-02, RNG-WAL-180):
--
-- - a new profile: a campus wallet (a merchant's wallet for a merchant) in the holder's status, with
--   its balance row, ledger account and — when the institution has a corporate code — its virtual
--   account; and an allowance wallet, Inactive until the allowance job first credits it;
-- - a status change of the holder: the campus wallet takes the same status; the allowance wallet
--   too, except that an allowance wallet never credited stays Inactive;
-- - the institution's corporate code is set: virtual accounts open for its campus wallets.
--
-- Numbers come from wallet_number_sequences (27.4); the row lock serialises numbering.

CREATE TRIGGER trg_member_profiles__wallets AFTER INSERT ON member_profiles
FOR EACH ROW
BEGIN
  DECLARE v_category VARCHAR(20);
  DECLARE v_no BIGINT UNSIGNED;
  DECLARE v_code VARCHAR(8);
  DECLARE v_wallet BIGINT UNSIGNED;

  SELECT category INTO v_category FROM user_types WHERE id = NEW.user_type_id;

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
END;

CREATE TRIGGER trg_member_profiles__wallet_status AFTER UPDATE ON member_profiles
FOR EACH ROW
BEGIN
  IF NEW.status <> OLD.status THEN
    UPDATE wallets
    SET status = NEW.status, status_reason = NEW.status_reason, status_changed_at = UTC_TIMESTAMP(3),
        row_version = row_version + 1, updated_at = UTC_TIMESTAMP(3)
    WHERE owner_profile_id = NEW.id AND kind IN ('CAMPUS', 'MERCHANT');
    UPDATE wallets w
    SET w.status = IF(NEW.status <> 'ACTIVE', NEW.status,
                      IF(EXISTS (SELECT 1 FROM ledger_entries e WHERE e.wallet_id = w.id), 'ACTIVE', 'INACTIVE')),
        w.status_changed_at = UTC_TIMESTAMP(3), w.row_version = w.row_version + 1,
        w.updated_at = UTC_TIMESTAMP(3)
    WHERE w.owner_profile_id = NEW.id AND w.kind = 'ALLOWANCE';
  END IF;
END;

CREATE TRIGGER trg_institutions__virtual_accounts AFTER UPDATE ON institutions
FOR EACH ROW
BEGIN
  IF NEW.corporate_code IS NOT NULL AND NOT (OLD.corporate_code <=> NEW.corporate_code) THEN
    INSERT INTO virtual_accounts (institution_id, wallet_id, corporate_code, va_number)
    SELECT w.institution_id, w.id, NEW.corporate_code, CONCAT(NEW.corporate_code, w.wallet_no)
    FROM wallets w
    LEFT JOIN virtual_accounts v ON v.wallet_id = w.id
    WHERE w.institution_id = NEW.id AND w.kind IN ('CAMPUS', 'MERCHANT') AND v.id IS NULL;
  END IF;
END;

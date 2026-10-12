-- RingPe database triggers: 36 triggers, generated from a migrated database by
-- scripts/export-triggers.ts. Do not edit by hand; the migrations (db/migrations) are the source.
--
-- Before running:
--   * the tables must exist (run `npm run migrate`, or load the schema first);
--   * the MySQL user needs the TRIGGER privilege on the database;
--   * with binary logging on and a user without SUPER, set once as an administrator:
--       SET GLOBAL log_bin_trust_function_creators = 1;
--
-- Run (MySQL client):  mysql -u <user> -p <database> < create-triggers.sql
-- MySQL Workbench:     open this file with the database selected and run it all (Ctrl+Shift+Enter).

SET NAMES utf8mb4;
DELIMITER $$

-- approval_requests
DROP TRIGGER IF EXISTS `trg_approval_requests__seq`$$
CREATE TRIGGER `trg_approval_requests__seq` BEFORE INSERT ON `approval_requests` FOR EACH ROW BEGIN
  SET NEW.request_seq = IF(
      NEW.request_seq IS NULL OR NEW.request_seq = 0,
      (SELECT COALESCE(MAX(r.request_seq), 0) + 1 FROM approval_requests r
        WHERE r.seq_scope = COALESCE(NEW.institution_id, 0)),
      NEW.request_seq
    );
END$$

-- approval_requests
DROP TRIGGER IF EXISTS `trg_approval_requests__no_delete`$$
CREATE TRIGGER `trg_approval_requests__no_delete` BEFORE DELETE ON `approval_requests` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_requests are never deleted'$$

-- audit_log
DROP TRIGGER IF EXISTS `trg_audit_log__no_update`$$
CREATE TRIGGER `trg_audit_log__no_update` BEFORE UPDATE ON `audit_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
END$$

-- audit_log
DROP TRIGGER IF EXISTS `trg_audit_log__no_delete`$$
CREATE TRIGGER `trg_audit_log__no_delete` BEFORE DELETE ON `audit_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
END$$

-- bank_credits
DROP TRIGGER IF EXISTS `trg_bank_credits__no_delete`$$
CREATE TRIGGER `trg_bank_credits__no_delete` BEFORE DELETE ON `bank_credits` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_credits is append-only'$$

-- bank_va_validations
DROP TRIGGER IF EXISTS `trg_bank_va_validations__no_update`$$
CREATE TRIGGER `trg_bank_va_validations__no_update` BEFORE UPDATE ON `bank_va_validations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_va_validations is append-only';
END$$

-- bank_va_validations
DROP TRIGGER IF EXISTS `trg_bank_va_validations__no_delete`$$
CREATE TRIGGER `trg_bank_va_validations__no_delete` BEFORE DELETE ON `bank_va_validations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_va_validations is append-only';
END$$

-- cancellation_requests
DROP TRIGGER IF EXISTS `trg_cancellation_requests__no_delete`$$
CREATE TRIGGER `trg_cancellation_requests__no_delete` BEFORE DELETE ON `cancellation_requests` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cancellation_requests are never deleted'$$

-- consents
DROP TRIGGER IF EXISTS `trg_consents__no_update`$$
CREATE TRIGGER `trg_consents__no_update` BEFORE UPDATE ON `consents` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';
END$$

-- consents
DROP TRIGGER IF EXISTS `trg_consents__no_delete`$$
CREATE TRIGGER `trg_consents__no_delete` BEFORE DELETE ON `consents` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';
END$$

-- cross_institution_access_record
DROP TRIGGER IF EXISTS `trg_xiar__no_update`$$
CREATE TRIGGER `trg_xiar__no_update` BEFORE UPDATE ON `cross_institution_access_record` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cross_institution_access_record is append-only';
END$$

-- cross_institution_access_record
DROP TRIGGER IF EXISTS `trg_xiar__no_delete`$$
CREATE TRIGGER `trg_xiar__no_delete` BEFORE DELETE ON `cross_institution_access_record` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cross_institution_access_record is append-only';
END$$

-- feature_change_log
DROP TRIGGER IF EXISTS `trg_feature_change_log__no_update`$$
CREATE TRIGGER `trg_feature_change_log__no_update` BEFORE UPDATE ON `feature_change_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';
END$$

-- feature_change_log
DROP TRIGGER IF EXISTS `trg_feature_change_log__no_delete`$$
CREATE TRIGGER `trg_feature_change_log__no_delete` BEFORE DELETE ON `feature_change_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';
END$$

-- institution_lifecycle_events
DROP TRIGGER IF EXISTS `trg_institution_lifecycle_events__no_update`$$
CREATE TRIGGER `trg_institution_lifecycle_events__no_update` BEFORE UPDATE ON `institution_lifecycle_events` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';
END$$

-- institution_lifecycle_events
DROP TRIGGER IF EXISTS `trg_institution_lifecycle_events__no_delete`$$
CREATE TRIGGER `trg_institution_lifecycle_events__no_delete` BEFORE DELETE ON `institution_lifecycle_events` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';
END$$

-- institutions
DROP TRIGGER IF EXISTS `trg_institutions__virtual_accounts`$$
CREATE TRIGGER `trg_institutions__virtual_accounts` AFTER UPDATE ON `institutions` FOR EACH ROW BEGIN
  IF NEW.corporate_code IS NOT NULL AND NOT (OLD.corporate_code <=> NEW.corporate_code) THEN
    INSERT INTO virtual_accounts (institution_id, wallet_id, corporate_code, va_number)
    SELECT w.institution_id, w.id, NEW.corporate_code, CONCAT(NEW.corporate_code, w.wallet_no)
    FROM wallets w
    LEFT JOIN virtual_accounts v ON v.wallet_id = w.id
    WHERE w.institution_id = NEW.id AND w.kind IN ('CAMPUS', 'MERCHANT') AND v.id IS NULL;
  END IF;
END$$

-- invoice_payments
DROP TRIGGER IF EXISTS `trg_invoice_payments__no_update`$$
CREATE TRIGGER `trg_invoice_payments__no_update` BEFORE UPDATE ON `invoice_payments` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_payments is append-only';
END$$

-- invoice_payments
DROP TRIGGER IF EXISTS `trg_invoice_payments__no_delete`$$
CREATE TRIGGER `trg_invoice_payments__no_delete` BEFORE DELETE ON `invoice_payments` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_payments is append-only'$$

-- ledger_entries
DROP TRIGGER IF EXISTS `trg_ledger_entries__no_update`$$
CREATE TRIGGER `trg_ledger_entries__no_update` BEFORE UPDATE ON `ledger_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
END$$

-- ledger_entries
DROP TRIGGER IF EXISTS `trg_ledger_entries__no_delete`$$
CREATE TRIGGER `trg_ledger_entries__no_delete` BEFORE DELETE ON `ledger_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
END$$

-- ledger_idempotency
DROP TRIGGER IF EXISTS `trg_ledger_idempotency__no_delete`$$
CREATE TRIGGER `trg_ledger_idempotency__no_delete` BEFORE DELETE ON `ledger_idempotency` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_idempotency is append-only';
END$$

-- ledger_transactions
DROP TRIGGER IF EXISTS `trg_ledger_txn__no_update`$$
CREATE TRIGGER `trg_ledger_txn__no_update` BEFORE UPDATE ON `ledger_transactions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
END$$

-- ledger_transactions
DROP TRIGGER IF EXISTS `trg_ledger_txn__no_delete`$$
CREATE TRIGGER `trg_ledger_txn__no_delete` BEFORE DELETE ON `ledger_transactions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
END$$

-- member_profiles
DROP TRIGGER IF EXISTS `trg_member_profiles__seq`$$
CREATE TRIGGER `trg_member_profiles__seq` BEFORE INSERT ON `member_profiles` FOR EACH ROW SET NEW.member_seq = IF(
    NEW.member_seq IS NULL OR NEW.member_seq = 0,
    (SELECT COALESCE(MAX(p.member_seq), 0) + 1 FROM member_profiles p WHERE p.institution_id = NEW.institution_id),
    NEW.member_seq
  )$$

-- member_profiles
DROP TRIGGER IF EXISTS `trg_member_profiles__wallets`$$
CREATE TRIGGER `trg_member_profiles__wallets` AFTER INSERT ON `member_profiles` FOR EACH ROW BEGIN
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
END$$

-- member_profiles
DROP TRIGGER IF EXISTS `trg_member_profiles__wallet_status`$$
CREATE TRIGGER `trg_member_profiles__wallet_status` AFTER UPDATE ON `member_profiles` FOR EACH ROW BEGIN
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
END$$

-- payment_attempts
DROP TRIGGER IF EXISTS `trg_payment_attempts__forward`$$
CREATE TRIGGER `trg_payment_attempts__forward` BEFORE UPDATE ON `payment_attempts` FOR EACH ROW BEGIN
  IF OLD.status <> 'PENDING' OR OLD.amount_paise <> NEW.amount_paise
     OR OLD.payer_profile_id <> NEW.payer_profile_id OR OLD.payee_profile_id <> NEW.payee_profile_id
     OR OLD.reference <> NEW.reference THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_attempts: only a PENDING record may change status';
  END IF;
END$$

-- payment_attempts
DROP TRIGGER IF EXISTS `trg_payment_attempts__no_delete`$$
CREATE TRIGGER `trg_payment_attempts__no_delete` BEFORE DELETE ON `payment_attempts` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_attempts is append-only';
END$$

-- pii_correction_requests
DROP TRIGGER IF EXISTS `trg_pii_correction_requests__no_delete`$$
CREATE TRIGGER `trg_pii_correction_requests__no_delete` BEFORE DELETE ON `pii_correction_requests` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pii_correction_requests is append-only';
END$$

-- plan_versions
DROP TRIGGER IF EXISTS `trg_plan_versions__no_update`$$
CREATE TRIGGER `trg_plan_versions__no_update` BEFORE UPDATE ON `plan_versions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'plan_versions is append-only';
END$$

-- plan_versions
DROP TRIGGER IF EXISTS `trg_plan_versions__no_delete`$$
CREATE TRIGGER `trg_plan_versions__no_delete` BEFORE DELETE ON `plan_versions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'plan_versions is append-only';
END$$

-- platform_setting_changes
DROP TRIGGER IF EXISTS `trg_psc__no_update`$$
CREATE TRIGGER `trg_psc__no_update` BEFORE UPDATE ON `platform_setting_changes` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_setting_changes is append-only';
END$$

-- platform_setting_changes
DROP TRIGGER IF EXISTS `trg_psc__no_delete`$$
CREATE TRIGGER `trg_psc__no_delete` BEFORE DELETE ON `platform_setting_changes` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_setting_changes is append-only';
END$$

-- role_change_log
DROP TRIGGER IF EXISTS `trg_role_change_log__no_update`$$
CREATE TRIGGER `trg_role_change_log__no_update` BEFORE UPDATE ON `role_change_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_change_log is append-only';
END$$

-- role_change_log
DROP TRIGGER IF EXISTS `trg_role_change_log__no_delete`$$
CREATE TRIGGER `trg_role_change_log__no_delete` BEFORE DELETE ON `role_change_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_change_log is append-only';
END$$

DELIMITER ;

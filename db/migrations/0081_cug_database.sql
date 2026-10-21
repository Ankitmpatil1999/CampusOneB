-- 0081_cug_database.sql — forward-only migration (D-16). Client 2026-10-21: "separate the RingPe
-- database and the CUG database … it should not affect the functionalities running now; divide the
-- tables into two databases".
--
-- The school tables (db/cug-tables.ts, 158 tables) move to the CUG database beside this one —
-- {{CUG}} is filled in by the migrator: `ringpe` → `ringpe_cug`. Both stay on the same MySQL server,
-- so one connection, one transaction and the foreign keys still span them (RENAME TABLE keeps every
-- foreign key, in both directions). The application keeps writing plain table names: CugSchemaPlugin
-- (models/cug-schema-plugin.ts) sends the CUG tables to the CUG database.
--
-- MySQL does not move a table that has triggers: the 19 triggers of the school tables are dropped,
-- the tables are moved in one RENAME (atomic: all or none), and the triggers are created again in the
-- CUG database exactly as they were (their bodies name only CUG tables, which a trigger finds in its
-- own database), in their order.
--
-- Deployment: stop the API and the worker, take a backup, run the migration, start the new build.
-- A least-privilege database user needs the same rights on the CUG database (infra/mysql/local-setup.sql).

CREATE DATABASE IF NOT EXISTS {{CUG}} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `trg_bank_credits__no_delete`;
DROP TRIGGER IF EXISTS `trg_bank_va_validations__no_update`;
DROP TRIGGER IF EXISTS `trg_bank_va_validations__no_delete`;
DROP TRIGGER IF EXISTS `trg_cancellation_requests__no_delete`;
DROP TRIGGER IF EXISTS `trg_feature_change_log__no_update`;
DROP TRIGGER IF EXISTS `trg_feature_change_log__no_delete`;
DROP TRIGGER IF EXISTS `trg_institution_lifecycle_events__no_update`;
DROP TRIGGER IF EXISTS `trg_institution_lifecycle_events__no_delete`;
DROP TRIGGER IF EXISTS `trg_institutions__virtual_accounts`;
DROP TRIGGER IF EXISTS `trg_ledger_entries__no_update`;
DROP TRIGGER IF EXISTS `trg_ledger_entries__no_delete`;
DROP TRIGGER IF EXISTS `trg_ledger_idempotency__no_delete`;
DROP TRIGGER IF EXISTS `trg_ledger_txn__no_update`;
DROP TRIGGER IF EXISTS `trg_ledger_txn__no_delete`;
DROP TRIGGER IF EXISTS `trg_member_profiles__seq`;
DROP TRIGGER IF EXISTS `trg_member_profiles__wallets`;
DROP TRIGGER IF EXISTS `trg_member_profiles__wallet_status`;
DROP TRIGGER IF EXISTS `trg_payment_attempts__forward`;
DROP TRIGGER IF EXISTS `trg_payment_attempts__no_delete`;

RENAME TABLE
  `institutions` TO {{CUG}}.`institutions`,
  `institution_contacts` TO {{CUG}}.`institution_contacts`,
  `institution_settings` TO {{CUG}}.`institution_settings`,
  `institution_lifecycle_events` TO {{CUG}}.`institution_lifecycle_events`,
  `institution_comm_events` TO {{CUG}}.`institution_comm_events`,
  `institution_corporate_codes` TO {{CUG}}.`institution_corporate_codes`,
  `institution_payment_gateways` TO {{CUG}}.`institution_payment_gateways`,
  `class_corporate_codes` TO {{CUG}}.`class_corporate_codes`,
  `feature_toggles` TO {{CUG}}.`feature_toggles`,
  `feature_change_log` TO {{CUG}}.`feature_change_log`,
  `notification_channel_settings` TO {{CUG}}.`notification_channel_settings`,
  `onboarding_checklist_steps` TO {{CUG}}.`onboarding_checklist_steps`,
  `cancellation_requests` TO {{CUG}}.`cancellation_requests`,
  `data_exports` TO {{CUG}}.`data_exports`,
  `custom_field_definitions` TO {{CUG}}.`custom_field_definitions`,
  `custom_field_options` TO {{CUG}}.`custom_field_options`,
  `custom_field_values` TO {{CUG}}.`custom_field_values`,
  `custom_field_value_options` TO {{CUG}}.`custom_field_value_options`,
  `user_types` TO {{CUG}}.`user_types`,
  `departments` TO {{CUG}}.`departments`,
  `member_profiles` TO {{CUG}}.`member_profiles`,
  `member_uploads` TO {{CUG}}.`member_uploads`,
  `guardianships` TO {{CUG}}.`guardianships`,
  `profile_roles` TO {{CUG}}.`profile_roles`,
  `academic_years` TO {{CUG}}.`academic_years`,
  `classes` TO {{CUG}}.`classes`,
  `sections` TO {{CUG}}.`sections`,
  `subjects` TO {{CUG}}.`subjects`,
  `class_subjects` TO {{CUG}}.`class_subjects`,
  `periods` TO {{CUG}}.`periods`,
  `timetable_slots` TO {{CUG}}.`timetable_slots`,
  `teacher_assignments` TO {{CUG}}.`teacher_assignments`,
  `enrolments` TO {{CUG}}.`enrolments`,
  `enrolment_changes` TO {{CUG}}.`enrolment_changes`,
  `rollovers` TO {{CUG}}.`rollovers`,
  `rollover_items` TO {{CUG}}.`rollover_items`,
  `calendar_entries` TO {{CUG}}.`calendar_entries`,
  `calendar_entry_targets` TO {{CUG}}.`calendar_entry_targets`,
  `exam_names` TO {{CUG}}.`exam_names`,
  `exams` TO {{CUG}}.`exams`,
  `marks` TO {{CUG}}.`marks`,
  `homework` TO {{CUG}}.`homework`,
  `homework_students` TO {{CUG}}.`homework_students`,
  `homework_submissions` TO {{CUG}}.`homework_submissions`,
  `student_leaves` TO {{CUG}}.`student_leaves`,
  `staff_leaves` TO {{CUG}}.`staff_leaves`,
  `quiz_attempts` TO {{CUG}}.`quiz_attempts`,
  `quiz_attempt_questions` TO {{CUG}}.`quiz_attempt_questions`,
  `attendance_types` TO {{CUG}}.`attendance_types`,
  `attendance_days` TO {{CUG}}.`attendance_days`,
  `attendance_events` TO {{CUG}}.`attendance_events`,
  `period_attendance` TO {{CUG}}.`period_attendance`,
  `location_attendance` TO {{CUG}}.`location_attendance`,
  `auto_absent_settings` TO {{CUG}}.`auto_absent_settings`,
  `auto_absent_runs` TO {{CUG}}.`auto_absent_runs`,
  `terminals` TO {{CUG}}.`terminals`,
  `terminal_changes` TO {{CUG}}.`terminal_changes`,
  `terminal_nonces` TO {{CUG}}.`terminal_nonces`,
  `cards` TO {{CUG}}.`cards`,
  `card_writes` TO {{CUG}}.`card_writes`,
  `visitors` TO {{CUG}}.`visitors`,
  `transport_routes` TO {{CUG}}.`transport_routes`,
  `transport_stops` TO {{CUG}}.`transport_stops`,
  `transport_route_stops` TO {{CUG}}.`transport_route_stops`,
  `transport_vehicles` TO {{CUG}}.`transport_vehicles`,
  `transport_crew` TO {{CUG}}.`transport_crew`,
  `transport_assignments` TO {{CUG}}.`transport_assignments`,
  `transport_allocations` TO {{CUG}}.`transport_allocations`,
  `transport_sessions` TO {{CUG}}.`transport_sessions`,
  `transport_trips` TO {{CUG}}.`transport_trips`,
  `transport_trip_stops` TO {{CUG}}.`transport_trip_stops`,
  `transport_trip_events` TO {{CUG}}.`transport_trip_events`,
  `transport_boardings` TO {{CUG}}.`transport_boardings`,
  `admission_links` TO {{CUG}}.`admission_links`,
  `admission_applications` TO {{CUG}}.`admission_applications`,
  `admission_application_seq` TO {{CUG}}.`admission_application_seq`,
  `admission_documents` TO {{CUG}}.`admission_documents`,
  `admission_references` TO {{CUG}}.`admission_references`,
  `admission_payments` TO {{CUG}}.`admission_payments`,
  `admission_imports` TO {{CUG}}.`admission_imports`,
  `fee_heads` TO {{CUG}}.`fee_heads`,
  `fee_structures` TO {{CUG}}.`fee_structures`,
  `fee_structure_versions` TO {{CUG}}.`fee_structure_versions`,
  `fee_structure_classes` TO {{CUG}}.`fee_structure_classes`,
  `fee_structure_heads` TO {{CUG}}.`fee_structure_heads`,
  `fee_structure_instalments` TO {{CUG}}.`fee_structure_instalments`,
  `fee_assignments` TO {{CUG}}.`fee_assignments`,
  `fee_records` TO {{CUG}}.`fee_records`,
  `fee_record_heads` TO {{CUG}}.`fee_record_heads`,
  `fee_uploads` TO {{CUG}}.`fee_uploads`,
  `fee_collections` TO {{CUG}}.`fee_collections`,
  `fee_collection_attempts` TO {{CUG}}.`fee_collection_attempts`,
  `fee_payment_requests` TO {{CUG}}.`fee_payment_requests`,
  `fee_consents` TO {{CUG}}.`fee_consents`,
  `fee_financing_registrations` TO {{CUG}}.`fee_financing_registrations`,
  `fee_financing_records` TO {{CUG}}.`fee_financing_records`,
  `entry_fees` TO {{CUG}}.`entry_fees`,
  `wallets` TO {{CUG}}.`wallets`,
  `wallet_balances` TO {{CUG}}.`wallet_balances`,
  `wallet_day_balances` TO {{CUG}}.`wallet_day_balances`,
  `wallet_number_sequences` TO {{CUG}}.`wallet_number_sequences`,
  `virtual_accounts` TO {{CUG}}.`virtual_accounts`,
  `ledger_accounts` TO {{CUG}}.`ledger_accounts`,
  `ledger_transactions` TO {{CUG}}.`ledger_transactions`,
  `ledger_entries` TO {{CUG}}.`ledger_entries`,
  `ledger_idempotency` TO {{CUG}}.`ledger_idempotency`,
  `payment_attempts` TO {{CUG}}.`payment_attempts`,
  `payment_requests` TO {{CUG}}.`payment_requests`,
  `refunds` TO {{CUG}}.`refunds`,
  `chargebacks` TO {{CUG}}.`chargebacks`,
  `bank_credits` TO {{CUG}}.`bank_credits`,
  `bank_va_validations` TO {{CUG}}.`bank_va_validations`,
  `allowance_grants` TO {{CUG}}.`allowance_grants`,
  `merchants` TO {{CUG}}.`merchants`,
  `merchant_qr_codes` TO {{CUG}}.`merchant_qr_codes`,
  `merchant_asset_groups` TO {{CUG}}.`merchant_asset_groups`,
  `asset_groups` TO {{CUG}}.`asset_groups`,
  `assets` TO {{CUG}}.`assets`,
  `pos_outlets` TO {{CUG}}.`pos_outlets`,
  `pos_categories` TO {{CUG}}.`pos_categories`,
  `pos_items` TO {{CUG}}.`pos_items`,
  `pos_orders` TO {{CUG}}.`pos_orders`,
  `pos_order_lines` TO {{CUG}}.`pos_order_lines`,
  `pos_operator_tags` TO {{CUG}}.`pos_operator_tags`,
  `pos_offline_batches` TO {{CUG}}.`pos_offline_batches`,
  `pos_offline_batch_items` TO {{CUG}}.`pos_offline_batch_items`,
  `pos_offline_captures` TO {{CUG}}.`pos_offline_captures`,
  `coupon_types` TO {{CUG}}.`coupon_types`,
  `coupon_type_merchants` TO {{CUG}}.`coupon_type_merchants`,
  `coupon_slots` TO {{CUG}}.`coupon_slots`,
  `coupons` TO {{CUG}}.`coupons`,
  `coupon_issuances` TO {{CUG}}.`coupon_issuances`,
  `coupon_redemptions` TO {{CUG}}.`coupon_redemptions`,
  `coupon_taps` TO {{CUG}}.`coupon_taps`,
  `events` TO {{CUG}}.`events`,
  `event_heads` TO {{CUG}}.`event_heads`,
  `entry_passes` TO {{CUG}}.`entry_passes`,
  `entry_pass_scans` TO {{CUG}}.`entry_pass_scans`,
  `settlements` TO {{CUG}}.`settlements`,
  `settlement_lines` TO {{CUG}}.`settlement_lines`,
  `recon_statements` TO {{CUG}}.`recon_statements`,
  `recon_statement_rows` TO {{CUG}}.`recon_statement_rows`,
  `recon_mismatches` TO {{CUG}}.`recon_mismatches`,
  `accounting_settings` TO {{CUG}}.`accounting_settings`,
  `accounting_mappings` TO {{CUG}}.`accounting_mappings`,
  `accounting_vouchers` TO {{CUG}}.`accounting_vouchers`,
  `announcement_categories` TO {{CUG}}.`announcement_categories`,
  `announcements` TO {{CUG}}.`announcements`,
  `announcement_recipients` TO {{CUG}}.`announcement_recipients`,
  `conversations` TO {{CUG}}.`conversations`,
  `conversation_participants` TO {{CUG}}.`conversation_participants`,
  `direct_messages` TO {{CUG}}.`direct_messages`,
  `comm_log_daily` TO {{CUG}}.`comm_log_daily`,
  `comm_log_daily_done` TO {{CUG}}.`comm_log_daily_done`,
  `comm_log_gaps` TO {{CUG}}.`comm_log_gaps`,
  `tickets` TO {{CUG}}.`tickets`,
  `ticket_events` TO {{CUG}}.`ticket_events`,
  `call_logs` TO {{CUG}}.`call_logs`;

-- bank_credits
CREATE TRIGGER {{CUG}}.`trg_bank_credits__no_delete` BEFORE DELETE ON {{CUG}}.`bank_credits` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_credits is append-only';
END;

-- bank_va_validations
CREATE TRIGGER {{CUG}}.`trg_bank_va_validations__no_update` BEFORE UPDATE ON {{CUG}}.`bank_va_validations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_va_validations is append-only';
END;

-- bank_va_validations
CREATE TRIGGER {{CUG}}.`trg_bank_va_validations__no_delete` BEFORE DELETE ON {{CUG}}.`bank_va_validations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_va_validations is append-only';
END;

-- cancellation_requests
CREATE TRIGGER {{CUG}}.`trg_cancellation_requests__no_delete` BEFORE DELETE ON {{CUG}}.`cancellation_requests` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cancellation_requests are never deleted';
END;

-- feature_change_log
CREATE TRIGGER {{CUG}}.`trg_feature_change_log__no_update` BEFORE UPDATE ON {{CUG}}.`feature_change_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';
END;

-- feature_change_log
CREATE TRIGGER {{CUG}}.`trg_feature_change_log__no_delete` BEFORE DELETE ON {{CUG}}.`feature_change_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';
END;

-- institution_lifecycle_events
CREATE TRIGGER {{CUG}}.`trg_institution_lifecycle_events__no_update` BEFORE UPDATE ON {{CUG}}.`institution_lifecycle_events` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';
END;

-- institution_lifecycle_events
CREATE TRIGGER {{CUG}}.`trg_institution_lifecycle_events__no_delete` BEFORE DELETE ON {{CUG}}.`institution_lifecycle_events` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';
END;

-- institutions
CREATE TRIGGER {{CUG}}.`trg_institutions__virtual_accounts` AFTER UPDATE ON {{CUG}}.`institutions` FOR EACH ROW BEGIN
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

-- ledger_entries
CREATE TRIGGER {{CUG}}.`trg_ledger_entries__no_update` BEFORE UPDATE ON {{CUG}}.`ledger_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
END;

-- ledger_entries
CREATE TRIGGER {{CUG}}.`trg_ledger_entries__no_delete` BEFORE DELETE ON {{CUG}}.`ledger_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
END;

-- ledger_idempotency
CREATE TRIGGER {{CUG}}.`trg_ledger_idempotency__no_delete` BEFORE DELETE ON {{CUG}}.`ledger_idempotency` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_idempotency is append-only';
END;

-- ledger_transactions
CREATE TRIGGER {{CUG}}.`trg_ledger_txn__no_update` BEFORE UPDATE ON {{CUG}}.`ledger_transactions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
END;

-- ledger_transactions
CREATE TRIGGER {{CUG}}.`trg_ledger_txn__no_delete` BEFORE DELETE ON {{CUG}}.`ledger_transactions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
END;

-- member_profiles
CREATE TRIGGER {{CUG}}.`trg_member_profiles__seq` BEFORE INSERT ON {{CUG}}.`member_profiles` FOR EACH ROW
BEGIN
  SET NEW.member_seq = IF(
    NEW.member_seq IS NULL OR NEW.member_seq = 0,
    (SELECT COALESCE(MAX(p.member_seq), 0) + 1 FROM member_profiles p WHERE p.institution_id = NEW.institution_id),
    NEW.member_seq
  );
END;

-- member_profiles
CREATE TRIGGER {{CUG}}.`trg_member_profiles__wallets` AFTER INSERT ON {{CUG}}.`member_profiles` FOR EACH ROW BEGIN
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

-- member_profiles
CREATE TRIGGER {{CUG}}.`trg_member_profiles__wallet_status` AFTER UPDATE ON {{CUG}}.`member_profiles` FOR EACH ROW BEGIN
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

-- payment_attempts
CREATE TRIGGER {{CUG}}.`trg_payment_attempts__forward` BEFORE UPDATE ON {{CUG}}.`payment_attempts` FOR EACH ROW BEGIN
  IF OLD.status <> 'PENDING' OR OLD.amount_paise <> NEW.amount_paise
     OR OLD.payer_profile_id <> NEW.payer_profile_id OR OLD.payee_profile_id <> NEW.payee_profile_id
     OR OLD.reference <> NEW.reference THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_attempts: only a PENDING record may change status';
  END IF;
END;

-- payment_attempts
CREATE TRIGGER {{CUG}}.`trg_payment_attempts__no_delete` BEFORE DELETE ON {{CUG}}.`payment_attempts` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_attempts is append-only';
END;

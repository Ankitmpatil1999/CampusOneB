-- CampusOne CampusOne database triggers: 17 triggers, generated from a migrated database by
-- scripts/export-triggers.ts. Do not edit by hand; the migrations (db/migrations) are the source.
--
-- Before running:
--   * the tables must exist (run `npm run migrate`, or load the schema first);
--   * the MySQL user needs the TRIGGER privilege on the database;
--   * with binary logging on and a user without SUPER, set once as an administrator:
--       SET GLOBAL log_bin_trust_function_creators = 1;
--
-- Run (MySQL client):  mysql -u <user> -p <CampusOne database, e.g. campusone> < create-triggers.sql
-- MySQL Workbench:     open this file with that database selected and run it all (Ctrl+Shift+Enter).

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

-- invoice_payments
DROP TRIGGER IF EXISTS `trg_invoice_payments__no_update`$$
CREATE TRIGGER `trg_invoice_payments__no_update` BEFORE UPDATE ON `invoice_payments` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_payments is append-only';
END$$

-- invoice_payments
DROP TRIGGER IF EXISTS `trg_invoice_payments__no_delete`$$
CREATE TRIGGER `trg_invoice_payments__no_delete` BEFORE DELETE ON `invoice_payments` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_payments is append-only'$$

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

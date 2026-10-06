-- 0063_trigger_bodies.sql — forward-only migration (D-16). Phase 9.4 (backup and restore drill).
-- The drill found that a dump of the database could not be restored: 25 triggers with a one-statement
-- body (the append-only guards of the ledger, the audit log and the other history tables, and the
-- approval number) were stored with the statement's closing semicolon inside the body. mysqldump
-- wraps a trigger in a version comment, `/*!50003 … */`, and that semicolon ends the statement
-- before the comment closes, so the restore stops with a syntax error (and a forced restore would
-- leave the ledger without its append-only guard). Each is recreated with a BEGIN … END body, the
-- same behaviour, which dumps and restores cleanly. Rule from now on: trigger bodies use BEGIN … END
-- (`migrations.int.spec.ts` checks that no stored body ends with a semicolon).

DROP TRIGGER IF EXISTS trg_approval_requests__seq;
CREATE TRIGGER trg_approval_requests__seq BEFORE INSERT ON approval_requests FOR EACH ROW
BEGIN
  SET NEW.request_seq = IF(
      NEW.request_seq IS NULL OR NEW.request_seq = 0,
      (SELECT COALESCE(MAX(r.request_seq), 0) + 1 FROM approval_requests r
        WHERE r.seq_scope = COALESCE(NEW.institution_id, 0)),
      NEW.request_seq
    );
END;

DROP TRIGGER IF EXISTS trg_audit_log__no_delete;
CREATE TRIGGER trg_audit_log__no_delete BEFORE DELETE ON audit_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
END;

DROP TRIGGER IF EXISTS trg_audit_log__no_update;
CREATE TRIGGER trg_audit_log__no_update BEFORE UPDATE ON audit_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
END;

DROP TRIGGER IF EXISTS trg_consents__no_delete;
CREATE TRIGGER trg_consents__no_delete BEFORE DELETE ON consents FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';
END;

DROP TRIGGER IF EXISTS trg_consents__no_update;
CREATE TRIGGER trg_consents__no_update BEFORE UPDATE ON consents FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';
END;

DROP TRIGGER IF EXISTS trg_xiar__no_delete;
CREATE TRIGGER trg_xiar__no_delete BEFORE DELETE ON cross_institution_access_record FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cross_institution_access_record is append-only';
END;

DROP TRIGGER IF EXISTS trg_xiar__no_update;
CREATE TRIGGER trg_xiar__no_update BEFORE UPDATE ON cross_institution_access_record FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cross_institution_access_record is append-only';
END;

DROP TRIGGER IF EXISTS trg_feature_change_log__no_delete;
CREATE TRIGGER trg_feature_change_log__no_delete BEFORE DELETE ON feature_change_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';
END;

DROP TRIGGER IF EXISTS trg_feature_change_log__no_update;
CREATE TRIGGER trg_feature_change_log__no_update BEFORE UPDATE ON feature_change_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature_change_log is append-only';
END;

DROP TRIGGER IF EXISTS trg_institution_lifecycle_events__no_delete;
CREATE TRIGGER trg_institution_lifecycle_events__no_delete BEFORE DELETE ON institution_lifecycle_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';
END;

DROP TRIGGER IF EXISTS trg_institution_lifecycle_events__no_update;
CREATE TRIGGER trg_institution_lifecycle_events__no_update BEFORE UPDATE ON institution_lifecycle_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'institution_lifecycle_events is append-only';
END;

DROP TRIGGER IF EXISTS trg_invoice_payments__no_update;
CREATE TRIGGER trg_invoice_payments__no_update BEFORE UPDATE ON invoice_payments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_payments is append-only';
END;

DROP TRIGGER IF EXISTS trg_ledger_entries__no_delete;
CREATE TRIGGER trg_ledger_entries__no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
END;

DROP TRIGGER IF EXISTS trg_ledger_entries__no_update;
CREATE TRIGGER trg_ledger_entries__no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only (RNG-GOV-017)';
END;

DROP TRIGGER IF EXISTS trg_ledger_idempotency__no_delete;
CREATE TRIGGER trg_ledger_idempotency__no_delete BEFORE DELETE ON ledger_idempotency FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_idempotency is append-only';
END;

DROP TRIGGER IF EXISTS trg_ledger_txn__no_delete;
CREATE TRIGGER trg_ledger_txn__no_delete BEFORE DELETE ON ledger_transactions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
END;

DROP TRIGGER IF EXISTS trg_ledger_txn__no_update;
CREATE TRIGGER trg_ledger_txn__no_update BEFORE UPDATE ON ledger_transactions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only (RNG-GOV-017)';
END;

DROP TRIGGER IF EXISTS trg_payment_attempts__no_delete;
CREATE TRIGGER trg_payment_attempts__no_delete BEFORE DELETE ON payment_attempts FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_attempts is append-only';
END;

DROP TRIGGER IF EXISTS trg_pii_correction_requests__no_delete;
CREATE TRIGGER trg_pii_correction_requests__no_delete BEFORE DELETE ON pii_correction_requests FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pii_correction_requests is append-only';
END;

DROP TRIGGER IF EXISTS trg_plan_versions__no_delete;
CREATE TRIGGER trg_plan_versions__no_delete BEFORE DELETE ON plan_versions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'plan_versions is append-only';
END;

DROP TRIGGER IF EXISTS trg_plan_versions__no_update;
CREATE TRIGGER trg_plan_versions__no_update BEFORE UPDATE ON plan_versions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'plan_versions is append-only';
END;

DROP TRIGGER IF EXISTS trg_psc__no_delete;
CREATE TRIGGER trg_psc__no_delete BEFORE DELETE ON platform_setting_changes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_setting_changes is append-only';
END;

DROP TRIGGER IF EXISTS trg_psc__no_update;
CREATE TRIGGER trg_psc__no_update BEFORE UPDATE ON platform_setting_changes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_setting_changes is append-only';
END;

DROP TRIGGER IF EXISTS trg_role_change_log__no_delete;
CREATE TRIGGER trg_role_change_log__no_delete BEFORE DELETE ON role_change_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_change_log is append-only';
END;

DROP TRIGGER IF EXISTS trg_role_change_log__no_update;
CREATE TRIGGER trg_role_change_log__no_update BEFORE UPDATE ON role_change_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_change_log is append-only';
END;

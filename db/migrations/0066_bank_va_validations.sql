-- 0066_bank_va_validations.sql — forward-only migration (D-16). Client request 2026-10-12: the Axis
-- Bank Power E-coll APIs ("Updated Axis Bank APIs for Integration", Sabado Technologies), in the
-- bank's own request and answer format, as the earlier application served them.
--
-- - Every validation call the bank makes is logged with its answer (S/F flag and code). A
--   notification is posted only after a successful validation of the same UTR + transaction id
--   (setting `bank.axis.requireValidation`), as before.
-- - The sender's account number is never stored: only its last four digits, as for bank credits.
-- - The log is append-only.

CREATE TABLE bank_va_validations (
  id                     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  api_client_id          BIGINT UNSIGNED  NULL,
  institution_id         BIGINT UNSIGNED  NULL,                   -- NULL when the account isn't ours
  utr                    VARCHAR(32)      NOT NULL,
  bank_txn_id            VARCHAR(40)      NOT NULL,
  va_number              VARCHAR(32)      NOT NULL,
  amount_text            VARCHAR(20)      NULL,                    -- as the bank sent it, e.g. 4999.00
  req_date               VARCHAR(20)      NULL,                    -- as the bank sent it (YYYY-MM-DD)
  pay_mode               VARCHAR(20)      NULL,
  sender_name            VARCHAR(120)     NULL,
  sender_account_last4   CHAR(4)          NULL,
  sender_ifsc            CHAR(11)         NULL,
  status_flag            CHAR(1)          NOT NULL,                -- S success · F failure
  response_code          CHAR(3)          NOT NULL,                -- 000, 002, 003, 006, 999
  ip_bin                 VARBINARY(16)    NULL,
  received_at            DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY ix_bank_va_validations__utr_txn (utr, bank_txn_id, id),
  KEY ix_bank_va_validations__received (received_at),
  CONSTRAINT fk_bank_va_validations__client FOREIGN KEY (api_client_id) REFERENCES api_clients (id),
  CONSTRAINT fk_bank_va_validations__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_bank_va_validations__no_update BEFORE UPDATE ON bank_va_validations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_va_validations is append-only';
END;

CREATE TRIGGER trg_bank_va_validations__no_delete BEFORE DELETE ON bank_va_validations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_va_validations is append-only';
END;

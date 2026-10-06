-- 0017_invoices.sql — forward-only migration (D-16). Phase 2.7: institution invoices and offline
-- payments (FR-SAS-07/08; SAS-030…032; prototype o.plans; Q14 · M14 defaults: due in 15 days, 14 days
-- of grace, GST 18 % — settings `sas.invoice.*`). Status RC-09: Draft · Due · Grace · Overdue · Paid ·
-- Void. Money in paise (ADR-0004).

CREATE TABLE invoices (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NOT NULL,
  invoice_no       VARCHAR(20)     NOT NULL,       -- INV-YYYY-NNNNN
  trigger_kind     ENUM('PLAN_ACTIVATION','RENEWAL','PLAN_CHANGE','USAGE_OVERAGE','MANUAL') NOT NULL,
  period_key       VARCHAR(32)     NOT NULL,       -- one invoice per institution, trigger and period
  period_label     VARCHAR(60)     NOT NULL,
  period_from_on   DATE            NULL,
  period_to_on     DATE            NULL,
  amount_paise     BIGINT UNSIGNED NOT NULL,       -- before GST
  tax_bp           SMALLINT UNSIGNED NOT NULL,     -- GST rate at issue (basis points)
  tax_paise        BIGINT UNSIGNED NOT NULL,
  total_paise      BIGINT UNSIGNED NOT NULL,
  issued_on        DATE            NOT NULL,
  due_on           DATE            NOT NULL,
  grace_until_on   DATE            NOT NULL,
  status           ENUM('DRAFT','DUE','GRACE','OVERDUE','PAID','VOID') NOT NULL DEFAULT 'DUE',  -- RC-09
  paid_at          DATETIME(3)     NULL,
  row_version      INT UNSIGNED    NOT NULL DEFAULT 1,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  created_by       BINARY(16)      NULL,
  updated_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_invoices__public_id (public_id),
  UNIQUE KEY ux_invoices__invoice_no (invoice_no),
  UNIQUE KEY ux_invoices__inst_trigger_period (institution_id, trigger_kind, period_key),
  KEY ix_invoices__inst_status (institution_id, status),
  KEY ix_invoices__status_due (status, due_on),
  CONSTRAINT ck_invoices__total CHECK (total_paise = amount_paise + tax_paise AND amount_paise > 0),
  CONSTRAINT ck_invoices__dates CHECK (due_on >= issued_on AND grace_until_on >= due_on),
  CONSTRAINT fk_invoices__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE invoice_lines (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id    BIGINT UNSIGNED NOT NULL,
  invoice_id        BIGINT UNSIGNED NOT NULL,
  description       VARCHAR(200)    NOT NULL,
  quantity          INT UNSIGNED    NOT NULL,
  unit_price_paise  BIGINT UNSIGNED NOT NULL,
  amount_paise      BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY ix_invoice_lines__inst_invoice (institution_id, invoice_id),
  CONSTRAINT ck_invoice_lines__amount CHECK (amount_paise = quantity * unit_price_paise),
  CONSTRAINT fk_invoice_lines__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_invoice_lines__invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE invoice_payments (                      -- append-only record of money received
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id         BINARY(16)      NOT NULL,
  institution_id    BIGINT UNSIGNED NOT NULL,
  invoice_id        BIGINT UNSIGNED NOT NULL,
  method            ENUM('BANK_TRANSFER','GATEWAY') NOT NULL,
  utr               VARCHAR(22)     NULL,            -- bank reference (bank transfers)
  amount_paise      BIGINT UNSIGNED NOT NULL,
  paid_on           DATE            NOT NULL,
  recorded_by       BINARY(16)      NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_invoice_payments__public_id (public_id),
  UNIQUE KEY ux_invoice_payments__utr (utr),
  KEY ix_invoice_payments__inst_invoice (institution_id, invoice_id),
  CONSTRAINT fk_invoice_payments__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_invoice_payments__invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_invoice_payments__no_update BEFORE UPDATE ON invoice_payments
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_payments is append-only';
CREATE TRIGGER trg_invoice_payments__no_delete BEFORE DELETE ON invoice_payments
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_payments is append-only';

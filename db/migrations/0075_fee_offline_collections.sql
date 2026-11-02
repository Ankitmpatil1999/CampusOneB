-- 0075_fee_offline_collections.sql — forward-only migration (D-16). Accounts collects an instalment
-- in cash, or the family pays it through the school's payment gateway from a payment link or a QR
-- code (client 2026-10-19), besides the collection from the student's wallet:
--
-- * fee_collections keeps those payments too: no payment-engine attempt (the money never passes
--   through the wallet ledger, so it is never settled to the fee account), how it was paid, its
--   receipt number, who paid it, the gateway's transaction ID and who recorded it;
-- * fee_payment_requests: a payment link or QR code for one instalment — the amount asked, where the
--   link was sent, and the gateway order the family pays.

ALTER TABLE fee_collections
  MODIFY payment_attempt_id BIGINT UNSIGNED NULL,
  ADD COLUMN mode ENUM('WALLET','CASH','ONLINE') NOT NULL DEFAULT 'WALLET' AFTER source,
  ADD COLUMN receipt_no VARCHAR(40) NULL AFTER mode,
  ADD COLUMN paid_by VARCHAR(100) NULL AFTER receipt_no,
  ADD COLUMN gateway_payment_id VARCHAR(64) NULL AFTER paid_by,
  ADD COLUMN collected_by BINARY(16) NULL AFTER gateway_payment_id,
  ADD UNIQUE KEY ux_fee_collections__receipt (institution_id, receipt_no);

CREATE TABLE fee_payment_requests (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  record_id           BIGINT UNSIGNED  NOT NULL,
  channel             ENUM('LINK','QR') NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  status              ENUM('OPEN','PAID','CANCELLED') NOT NULL DEFAULT 'OPEN',
  sent_mobile         VARCHAR(20)      NULL,
  sent_email          VARCHAR(254)     NULL,
  gateway_id          BIGINT UNSIGNED  NULL,                          -- NULL: CampusOne's own gateway
  gateway_order_id    VARCHAR(64)      NULL,
  gateway_payment_id  VARCHAR(64)      NULL,
  collection_id       BIGINT UNSIGNED  NULL,
  expires_at          DATETIME(3)      NOT NULL,
  paid_at             DATETIME(3)      NULL,
  created_by          BINARY(16)       NULL,
  created_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at          DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_fee_payment_requests__public_id (public_id),
  KEY ix_fee_payment_requests__record (record_id, status),
  KEY ix_fee_payment_requests__order (gateway_order_id),
  CONSTRAINT fk_fee_payment_requests__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_fee_payment_requests__record FOREIGN KEY (record_id) REFERENCES fee_records (id),
  CONSTRAINT fk_fee_payment_requests__collection FOREIGN KEY (collection_id) REFERENCES fee_collections (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

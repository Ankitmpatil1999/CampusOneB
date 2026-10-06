-- 0046_grievances.sql — forward-only migration (D-16). Phase 6.3: grievances (SRS 16; GRV-001…013;
-- RC-20; OI-GRV-01…11; Q14 M16).
--
-- - A ticket is raised by a member against one of their own movements (a party to it), or is feedback
--   or a fraud report; all three reach the institution's console (OI-GRV-07). One ticket that is not
--   Closed per profile and movement (RNG-GRV-008), guarded by a unique key.
-- - Every change appends a history row; the ticket row keeps the current state. Closed is read-only.
-- - A Priority-1 change waits as an approval request (MKR), not as a ticket status (RC-20); a refund
--   resolution is approved the same way and posts the ledger refund on approval (Q14 M16).
-- - Calls are logged against a ticket by the console or the support desk; the support desk's
--   look-ups are recorded in the audit log with their reason (RNG-GOV-008).

CREATE TABLE tickets (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  ticket_no           VARCHAR(20)      NULL,                          -- TKT- / FBK- / FRD- + 6 digits
  kind                ENUM('TRANSACTION','FEEDBACK','FRAUD') NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,                      -- who raised it
  account_id          BIGINT UNSIGNED  NULL,
  ledger_txn_id       BIGINT UNSIGNED  NULL,
  transaction_ref     CHAR(35)         NULL,
  txn_type            VARCHAR(30)      NULL,
  txn_amount_paise    BIGINT UNSIGNED  NULL,
  txn_at              DATETIME(3)      NULL,
  category            VARCHAR(40)      NULL,
  issue               VARCHAR(1000)    NOT NULL,
  channel             ENUM('APP','WEB','PHONE') NOT NULL,
  status              ENUM('OPEN','ESCALATED_VENDOR','ESCALATED_INTERNAL','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  priority            TINYINT UNSIGNED NOT NULL DEFAULT 2,
  reason_code         VARCHAR(40)      NULL,
  resolution          VARCHAR(500)     NULL,
  comments            VARCHAR(1000)    NULL,
  fraud_at            DATETIME(3)      NULL,
  fraud_location      VARCHAR(200)     NULL,
  attachment_file_id  BIGINT UNSIGNED  NULL,
  refund_id           BIGINT UNSIGNED  NULL,
  created_at          DATETIME(3)      NOT NULL,
  updated_at          DATETIME(3)      NOT NULL,
  closed_at           DATETIME(3)      NULL,
  row_version         INT UNSIGNED     NOT NULL DEFAULT 1,
  open_key            VARCHAR(60) GENERATED ALWAYS AS
                        (IF(status <> 'CLOSED' AND transaction_ref IS NOT NULL AND kind = 'TRANSACTION', CONCAT(profile_id, ':', transaction_ref), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_tickets__public_id (public_id),
  UNIQUE KEY ux_tickets__ticket_no (ticket_no),
  UNIQUE KEY ux_tickets__open (open_key),                             -- one live ticket per profile and transaction
  KEY ix_tickets__inst_status (institution_id, status, created_at),
  KEY ix_tickets__inst_created (institution_id, created_at),
  KEY ix_tickets__profile (profile_id, created_at),
  KEY ix_tickets__txn (institution_id, transaction_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ticket_events (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  ticket_id           BIGINT UNSIGNED  NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  status              ENUM('OPEN','ESCALATED_VENDOR','ESCALATED_INTERNAL','RESOLVED','CLOSED') NOT NULL,
  priority            TINYINT UNSIGNED NOT NULL,
  reason_code         VARCHAR(40)      NULL,
  resolution          VARCHAR(500)     NULL,
  comments            VARCHAR(1000)    NULL,
  actor_type          ENUM('MEMBER','STAFF','OPERATOR','SYSTEM') NOT NULL,
  actor_ref           BINARY(16)       NULL,
  approval_id         BIGINT UNSIGNED  NULL,                          -- the Priority-1 request that applied it
  at                  DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY ix_ticket_events__ticket (ticket_id, id),
  CONSTRAINT fk_ticket_events__ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE call_logs (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  ticket_id           BIGINT UNSIGNED  NULL,                          -- none for a general enquiry
  direction           ENUM('INBOUND','OUTBOUND') NOT NULL,
  caller              VARCHAR(100)     NOT NULL,
  minutes             SMALLINT UNSIGNED NOT NULL,
  summary             VARCHAR(1000)    NOT NULL,                       -- never a PIN, password or code
  source              ENUM('CONSOLE','SUPPORT') NOT NULL,
  logged_by           BINARY(16)       NULL,
  logged_at           DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_call_logs__public_id (public_id),
  KEY ix_call_logs__ticket (ticket_id, id),
  KEY ix_call_logs__inst (institution_id, logged_at),
  CONSTRAINT fk_call_logs__ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Refunds and chargebacks look for an earlier reversal of the same movement.
ALTER TABLE ledger_transactions ADD KEY ix_ledger_txn__reversal (reversal_of_txn_id);

-- 0031_partners_bank_credits.sql — forward-only migration (D-16). Phase 3.5: partner API clients and
-- their tokens (SRS 8.13, 18.2; IDN-043, INT-001…008), the replay guard for signed partner calls, and
-- bank credits to virtual accounts (WAL-010…013; BR-16; RC-12 with CR-08 held credits).
--
-- - A client holds one shared secret, encrypted at field level (ADR-0012): it is checked when the
--   client asks for a token and used to verify the HMAC of every signed call, so it can't be a
--   one-way hash. A rotation keeps the previous secret valid until `previous_valid_until`.
-- - Every token request is logged (issued or refused with the reason). A new token for a client ends
--   its earlier live tokens (27.2 "API client token": 1 → 0 when a new token is issued).
-- - A signed call is accepted once per (client, endpoint, request id); a repeat with the same body
--   returns the stored response (exactly once), a different body is refused.
-- - A bank credit is unique on UTR + bank transaction id (BR-16). An active wallet is credited
--   through the ledger (PROCESSED); a suspended or inactive wallet's credit is HELD — posted to the
--   institution's held-suspense account, never to the wallet — until the suspension is lifted
--   (PROCESSED) or the money is returned on an approved instruction (RETURNED).

CREATE TABLE api_clients (
  id                    BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id             BINARY(16)       NOT NULL,
  client_id             VARCHAR(40)      NOT NULL,                -- rpc_ + 26 base32
  name                  VARCHAR(100)     NOT NULL,
  partner               VARCHAR(40)      NOT NULL,                -- SPONSOR_BANK, PAYMENT_GATEWAY, …
  scopes                JSON             NOT NULL,
  ip_allowlist          JSON             NOT NULL,                -- addresses or IPv4 CIDR blocks
  secret_enc            VARBINARY(512)   NOT NULL,
  previous_secret_enc   VARBINARY(512)   NULL,
  previous_valid_until  DATETIME(3)      NULL,
  secret_rotated_at     DATETIME(3)      NOT NULL,
  status                ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  status_reason         VARCHAR(300)     NULL,
  row_version           INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by            BINARY(16)       NULL,
  created_at            DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at            DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_clients__public_id (public_id),
  UNIQUE KEY ux_api_clients__client_id (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE api_client_tokens (
  id               BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)       NOT NULL,                     -- the token's session id (sid)
  api_client_id    BIGINT UNSIGNED  NOT NULL,
  outcome          ENUM('ISSUED','REFUSED') NOT NULL,
  reason           VARCHAR(40)      NULL,                          -- invalid_client, IP_NOT_ALLOWED, …
  scopes           JSON             NULL,
  ip_bin           VARBINARY(16)    NULL,
  issued_at        DATETIME(3)      NOT NULL,
  expires_at       DATETIME(3)      NULL,
  revoked_at       DATETIME(3)      NULL,
  revoke_reason    VARCHAR(300)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_client_tokens__public_id (public_id),
  KEY ix_api_client_tokens__client_issued (api_client_id, issued_at),
  CONSTRAINT fk_api_client_tokens__client FOREIGN KEY (api_client_id) REFERENCES api_clients (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE partner_requests (
  api_client_id    BIGINT UNSIGNED  NOT NULL,
  endpoint         VARCHAR(40)      NOT NULL,
  request_id       VARCHAR(64)      NOT NULL,
  body_hash        BINARY(32)       NOT NULL,
  status_code      SMALLINT UNSIGNED NULL,
  response         JSON             NULL,
  received_at      DATETIME(3)      NOT NULL,
  PRIMARY KEY (api_client_id, endpoint, request_id),
  KEY ix_partner_requests__received (received_at),
  CONSTRAINT fk_partner_requests__client FOREIGN KEY (api_client_id) REFERENCES api_clients (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE bank_credits (
  id                     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id              BINARY(16)       NOT NULL,
  institution_id         BIGINT UNSIGNED  NULL,                   -- NULL when the account isn't ours
  wallet_id              BIGINT UNSIGNED  NULL,
  va_number              VARCHAR(30)      NOT NULL,
  utr                    VARCHAR(32)      NOT NULL,
  bank_txn_id            VARCHAR(40)      NOT NULL,
  amount_paise           BIGINT UNSIGNED  NOT NULL,
  mode                   ENUM('UPI','IMPS','NEFT','RTGS','OTHER') NOT NULL DEFAULT 'OTHER',
  sender_name            VARCHAR(120)     NULL,
  sender_account_last4   CHAR(4)          NULL,
  sender_ifsc            CHAR(11)         NULL,
  credited_at            DATETIME(3)      NOT NULL,
  status                 ENUM('RECEIVED','PROCESSED','FAILED','HELD','RETURNED') NOT NULL DEFAULT 'RECEIVED',
  response_code          CHAR(3)          NOT NULL,
  ledger_txn_id          BIGINT UNSIGNED  NULL,                   -- the credit (wallet or held suspense)
  release_txn_id         BIGINT UNSIGNED  NULL,                   -- held → wallet, or held → returned
  return_instruction     VARCHAR(60)      NULL,
  status_reason          VARCHAR(300)     NULL,
  api_client_id          BIGINT UNSIGNED  NULL,
  received_at            DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  resolved_at            DATETIME(3)      NULL,
  row_version            INT UNSIGNED     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_bank_credits__public_id (public_id),
  UNIQUE KEY ux_bank_credits__utr_txn (utr, bank_txn_id),        -- BR-16: one credit per bank event
  KEY ix_bank_credits__inst_status (institution_id, status, received_at),
  KEY ix_bank_credits__wallet (wallet_id, received_at),
  CONSTRAINT fk_bank_credits__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_bank_credits__wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT fk_bank_credits__client FOREIGN KEY (api_client_id) REFERENCES api_clients (id),
  CONSTRAINT ck_bank_credits__amount CHECK (amount_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A bank credit is never deleted (RNG-GOV-015).
CREATE TRIGGER trg_bank_credits__no_delete BEFORE DELETE ON bank_credits FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_credits is append-only';

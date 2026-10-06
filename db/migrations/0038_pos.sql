-- 0038_pos.sql — forward-only migration (D-16). Phase 4.6: the canteen point of sale (SRS 12.8–12.10,
-- 9.10; IDN-042, MER-001…012, MER-014…022; prototype t.pos, t.signin).
--
-- - A POS terminal (purpose POS, bound to a regular merchant) serves the merchant's outlet. The outlet
--   is created the first time a POS terminal of the merchant asks for its menu (OI-MER-10: no legacy
--   operation created it); its bank details are the merchant's own (12.1), not a second record.
-- - Categories and items belong to the outlet; names are unique per outlet (the collation ignores
--   case). An item carries its GST slab in basis points (500 = 5 %).
-- - Operators sign in on the terminal with their NFC tag (FR-MER-04). One active tag per operator
--   mobile per outlet; a re-issue writes a new tag, keeps the old one Inactive with the reason and
--   counts the re-issues. Only the tag token's hash is stored.
-- - Orders: the server prices every line from the menu (OI-MER-10: totals were taken from the
--   terminal) and numbers them ORD-MMDD-NNN per outlet and day. An order is paid once, through the
--   payment engine (P3), by a card tap on the counter (NFC request with a one-time nonce), from the
--   allowance wallet, or covered by a meal coupon; no operator wallet (Q14 M7 recommendation).
-- - Offline captures are sent in batches and each is posted once through the engine (OI-MER-12,
--   Q14 M8 recommendation: a capture the member can't afford is refused, never a negative balance).
-- - A POS partner (an API client bound to one institution) creates QR requests for its terminals,
--   polls them and uploads offline captures (MER-014…016).

CREATE TABLE pos_outlets (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)       NOT NULL,
  institution_id       BIGINT UNSIGNED  NOT NULL,
  merchant_profile_id  BIGINT UNSIGNED  NOT NULL,
  name                 VARCHAR(40)      NOT NULL,
  opens_at             TIME             NULL,
  closes_at            TIME             NULL,
  gstin                CHAR(15)         NULL,
  order_day            DATE             NULL,                       -- the day `order_seq` counts
  order_seq            INT UNSIGNED     NOT NULL DEFAULT 0,
  row_version          INT UNSIGNED     NOT NULL DEFAULT 1,
  updated_by           BINARY(16)       NULL,
  created_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at           DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_pos_outlets__public_id (public_id),
  UNIQUE KEY ux_pos_outlets__merchant (merchant_profile_id),
  KEY ix_pos_outlets__institution (institution_id),
  CONSTRAINT fk_pos_outlets__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pos_outlets__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pos_categories (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)       NOT NULL,
  institution_id  BIGINT UNSIGNED  NOT NULL,
  outlet_id       BIGINT UNSIGNED  NOT NULL,
  name            VARCHAR(24)      NOT NULL,
  created_by      BINARY(16)       NULL,
  created_at      DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_pos_categories__public_id (public_id),
  UNIQUE KEY ux_pos_categories__name (outlet_id, name),
  KEY ix_pos_categories__inst_outlet (institution_id, outlet_id),
  CONSTRAINT fk_pos_categories__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pos_categories__outlet FOREIGN KEY (outlet_id) REFERENCES pos_outlets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pos_items (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)       NOT NULL,
  institution_id  BIGINT UNSIGNED  NOT NULL,
  outlet_id       BIGINT UNSIGNED  NOT NULL,
  category_id     BIGINT UNSIGNED  NOT NULL,
  name            VARCHAR(40)      NOT NULL,
  description     VARCHAR(200)     NULL,
  food_type       ENUM('VEG','NON_VEG') NULL,
  price_paise     BIGINT UNSIGNED  NOT NULL,
  gst_bp          SMALLINT UNSIGNED NOT NULL,                     -- 0, 500, 1200, 1800 or 2800
  available       TINYINT(1)       NOT NULL DEFAULT 1,
  row_version     INT UNSIGNED     NOT NULL DEFAULT 1,
  created_by      BINARY(16)       NULL,
  created_at      DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_pos_items__public_id (public_id),
  UNIQUE KEY ux_pos_items__name (outlet_id, name),
  KEY ix_pos_items__inst_outlet (institution_id, outlet_id, category_id),
  CONSTRAINT fk_pos_items__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pos_items__outlet FOREIGN KEY (outlet_id) REFERENCES pos_outlets (id),
  CONSTRAINT fk_pos_items__category FOREIGN KEY (category_id) REFERENCES pos_categories (id),
  CONSTRAINT ck_pos_items__price CHECK (price_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pos_operator_tags (
  id                BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id         BINARY(16)       NOT NULL,
  institution_id    BIGINT UNSIGNED  NOT NULL,
  outlet_id         BIGINT UNSIGNED  NOT NULL,
  operator_name     VARCHAR(40)      NOT NULL,
  mobile            CHAR(10)         NOT NULL,
  token_hash        BINARY(32)       NOT NULL,                      -- SHA-256 of the tag token
  token_last4       CHAR(4)          NOT NULL,
  status            ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  reissue_count     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  replaces_id       BIGINT UNSIGNED  NULL,                          -- the tag this one re-issued
  reissue_reason    VARCHAR(200)     NULL,
  ended_at          DATETIME(3)      NULL,
  issued_by_terminal BIGINT UNSIGNED NULL,
  issued_at         DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  live_key          VARCHAR(40) GENERATED ALWAYS AS (IF(status = 'ACTIVE', CONCAT(outlet_id, ':', mobile), NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_pos_operator_tags__public_id (public_id),
  UNIQUE KEY ux_pos_operator_tags__token (token_hash),
  UNIQUE KEY ux_pos_operator_tags__live (live_key),                -- one active tag per mobile and outlet
  KEY ix_pos_operator_tags__inst_outlet (institution_id, outlet_id, status),
  CONSTRAINT fk_pos_operator_tags__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pos_operator_tags__outlet FOREIGN KEY (outlet_id) REFERENCES pos_outlets (id),
  CONSTRAINT fk_pos_operator_tags__replaces FOREIGN KEY (replaces_id) REFERENCES pos_operator_tags (id),
  CONSTRAINT fk_pos_operator_tags__terminal FOREIGN KEY (issued_by_terminal) REFERENCES terminals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The operator signed in on a POS terminal now, and the terminal's last offline sync (MER-012).
ALTER TABLE terminals
  ADD COLUMN operator_tag_id BIGINT UNSIGNED NULL AFTER location_type,
  ADD COLUMN operator_since  DATETIME(3)     NULL AFTER operator_tag_id,
  ADD COLUMN operator_until  DATETIME(3)     NULL AFTER operator_since,
  ADD COLUMN last_sync_at    DATETIME(3)     NULL AFTER last_seen_at,
  ADD CONSTRAINT fk_terminals__operator_tag FOREIGN KEY (operator_tag_id) REFERENCES pos_operator_tags (id);

CREATE TABLE pos_orders (
  id                    BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id             BINARY(16)       NOT NULL,
  institution_id        BIGINT UNSIGNED  NOT NULL,
  outlet_id             BIGINT UNSIGNED  NOT NULL,
  terminal_id           BIGINT UNSIGNED  NOT NULL,
  operator_tag_id       BIGINT UNSIGNED  NULL,
  order_no              VARCHAR(20)      NOT NULL,                  -- ORD-MMDD-NNN
  business_date         DATE             NOT NULL,                  -- IST
  order_type            ENUM('DINE_IN','TAKEAWAY') NOT NULL,
  subtotal_paise        BIGINT UNSIGNED  NOT NULL,
  tax_paise             BIGINT UNSIGNED  NOT NULL,
  total_paise           BIGINT UNSIGNED  NOT NULL,
  status                ENUM('CREATED','PAID','CANCELLED') NOT NULL DEFAULT 'CREATED',
  instrument            ENUM('WALLET','ALLOWANCE','COUPON') NULL,
  payer_profile_id      BIGINT UNSIGNED  NULL,
  payment_attempt_id    BIGINT UNSIGNED  NULL,
  coupon_redemption_id  BIGINT UNSIGNED  NULL,
  last_failure_code     VARCHAR(64)      NULL,
  offline               TINYINT(1)       NOT NULL DEFAULT 0,        -- created from an offline capture
  paid_at               DATETIME(3)      NULL,
  cancelled_at          DATETIME(3)      NULL,
  cancel_reason         VARCHAR(200)     NULL,
  row_version           INT UNSIGNED     NOT NULL DEFAULT 1,
  created_at            DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_pos_orders__public_id (public_id),
  UNIQUE KEY ux_pos_orders__number (outlet_id, business_date, order_no),
  KEY ix_pos_orders__inst_outlet_day (institution_id, outlet_id, business_date, status),
  KEY ix_pos_orders__attempt (payment_attempt_id),
  CONSTRAINT fk_pos_orders__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pos_orders__outlet FOREIGN KEY (outlet_id) REFERENCES pos_outlets (id),
  CONSTRAINT fk_pos_orders__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id),
  CONSTRAINT fk_pos_orders__operator FOREIGN KEY (operator_tag_id) REFERENCES pos_operator_tags (id),
  CONSTRAINT fk_pos_orders__payer FOREIGN KEY (payer_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT ck_pos_orders__total CHECK (total_paise = subtotal_paise + tax_paise AND total_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pos_order_lines (
  order_id          BIGINT UNSIGNED  NOT NULL,
  line_no           SMALLINT UNSIGNED NOT NULL,
  item_id           BIGINT UNSIGNED  NOT NULL,
  name              VARCHAR(40)      NOT NULL,                      -- as on the menu when ordered
  unit_price_paise  BIGINT UNSIGNED  NOT NULL,
  qty               SMALLINT UNSIGNED NOT NULL,
  gst_bp            SMALLINT UNSIGNED NOT NULL,
  net_paise         BIGINT UNSIGNED  NOT NULL,
  tax_paise         BIGINT UNSIGNED  NOT NULL,
  total_paise       BIGINT UNSIGNED  NOT NULL,
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT fk_pos_order_lines__order FOREIGN KEY (order_id) REFERENCES pos_orders (id),
  CONSTRAINT fk_pos_order_lines__item FOREIGN KEY (item_id) REFERENCES pos_items (id),
  CONSTRAINT ck_pos_order_lines__qty CHECK (qty > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- POS requests: the order and the terminal (or the partner client) they collect for.
ALTER TABLE payment_requests
  ADD COLUMN order_id       BIGINT UNSIGNED NULL AFTER instrument,
  ADD COLUMN terminal_id    BIGINT UNSIGNED NULL AFTER order_id,
  ADD COLUMN api_client_id  BIGINT UNSIGNED NULL AFTER terminal_id,
  ADD KEY ix_payment_requests__order (order_id, status),
  ADD CONSTRAINT fk_payment_requests__order FOREIGN KEY (order_id) REFERENCES pos_orders (id),
  ADD CONSTRAINT fk_payment_requests__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id),
  ADD CONSTRAINT fk_payment_requests__client FOREIGN KEY (api_client_id) REFERENCES api_clients (id);

-- A POS partner client serves one institution's terminals (RNG-GOV-006; RNG-PAY-110 resolved the
-- merchant across the platform).
ALTER TABLE api_clients
  ADD COLUMN institution_id BIGINT UNSIGNED NULL AFTER partner,
  ADD CONSTRAINT fk_api_clients__institution FOREIGN KEY (institution_id) REFERENCES institutions (id);

CREATE TABLE pos_offline_batches (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)       NOT NULL,                        -- the batch id the sender chose
  institution_id  BIGINT UNSIGNED  NOT NULL,
  terminal_id     BIGINT UNSIGNED  NOT NULL,
  api_client_id   BIGINT UNSIGNED  NULL,                            -- sent by a POS partner
  captures        SMALLINT UNSIGNED NOT NULL,
  received_at     DATETIME(3)      NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_pos_offline_batches__sender (terminal_id, public_id),
  KEY ix_pos_offline_batches__inst (institution_id, received_at),
  CONSTRAINT fk_pos_offline_batches__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pos_offline_batches__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id),
  CONSTRAINT fk_pos_offline_batches__client FOREIGN KEY (api_client_id) REFERENCES api_clients (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pos_offline_captures (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  terminal_id         BIGINT UNSIGNED  NOT NULL,
  batch_id            BIGINT UNSIGNED  NOT NULL,                    -- the batch that first carried it
  capture_key         VARCHAR(64)      NOT NULL,                    -- the terminal's idempotency key
  order_id            BIGINT UNSIGNED  NULL,
  card_last4          CHAR(4)          NULL,
  payer_profile_id    BIGINT UNSIGNED  NULL,
  instrument          ENUM('WALLET','ALLOWANCE') NOT NULL,
  amount_paise        BIGINT UNSIGNED  NOT NULL,
  captured_at         DATETIME(3)      NOT NULL,
  outcome             ENUM('PROCESSING','ACCEPTED','REFUSED') NOT NULL DEFAULT 'PROCESSING',
  refusal_code        VARCHAR(64)      NULL,
  payment_attempt_id  BIGINT UNSIGNED  NULL,
  processed_at        DATETIME(3)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_pos_offline_captures__key (terminal_id, capture_key), -- accepted at most once
  KEY ix_pos_offline_captures__batch (batch_id),
  KEY ix_pos_offline_captures__inst (institution_id, terminal_id, processed_at),
  CONSTRAINT fk_pos_offline_captures__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_pos_offline_captures__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id),
  CONSTRAINT fk_pos_offline_captures__batch FOREIGN KEY (batch_id) REFERENCES pos_offline_batches (id),
  CONSTRAINT fk_pos_offline_captures__order FOREIGN KEY (order_id) REFERENCES pos_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Which batches carried a capture again (a re-sent batch is acknowledged, never posted twice).
CREATE TABLE pos_offline_batch_items (
  batch_id     BIGINT UNSIGNED NOT NULL,
  capture_id   BIGINT UNSIGNED NOT NULL,
  seq          SMALLINT UNSIGNED NOT NULL,
  replayed     TINYINT(1)      NOT NULL,
  PRIMARY KEY (batch_id, seq),
  CONSTRAINT fk_pos_offline_batch_items__batch FOREIGN KEY (batch_id) REFERENCES pos_offline_batches (id),
  CONSTRAINT fk_pos_offline_batch_items__capture FOREIGN KEY (capture_id) REFERENCES pos_offline_captures (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

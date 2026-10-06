-- 0036_coupons.sql — forward-only migration (D-16). Phase 4.4: meal coupons and coupon types (SRS 11,
-- CR-15 / 11.10.1, ATT 21.20.1; CPN-001…014, job coupon-expiry).
--
-- - Slots: one master per institution (OI-CPN-12 proposal); a meal type points at a slot, any other
--   type carries its own window (start inclusive, end exclusive).
-- - Types (RC-16: Active · Inactive, never deleted): a name unique in the institution, what it stands
--   for, the window, the accepting merchants (all regular merchants, or a list), the most a student
--   may hold and redeem per period (OI-CPN-11 proposal: per type, per day by default), the dates it
--   may be issued between. A value is recorded but redemption moves no money (Q14 M5 recommendation:
--   free entitlements in v1; value-bearing types switched off by a setting).
-- - Coupons (27.2: ACTIVE · USED · EXPIRED): one per student, type and date; each keeps its type's
--   terms as issued (RNG-CPN-082). Cancelling a future coupon (OI-CPN-03) ends it EXPIRED with
--   `ended_reason` CANCELLED (no new status — 01c withdrawn list).
-- - A redemption is one row per used coupon (27.2 coupon transaction REDEEMED).
-- - Coupon counter taps (21.20.1): a tap lists the holder's eligible types for a short time and is
--   redeemed once.

CREATE TABLE coupon_slots (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(40)     NOT NULL,
  start_time      TIME            NOT NULL,
  end_time        TIME            NOT NULL,
  sort_order      SMALLINT        NOT NULL DEFAULT 0,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_coupon_slots__public_id (public_id),
  UNIQUE KEY ux_coupon_slots__name (institution_id, name),
  CONSTRAINT fk_coupon_slots__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT ck_coupon_slots__window CHECK (end_time > start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE coupon_types (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(40)     NOT NULL,
  kind            ENUM('MEAL','NUTRITION','EVENT','OTHER') NOT NULL,
  description     VARCHAR(200)    NULL,
  slot_id         BIGINT UNSIGNED NULL,          -- a meal type's slot
  window_start    TIME            NULL,          -- the window of a type without a slot
  window_end      TIME            NULL,
  value_paise     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  hold_max        SMALLINT UNSIGNED NOT NULL,
  redeem_max      SMALLINT UNSIGNED NOT NULL,
  redeem_period   ENUM('DAY','WEEK','MONTH') NOT NULL DEFAULT 'DAY',
  accepts_all     BOOLEAN         NOT NULL DEFAULT TRUE,  -- every regular merchant of the institution
  issue_from      DATE            NULL,
  issue_to        DATE            NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_by      BINARY(16)      NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_coupon_types__public_id (public_id),
  UNIQUE KEY ux_coupon_types__name (institution_id, name),
  KEY ix_coupon_types__inst_status (institution_id, status),
  CONSTRAINT fk_coupon_types__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_coupon_types__slot FOREIGN KEY (slot_id) REFERENCES coupon_slots (id),
  CONSTRAINT ck_coupon_types__window CHECK (
    (slot_id IS NOT NULL AND window_start IS NULL AND window_end IS NULL)
    OR (slot_id IS NULL AND window_start IS NOT NULL AND window_end > window_start)),
  CONSTRAINT ck_coupon_types__max CHECK (hold_max > 0 AND redeem_max > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE coupon_type_merchants (
  type_id              BIGINT UNSIGNED NOT NULL,
  merchant_profile_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (type_id, merchant_profile_id),
  CONSTRAINT fk_coupon_type_merchants__type FOREIGN KEY (type_id) REFERENCES coupon_types (id),
  CONSTRAINT fk_coupon_type_merchants__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE coupon_issuances (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NOT NULL,
  from_date        DATE            NOT NULL,
  to_date          DATE            NOT NULL,
  excluded_dates   JSON            NOT NULL,
  type_ids         JSON            NOT NULL,       -- public ids of the types issued
  students         INT UNSIGNED    NOT NULL,
  created_count    INT UNSIGNED    NOT NULL,
  skipped_count    INT UNSIGNED    NOT NULL,
  refused_count    INT UNSIGNED    NOT NULL,
  issued_by        BINARY(16)      NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_coupon_issuances__public_id (public_id),
  KEY ix_coupon_issuances__inst (institution_id, id),
  CONSTRAINT fk_coupon_issuances__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE coupons (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)      NOT NULL,
  institution_id   BIGINT UNSIGNED NOT NULL,
  profile_id       BIGINT UNSIGNED NOT NULL,
  type_id          BIGINT UNSIGNED NOT NULL,
  issuance_id      BIGINT UNSIGNED NOT NULL,
  valid_on         DATE            NOT NULL,
  -- the type's terms as issued (RNG-CPN-082)
  window_start     TIME            NOT NULL,
  window_end       TIME            NOT NULL,
  value_paise      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  accepts_all      BOOLEAN         NOT NULL,
  accepts          JSON            NULL,           -- merchant profile ids when not all
  status           ENUM('ACTIVE','USED','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  ended_reason     ENUM('LAPSED','CANCELLED') NULL,
  cancel_reason    VARCHAR(200)    NULL,
  used_at          DATETIME(3)     NULL,
  ended_at         DATETIME(3)     NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_coupons__public_id (public_id),
  UNIQUE KEY ux_coupons__holder_type_day (profile_id, type_id, valid_on),   -- duplicate-skip (RNG-CPN-011)
  KEY ix_coupons__inst_day (institution_id, valid_on, status),
  KEY ix_coupons__holder_day (profile_id, valid_on, status),
  KEY ix_coupons__status_day (status, valid_on),                           -- the expiry job
  CONSTRAINT fk_coupons__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_coupons__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_coupons__type FOREIGN KEY (type_id) REFERENCES coupon_types (id),
  CONSTRAINT fk_coupons__issuance FOREIGN KEY (issuance_id) REFERENCES coupon_issuances (id),
  CONSTRAINT ck_coupons__ended CHECK ((status = 'EXPIRED') = (ended_reason IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE coupon_redemptions (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)      NOT NULL,
  institution_id       BIGINT UNSIGNED NOT NULL,
  coupon_id            BIGINT UNSIGNED NOT NULL,
  profile_id           BIGINT UNSIGNED NOT NULL,
  merchant_profile_id  BIGINT UNSIGNED NOT NULL,
  channel              ENUM('QR','READER') NOT NULL,
  terminal_id          BIGINT UNSIGNED NULL,
  status               ENUM('REDEEMED') NOT NULL DEFAULT 'REDEEMED',
  redeemed_at          DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_coupon_redemptions__public_id (public_id),
  UNIQUE KEY ux_coupon_redemptions__coupon (coupon_id),                     -- a coupon is used once
  KEY ix_coupon_redemptions__inst_at (institution_id, redeemed_at),
  KEY ix_coupon_redemptions__merchant (merchant_profile_id, redeemed_at),
  CONSTRAINT fk_coupon_redemptions__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_coupon_redemptions__coupon FOREIGN KEY (coupon_id) REFERENCES coupons (id),
  CONSTRAINT fk_coupon_redemptions__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_coupon_redemptions__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id),
  CONSTRAINT fk_coupon_redemptions__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE coupon_taps (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id   BIGINT UNSIGNED NOT NULL,
  terminal_id      BIGINT UNSIGNED NOT NULL,
  tap_ref          VARCHAR(64)     NOT NULL,       -- the reader's tap id
  profile_id       BIGINT UNSIGNED NOT NULL,
  expires_at       DATETIME(3)     NOT NULL,
  redemption_id    BIGINT UNSIGNED NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_coupon_taps__terminal_ref (terminal_id, tap_ref),
  CONSTRAINT fk_coupon_taps__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_coupon_taps__terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id),
  CONSTRAINT fk_coupon_taps__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_coupon_taps__redemption FOREIGN KEY (redemption_id) REFERENCES coupon_redemptions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

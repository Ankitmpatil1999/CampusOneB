-- 0037_events_passes.sql — forward-only migration (D-16). Phase 4.5: paid events and entry passes
-- (SRS 13.7–13.10, 13.16, 9.7–9.9; FEE-028…033, PAY-003…006, PAY-026…028, job event-status).
--
-- Events (27.2: Active 1 / Inactive 0):
-- - payment heads with amounts, the total, the period (end date inclusive to 23:59:59 IST,
--   OI-FEE-15), an optional audience (classes), and the institution's fee account as the payee;
-- - payable while Active and within its period, once per payer (the engine's P2, channel EVENT);
--   the 23:50 job deactivates events after their end date (OI-FEE-14, brief §7.5).
-- Entry passes (RC-15: ACTIVE · AUTHORIZED · USED · EXPIRED · CANCELLED):
-- - one day, one holder bound to their registered phone, a number of scans; the holder authorises
--   it on that phone for a short window (a fresh token), a staff member scans it; every scan is
--   recorded (OI-PAY-10); at most one live pass per holder, phone and day.

CREATE TABLE events (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id            BINARY(16)      NOT NULL,
  institution_id       BIGINT UNSIGNED NOT NULL,
  title                VARCHAR(80)     NOT NULL,
  description          VARCHAR(500)    NULL,
  start_date           DATE            NOT NULL,
  end_date             DATE            NOT NULL,
  total_paise          BIGINT UNSIGNED NOT NULL,
  merchant_profile_id  BIGINT UNSIGNED NOT NULL,            -- the fee account (MER 12.7)
  audience_class_ids   JSON            NULL,                -- null: every member
  status               ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  row_version          INT UNSIGNED    NOT NULL DEFAULT 1,
  created_by           BINARY(16)      NULL,
  created_at           DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at           DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_events__public_id (public_id),
  KEY ix_events__inst_status (institution_id, status, start_date),
  CONSTRAINT fk_events__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_events__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id),
  CONSTRAINT ck_events__dates CHECK (end_date >= start_date),
  CONSTRAINT ck_events__total CHECK (total_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE event_heads (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id      BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(60)     NOT NULL,
  amount_paise  BIGINT UNSIGNED NOT NULL,
  sort_order    SMALLINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_event_heads__event (event_id, sort_order),
  CONSTRAINT fk_event_heads__event FOREIGN KEY (event_id) REFERENCES events (id),
  CONSTRAINT ck_event_heads__amount CHECK (amount_paise > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The event an attempt pays is its `event_ref` (the event's public id, since 0030): P2, "paid
-- once" and the event report read it.
ALTER TABLE payment_attempts
  ADD KEY ix_payment_attempts__event (institution_id, event_ref, status);

CREATE TABLE entry_passes (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id         BINARY(16)      NOT NULL,
  institution_id    BIGINT UNSIGNED NOT NULL,
  pass_type         VARCHAR(30)     NOT NULL,          -- registers: FEST-ENTRY, COLLEGE-ENTRY
  purpose           VARCHAR(120)    NOT NULL,
  description       VARCHAR(300)    NOT NULL,
  holder_profile_id BIGINT UNSIGNED NOT NULL,
  device_id         BIGINT UNSIGNED NOT NULL,          -- the holder's registered phone at issue
  valid_on          DATE            NOT NULL,
  max_scans         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  used_scans        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  transfer_allowed  BOOLEAN         NOT NULL DEFAULT FALSE,
  comments          VARCHAR(300)    NULL,
  status            ENUM('ACTIVE','AUTHORIZED','USED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  live_key          VARCHAR(64) GENERATED ALWAYS AS (
                      CASE WHEN status IN ('ACTIVE','AUTHORIZED')
                           THEN CONCAT(holder_profile_id, ':', device_id, ':', valid_on) END) STORED,
  token_hash        BINARY(32)      NULL,              -- the current authorisation's QR token
  authorised_until  DATETIME(3)     NULL,
  cancel_reason     VARCHAR(200)    NULL,
  ended_at          DATETIME(3)     NULL,
  row_version       INT UNSIGNED    NOT NULL DEFAULT 1,
  created_by        BINARY(16)      NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at        DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_entry_passes__public_id (public_id),
  UNIQUE KEY ux_entry_passes__live (live_key),                          -- RNG-PAY-080
  UNIQUE KEY ux_entry_passes__token (token_hash),
  KEY ix_entry_passes__inst_day (institution_id, valid_on, status),
  KEY ix_entry_passes__holder (holder_profile_id, valid_on),
  KEY ix_entry_passes__status_day (status, valid_on),                   -- the expiry
  CONSTRAINT fk_entry_passes__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_entry_passes__holder FOREIGN KEY (holder_profile_id) REFERENCES member_profiles (id),
  CONSTRAINT fk_entry_passes__device FOREIGN KEY (device_id) REFERENCES devices (id),
  CONSTRAINT ck_entry_passes__scans CHECK (max_scans >= 1 AND used_scans <= max_scans)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE entry_pass_scans (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pass_id             BIGINT UNSIGNED NOT NULL,
  checker_profile_id  BIGINT UNSIGNED NOT NULL,
  scanned_at          DATETIME(3)     NOT NULL,
  scan_no             SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_entry_pass_scans__pass_no (pass_id, scan_no),
  KEY ix_entry_pass_scans__checker (checker_profile_id, scanned_at),
  CONSTRAINT fk_entry_pass_scans__pass FOREIGN KEY (pass_id) REFERENCES entry_passes (id),
  CONSTRAINT fk_entry_pass_scans__checker FOREIGN KEY (checker_profile_id) REFERENCES member_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

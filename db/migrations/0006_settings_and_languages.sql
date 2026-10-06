-- 0006_settings_and_languages.sql — forward-only migration (D-16).
-- Platform settings: operator-changeable values over the limits-register defaults (NFR-52; client,
-- 2026-10-02: "give us the provision to change"). Language order for every language picker
-- (client, 2026-10-02: Kannada next to English everywhere).

CREATE TABLE platform_settings (
  setting_key      VARCHAR(80)     NOT NULL,       -- limits-register key, e.g. auth.session.memberMobileDays
  value_json       JSON            NOT NULL,
  reason           VARCHAR(500)    NOT NULL,
  row_version      INT UNSIGNED    NOT NULL DEFAULT 1,
  updated_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_by       BINARY(16)      NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE platform_setting_changes (               -- who changed what, when and why (append-only)
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  setting_key      VARCHAR(80)     NOT NULL,
  from_json        JSON            NULL,           -- NULL = the register default was in force
  to_json          JSON            NULL,           -- NULL = reset to the register default
  reason           VARCHAR(500)    NOT NULL,
  changed_at       DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  changed_by       BINARY(16)      NULL,
  PRIMARY KEY (id),
  KEY ix_psc__key_changed (setting_key, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER trg_psc__no_update BEFORE UPDATE ON platform_setting_changes FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_setting_changes is append-only';
CREATE TRIGGER trg_psc__no_delete BEFORE DELETE ON platform_setting_changes FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_setting_changes is append-only';

ALTER TABLE languages
  ADD COLUMN sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 100 AFTER is_default;

-- 0034_assets.sql — forward-only migration (D-16). Phase 4.2: asset groups and assets (SRS 7.6, 7.7;
-- INS-020…026, PAY-015) — what a vendor merchant may be paid for (BR-20).
--
-- - A group and an asset are Active (1) or Inactive (0) (27.2). Names are unique per institution
--   (groups) and per group (assets).
-- - A vendor is linked to groups. An inactive group can't be newly linked (skipped) nor de-linked
--   (27.2). A vendor payment names an Active asset of an Active group linked to that vendor (the
--   engine's P4), and its invoice number once (P5).

CREATE TABLE asset_groups (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(60)     NOT NULL,
  description     VARCHAR(200)    NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_by      BINARY(16)      NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_asset_groups__public_id (public_id),
  UNIQUE KEY ux_asset_groups__name (institution_id, name),
  CONSTRAINT fk_asset_groups__institution FOREIGN KEY (institution_id) REFERENCES institutions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE assets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       BINARY(16)      NOT NULL,
  institution_id  BIGINT UNSIGNED NOT NULL,
  group_id        BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(80)     NOT NULL,
  type            ENUM('PHYSICAL','DIGITAL','SERVICE','OTHER') NOT NULL,
  description     VARCHAR(200)    NULL,
  status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  row_version     INT UNSIGNED    NOT NULL DEFAULT 1,
  created_by      BINARY(16)      NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at      DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY ux_assets__public_id (public_id),
  UNIQUE KEY ux_assets__name (group_id, name),
  KEY ix_assets__inst_group (institution_id, group_id, status),
  CONSTRAINT fk_assets__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_assets__group FOREIGN KEY (group_id) REFERENCES asset_groups (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE merchant_asset_groups (
  merchant_profile_id  BIGINT UNSIGNED NOT NULL,
  group_id             BIGINT UNSIGNED NOT NULL,
  linked_by            BINARY(16)      NULL,
  linked_at            DATETIME(3)     NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (merchant_profile_id, group_id),
  KEY ix_merchant_asset_groups__group (group_id),
  CONSTRAINT fk_merchant_asset_groups__merchant FOREIGN KEY (merchant_profile_id) REFERENCES merchants (profile_id),
  CONSTRAINT fk_merchant_asset_groups__group FOREIGN KEY (group_id) REFERENCES asset_groups (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

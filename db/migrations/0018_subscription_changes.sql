-- 0018_subscription_changes.sql — forward-only migration (D-16). Phase 2.7 part 2: plan changes
-- after go-live (FR-SAS-07: an upgrade is billed now, prorated; a downgrade waits for renewal), the
-- subscription billing run (renewal, renewal invoices, grace reminders) and the console's Plan &
-- billing page (c.subscription: plan change requests, bank transfers reported by the institution).

-- A change that waits for renewal: the version the next period takes.
ALTER TABLE subscriptions
  ADD COLUMN scheduled_plan_version_id INT UNSIGNED NULL AFTER plan_version_id,
  ADD COLUMN scheduled_at              DATETIME(3)  NULL AFTER scheduled_plan_version_id,
  ADD COLUMN scheduled_by              BINARY(16)   NULL AFTER scheduled_at,
  ADD CONSTRAINT fk_subscriptions__scheduled_version
    FOREIGN KEY (scheduled_plan_version_id) REFERENCES plan_versions (id);

-- Reminders sent by the billing run (0 none · 1 grace started · 2 grace ended), and a bank transfer
-- the institution reports from the console; a platform administrator confirms it (SAS-032).
ALTER TABLE invoices
  ADD COLUMN reminder_stage        TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN transfer_utr          VARCHAR(22)      NULL AFTER paid_at,
  ADD COLUMN transfer_paid_on      DATE             NULL AFTER transfer_utr,
  ADD COLUMN transfer_reported_at  DATETIME(3)      NULL AFTER transfer_paid_on,
  ADD COLUMN transfer_reported_by  BINARY(16)       NULL AFTER transfer_reported_at,
  ADD CONSTRAINT ck_invoices__reminder_stage CHECK (reminder_stage <= 2);

-- An institution's request for another plan (prototype c.subscription "Request a plan change").
-- Status RC-09: Pending · Applied · Declined · Withdrawn.
CREATE TABLE plan_change_requests (
  id               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  public_id        BINARY(16)        NOT NULL,
  institution_id   BIGINT UNSIGNED   NOT NULL,
  plan_id          SMALLINT UNSIGNED NOT NULL,
  timing           ENUM('RENEWAL','NOW') NOT NULL,
  note             VARCHAR(300)      NULL,
  status           ENUM('PENDING','APPLIED','DECLINED','WITHDRAWN') NOT NULL DEFAULT 'PENDING',
  requested_by     BINARY(16)        NOT NULL,
  requested_at     DATETIME(3)       NOT NULL,
  resolved_by      BINARY(16)        NULL,
  resolved_at      DATETIME(3)       NULL,
  resolution       VARCHAR(300)      NULL,
  row_version      INT UNSIGNED      NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY ux_plan_change_requests__public_id (public_id),
  KEY ix_plan_change_requests__inst_status (institution_id, status, requested_at),
  CONSTRAINT fk_plan_change_requests__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_plan_change_requests__plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

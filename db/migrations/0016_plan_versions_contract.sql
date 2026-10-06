-- 0016_plan_versions_contract.sql — forward-only migration (D-16). Contract step of 0015: the terms
-- now live only in plan_versions, so the single-version columns and tables are removed.

ALTER TABLE subscriptions MODIFY plan_version_id INT UNSIGNED NOT NULL;
ALTER TABLE plans
  DROP COLUMN cycle,
  DROP COLUMN price_paise,
  DROP COLUMN trial_days;
DROP TABLE plan_modules;
DROP TABLE plan_allowances;

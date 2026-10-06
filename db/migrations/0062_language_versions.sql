-- 0062_language_versions.sql — forward-only migration (D-16). Phase 9.6 hardening.
-- Optimistic locking (golden rule) on the languages operators switch on and off or make the default
-- (IDN-072): the version is exposed as an ETag and the edit must send If-Match.

ALTER TABLE languages
  ADD COLUMN row_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER sort_order;

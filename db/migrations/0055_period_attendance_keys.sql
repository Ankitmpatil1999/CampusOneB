-- 0055_period_attendance_keys.sql — forward-only migration (D-16). Period attendance is kept against the
-- section and the bell period (with the subject and teacher of the timetable at the time), not the
-- timetable slot row: a timetable is saved whole, so its slot rows are replaced and their ids change.

ALTER TABLE period_attendance
  DROP INDEX ux_period_attendance__once,
  DROP COLUMN slot_id,
  ADD COLUMN section_id         BIGINT UNSIGNED NOT NULL AFTER year_id,
  ADD COLUMN period_id          BIGINT UNSIGNED NOT NULL AFTER section_id,
  ADD COLUMN subject_id         BIGINT UNSIGNED NOT NULL AFTER period_id,
  ADD COLUMN teacher_profile_id BIGINT UNSIGNED NOT NULL AFTER subject_id,
  ADD UNIQUE KEY ux_period_attendance__once (section_id, period_id, att_date, profile_id);

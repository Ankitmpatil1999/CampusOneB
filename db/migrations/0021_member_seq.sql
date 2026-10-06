-- 0021_member_seq.sql — forward-only migration (D-16). Every new member profile gets the next
-- number in its institution (shown as <short name>-00001), whichever path creates it (onboarding,
-- staff, registration's administrator). Onboarding holds the institution row lock, so numbers are
-- taken one at a time; the unique key catches anything else.

CREATE TRIGGER trg_member_profiles__seq BEFORE INSERT ON member_profiles
FOR EACH ROW
  SET NEW.member_seq = IF(
    NEW.member_seq IS NULL OR NEW.member_seq = 0,
    (SELECT COALESCE(MAX(p.member_seq), 0) + 1 FROM member_profiles p WHERE p.institution_id = NEW.institution_id),
    NEW.member_seq
  );

-- 0087_legacy_cards.sql — forward-only migration (D-16). Client 2026-10-23: cards carried over from
-- the earlier application keep working without being written again. Such a card holds the earlier
-- application's encrypted token (base64, "U2FsdGVkX1…"), which is what a reader reads off it; the
-- card row keeps that value's SHA-256, so a tap with it finds the card. A card CampusOne issues has none.
--
-- School tables are in the CUG database ({{CUG}}, ADR-0019).

ALTER TABLE {{CUG}}.cards
  ADD COLUMN legacy_token_hash BINARY(32) NULL AFTER token,
  ADD UNIQUE KEY ux_cards__legacy_token (institution_id, legacy_token_hash);

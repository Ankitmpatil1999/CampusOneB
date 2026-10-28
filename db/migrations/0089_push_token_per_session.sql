-- 0089_push_token_per_session.sql — forward-only migration (D-16). Client 2026-10-27: one sign-in on
-- the phone holds the member session and, for staff, the staff app's console session together
-- (one experience for staff, a choice of mode for a parent who is also staff). The phone's Firebase
-- token is then registered for both sessions of the same account, each pushed its own surface's
-- notices, so a token is no longer unique across sessions: another account's session still gives it
-- up (PushTokensService.register), the same person's other session keeps it.
-- The srgs-staff-migration branch has a 0089 too (legacy_cards): renumber one of them when merging.

ALTER TABLE session_push_tokens
  DROP INDEX ux_session_push_tokens__token,
  ADD KEY ix_session_push_tokens__token (token_hash);

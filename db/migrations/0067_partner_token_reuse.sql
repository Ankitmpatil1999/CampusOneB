-- 0067_partner_token_reuse.sql — forward-only migration (D-16). Client answer 2026-10-12 (Axis Bank
-- Power E-coll): one token serves both calls, and while it is valid the token call returns the same
-- token again instead of a new one. The live token is kept encrypted at field level (AES-256-GCM,
-- purpose partner_token, the token's id as associated data) so it can be returned; it is cleared
-- when the token is revoked or ended.

ALTER TABLE api_client_tokens
  ADD COLUMN token_enc VARBINARY(2048) NULL AFTER revoke_reason;

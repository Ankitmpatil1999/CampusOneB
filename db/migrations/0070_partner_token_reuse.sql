-- 0070_partner_token_reuse.sql — forward-only migration (D-16). Client answer 2026-10-12 (Axis Bank
-- Power E-coll): one token serves both calls, and while it is valid the token call returns the same
-- token again instead of a new one. The live token is kept encrypted at field level (AES-256-GCM,
-- purpose partner_token, the token's id as associated data) so it can be returned; it is cleared
-- when the token is revoked or ended.
--
-- First written as 0067; renumbered after 0067–0069 (admission changes) were merged under those
-- numbers. A database that ran it as 0067 already has the column, so it is added only when missing
-- (that database drops its stale 0067 record first: docs/runbooks/README.md §2).

SET @has_token_enc := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_client_tokens' AND COLUMN_NAME = 'token_enc'
);
SET @ddl := IF(
  @has_token_enc = 0,
  'ALTER TABLE api_client_tokens ADD COLUMN token_enc VARBINARY(2048) NULL AFTER revoke_reason',
  'DO 0'
);
PREPARE add_token_enc FROM @ddl;
EXECUTE add_token_enc;
DEALLOCATE PREPARE add_token_enc;

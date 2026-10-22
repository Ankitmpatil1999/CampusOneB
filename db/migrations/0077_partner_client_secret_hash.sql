-- 0074_partner_client_secret_hash.sql — forward-only migration (D-16). Client 2026-10-14: the client id
-- and secret already given to Axis Bank by the earlier application (its secret kept only as a bcrypt
-- hash) must keep working. Such a client is imported with its own client id and the hash; its secret
-- is checked against the hash at the token call (as the earlier application did). It can't sign
-- (WAL-012/013 need the secret itself): it uses the bearer-only bank calls (BNK-001…003).
-- Rotating its secret gives it a RingPe secret; the hash stays valid for the rotation's overlap.

ALTER TABLE api_clients
  MODIFY COLUMN secret_enc VARBINARY(512) NULL,
  ADD COLUMN secret_hash VARCHAR(100) NULL AFTER secret_enc,
  ADD CONSTRAINT ck_api_clients__secret CHECK (secret_enc IS NOT NULL OR secret_hash IS NOT NULL);

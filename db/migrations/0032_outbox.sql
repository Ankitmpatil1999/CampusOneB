-- 0032_outbox.sql — forward-only migration (D-16). Phase 3.6: the transactional outbox of 0004
-- (docs/03 §9.1) now carries realtime events (COM-025). A business change writes its event in the same
-- transaction; the relay in the API process (where the sockets are) sends it after commit to the rooms
-- named at write time, and marks it dispatched. Rooms are server-derived (institution, account,
-- profile — OI-INT-05); events carry identifiers only, so clients re-read with their own
-- authorisation. Dispatched realtime rows are purged after 7 days by the relay.

ALTER TABLE outbox_events
  ADD COLUMN rooms JSON NULL AFTER payload,                                  -- realtime rooms (aggregate_type 'realtime')
  ADD KEY ix_outbox__status_dispatched (status, dispatched_at);

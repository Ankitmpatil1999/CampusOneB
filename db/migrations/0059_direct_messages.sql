-- 0059_direct_messages.sql — forward-only migration (D-16). Phase 8.3: direct messages between members
-- (SRS 23.9–23.11; COM-016…021; FR-COM-05; BR-71; RNG-COM-088…128; OI-COM-24…33).
--
-- - One conversation per unordered pair of members of an institution (RNG-COM-096), created by the
--   first message; each participant archives it for themselves only (27.2 archived / not archived;
--   RNG-COM-103/104) and keeps the time of its last message for their own list (newest first, paged:
--   OI-COM-24/31).
-- - A message (27.2 SENT · DELIVERED · READ · FAILED) is 1 to 4,000 characters, never edited or deleted;
--   it is delivered in the app (the communication log records the delivery, RC-24 kind DIRECT_MESSAGE)
--   and read once by its recipient (the first read time is kept, RNG-COM-099).
-- - A child's profile is held by the family's account, so a guardian and the child share the child's
--   thread with each contact (OI-COM-33).
-- - The sender's last minute of messages is read through (institution, sender, time) for the
--   30-a-minute limit, which every server shares (OI-COM-27).

CREATE TABLE conversations (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  profile_low         BIGINT UNSIGNED  NOT NULL,                       -- the lower member id of the pair
  profile_high        BIGINT UNSIGNED  NOT NULL,
  started_by          BIGINT UNSIGNED  NOT NULL,
  last_message_id     BIGINT UNSIGNED  NULL,
  last_message_at     DATETIME(3)      NULL,
  created_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_conversations__public_id (public_id),
  UNIQUE KEY ux_conversations__pair (institution_id, profile_low, profile_high),
  CONSTRAINT fk_conversations__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_conversations__low FOREIGN KEY (profile_low) REFERENCES member_profiles (id),
  CONSTRAINT fk_conversations__high FOREIGN KEY (profile_high) REFERENCES member_profiles (id),
  CONSTRAINT ck_conversations__pair CHECK (profile_low < profile_high)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE conversation_participants (
  conversation_id     BIGINT UNSIGNED  NOT NULL,
  profile_id          BIGINT UNSIGNED  NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  other_profile_id    BIGINT UNSIGNED  NOT NULL,
  archived_at         DATETIME(3)      NULL,
  last_message_at     DATETIME(3)      NOT NULL,
  PRIMARY KEY (conversation_id, profile_id),
  KEY ix_conversation_participants__list (institution_id, profile_id, last_message_at, conversation_id),
  CONSTRAINT fk_conversation_participants__conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  CONSTRAINT fk_conversation_participants__profile FOREIGN KEY (profile_id) REFERENCES member_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE direct_messages (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id           BINARY(16)       NOT NULL,
  institution_id      BIGINT UNSIGNED  NOT NULL,
  conversation_id     BIGINT UNSIGNED  NOT NULL,
  sender_profile_id   BIGINT UNSIGNED  NOT NULL,
  body                VARCHAR(4000)    NOT NULL,
  status              ENUM('SENT','DELIVERED','READ','FAILED') NOT NULL DEFAULT 'SENT',
  created_at          DATETIME(3)      NOT NULL,
  delivered_at        DATETIME(3)      NULL,
  read_at             DATETIME(3)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_direct_messages__public_id (public_id),
  KEY ix_direct_messages__thread (conversation_id, id),
  KEY ix_direct_messages__unread (conversation_id, status, sender_profile_id),
  KEY ix_direct_messages__sender (institution_id, sender_profile_id, created_at),
  CONSTRAINT fk_direct_messages__institution FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT fk_direct_messages__conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  CONSTRAINT fk_direct_messages__sender FOREIGN KEY (sender_profile_id) REFERENCES member_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- P10: server-authoritative raid rewards. Pin the raid being fought on its session
-- so /raid/finish can price the reward from the server catalog, and add a first-clear
-- ledger so the one-time XP grant can't be farmed by replaying finishes.
--
-- Additive: raid_id is nullable (pre-P10 sessions predate it and just won't credit a
-- reward), raid_clears is a new table. Safe to run against a live DB.
ALTER TABLE raid_sessions ADD COLUMN raid_id INTEGER;

CREATE TABLE IF NOT EXISTS raid_clears (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  raid_id    INTEGER NOT NULL,
  cleared_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, raid_id)
);

-- Migration 0003 — server-owned raid cooldown + one-use raid sessions (Phase 3).
--
-- Run ONCE:
--   wrangler d1 execute zombiefarm --remote --file=./migrations/0003_raid_cooldown.sql
--
-- Purely additive (CREATE TABLE IF NOT EXISTS), safe on fresh and existing DBs.
-- Existing players have no raid_state row yet; the server treats a missing row as
-- last_raid_at = 0 (no cooldown), so nobody is wrongly gated after deploy.

CREATE TABLE IF NOT EXISTS raid_state (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id),
  last_raid_at   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS raid_sessions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  started_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_raid_sessions_acct ON raid_sessions (account_id, finished_at);

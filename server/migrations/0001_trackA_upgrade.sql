-- Migration 0001 — Track A security upgrade for an EXISTING (pre-Track-A) database.
--
-- Run ONCE against a production DB that predates the security work:
--   wrangler d1 execute zombiefarm --remote --file=./migrations/0001_trackA_upgrade.sql
--
-- A FRESH database does not need this — schema.sql already creates everything with
-- day_bucket present. Re-running this file will error on the ALTER (SQLite has no
-- "ADD COLUMN IF NOT EXISTS"); that error is the safe signal it was already applied.
--
-- ORDER MATTERS: the gifts UNIQUE index must be built AFTER day_bucket is populated
-- and AFTER duplicate same-day gifts are removed, or index creation fails.

-- New additive tables (safe if already present).
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id     TEXT NOT NULL REFERENCES accounts(id),
  to_id       TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_reqs_incoming ON friend_requests (to_id, created_at);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  TEXT NOT NULL REFERENCES accounts(id),
  blocked_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS grants (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  kind           TEXT NOT NULL,
  amount         INTEGER NOT NULL,
  source_gift_id TEXT UNIQUE,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_account ON grants (account_id, kind);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id, revoked_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- gifts.day_bucket: add the column, backfill from created_at, dedup, then index.
ALTER TABLE gifts ADD COLUMN day_bucket INTEGER NOT NULL DEFAULT 0;
UPDATE gifts SET day_bucket = created_at / 86400000;

-- Remove duplicate same-(from,to,day) gifts, keeping the earliest row, so the
-- UNIQUE index can build. (Historical duplicates existed because the old daily
-- gate was a non-atomic read-then-insert.)
DELETE FROM gifts
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM gifts GROUP BY from_id, to_id, day_bucket
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gifts_once ON gifts (from_id, to_id, day_bucket);

-- Zombie Farm server schema (Cloudflare D1 / SQLite).
-- Idempotent: safe to run repeatedly (CREATE TABLE IF NOT EXISTS).

-- One row per signed-in player. `id` is our internal account id (also the save
-- key); `google_sub` is Google's stable per-user id (the verified identity).
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  google_sub   TEXT UNIQUE NOT NULL,
  email        TEXT,
  name         TEXT NOT NULL,
  friend_code  TEXT UNIQUE NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Ground-truth save blob, one per account. `rev` drives optimistic concurrency:
-- a PUT is accepted only if its baseRev matches the stored rev.
CREATE TABLE IF NOT EXISTS saves (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id),
  blob        TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Friendship edges. Stored in BOTH directions (a->b and b->a) so "my friends"
-- is a single indexed lookup.
CREATE TABLE IF NOT EXISTS friendships (
  a_id        TEXT NOT NULL REFERENCES accounts(id),
  b_id        TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);

-- Gifts. A send inserts an unclaimed row; a claim sets claimed_at and credits the
-- recipient's save. `claimed_at IS NULL` = still in the recipient's inbox.
CREATE TABLE IF NOT EXISTS gifts (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL REFERENCES accounts(id),
  to_id       TEXT NOT NULL REFERENCES accounts(id),
  type        TEXT NOT NULL DEFAULT 'brain',
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_gifts_inbox ON gifts (to_id, claimed_at);
-- Fast "did I already gift this friend recently?" lookup for the daily gate.
CREATE INDEX IF NOT EXISTS idx_gifts_pair ON gifts (from_id, to_id, created_at);

-- Migration 0004 — server-authoritative currency (Phase 4, doc items 1-2).
--
-- Run ONCE:
--   wrangler d1 execute zombiefarm --remote --file=./migrations/0004_economy_ledger.sql
--
-- Purely additive. `balances` rows are created lazily on first /economy/balance
-- read, seeded from the player's current save so nobody loses gold/brains/xp on
-- migration. From then on the server balance is authoritative.

CREATE TABLE IF NOT EXISTS balances (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id),
  gold        INTEGER NOT NULL DEFAULT 0,
  brains      INTEGER NOT NULL DEFAULT 0,
  xp          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  currency    TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger (account_id, created_at);

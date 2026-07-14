-- P11: server-owned consumable boost inventory. Counts become server-authoritative
-- (buy debits the exact catalog price + grants; use decrements; loot grants), so the
-- save blob's boost list can no longer fabricate boosts. The invasion voucher's count
-- lives here too, so /raid/start can consume it server-side instead of trusting the
-- client's bypass.
--
-- Additive: new tables only, seeded lazily from each player's save on first sync.
-- Safe to run against a live DB.
CREATE TABLE IF NOT EXISTS inventory (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_key   TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, item_key)
);

CREATE TABLE IF NOT EXISTS inventory_actions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL
);

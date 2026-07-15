-- Phase D: server-owned placeable objects (buy + refund).
--
-- Object ownership is tracked as a COUNT per key (placement/position stays client-side
-- layout, like the boost inventory). A server-priced `buy` debits the exact catalog cost
-- + grants buyXp; a `refund` credits floor(cost * 0.2) and decrements (guarded so it can't
-- go negative — you can't refund an object you don't own). Seeded once from the save.
--
-- Additive tables; safe to run against a live DB.
CREATE TABLE IF NOT EXISTS object_counts (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  object_key TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, object_key)
);

-- Idempotency ledger for object actions (uuid per action). A retried buy/refund is a
-- no-op instead of double-charging or double-crediting.
CREATE TABLE IF NOT EXISTS object_actions (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);

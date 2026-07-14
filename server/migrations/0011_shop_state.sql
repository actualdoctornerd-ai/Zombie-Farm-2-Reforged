-- P16: server-owned non-boost purchases — farm size (a scalar) and ground/climate
-- skins (an owned set). Both are seeded once from the save and then owned by the
-- server (exact-price upgrades/buys), so an edited save can't fabricate a bigger farm
-- or free skins.
--
-- Additive: new tables only, seeded lazily from each player's save on first sync.
-- Safe to run against a live DB.
CREATE TABLE IF NOT EXISTS farm_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  size       INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS owned_climates (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  terrain    TEXT NOT NULL,
  PRIMARY KEY (account_id, terrain)
);

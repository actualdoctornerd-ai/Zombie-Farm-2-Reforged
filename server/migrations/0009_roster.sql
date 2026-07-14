-- P12: server-owned zombie roster (validation + money shadow). Makes SELL
-- server-authoritative (server prices floor(cost/2) and removes the unit, so a
-- fabricated zombie can't be sold for gold), and gives the server an accurate roster
-- for future raid-roster validation. Grants (crop/gift/combine), veterancy, and
-- casualties keep the shadow in step with the client's units.
--
-- Additive: new tables only, seeded lazily from each player's save on first sync.
-- Safe to run against a live DB.
CREATE TABLE IF NOT EXISTS roster (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  id         TEXT NOT NULL,
  key        TEXT NOT NULL,
  mutation   INTEGER NOT NULL DEFAULT 0,
  invasions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS roster_actions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL
);

-- Migration 0005 — server-owned crop plots + exact per-action economics (doc 1-2).
--
-- Run ONCE:
--   wrangler d1 execute zombiefarm --remote --file=./migrations/0005_farm_economy.sql
--
-- Purely additive. Crops planted before this migration have no server plot record,
-- so the client grandfathers their harvests onto the bounds-validated economy path;
-- newly planted crops go through the exact path.

CREATE TABLE IF NOT EXISTS crop_plots (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  oc          INTEGER NOT NULL,
  pr          INTEGER NOT NULL,
  crop_key    TEXT NOT NULL,
  planted_at  INTEGER NOT NULL,
  grow_ms     INTEGER NOT NULL,
  sell        INTEGER NOT NULL,
  xp          INTEGER NOT NULL,
  fertilized  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, oc, pr)
);

CREATE TABLE IF NOT EXISTS farm_actions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL
);

-- Phase E: server-owned plowed soil.
--
-- A plot must be tilled before it can be planted. Previously `plow` was only an economy
-- ledger REASON — the till itself was a purely local spend, so online it cost nothing
-- (the local debit reconciled away) and planting never checked for soil at all. Now a
-- `plow` farm action debits the server's cost (0 while a Plowing Monolith is owned) +
-- grants 1 xp and records the soil here; a plant requires a row.
--
-- One row per PLOWED-AND-EMPTY plot. The row is deleted when the plot is planted (the
-- crop_plots row then represents that soil) and re-created by re-tilling the harvested
-- dirt/hole. So `plowed_soil` and `crop_plots` are disjoint by construction: a plot is
-- either bare, plowed-and-empty, or planted.
--
-- Coordinates match crop_plots (plot ORIGIN in base tiles, on the 4x4 plot lattice).
--
-- Additive; safe to run against a live DB. Existing accounts have no rows, so their
-- already-plowed soil is imported once by seedPlowedSoil (POST /farm/sync), gated by
-- MIGRATION_CUTOFF_MS like every other import. Without that import an existing player
-- would soft-lock: the server would say "not_plowed" while their client still shows the
-- soil as plowed and therefore refuses to re-till it.
CREATE TABLE IF NOT EXISTS plowed_soil (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  oc         INTEGER NOT NULL,   -- plot origin column
  pr         INTEGER NOT NULL,   -- plot origin row
  plowed_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, oc, pr)
);

-- Once-guard for that import. "No plowed_soil rows" is a LEGITIMATE steady state (you
-- planted everything), so seed-once-if-empty would let a client re-import plowed soil
-- over and over — each row is worth the plow cost + 1 xp, i.e. an xp mint. A dedicated
-- flag is the only correct guard.
ALTER TABLE farm_state ADD COLUMN soil_seeded INTEGER NOT NULL DEFAULT 0;

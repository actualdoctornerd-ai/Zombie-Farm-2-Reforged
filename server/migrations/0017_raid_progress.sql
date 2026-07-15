-- T1: server-owned raid progress (lifetime wins per raid).
--
-- Two problems this closes.
--
-- 1. FIRST-CLEAR RE-EARN. `raid_clears` was never seeded from the save, so every player
--    who migrated with raids already won was invisible to the server and could re-earn
--    first-clear XP for all 11 raids (~21,000 XP -> ~24 free level-up brains). The
--    import below makes their existing wins count.
--
-- 2. WINS LIVED ONLY IN THE BLOB. `raids.completed` (lifetime wins per raid) is what
--    drives zombie ABILITY unlocks (GameState.tierAbilitiesUnlocked reads raidWins of
--    raid ids 1..4 for tiers 1..4), so an edited save could unlock every ability. Wins
--    now live here and settleRaid maintains them.
--
-- `wins` defaults to 1 because every existing raid_clears row was written by a win.
ALTER TABLE raid_clears ADD COLUMN wins INTEGER NOT NULL DEFAULT 1;

-- Once-guard for the import. "No raid_clears rows" is a LEGITIMATE state (you've never
-- won a raid), so seed-once-if-empty can't guard this — it would let a client re-import
-- wins, and wins buy ability unlocks. Same reasoning as farm_state.soil_seeded (0015).
ALTER TABLE raid_state ADD COLUMN progress_seeded INTEGER NOT NULL DEFAULT 0;

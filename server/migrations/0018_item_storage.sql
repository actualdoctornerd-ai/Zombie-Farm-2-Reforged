-- T2/F: server-owned item storage — the Received bucket and the shed.
--
-- Both are collections of loot-item names with counts, so one table with a `bucket`
-- discriminator covers them:
--   'received' — raid loot waiting to be claimed/placed (the Received tab)
--   'stored'   — items packed away in the shed (the Items tab)
--
-- Why server-owned:
--   * T2 rolls raid loot server-side, so the grant needs somewhere real to land.
--   * The loot roll's unique/limit filters ask "do you already own one?" — a question
--     that can't be answered from an editable blob.
--   * Phase F: `storage.received` / `storage.items` were client-authored, and the claim
--     path turned a Received boost into an inventory `grant` (removed in Phase 0), so a
--     blob-injected item claimed into nothing. Loot was silently broken online.
--
-- The shed's item CAP is NOT stored: it's derived from the shed the account owns, which
-- object_counts already knows (storageSlots per shed tier).
CREATE TABLE IF NOT EXISTS item_storage (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  bucket     TEXT NOT NULL,      -- 'received' | 'stored'
  item_key   TEXT NOT NULL,      -- loot item NAME (drops.json key), e.g. "Scarecrow"
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, bucket, item_key)
);

-- Once-guard for the import. Empty storage is a LEGITIMATE state (you've claimed
-- everything, or you're new), so seed-once-if-empty can't guard it — a client could
-- re-import items whenever it held none. Same reasoning as farm_state.soil_seeded (0015)
-- and raid_state.progress_seeded (0017).
--
-- farm_state is one row per account and already carries soil_seeded, so it serves as the
-- account's import-flag row. The name is a historical stretch; it is NOT farm-specific.
ALTER TABLE farm_state ADD COLUMN storage_seeded INTEGER NOT NULL DEFAULT 0;

-- Golden Dice spent on a raid, PINNED to the session at /raid/start (where the server
-- consumes them from the boost inventory). The loot roll's luck bracket reads this, so
-- the client can't declare its own luck at finish. Pre-T2 sessions have 0 = no luck.
ALTER TABLE raid_sessions ADD COLUMN dice INTEGER NOT NULL DEFAULT 0;

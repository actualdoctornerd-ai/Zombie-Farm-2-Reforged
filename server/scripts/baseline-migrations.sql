-- Run only after schema.sql initializes a fresh database. This records the migration
-- effects already contained in that full schema snapshot so Wrangler never replays
-- historical ALTER or destructive reset migrations against it.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_trackA_upgrade.sql'),
  ('0002_grant_settlement.sql'),
  ('0003_raid_cooldown.sql'),
  ('0004_economy_ledger.sql'),
  ('0005_farm_economy.sql'),
  ('0006_session_labels.sql'),
  ('0007_raid_rewards.sql'),
  ('0008_boost_inventory.sql'),
  ('0009_roster.sql'),
  ('0010_combine_jobs.sql'),
  ('0011_shop_state.sql'),
  ('0012_level_rewards.sql'),
  ('0013_quest_completions.sql'),
  ('0014_object_ownership.sql'),
  ('0015_plowed_soil.sql'),
  ('0016_raid_session_reserve.sql'),
  ('0017_raid_progress.sql'),
  ('0018_item_storage.sql'),
  ('0019_integrity_v2.sql'),
  ('0020_permanent_import_closure.sql'),
  ('0020_protocol_v3_reset.sql'),
  ('0021_epic_boss.sql'),
  ('0022_epic_boss_retry_skip.sql'),
  ('0023_raid_revives.sql'),
  ('0024_epic_boss_tokens.sql'),
  ('0025_writer_lease.sql'),
  ('0026_black_market.sql'),
  ('0027_v3_raid_replay.sql'),
  ('0028_gift_rewards.sql'),
  ('0029_restore_ledger.sql'),
  ('0030_black_market_specific_mutations.sql'),
  ('0031_account_last_online.sql'),
  ('0032_black_market_collection.sql'),
  ('0033_black_market_history.sql'),
  ('0034_quest_45_popcorn_backfill.sql'),
  ('0035_headless_mutation_repair.sql'),
  ('0036_raid_brain_pity.sql'),
  ('0037_raid_zombie_pity.sql'),
  ('0038_gift_reward_roll.sql'),
  ('0039_roster_escrow_return.sql'),
  ('0040_black_market_delivery_claim.sql'),
  ('0041_roster_color.sql'),
  ('0042_service_state.sql'),
  ('0043_black_market_brain_payout.sql'),
  ('0044_black_market_mutation_width.sql'),
  ('0045_black_market_gold.sql'),
  -- Data repair only (clamps in-flight Epic Boss runs to the 20-rung ladder); a fresh
  -- database has no rows to repair, so baselining it is a no-op.
  ('0046_epic_boss_twenty_level_ladder.sql'),
  ('0047_fallen_zombies.sql'),
  ('0048_fallen_released_at.sql'),
  ('0049_periodic_quests.sql'),
  -- Data repair only (retires the lower-tier mutation bit the two Tier-4 variants used
  -- to ride); a fresh database has no rows to repair, so baselining it is a no-op.
  ('0050_tier4_variant_mutations.sql'),
  -- Data repair only (pulls runs parked above the re-cut 10-rung Epic ladder down to its
  -- top and corrects their HP); a fresh database has no rows to repair, so baselining it
  -- is a no-op.
  ('0051_epic_boss_ten_rung_ladder.sql'),
  -- Data repair only (re-fits in-flight Epic runs onto the per-boss baseHp ramp); a fresh
  -- database has no rows to repair, so baselining it is a no-op.
  ('0052_epic_boss_per_boss_base_hp.sql'),
  -- Data repair only (buries Epic Boss casualties that settled before the graveyard
  -- write existed); a fresh database has no rows to repair, so baselining it is a no-op.
  ('0053_epic_boss_graveyard_backfill.sql'),
  -- Adds epic_boss_runs_v3.started_crop, which schema.sql already creates on a fresh
  -- database, so re-running the ALTER would fail on a duplicate column.
  ('0054_epic_boss_started_crop.sql'),
  -- Creates pvp_sessions_v3 (friend invasions), which schema.sql already creates
  -- on a fresh database.
  ('0055_pvp_invasions.sql'),
  -- Data repair only (empties the pinned config of already-finished raid and Epic Boss
  -- sessions); a fresh database has no finished sessions, so baselining it is a no-op.
  ('0056_release_spent_fight_configs.sql'),
  ('0057_pvp_rework.sql'),
  -- Adds raid_state_v3.tier_json (dual-invasion ladder position), which schema.sql
  -- already declares on a fresh database.
  ('0058_dual_invasion_tiers.sql');

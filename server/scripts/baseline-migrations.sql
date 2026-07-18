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
  ('0026_black_market.sql');

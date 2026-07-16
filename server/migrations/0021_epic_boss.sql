CREATE TABLE IF NOT EXISTS epic_boss_runs_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE, boss_id TEXT NOT NULL,
  activated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  level INTEGER NOT NULL, max_hp INTEGER NOT NULL, current_hp INTEGER NOT NULL,
  encounter_started_at INTEGER NOT NULL DEFAULT 0,
  retry_ready_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0,
  attack_order_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS epic_boss_sessions_v3 (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL, level INTEGER NOT NULL, starting_hp INTEGER NOT NULL,
  roster_json TEXT NOT NULL, config_json TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  finished_at INTEGER, result_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_epic_boss_session_live_v3
  ON epic_boss_sessions_v3(account_id) WHERE finished_at IS NULL;

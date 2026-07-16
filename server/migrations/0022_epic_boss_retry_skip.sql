CREATE TABLE IF NOT EXISTS epic_boss_retry_skips_v3 (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  retry_ready_at INTEGER NOT NULL,
  cost_brains INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, run_id, retry_ready_at)
);

CREATE TABLE IF NOT EXISTS raid_revivals_v3 (
  session_id TEXT PRIMARY KEY REFERENCES raid_sessions_v3(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  casualties_json TEXT NOT NULL,
  revived_json TEXT,
  resolution_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_raid_revivals_pending
  ON raid_revivals_v3(account_id, resolved_at);

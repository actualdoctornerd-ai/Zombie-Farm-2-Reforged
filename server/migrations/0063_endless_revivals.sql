-- Endless: the brain revival a run's end offers, the same offer an invasion writes to
-- raid_revivals_v3 (2026-11-11: players could not buy back zombies lost in Endless). Its own
-- table only because raid_revivals_v3.session_id references raid_sessions_v3; /raid/revive
-- resolves both, and the bootstrap surfaces whichever unresolved offer is newest.
CREATE TABLE IF NOT EXISTS endless_revivals_v3 (
  session_id TEXT PRIMARY KEY REFERENCES endless_runs_v3(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  casualties_json TEXT NOT NULL,
  revived_json TEXT,
  resolution_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_endless_revivals_pending
  ON endless_revivals_v3(account_id, resolved_at);

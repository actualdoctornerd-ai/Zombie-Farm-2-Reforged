-- DESTRUCTIVE protocol-v3 reset. This migration intentionally discards every v2
-- identity, session, social, save, gameplay, receipt, and audit row. Rotate
-- SESSION_SECRET in the same maintenance window before reopening sign-in.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS audit_events_v3;
DROP TABLE IF EXISTS raid_state_v3;
DROP TABLE IF EXISTS raid_sessions_v3;
DROP TABLE IF EXISTS roster_v3;
DROP TABLE IF EXISTS presentations_v3;
DROP TABLE IF EXISTS gameplay_documents_v3;
DROP TABLE IF EXISTS quest_documents_v3;
DROP TABLE IF EXISTS object_documents_v3;
DROP TABLE IF EXISTS farm_documents_v3;
DROP TABLE IF EXISTS account_runtime_v3;
DROP TABLE IF EXISTS raid_checkpoints;
DROP TABLE IF EXISTS raid_roster_locks;
DROP TABLE IF EXISTS quest_event_applications;
DROP TABLE IF EXISTS quest_progress;
DROP TABLE IF EXISTS game_events;
DROP TABLE IF EXISTS command_receipts;
DROP TABLE IF EXISTS account_import_state;
DROP TABLE IF EXISTS object_actions;
DROP TABLE IF EXISTS object_counts;
DROP TABLE IF EXISTS quest_completions;
DROP TABLE IF EXISTS combine_jobs;
DROP TABLE IF EXISTS owned_climates;
DROP TABLE IF EXISTS farm_state;
DROP TABLE IF EXISTS roster_actions;
DROP TABLE IF EXISTS roster;
DROP TABLE IF EXISTS inventory_actions;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS farm_actions;
DROP TABLE IF EXISTS storage_actions;
DROP TABLE IF EXISTS item_storage;
DROP TABLE IF EXISTS plowed_soil;
DROP TABLE IF EXISTS crop_plots;
DROP TABLE IF EXISTS ledger;
DROP TABLE IF EXISTS balances;
DROP TABLE IF EXISTS raid_clears;
DROP TABLE IF EXISTS raid_sessions;
DROP TABLE IF EXISTS raid_state;
DROP TABLE IF EXISTS grants;
DROP TABLE IF EXISTS gifts;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS friend_requests;
DROP TABLE IF EXISTS friendships;
DROP TABLE IF EXISTS saves;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS accounts;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, username TEXT,
  friend_code TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER, label TEXT
);
CREATE INDEX idx_sessions_account ON sessions(account_id, revoked_at);
CREATE TABLE friendships (
  a_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY(a_id,b_id)
);
CREATE TABLE friend_requests (
  from_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY(from_id,to_id)
);
CREATE INDEX idx_reqs_incoming ON friend_requests(to_id,created_at);
CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY(blocker_id,blocked_id)
);
CREATE TABLE gifts (
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, type TEXT NOT NULL DEFAULT 'brain',
  created_at INTEGER NOT NULL, day_bucket INTEGER NOT NULL, claimed_at INTEGER
);
CREATE INDEX idx_gifts_inbox ON gifts(to_id,claimed_at);
CREATE UNIQUE INDEX idx_gifts_once ON gifts(from_id,to_id,day_bucket);
CREATE TABLE grants (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, amount INTEGER NOT NULL, source_gift_id TEXT UNIQUE,
  created_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE INDEX idx_grants_account ON grants(account_id,kind);
CREATE INDEX idx_grants_pending ON grants(account_id,settled_at);
CREATE TABLE rate_limits (bucket_key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE balances (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  gold INTEGER NOT NULL DEFAULT 200, brains INTEGER NOT NULL DEFAULT 15,
  xp INTEGER NOT NULL DEFAULT 0, claimed_level INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE account_runtime_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  account_version INTEGER NOT NULL DEFAULT 0, writer_device_id TEXT,
  writer_generation INTEGER NOT NULL DEFAULT 0, active_batch_id TEXT,
  last_batch_id TEXT, last_first_sequence INTEGER, last_result_json TEXT,
  command_window_start INTEGER NOT NULL DEFAULT 0, command_window_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE farm_documents_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0, current_json TEXT NOT NULL DEFAULT '{}',
  previous_version INTEGER, previous_json TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE object_documents_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0, current_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
);
CREATE TABLE quest_documents_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0, current_json TEXT NOT NULL DEFAULT '{"completed":[],"progress":[]}', updated_at INTEGER NOT NULL
);
CREATE TABLE gameplay_documents_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  current_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE presentations_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0, current_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
CREATE TABLE roster_v3 (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, unit_id TEXT NOT NULL,
  zombie_key TEXT NOT NULL, mutation INTEGER NOT NULL DEFAULT 0, invasions INTEGER NOT NULL DEFAULT 0,
  stored INTEGER NOT NULL DEFAULT 0, locked_by_raid TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,unit_id)
);
CREATE TABLE raid_sessions_v3 (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  raid_id TEXT NOT NULL, roster_json TEXT NOT NULL, boosts_json TEXT NOT NULL DEFAULT '{}', started_at INTEGER NOT NULL,
  earliest_finish_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT
);
CREATE TABLE raid_state_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_started_at INTEGER NOT NULL DEFAULT 0, progress_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_raid_v3_live ON raid_sessions_v3(account_id) WHERE finished_at IS NULL;
CREATE TABLE audit_events_v3 (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_v3_account ON audit_events_v3(account_id,created_at);

PRAGMA foreign_keys = ON;

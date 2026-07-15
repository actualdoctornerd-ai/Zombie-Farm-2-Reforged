-- Integrity v2: permanent import markers, atomic command receipts, authoritative
-- quest events/progress, and raid-verification state. Additive so the old Worker can
-- continue running while the v2 Worker/client are rolled out.

CREATE TABLE IF NOT EXISTS account_import_state (
  account_id       TEXT PRIMARY KEY REFERENCES accounts(id),
  balance_seeded   INTEGER NOT NULL DEFAULT 0,
  balance_token    TEXT,
  inventory_seeded INTEGER NOT NULL DEFAULT 0,
  inventory_token  TEXT,
  objects_seeded   INTEGER NOT NULL DEFAULT 0,
  objects_token    TEXT,
  roster_seeded    INTEGER NOT NULL DEFAULT 0,
  roster_token     TEXT,
  quests_seeded    INTEGER NOT NULL DEFAULT 0,
  quests_token     TEXT,
  shop_seeded      INTEGER NOT NULL DEFAULT 0,
  shop_token       TEXT,
  completed_at     INTEGER
);

CREATE TABLE IF NOT EXISTS command_receipts (
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  command_kind  TEXT NOT NULL,
  action_id     TEXT NOT NULL,
  attempt_token TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, command_kind, action_id)
);
CREATE INDEX IF NOT EXISTS idx_command_receipts_created
  ON command_receipts (created_at);

CREATE TABLE IF NOT EXISTS game_events (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  event_type   TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  amount       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_game_events_pending
  ON game_events (account_id, processed_at, created_at);

CREATE TABLE IF NOT EXISTS quest_progress (
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  quest_id          TEXT NOT NULL,
  requirement_index INTEGER NOT NULL,
  count              INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (account_id, quest_id, requirement_index)
);

CREATE TABLE IF NOT EXISTS quest_event_applications (
  event_id           TEXT NOT NULL REFERENCES game_events(id),
  account_id         TEXT NOT NULL REFERENCES accounts(id),
  quest_id           TEXT NOT NULL,
  requirement_index  INTEGER NOT NULL,
  applied_at         INTEGER NOT NULL,
  attempt_token      TEXT NOT NULL,
  PRIMARY KEY (event_id, quest_id, requirement_index)
);

CREATE TABLE IF NOT EXISTS raid_roster_locks (
  session_id TEXT NOT NULL REFERENCES raid_sessions(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  unit_id    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  PRIMARY KEY (session_id, unit_id),
  UNIQUE (account_id, unit_id)
);

CREATE TABLE IF NOT EXISTS raid_checkpoints (
  session_id    TEXT PRIMARY KEY REFERENCES raid_sessions(id),
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  last_seq      INTEGER NOT NULL DEFAULT 0,
  last_tick     INTEGER NOT NULL DEFAULT 0,
  input_bytes   INTEGER NOT NULL DEFAULT 0,
  state_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

ALTER TABLE raid_sessions ADD COLUMN ruleset_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE raid_sessions ADD COLUMN rng_seed TEXT;
ALTER TABLE raid_sessions ADD COLUMN config_json TEXT;
ALTER TABLE raid_sessions ADD COLUMN result_json TEXT;
ALTER TABLE raid_sessions ADD COLUMN invalid_reason TEXT;

-- Defense-in-depth invariants without rebuilding live tables.
CREATE TRIGGER IF NOT EXISTS trg_balances_nonnegative_insert
BEFORE INSERT ON balances
WHEN NEW.gold < 0 OR NEW.brains < 0 OR NEW.xp < 0
BEGIN SELECT RAISE(ABORT, 'negative_balance'); END;

CREATE TRIGGER IF NOT EXISTS trg_balances_nonnegative_update
BEFORE UPDATE OF gold, brains, xp ON balances
WHEN NEW.gold < 0 OR NEW.brains < 0 OR NEW.xp < 0
BEGIN SELECT RAISE(ABORT, 'negative_balance'); END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_nonnegative_insert
BEFORE INSERT ON inventory WHEN NEW.count < 0
BEGIN SELECT RAISE(ABORT, 'negative_inventory'); END;
CREATE TRIGGER IF NOT EXISTS trg_inventory_nonnegative_update
BEFORE UPDATE OF count ON inventory WHEN NEW.count < 0
BEGIN SELECT RAISE(ABORT, 'negative_inventory'); END;

CREATE TRIGGER IF NOT EXISTS trg_objects_nonnegative_insert
BEFORE INSERT ON object_counts WHEN NEW.count < 0
BEGIN SELECT RAISE(ABORT, 'negative_objects'); END;
CREATE TRIGGER IF NOT EXISTS trg_objects_nonnegative_update
BEFORE UPDATE OF count ON object_counts WHEN NEW.count < 0
BEGIN SELECT RAISE(ABORT, 'negative_objects'); END;

CREATE TRIGGER IF NOT EXISTS trg_storage_nonnegative_insert
BEFORE INSERT ON item_storage WHEN NEW.count < 0
BEGIN SELECT RAISE(ABORT, 'negative_storage'); END;
CREATE TRIGGER IF NOT EXISTS trg_storage_nonnegative_update
BEFORE UPDATE OF count ON item_storage WHEN NEW.count < 0
BEGIN SELECT RAISE(ABORT, 'negative_storage'); END;

-- Existing non-empty subsystems have already crossed their historical seed boundary.
INSERT OR IGNORE INTO account_import_state (account_id)
SELECT id FROM accounts;
UPDATE account_import_state
SET balance_seeded = EXISTS (SELECT 1 FROM balances b WHERE b.account_id = account_import_state.account_id),
    inventory_seeded = EXISTS (SELECT 1 FROM inventory i WHERE i.account_id = account_import_state.account_id),
    objects_seeded = EXISTS (SELECT 1 FROM object_counts o WHERE o.account_id = account_import_state.account_id),
    roster_seeded = EXISTS (SELECT 1 FROM roster r WHERE r.account_id = account_import_state.account_id),
    shop_seeded = EXISTS (SELECT 1 FROM farm_state f WHERE f.account_id = account_import_state.account_id);

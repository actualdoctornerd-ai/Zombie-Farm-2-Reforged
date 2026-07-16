-- Zombie Farm server schema (Cloudflare D1 / SQLite).
-- Idempotent: safe to run repeatedly (CREATE TABLE IF NOT EXISTS).

-- One row per signed-in player. NO PERSONAL DATA is stored: `google_sub` is
-- Google's opaque per-user id (used only to match a returning login; never
-- exposed by the API), `username` is the player-chosen display name (NULL until
-- picked on first sign-in), `friend_code` is a random share code. The email and
-- Google display name from the sign-in token are read for verification and then
-- discarded — never written here.
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  google_sub   TEXT UNIQUE NOT NULL,
  username     TEXT,
  friend_code  TEXT UNIQUE NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Migration from the earlier schema that stored PII (run once; safe on fresh DBs):
--   ALTER TABLE accounts DROP COLUMN email;
--   ALTER TABLE accounts DROP COLUMN name;

-- Ground-truth save blob, one per account. `rev` drives optimistic concurrency:
-- a PUT is accepted only if its baseRev matches the stored rev. The check is an
-- atomic compare-and-swap in db.writeSave (UPDATE ... WHERE rev = expected), so
-- two concurrent writes can no longer both win.
CREATE TABLE IF NOT EXISTS saves (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id),
  blob        TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Accepted friendship edges. Stored in BOTH directions (a->b and b->a) so
-- "my friends" is a single indexed lookup. A row here means the target ACCEPTED —
-- edges are created only by /friends/accept, never by /friends/add (which now
-- only files a pending request). See friend_requests + blocks below.
CREATE TABLE IF NOT EXISTS friendships (
  a_id        TEXT NOT NULL REFERENCES accounts(id),
  b_id        TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);

-- Pending friend requests (directional: from_id asked to befriend to_id). A
-- /friends/add inserts one row here; the recipient's /friends/accept promotes it
-- to a friendship (both directions) and deletes the request. Consent-based: nobody
-- lands in your friend graph without you accepting. INSERT OR IGNORE makes a
-- repeated add a no-op rather than an error or an oracle signal.
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id     TEXT NOT NULL REFERENCES accounts(id),
  to_id       TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_reqs_incoming ON friend_requests (to_id, created_at);

-- Block list (directional: blocker_id will not receive requests/gifts from
-- blocked_id, and cannot be found by them). Checked in /friends/add and /gifts.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  TEXT NOT NULL REFERENCES accounts(id),
  blocked_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Gifts. A send inserts an unclaimed row; a claim sets claimed_at and credits the
-- recipient via a unique grant (see grants). `claimed_at IS NULL` = still in the
-- recipient's inbox. `day_bucket` = floor(created_at / 86400000): the once-a-day
-- window is now enforced by a UNIQUE index rather than a read-then-insert race.
CREATE TABLE IF NOT EXISTS gifts (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL REFERENCES accounts(id),
  to_id       TEXT NOT NULL REFERENCES accounts(id),
  type        TEXT NOT NULL DEFAULT 'brain',
  created_at  INTEGER NOT NULL,
  day_bucket  INTEGER NOT NULL DEFAULT 0,
  claimed_at  INTEGER
);

-- Existing-DB migration for the day_bucket column (run once; harmless on fresh DBs
-- where the column already exists as part of CREATE TABLE above):
--   ALTER TABLE gifts ADD COLUMN day_bucket INTEGER NOT NULL DEFAULT 0;
--   UPDATE gifts SET day_bucket = created_at / 86400000;

CREATE INDEX IF NOT EXISTS idx_gifts_inbox ON gifts (to_id, claimed_at);
-- Atomic once/day gate: a second send in the same UTC day bucket hits this unique
-- constraint and is rejected without any preceding eligibility read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gifts_once ON gifts (from_id, to_id, day_bucket);

-- Idempotent credit ledger. A gift claim inserts exactly one grant keyed by the
-- source gift id (UNIQUE), so even a claim that races past the claimed_at guard
-- cannot credit the recipient twice. This is also the seam for server-owned
-- balances (Track B): today it records the +1 brain that a claim applies to the
-- save; later the balance can be derived from this table instead of the blob.
CREATE TABLE IF NOT EXISTS grants (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  kind           TEXT NOT NULL,           -- e.g. 'brain'
  amount         INTEGER NOT NULL,
  source_gift_id TEXT UNIQUE,             -- gift that produced this grant (idempotency key)
  created_at     INTEGER NOT NULL,
  -- When the grant's amount was applied into the (still client-shaped) save.
  -- NULL = pending: recorded but not yet reflected in the save. The claim path
  -- settles it immediately; if that couldn't land against save churn, the read-time
  -- reconciler (GET /save) settles it later. settled_at is the single-apply gate,
  -- so a grant is credited exactly once. (Full crash-safety needs a server-owned
  -- balance — deferred to the economy rebuild; see SECURITY.md item 1/4.)
  settled_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grants_account ON grants (account_id, kind);
-- Fast lookup of a specific account's still-pending grants for reconciliation.
CREATE INDEX IF NOT EXISTS idx_grants_pending ON grants (account_id, settled_at);

-- Revocable sessions. Each sign-in mints a session row; the access-token JWT
-- carries this id (sid). verifySession rejects a token whose session is missing or
-- revoked, so sign-out / "log out everywhere" / a leaked token can be killed
-- server-side instead of remaining valid until the JWT expires.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at   INTEGER,
  -- Human device label (e.g. "Chrome on Windows") derived SERVER-SIDE from the
  -- User-Agent at sign-in, so a player can tell their active devices apart in the
  -- Account menu. Never client-supplied. Null for pre-P8 rows / unknown agents.
  label        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id, revoked_at);

-- Server-owned raid cooldown clock, one row per account. The between-raids
-- cooldown is now decided by THIS `last_raid_at` (set on /raid/finish), not by the
-- client-authored save — so editing the save can't reset it. (Skipping the cooldown with
-- an Invasion Voucher is intended play; the voucher is consumed server-side.)
CREATE TABLE IF NOT EXISTS raid_state (
  account_id      TEXT PRIMARY KEY REFERENCES accounts(id),
  last_raid_at    INTEGER NOT NULL DEFAULT 0,
  -- Once-guard for the raid_clears import (migration 0017). Zero clears is a legitimate
  -- state, so seed-once-if-empty can't guard it; this flag can.
  progress_seeded INTEGER NOT NULL DEFAULT 0
);

-- One-use, expiring raid sessions. /raid/start opens one after the server cooldown
-- gate passes and pins the raid being fought (raid_id); /raid/finish consumes it
-- exactly once (finished_at CAS) to start the cooldown AND credit the server-computed
-- reward for raid_id. This is also the seam for future deterministic raid replay:
-- seed + pinned ruleset will hang here, and the transcript will be validated.
CREATE TABLE IF NOT EXISTS raid_sessions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  started_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  finished_at INTEGER,
  raid_id     INTEGER,             -- which raid this session is for (server prices the reward)
  dice        INTEGER NOT NULL DEFAULT 0, -- Golden Dice spent (loot luck), consumed at start
  ruleset_version INTEGER NOT NULL DEFAULT 0,
  rng_seed    TEXT,
  config_json TEXT,
  result_json TEXT,
  invalid_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_raid_sessions_acct ON raid_sessions (account_id, finished_at);
-- One LIVE (unfinished) raid session per account — the backstop for openRaidSessionOnce's
-- atomic reserve (migration 0016). Partial, so finished sessions accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_raid_sessions_live
  ON raid_sessions (account_id)
  WHERE finished_at IS NULL;

-- Server-owned raid progress + first-clear ledger. The FIRST win of a raid grants XP
-- (repeat wins pay gold only); one row per (account, raid), and INSERT OR IGNORE makes
-- "first clear" atomic + idempotent so the XP can't be farmed by replaying finishes.
-- `wins` is the LIFETIME win count (migration 0017), which drives zombie ability unlocks
-- (tier N's abilities unlock one per win of raid N) — so it must not live in the editable
-- save. Imported once from a migrating save, guarded by raid_state.progress_seeded.
CREATE TABLE IF NOT EXISTS raid_clears (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  raid_id    INTEGER NOT NULL,
  cleared_at INTEGER NOT NULL,
  wins       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, raid_id)
);

-- Server-authoritative currency. `balances` is the materialized truth for
-- gold/brains/xp, seeded once from the player's save (economySeeded) so nobody
-- loses current progress on migration. From then on the SERVER balance is
-- authoritative: the client syncs from it on load and reconciles to it, so a
-- save-edited currency value is corrected rather than trusted.
CREATE TABLE IF NOT EXISTS balances (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id),
  gold          INTEGER NOT NULL DEFAULT 0,
  brains        INTEGER NOT NULL DEFAULT 0,
  xp            INTEGER NOT NULL DEFAULT 0,
  -- Highest level the +1-brain-per-level reward has already been paid for. Server
  -- derives level from `xp` (levels.ts) and grants brains for each new level exactly
  -- once. DEFAULT 0 is the "uninitialized" sentinel: the first reconcile adopts the
  -- current level without granting, so migrated progress isn't a retroactive windfall.
  claimed_level INTEGER NOT NULL DEFAULT 0
);

-- Append-only economy ledger. Every currency change is an event with a
-- client-generated id (idempotency key), so retries/concurrent flushes can't
-- double-apply. Spends are rejected when they'd overdraw; earns are bounded by a
-- per-reason cap (see catalog.ts) — the transitional plausibility control until
-- the server computes exact per-action economics from its own farm/roster state.
CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,       -- client idempotency key (uuid)
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  currency    TEXT NOT NULL,          -- 'gold' | 'brains' | 'xp'
  delta       INTEGER NOT NULL,       -- signed
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger (account_id, created_at);

-- Server-owned planted crops (exact per-action economics). A validated `plant`
-- action records a row here with the SERVER plant time and the economics locked in
-- from the catalog; a `harvest` action is gated by grow time against `planted_at`
-- (so a client can't fast-harvest by editing its clock) and credits the exact
-- sell/xp. Keyed by (account, plot origin) — one crop per plot. `pr` is the plot
-- origin row (named `pr`, not `or`, because OR is a SQL keyword).
CREATE TABLE IF NOT EXISTS crop_plots (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  oc          INTEGER NOT NULL,   -- plot origin column
  pr          INTEGER NOT NULL,   -- plot origin row
  crop_key    TEXT NOT NULL,
  planted_at  INTEGER NOT NULL,
  grow_ms     INTEGER NOT NULL,
  sell        INTEGER NOT NULL,   -- base gold value (pre-fertilize)
  xp          INTEGER NOT NULL,
  fertilized  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, oc, pr)
);

-- Plowed-and-empty soil (Phase E, migration 0015). A plant requires a row here; the
-- row is consumed by the plant and re-created by re-tilling the harvested plot, so
-- plowed_soil and crop_plots are disjoint: a plot is bare, plowed, or planted.
CREATE TABLE IF NOT EXISTS plowed_soil (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  oc         INTEGER NOT NULL,   -- plot origin column
  pr         INTEGER NOT NULL,   -- plot origin row
  plowed_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, oc, pr)
);

-- Server-owned item storage (migration 0018): the Received bucket (raid loot awaiting
-- claim) and the shed. Same shape, split by `bucket`. The shed's item CAP is derived from
-- the shed in object_counts, not stored. Raid loot lands here, and the loot roll's
-- unique/limit filters read it to answer "do you already own one?".
CREATE TABLE IF NOT EXISTS item_storage (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  bucket     TEXT NOT NULL,  -- 'received' | 'stored'
  item_key   TEXT NOT NULL,  -- loot item NAME (drops.json key)
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, bucket, item_key)
);

-- Idempotency ledger for storage moves (claim / store / retrieve), migration 0018.
CREATE TABLE IF NOT EXISTS storage_actions (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);

-- Idempotency ledger for farm actions (uuid per action). A retried plant/harvest
-- is a no-op instead of double-charging or double-crediting.
CREATE TABLE IF NOT EXISTS farm_actions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL
);

-- Server-owned consumable boost inventory (counts). Seeded once from the save's boost
-- list; thereafter the SERVER count is authoritative (the blob's list is an ignored
-- cache, like currency). A `buy` debits the exact catalog price from `balances` and
-- grants perPurchase; a `use` decrements; a `grant` (loot) increments. Keyed by
-- (account, item). Only the catalog's boost keys are tracked here.
CREATE TABLE IF NOT EXISTS inventory (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_key   TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, item_key)
);

-- Idempotency ledger for inventory actions (uuid per action). A retried buy/use/grant
-- is a no-op instead of double-charging, double-spending a use, or double-granting.
CREATE TABLE IF NOT EXISTS inventory_actions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL
);

-- Server-owned zombie roster (a validation + money shadow of the client's units).
-- Only the source-of-truth fields are stored — id/key/mutation/invasions — since a
-- unit's stats derive from its key. Seeded once from the save. A SELL is priced +
-- credited here (so a client can't sell a fabricated unit for gold); grants (crop
-- harvest, gift redeem, combine result), veterancy, and casualties keep it accurate.
CREATE TABLE IF NOT EXISTS roster (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  id         TEXT NOT NULL,           -- client-shared unit instance id (e.g. "z3")
  key        TEXT NOT NULL,           -- catalog zombie key
  mutation   INTEGER NOT NULL DEFAULT 0,
  invasions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

-- Idempotency ledger for roster actions (uuid per action). A retried sell/grant/
-- veteran/casualty is a no-op instead of double-crediting or double-mutating.
CREATE TABLE IF NOT EXISTS roster_actions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL
);

-- Server-owned farm size (a scalar, upgraded 30→40→50→60 in sequence). Seeded once
-- from the save; thereafter the server owns it (a `sizeUpgrade` debits the exact tier
-- price + bumps it), so an edited save can't fabricate a bigger farm.
-- Per-account farm state — and, by history, the account's import-flag row (the *_seeded
-- columns are NOT farm-specific). Each flag guards a one-time seed-from-save whose
-- subsystem can legitimately be EMPTY, so "no rows yet" can't serve as the once-guard.
CREATE TABLE IF NOT EXISTS farm_state (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id),
  size           INTEGER NOT NULL DEFAULT 30,
  soil_seeded    INTEGER NOT NULL DEFAULT 0, -- plowed_soil import (0015)
  storage_seeded INTEGER NOT NULL DEFAULT 0  -- item_storage import (0018)
);

-- Server-owned ground/climate skins owned by an account (an owned set). Seeded once
-- from the save; buying a skin debits its exact price + inserts here. "grass" (the free
-- default) is implicit and never stored.
CREATE TABLE IF NOT EXISTS owned_climates (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  terrain    TEXT NOT NULL,
  PRIMARY KEY (account_id, terrain)
);

-- Server-owned Zombie Pot combine job (one per account). combineStart consumes the
-- two parents (removing them from `roster`) and records their KEYS here; combineCollect
-- validates that the granted result key is one of the two parent keys — so a combine
-- can't fabricate an arbitrary (expensive) result. (The pot's result species is always
-- one of the two parents; only the mutation mask merges.)
CREATE TABLE IF NOT EXISTS combine_jobs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  key_a      TEXT NOT NULL,
  key_b      TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

-- Server-owned placeable objects (Phase D). Ownership is a COUNT per object key
-- (placement/position stays client-side layout). A server-priced `buy` debits the exact
-- catalog cost + grants buyXp; a `refund` credits floor(cost * 0.2) and decrements the
-- count (guarded so you can't refund an object you don't own). Seeded once from the save.
CREATE TABLE IF NOT EXISTS object_counts (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  object_key TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, object_key)
);

-- Idempotency ledger for object actions (uuid per action). A retried buy/refund is a
-- no-op instead of double-charging or double-crediting.
CREATE TABLE IF NOT EXISTS object_actions (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);

-- Server-authoritative quest rewards. A completed quest grants its reward from the
-- SERVER catalog (questCatalog.ts, mirrored from quests.json) — never a client-sent
-- amount — at most ONCE per (account, quest); the PRIMARY KEY is the once-guard.
-- Currency rewards (Xp/Gold/Brains) are credited to `balances`; Item/Zombie rewards are
-- recorded here but granted later (Phase D — they need server-owned storage/roster).
-- Requirement PROOF is still deferred (client-asserted completion), so a reward is
-- bounded-once, not yet proven-earned.
CREATE TABLE IF NOT EXISTS quest_completions (
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  quest_id     TEXT NOT NULL,
  reward_type  INTEGER NOT NULL,
  reward_value INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, quest_id)
);

-- Fixed-window rate-limit counters (per-key). The key encodes route + caller
-- (account id or IP) + window bucket; each request atomically bumps the count and
-- the middleware rejects once a threshold is exceeded. Old windows are inert and
-- can be swept periodically.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Integrity v2 (migration 0019).
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
CREATE TRIGGER IF NOT EXISTS trg_accounts_close_legacy_imports
AFTER INSERT ON accounts
BEGIN
  INSERT OR IGNORE INTO account_import_state
    (account_id, balance_seeded, inventory_seeded, objects_seeded, roster_seeded, quests_seeded, shop_seeded)
  VALUES (NEW.id, 1, 1, 1, 1, 1, 1);
END;
CREATE TABLE IF NOT EXISTS command_receipts (
  account_id TEXT NOT NULL REFERENCES accounts(id), command_kind TEXT NOT NULL,
  action_id TEXT NOT NULL, attempt_token TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, command_kind, action_id)
);
CREATE INDEX IF NOT EXISTS idx_command_receipts_created ON command_receipts (created_at);
CREATE TABLE IF NOT EXISTS game_events (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  event_type TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_game_events_pending ON game_events (account_id, processed_at, created_at);
CREATE TABLE IF NOT EXISTS quest_progress (
  account_id TEXT NOT NULL REFERENCES accounts(id), quest_id TEXT NOT NULL,
  requirement_index INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, quest_id, requirement_index)
);
CREATE TABLE IF NOT EXISTS quest_event_applications (
  event_id TEXT NOT NULL REFERENCES game_events(id), account_id TEXT NOT NULL REFERENCES accounts(id),
  quest_id TEXT NOT NULL, requirement_index INTEGER NOT NULL, applied_at INTEGER NOT NULL, attempt_token TEXT NOT NULL,
  PRIMARY KEY (event_id, quest_id, requirement_index)
);
CREATE TABLE IF NOT EXISTS raid_roster_locks (
  session_id TEXT NOT NULL REFERENCES raid_sessions(id), account_id TEXT NOT NULL REFERENCES accounts(id),
  unit_id TEXT NOT NULL, position INTEGER NOT NULL, snapshot TEXT NOT NULL,
  PRIMARY KEY (session_id, unit_id), UNIQUE (account_id, unit_id)
);
CREATE TABLE IF NOT EXISTS raid_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES raid_sessions(id), account_id TEXT NOT NULL REFERENCES accounts(id),
  last_seq INTEGER NOT NULL DEFAULT 0, last_tick INTEGER NOT NULL DEFAULT 0,
  input_bytes INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_balances_nonnegative_insert BEFORE INSERT ON balances
WHEN NEW.gold < 0 OR NEW.brains < 0 OR NEW.xp < 0 BEGIN SELECT RAISE(ABORT, 'negative_balance'); END;
CREATE TRIGGER IF NOT EXISTS trg_balances_nonnegative_update BEFORE UPDATE OF gold, brains, xp ON balances
WHEN NEW.gold < 0 OR NEW.brains < 0 OR NEW.xp < 0 BEGIN SELECT RAISE(ABORT, 'negative_balance'); END;
CREATE TRIGGER IF NOT EXISTS trg_inventory_nonnegative_insert BEFORE INSERT ON inventory
WHEN NEW.count < 0 BEGIN SELECT RAISE(ABORT, 'negative_inventory'); END;
CREATE TRIGGER IF NOT EXISTS trg_inventory_nonnegative_update BEFORE UPDATE OF count ON inventory
WHEN NEW.count < 0 BEGIN SELECT RAISE(ABORT, 'negative_inventory'); END;
CREATE TRIGGER IF NOT EXISTS trg_objects_nonnegative_insert BEFORE INSERT ON object_counts
WHEN NEW.count < 0 BEGIN SELECT RAISE(ABORT, 'negative_objects'); END;
CREATE TRIGGER IF NOT EXISTS trg_objects_nonnegative_update BEFORE UPDATE OF count ON object_counts
WHEN NEW.count < 0 BEGIN SELECT RAISE(ABORT, 'negative_objects'); END;
CREATE TRIGGER IF NOT EXISTS trg_storage_nonnegative_insert BEFORE INSERT ON item_storage
WHEN NEW.count < 0 BEGIN SELECT RAISE(ABORT, 'negative_storage'); END;
CREATE TRIGGER IF NOT EXISTS trg_storage_nonnegative_update BEFORE UPDATE OF count ON item_storage
WHEN NEW.count < 0 BEGIN SELECT RAISE(ABORT, 'negative_storage'); END;

-- Protocol v3 stores frequently-changing low-row-count gameplay as versioned JSON
-- documents. Relational rows remain only where identity/lifecycle auditing matters.
CREATE TABLE IF NOT EXISTS account_runtime_v3 (
  account_id            TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  account_version       INTEGER NOT NULL DEFAULT 0,
  writer_device_id      TEXT,
  writer_generation     INTEGER NOT NULL DEFAULT 0,
  active_batch_id       TEXT,
  last_batch_id         TEXT,
  last_first_sequence   INTEGER,
  last_result_json      TEXT,
  command_window_start  INTEGER NOT NULL DEFAULT 0,
  command_window_count  INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS farm_documents_v3 (
  account_id        TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL DEFAULT 0,
  current_json      TEXT NOT NULL DEFAULT '{}',
  previous_version  INTEGER,
  previous_json     TEXT,
  updated_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS object_documents_v3 (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 0,
  current_json  TEXT NOT NULL DEFAULT '[]',
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quest_documents_v3 (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 0,
  current_json  TEXT NOT NULL DEFAULT '{"completed":[],"progress":[]}',
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gameplay_documents_v3 (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  current_json  TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presentations_v3 (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 0,
  current_json  TEXT NOT NULL DEFAULT '{}',
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roster_v3 (
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  unit_id          TEXT NOT NULL,
  zombie_key       TEXT NOT NULL,
  mutation         INTEGER NOT NULL DEFAULT 0,
  invasions        INTEGER NOT NULL DEFAULT 0,
  stored           INTEGER NOT NULL DEFAULT 0,
  locked_by_raid   TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, unit_id)
);
CREATE TABLE IF NOT EXISTS raid_sessions_v3 (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  raid_id             TEXT NOT NULL,
  roster_json         TEXT NOT NULL,
  boosts_json         TEXT NOT NULL DEFAULT '{}',
  started_at          INTEGER NOT NULL,
  earliest_finish_at  INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  result_json         TEXT
);
CREATE TABLE IF NOT EXISTS raid_state_v3 (
  account_id       TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_started_at  INTEGER NOT NULL DEFAULT 0,
  progress_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raid_v3_live
  ON raid_sessions_v3(account_id) WHERE finished_at IS NULL;
CREATE TABLE IF NOT EXISTS epic_boss_runs_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE, boss_id TEXT NOT NULL,
  activated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  level INTEGER NOT NULL, max_hp INTEGER NOT NULL, current_hp INTEGER NOT NULL,
  encounter_started_at INTEGER NOT NULL DEFAULT 0, retry_ready_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0, attack_order_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS epic_boss_sessions_v3 (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL, level INTEGER NOT NULL, starting_hp INTEGER NOT NULL,
  roster_json TEXT NOT NULL, config_json TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  finished_at INTEGER, result_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_epic_boss_session_live_v3
  ON epic_boss_sessions_v3(account_id) WHERE finished_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_events_v3 (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_v3_account ON audit_events_v3(account_id, created_at);

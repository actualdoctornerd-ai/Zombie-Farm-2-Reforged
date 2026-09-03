-- Zombie Farm server schema (Cloudflare D1 / SQLite).
-- Idempotent: safe to run repeatedly (CREATE TABLE IF NOT EXISTS).
--
-- THIS FILE IS A SNAPSHOT OF WHAT THE MIGRATIONS BUILD, NOT A SECOND SCHEMA. A
-- fresh database (staging, the test suites, a local dev DB) is created from this
-- file; production was built by replaying migrations/ in order. The two must agree
-- object for object — tables, columns, defaults, foreign-key actions, indexes,
-- triggers — or a test passes against a shape production does not have. That is
-- exactly how account deletion broke: this file kept 25 tables the v3 reset
-- (migration 0020_protocol_v3_reset) had dropped, the purge list mirrored this
-- file, every test passed, and every production delete failed on the first
-- DELETE FROM a table that no longer existed.
--
-- `test/schemaParity.test.ts` replays the migration chain into SQLite and diffs it
-- against this file. When a migration changes the schema, change this file in the
-- same commit; when this file changes, there must be a migration that makes the
-- same change on production. Neither edit is complete without the other.

-- One row per signed-in player. NO PERSONAL DATA is stored: `google_sub` is
-- Google's opaque per-user id (used only to match a returning login; never
-- exposed by the API), `username` is the player-chosen display name (NULL until
-- picked on first sign-in), `friend_code` is a random share code. The email and
-- Google display name from the sign-in token are read for verification and then
-- discarded — never written here.
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  google_sub     TEXT UNIQUE NOT NULL,
  username       TEXT,
  friend_code    TEXT UNIQUE NOT NULL,
  created_at     INTEGER NOT NULL,
  -- Account-level activity heartbeat for administrative account inspection.
  -- Updated at sign-in and alongside the throttled per-session heartbeat.
  last_online_at INTEGER NOT NULL DEFAULT 0
);

-- Migration from the earlier schema that stored PII (run once; safe on fresh DBs):
--   ALTER TABLE accounts DROP COLUMN email;
--   ALTER TABLE accounts DROP COLUMN name;

-- Accepted friendship edges. Stored in BOTH directions (a->b and b->a) so
-- "my friends" is a single indexed lookup. A row here means the target ACCEPTED —
-- edges are created only by /friends/accept, never by /friends/add (which now
-- only files a pending request). See friend_requests + blocks below.
CREATE TABLE IF NOT EXISTS friendships (
  a_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  b_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);

-- Pending friend requests (directional: from_id asked to befriend to_id). A
-- /friends/add inserts one row here; the recipient's /friends/accept promotes it
-- to a friendship (both directions) and deletes the request. Consent-based: nobody
-- lands in your friend graph without you accepting. INSERT OR IGNORE makes a
-- repeated add a no-op rather than an error or an oracle signal.
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_reqs_incoming ON friend_requests (to_id, created_at);

-- Block list (directional: blocker_id will not receive requests/gifts from
-- blocked_id, and cannot be found by them). Checked in /friends/add and /gifts.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Gifts. A send inserts an unclaimed row; a claim sets claimed_at and credits the
-- recipient via a unique grant (see grants). `claimed_at IS NULL` = still in the
-- recipient's inbox. `day_bucket` = floor(created_at / 86400000): the once-a-day
-- window is now enforced by a UNIQUE index rather than a read-then-insert race.
-- `reward_kind`/`reward_amount` are the contents, rolled by the SENDER's request and
-- fixed from then on (src/logic.ts GIFT_REWARD_TABLE); the recipient's first open each
-- UTC day overrides them with a guaranteed brain. `type` is the legacy pre-roll column
-- and is no longer read.
CREATE TABLE IF NOT EXISTS gifts (
  id            TEXT PRIMARY KEY,
  from_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'brain',
  created_at    INTEGER NOT NULL,
  day_bucket    INTEGER NOT NULL,
  claimed_at    INTEGER,
  reward_kind   TEXT NOT NULL DEFAULT 'brain',
  reward_amount INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_gifts_inbox ON gifts (to_id, claimed_at);
CREATE INDEX IF NOT EXISTS idx_gifts_sender_day ON gifts (from_id, day_bucket);
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
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at   INTEGER,
  -- Human device label (e.g. "Chrome on Windows") derived SERVER-SIDE from the
  -- User-Agent at sign-in, so a player can tell their active devices apart in the
  -- Account menu. Never client-supplied. Null for pre-P8 rows / unknown agents.
  label        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id, revoked_at);

-- Server-authoritative currency: the materialized truth for gold/brains/xp. The
-- client syncs from it on load and reconciles to it, so a save-edited currency
-- value is corrected rather than trusted. The column DEFAULTs are the v3 reset's
-- and are never relied on — ensureV3 (v3/db.ts) inserts every value explicitly.
CREATE TABLE IF NOT EXISTS balances (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  gold          INTEGER NOT NULL DEFAULT 200,
  brains        INTEGER NOT NULL DEFAULT 15,
  xp            INTEGER NOT NULL DEFAULT 0,
  -- Highest level the +1-brain-per-level reward has already been paid for. Server
  -- derives level from `xp` (levels.ts) and grants brains for each new level exactly
  -- once.
  claimed_level INTEGER NOT NULL DEFAULT 1
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

-- Fixed-window rate-limit counters (per-key). The key encodes route + caller
-- (account id or IP) + window bucket; each request atomically bumps the count and
-- the middleware rejects once a threshold is exceeded. Old windows are inert and
-- can be swept periodically.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Protocol v3 stores frequently-changing low-row-count gameplay as versioned JSON
-- documents. Relational rows remain only where identity/lifecycle auditing matters.
CREATE TABLE IF NOT EXISTS account_runtime_v3 (
  account_id            TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  account_version       INTEGER NOT NULL DEFAULT 0,
  writer_device_id      TEXT,
  writer_session_id     TEXT,
  writer_token_hash     TEXT,
  writer_generation     INTEGER NOT NULL DEFAULT 0,
  writer_last_activity_at INTEGER NOT NULL DEFAULT 0,
  active_batch_id       TEXT,
  active_batch_expires_at INTEGER NOT NULL DEFAULT 0,
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
-- Daily/weekly quests. Deliberately a separate document from quest_documents_v3 —
-- see migrations/0049_periodic_quests.sql for why.
CREATE TABLE IF NOT EXISTS periodic_quest_documents_v3 (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 0,
  current_json  TEXT NOT NULL DEFAULT '{"daily":null,"weekly":null}',
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
  -- 1 when this row is an escrowed zombie handed back by a cancelled Black Market
  -- sale. The unit is not a new acquisition, so the client must not credit it to
  -- the Zombie Almanac (see migration 0039).
  from_escrow      INTEGER NOT NULL DEFAULT 0,
  -- Inherited body tint as JSON "[r,g,b]" (Zombie Pot children mix their parents').
  -- NULL means no inherited tint: render the species' catalog colour. Lives here so
  -- it survives the new unit id a Black Market settlement mints (migration 0041).
  color            TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, unit_id)
);
CREATE TABLE IF NOT EXISTS raid_sessions_v3 (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  raid_id             TEXT NOT NULL,
  roster_json         TEXT NOT NULL,
  boosts_json         TEXT NOT NULL DEFAULT '{}',
  config_json         TEXT NOT NULL DEFAULT '{}',
  ruleset_version     INTEGER NOT NULL DEFAULT 0,
  started_at          INTEGER NOT NULL,
  earliest_finish_at  INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  result_json         TEXT
);
CREATE TABLE IF NOT EXISTS raid_state_v3 (
  account_id       TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_started_at  INTEGER NOT NULL DEFAULT 0,
  progress_json    TEXT NOT NULL DEFAULT '{}',
  -- Brain-eligible invasions settled since this account's last brain drop. Server-only:
  -- /raid/start floors a zero roll to one brain at the threshold, and the count is never
  -- sent to the client (see src/raid/brainDrops.ts).
  brain_dry_streak INTEGER NOT NULL DEFAULT 0,
  -- Per-raid wins since that raid last dropped its rare zombie, {"<raidId>": <dryWins>}.
  -- Server-only, same deal: /raid/finish grants the zombie outright at the threshold in
  -- src/raid/zombieDrops.ts and the count is never sent to the client.
  zombie_dry_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raid_v3_live
  ON raid_sessions_v3(account_id) WHERE finished_at IS NULL;
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
-- The graveyard: casualties that were not revived, so a Memorial Statue can carve
-- one in stone. Same minimal shape as roster_v3 (the card is derived from the
-- catalog by key + mutation) plus the two things that cannot be derived once the
-- roster row is gone: when it died, and its individual name. See migration 0047.
CREATE TABLE IF NOT EXISTS fallen_v3 (
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  unit_id            TEXT NOT NULL,
  zombie_key         TEXT NOT NULL,
  name               TEXT,
  mutation           INTEGER NOT NULL DEFAULT 0,
  invasions          INTEGER NOT NULL DEFAULT 0,
  color              TEXT,
  died_at            INTEGER NOT NULL,
  -- When this zombie last came OFF a statue. Ordering reads
  -- COALESCE(released_at, died_at), so a released zombie rejoins the graveyard at the
  -- top and ages out from there instead of being evicted by its old date of death.
  -- Never displayed — the plaque's date is `died_at`. See migration 0048.
  released_at        INTEGER,
  memorial_object_id TEXT,
  PRIMARY KEY (account_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_fallen_v3_recent
  ON fallen_v3(account_id, died_at DESC);
-- One zombie per plinth, enforced in the database rather than in application code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fallen_v3_statue
  ON fallen_v3(account_id, memorial_object_id)
  WHERE memorial_object_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS epic_boss_runs_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE, boss_id TEXT NOT NULL,
  activated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  level INTEGER NOT NULL, max_hp INTEGER NOT NULL, current_hp INTEGER NOT NULL,
  encounter_started_at INTEGER NOT NULL DEFAULT 0, retry_ready_at INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0, attack_order_json TEXT NOT NULL DEFAULT '[]',
  -- '' when the event was bought; a plants.json crop key when a harvest lured the boss
  -- (migration 0054, src/epicBoss/favoriteCrops.ts).
  started_crop TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS epic_boss_sessions_v3 (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL, level INTEGER NOT NULL, starting_hp INTEGER NOT NULL,
  roster_json TEXT NOT NULL, config_json TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  finished_at INTEGER, result_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_epic_boss_session_live_v3
  ON epic_boss_sessions_v3(account_id) WHERE finished_at IS NULL;
-- Legacy and unused (migration 0022; no code writes or reads it), but it exists on
-- every migrated database and references accounts, so it is here for parity and in
-- the account-deletion purge list. Dropping it would take a migration.
CREATE TABLE IF NOT EXISTS epic_boss_retry_skips_v3 (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  retry_ready_at INTEGER NOT NULL,
  cost_brains INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, run_id, retry_ready_at)
);
CREATE TABLE IF NOT EXISTS audit_events_v3 (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Asynchronous cross-account zombie/currency exchange. Assets represented by an OPEN
-- row are escrowed: sell zombies are absent from roster_v3 and a buy order's payment has
-- already been deducted from balances.
CREATE TABLE IF NOT EXISTS black_market_orders (
  id TEXT PRIMARY KEY,
  creator_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('BUY_ZOMBIE', 'SELL_ZOMBIE')),
  zombie_key TEXT NOT NULL,
  mutated_required INTEGER NOT NULL CHECK (mutated_required IN (0, 1)),
  -- Deliberately only bounded as positive: the exact requestable set is the shared
  -- mutation catalog (REQUESTABLE_MUTATION_MASK), enforced by the Worker before the
  -- INSERT, so adding a mutation never needs a schema change. Migration 0044 rebuilt
  -- this table to drop the old BETWEEN 1 AND 8191, which was a 13-bit cap.
  mutation_required INTEGER CHECK (mutation_required IS NULL OR (
    mutation_required > 0
    AND kind='BUY_ZOMBIE'
  )),
  -- THE PRICE, denominated in `currency` below — a gold post stores its gold here. The
  -- brains in the name is historical (migration 0045 added the currency; renaming the
  -- column would have broken migration 0044's SQL, which names it).
  price_brains INTEGER NOT NULL CHECK (price_brains BETWEEN 1 AND 10000000),
  -- What the price is paid in. Every row that existed before migration 0045 is 'BRAINS',
  -- which is also the default, so an old post keeps behaving exactly as it did.
  currency TEXT NOT NULL DEFAULT 'BRAINS' CHECK (currency IN ('BRAINS', 'GOLD')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULFILLED', 'CANCELLED')),
  created_day INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  fulfilled_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  closed_operation_id TEXT,
  source_unit_id TEXT,
  escrow_mutation INTEGER,
  escrow_invasions INTEGER,
  -- The escrowed payment of a BUY_ZOMBIE post, in the row's `currency` — same historical
  -- name, same meaning as price_brains above.
  escrow_brains INTEGER NOT NULL DEFAULT 0,
  -- The escrowed zombie's body tint, so a cancel hands back the same-looking unit
  -- and a buyer receives the one they saw listed (migration 0041).
  escrow_color TEXT,
  -- Set when the creator collects (acknowledges) a FULFILLED order; NULL on a
  -- fulfilled row means the outcome has not been shown to its creator yet.
  acknowledged_at INTEGER,
  -- The actually-traded unit, stamped at fulfillment (mirrors escrow for sales;
  -- records the offered unit for filled requests). Drives the History tab.
  delivered_mutation INTEGER,
  delivered_invasions INTEGER,
  delivered_color TEXT,
  -- Delivery of the traded zombie. It waits on the order after settlement and is
  -- minted into the recipient's roster only when they collect it, which is refused
  -- while their farm AND Mausoleum are full. NULL on a FULFILLED row means still
  -- owed; delivered_unit_id records which unit it became.
  claimed_at INTEGER,
  delivered_unit_id TEXT,
  -- Payout of the traded currency. A SALE's payment is held by the market after
  -- settlement and credited to its creator when they collect; a filled REQUEST pays
  -- its fulfiller inside the fulfil batch and is stamped there. NULL on a FULFILLED
  -- sale means the market is still holding them (migration 0043).
  payout_at INTEGER,
  CHECK ((kind='SELL_ZOMBIE' AND source_unit_id IS NOT NULL AND escrow_mutation IS NOT NULL AND
    escrow_invasions IS NOT NULL AND escrow_brains=0) OR (kind='BUY_ZOMBIE' AND
    source_unit_id IS NULL AND escrow_mutation IS NULL AND escrow_invasions IS NULL AND
    escrow_brains=price_brains))
);
CREATE INDEX IF NOT EXISTS idx_black_market_browse ON black_market_orders(status,kind,created_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_black_market_filter ON black_market_orders(status,kind,zombie_key,mutated_required,created_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_black_market_owner ON black_market_orders(creator_account_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_black_market_daily ON black_market_orders(creator_account_id,created_day);
CREATE INDEX IF NOT EXISTS idx_black_market_uncollected ON black_market_orders(creator_account_id,status,acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_black_market_fulfiller ON black_market_orders(fulfilled_by_account_id,status,closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_black_market_unclaimed_sale ON black_market_orders(fulfilled_by_account_id,status,claimed_at);
CREATE INDEX IF NOT EXISTS idx_black_market_unclaimed_request ON black_market_orders(creator_account_id,status,claimed_at);
CREATE INDEX IF NOT EXISTS idx_black_market_unpaid ON black_market_orders(creator_account_id,status,payout_at);
CREATE TABLE IF NOT EXISTS black_market_receipts (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('CREATE','CANCEL','FULFILL')),
  request_fingerprint TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES black_market_orders(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_black_market_receipts_account ON black_market_receipts(account_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_v3_account ON audit_events_v3(account_id, created_at);

-- Service closedown switch (see migrations/0042_service_state.sql). One row; the
-- local admin console flips it over D1 without a Worker deploy.
CREATE TABLE IF NOT EXISTS service_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT    NOT NULL DEFAULT 'open'
               CHECK (mode IN ('open','signups_closed','export_only','closed')),
  notice     TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO service_state (id, mode, notice, updated_at) VALUES (1, 'open', NULL, 0);

-- Friend invasions (PvP) — see migrations/0055_pvp_invasions.sql for the field notes.
CREATE TABLE IF NOT EXISTS pvp_sessions_v3 (
  id TEXT PRIMARY KEY,
  attacker_id TEXT NOT NULL REFERENCES accounts(id),
  defender_id TEXT NOT NULL REFERENCES accounts(id),
  config_json TEXT NOT NULL,
  ruleset_version INTEGER NOT NULL,
  attack_score INTEGER NOT NULL,
  defense_score INTEGER NOT NULL,
  boosts_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  earliest_finish_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  win INTEGER,
  final_tick INTEGER,
  inputs_json TEXT,
  defense_claimed_at INTEGER,
  -- Daily income caps (0057): stamped at settlement; only flagged rows pay.
  attacker_rewarded INTEGER,
  defense_rewarded INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pvp_live ON pvp_sessions_v3(attacker_id) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pvp_pair_day ON pvp_sessions_v3(attacker_id, defender_id, started_at);
CREATE INDEX IF NOT EXISTS idx_pvp_defender ON pvp_sessions_v3(defender_id, finished_at);
CREATE INDEX IF NOT EXISTS idx_pvp_attacker ON pvp_sessions_v3(attacker_id, finished_at);

-- PvP rework (0057): authored defense line-up + server-authored lifetime counters.
CREATE TABLE IF NOT EXISTS pvp_defense_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  loadout_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pvp_stats_v3 (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  attack_wins INTEGER NOT NULL DEFAULT 0,
  attack_losses INTEGER NOT NULL DEFAULT 0,
  defense_wins INTEGER NOT NULL DEFAULT 0,
  defense_losses INTEGER NOT NULL DEFAULT 0
);

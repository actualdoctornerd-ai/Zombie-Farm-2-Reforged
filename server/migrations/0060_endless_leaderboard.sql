-- Public Endless personal bests. One row per account and mode; writes are made only
-- from a server-verified run result. The army snapshot contains species keys and
-- mutation/veterancy values, never account roster ids or other save data.
CREATE TABLE IF NOT EXISTS endless_leaderboard (
  account_id     TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode           TEXT    NOT NULL CHECK (mode IN ('endless', 'nightmare')),
  deepest_floor  INTEGER NOT NULL CHECK (deepest_floor > 0),
  duration_ms    INTEGER NOT NULL CHECK (duration_ms >= 0),
  army_json      TEXT    NOT NULL,
  achieved_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, mode)
);

CREATE INDEX IF NOT EXISTS idx_endless_leaderboard_rank
  ON endless_leaderboard(mode, deepest_floor DESC, duration_ms ASC, achieved_at ASC);

-- One resumable, server-owned run per account. Every offered encounter config and the
-- carried army are pinned here; only a verified fight can advance or complete it.
CREATE TABLE IF NOT EXISTS endless_runs_v3 (
  id                TEXT    PRIMARY KEY,
  account_id        TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode              TEXT    NOT NULL CHECK (mode IN ('endless', 'nightmare')),
  current_wave      INTEGER NOT NULL CHECK (current_wave > 0),
  run_state_json    TEXT    NOT NULL,
  army_json         TEXT    NOT NULL,
  fight_config_json TEXT    NOT NULL,
  ruleset_version   INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  fight_started_at  INTEGER NOT NULL,
  finished_at       INTEGER,
  result_json       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_endless_runs_v3_live
  ON endless_runs_v3(account_id) WHERE finished_at IS NULL;

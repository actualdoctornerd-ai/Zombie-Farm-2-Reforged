-- Endless: a board per week (the week a run started in, since that is whose enemies and
-- choices it faced), and how far each account has ever beaten a boss in each mode, which is
-- what first-clear milestones pay against.
CREATE TABLE IF NOT EXISTS endless_weekly_leaderboard (
  week           TEXT    NOT NULL,
  account_id     TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode           TEXT    NOT NULL CHECK (mode IN ('endless', 'nightmare')),
  deepest_floor  INTEGER NOT NULL CHECK (deepest_floor > 0),
  duration_ms    INTEGER NOT NULL CHECK (duration_ms >= 0),
  army_json      TEXT    NOT NULL,
  achieved_at    INTEGER NOT NULL,
  PRIMARY KEY (week, account_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_endless_weekly_rank
  ON endless_weekly_leaderboard(week, mode, deepest_floor DESC, achieved_at ASC);
CREATE TABLE IF NOT EXISTS endless_progress (
  account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode        TEXT    NOT NULL CHECK (mode IN ('endless', 'nightmare')),
  best_tier   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, mode)
);

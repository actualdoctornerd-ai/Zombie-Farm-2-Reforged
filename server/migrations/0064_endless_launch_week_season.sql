-- Endless: freeze the launch-week boards as a season and start fresh (owner, 2026-11-11).
-- The launch-week records were set under rules ruleset 85 changed (Protect at 20% a carrier to
-- 95%, stuns that restarted an enemy's swing, Headless curses that cost nothing), so nobody
-- can reach them again. They are kept, not wiped: the players who set them found the strongest
-- builds the rules allowed. Every reward those runs paid (milestones, loot, endless_progress)
-- stays exactly where it is; only the public boards reset.
--
-- Apply this immediately before the ruleset-85 Worker deploy: a run finished between the two
-- lands on the fresh board under the old rules.
CREATE TABLE IF NOT EXISTS endless_leaderboard_seasons (
  season         TEXT    NOT NULL,
  account_id     TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode           TEXT    NOT NULL CHECK (mode IN ('endless', 'nightmare')),
  deepest_floor  INTEGER NOT NULL CHECK (deepest_floor > 0),
  duration_ms    INTEGER NOT NULL CHECK (duration_ms >= 0),
  army_json      TEXT    NOT NULL,
  achieved_at    INTEGER NOT NULL,
  PRIMARY KEY (season, account_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_endless_leaderboard_seasons_rank
  ON endless_leaderboard_seasons(season, mode, deepest_floor DESC, achieved_at ASC);

INSERT OR IGNORE INTO endless_leaderboard_seasons
  (season, account_id, mode, deepest_floor, duration_ms, army_json, achieved_at)
  SELECT 'launch-week', account_id, mode, deepest_floor, duration_ms, army_json, achieved_at
  FROM endless_leaderboard;

DELETE FROM endless_leaderboard;
DELETE FROM endless_weekly_leaderboard;

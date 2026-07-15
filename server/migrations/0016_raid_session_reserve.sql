-- T1: one open raid per account, enforced by the database.
--
-- The between-raids cooldown only advances at FINISH, so before this a client could open
-- many raid sessions in the pre-first-finish window, bank the ids, and settle them later
-- for repeated rewards. openRaidSessionOnce reserves atomically via INSERT ... WHERE NOT
-- EXISTS; this partial UNIQUE index is the backstop if two concurrent starts both pass
-- that SELECT.
--
-- Partial on `finished_at IS NULL`, so it constrains only UNFINISHED sessions: an account
-- may accumulate any number of finished ones (they're the history the cron purges).
--
-- The invariant is exactly "at most one UNFINISHED session per account" — note NOT "at
-- most one unexpired one", which a partial index can't express (expires_at is per-row,
-- not a constant). openRaidSessionOnce keeps that invariant honest by REAPING expired
-- sessions (stamping finished_at = expires_at) before it reserves. Without the reap, an
-- abandoned session — browser closed mid-raid — would hold the account's only slot until
-- the cron purge swept it a DAY later, locking the player out of raiding entirely.
--
-- Additive; safe to run against a live DB. Existing rows: an account with >1 unfinished
-- session (only possible from the pre-T1 window) would make this index creation FAIL, so
-- close them out first — that is what the UPDATE below does. It credits nothing; those
-- sessions were never settled and are worth nothing on their own.
UPDATE raid_sessions
SET finished_at = expires_at
WHERE finished_at IS NULL
  AND id NOT IN (
    SELECT id FROM raid_sessions s
    WHERE s.finished_at IS NULL
      AND s.started_at = (
        SELECT MAX(s2.started_at) FROM raid_sessions s2
        WHERE s2.account_id = s.account_id AND s2.finished_at IS NULL
      )
    GROUP BY s.account_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_raid_sessions_live
  ON raid_sessions (account_id)
  WHERE finished_at IS NULL;

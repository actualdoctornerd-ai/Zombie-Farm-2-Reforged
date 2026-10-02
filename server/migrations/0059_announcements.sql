-- In-game announcements: operator-authored messages every player sees once.
--
-- A D1 table rather than a Worker var or a file in the client bundle, for the same reason
-- service_state is (0042): the local admin console's Cloudflare token is scoped to D1
-- read/write only, so an announcement can be posted, scheduled or retired without a deploy.
-- `server/scripts/announce.mjs` does the same from a terminal.
--
-- Served, unauthenticated, by `GET /announcements` (server/src/announcements.ts), which
-- FAILS OPEN to an empty list when this table is missing — a Worker deployed ahead of the
-- migration simply has nothing to say. Not account data: nothing here is per player, and
-- which announcements a player has already seen is remembered on their own device.
--
--   published_at  ms since epoch; nothing is served before it, so a post can be scheduled
--   expires_at    ms since epoch, NULL = until retired; nothing is served at or after it
--   min_ruleset   NULL = every client. Otherwise only clients whose raid ruleset is at least
--                 this are shown it — the way to announce a change only to players who have
--                 actually UPDATED to it (the client filters; the Worker just publishes it)
--   active        0 retires an announcement without deleting its history
CREATE TABLE IF NOT EXISTS announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  published_at INTEGER NOT NULL,
  expires_at   INTEGER,
  min_ruleset  INTEGER,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_live ON announcements(active, published_at DESC);

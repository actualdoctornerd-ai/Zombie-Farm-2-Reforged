-- Phase C-B: server-authoritative quest rewards.
--
-- A completed quest grants its reward from the SERVER catalog (questCatalog.ts, mirrored
-- from quests.json), never a client-sent amount, and at most ONCE per (account, quest).
-- The PRIMARY KEY is the once-guard: a second /quest/complete for the same quest hits it
-- and grants nothing. (Whether the quest's requirements were actually met is still
-- client-asserted — deferred, same posture as raid wins — so the reward is bounded-once,
-- not yet proven-earned.)
--
-- Additive table; safe to run against a live DB.
CREATE TABLE IF NOT EXISTS quest_completions (
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  quest_id     TEXT NOT NULL,
  reward_type  INTEGER NOT NULL,  -- 0=Xp 1=Gold 2=Brains 3=Item 5=Zombie (as granted)
  reward_value INTEGER NOT NULL,  -- server-catalog amount actually credited (0 for item/zombie)
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, quest_id)
);

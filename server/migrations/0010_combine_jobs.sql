-- P14: server-authoritative Zombie Pot combine. The combine's two parent keys are
-- recorded when it STARTS (parents removed from the roster), so at COLLECT the server
-- can validate the result key is one of the two parents — closing the fabricate-an-
-- arbitrary-expensive-result exploit. One job per account.
--
-- Additive: new table only. Safe to run against a live DB.
CREATE TABLE IF NOT EXISTS combine_jobs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  key_a      TEXT NOT NULL,
  key_b      TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

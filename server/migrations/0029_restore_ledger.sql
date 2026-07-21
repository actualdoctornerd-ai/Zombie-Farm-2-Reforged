-- Protocol v3 dropped the economy ledger after its original migration had already
-- been recorded as applied. Gift sending now writes its XP reward to this table,
-- so upgraded databases need the table restored explicitly.
CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  currency    TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger (account_id, created_at);

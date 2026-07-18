CREATE TABLE IF NOT EXISTS black_market_orders (
  id TEXT PRIMARY KEY,
  creator_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('BUY_ZOMBIE', 'SELL_ZOMBIE')),
  zombie_key TEXT NOT NULL,
  mutated_required INTEGER NOT NULL CHECK (mutated_required IN (0, 1)),
  price_brains INTEGER NOT NULL CHECK (price_brains BETWEEN 1 AND 1000000),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULFILLED', 'CANCELLED')),
  created_day INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  fulfilled_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  closed_operation_id TEXT,
  source_unit_id TEXT,
  escrow_mutation INTEGER,
  escrow_invasions INTEGER,
  escrow_brains INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (kind = 'SELL_ZOMBIE' AND source_unit_id IS NOT NULL AND escrow_mutation IS NOT NULL AND
      escrow_invasions IS NOT NULL AND escrow_brains = 0) OR
    (kind = 'BUY_ZOMBIE' AND source_unit_id IS NULL AND escrow_mutation IS NULL AND
      escrow_invasions IS NULL AND escrow_brains = price_brains)
  )
);
CREATE INDEX IF NOT EXISTS idx_black_market_browse
  ON black_market_orders(status, kind, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_black_market_filter
  ON black_market_orders(status, kind, zombie_key, mutated_required, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_black_market_owner
  ON black_market_orders(creator_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_black_market_daily
  ON black_market_orders(creator_account_id, created_day);

CREATE TABLE IF NOT EXISTS black_market_receipts (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('CREATE', 'CANCEL', 'FULFILL')),
  request_fingerprint TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES black_market_orders(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_black_market_receipts_account
  ON black_market_receipts(account_id, created_at DESC);

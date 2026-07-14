-- Migration 0002 — grant settlement tracking (Phase 2, doc item 4).
--
-- Run ONCE against a DB that already has the Track A `grants` table:
--   wrangler d1 execute zombiefarm --remote --file=./migrations/0002_grant_settlement.sql
--
-- Adds `settled_at` (NULL = pending, not yet reflected in the save) so the read-time
-- reconciler can finish crediting a gift whose apply was deferred by save churn.
-- Existing grants predate this and were applied inline at claim time, so backfill
-- them as already-settled (created_at) to avoid re-crediting.

ALTER TABLE grants ADD COLUMN settled_at INTEGER;
UPDATE grants SET settled_at = created_at WHERE settled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_grants_pending ON grants (account_id, settled_at);

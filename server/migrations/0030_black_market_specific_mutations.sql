-- Preserve the existing mutated yes/no behavior while allowing a BUY_ZOMBIE order
-- to request a mask of named mutations. Same-slot bits are OR alternatives; the
-- server requires every represented slot. NULL means the legacy broad requirement.
ALTER TABLE black_market_orders ADD COLUMN mutation_required INTEGER CHECK (mutation_required IS NULL OR (
  mutation_required BETWEEN 1 AND 8191
  AND kind='BUY_ZOMBIE'
));

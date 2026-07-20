-- Efficiently enforce the two-total-gifts-per-UTC-day sender allowance.
CREATE INDEX IF NOT EXISTS idx_gifts_sender_day ON gifts(from_id, day_bucket);

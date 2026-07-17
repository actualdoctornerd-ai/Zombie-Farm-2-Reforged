ALTER TABLE account_runtime_v3 ADD COLUMN writer_session_id TEXT;
ALTER TABLE account_runtime_v3 ADD COLUMN writer_token_hash TEXT;
ALTER TABLE account_runtime_v3 ADD COLUMN writer_last_activity_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_runtime_v3 ADD COLUMN active_batch_expires_at INTEGER NOT NULL DEFAULT 0;

-- Earlier writer ids were not authenticated with a lease token. Treat them as
-- unowned so the first upgraded client can acquire control explicitly.
UPDATE account_runtime_v3
SET writer_device_id = NULL, writer_session_id = NULL, writer_token_hash = NULL,
    active_batch_id = NULL, active_batch_expires_at = 0;

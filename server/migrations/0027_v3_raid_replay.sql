ALTER TABLE raid_sessions_v3 ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE raid_sessions_v3 ADD COLUMN ruleset_version INTEGER NOT NULL DEFAULT 0;

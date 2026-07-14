-- P8: session/device management. Give each session a human device label, derived
-- SERVER-SIDE from the User-Agent at sign-in, so the Account menu can list a
-- player's active devices and let them revoke one individually.
--
-- Additive + nullable: existing sessions keep working and show as "Unknown device"
-- until their next sign-in. Safe to run against a live DB.
ALTER TABLE sessions ADD COLUMN label TEXT;

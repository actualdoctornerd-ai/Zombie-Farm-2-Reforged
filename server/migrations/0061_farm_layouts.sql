-- Saved farm layouts: each account's list of named decoration layouts (Storage → Farm
-- Layouts on the client), so a farm can swap between looks on any device.
--
-- One row per account holding the whole list (at most 6 layouts; validated by
-- server/src/farmLayouts.ts before every write). A table of its own rather than a field
-- in presentations_v3, so an oversized or refused layout write can never take the rest
-- of the presentation save down with it. Presentation only: nothing on the server reads
-- it back, and loading a layout goes through ordinary object.status commands.
CREATE TABLE IF NOT EXISTS farm_layouts (
  account_id   TEXT    PRIMARY KEY REFERENCES accounts(id),
  layouts_json TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL
);

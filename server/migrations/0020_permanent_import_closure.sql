-- Integrity v2 launches without legacy online value promotion. Existing and future
-- accounts are permanently closed for every historical seed category, independently
-- of Worker configuration, so a later cutoff misconfiguration cannot reopen imports.
INSERT OR IGNORE INTO account_import_state (account_id)
SELECT id FROM accounts;

UPDATE account_import_state
SET balance_seeded = 1,
    inventory_seeded = 1,
    objects_seeded = 1,
    roster_seeded = 1,
    quests_seeded = 1,
    shop_seeded = 1,
    balance_token = NULL,
    inventory_token = NULL,
    objects_token = NULL,
    roster_token = NULL,
    quests_token = NULL,
    shop_token = NULL;

CREATE TRIGGER IF NOT EXISTS trg_accounts_close_legacy_imports
AFTER INSERT ON accounts
BEGIN
  INSERT OR IGNORE INTO account_import_state
    (account_id, balance_seeded, inventory_seeded, objects_seeded, roster_seeded, quests_seeded, shop_seeded)
  VALUES (NEW.id, 1, 1, 1, 1, 1, 1);
END;

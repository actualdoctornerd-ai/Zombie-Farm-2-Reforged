// ---------------------------------------------------------------------------
// Self-service account deletion.
// ---------------------------------------------------------------------------
// The Farmer's Guide's Privacy page promises a player can have their account and
// everything attached to it removed. This is that promise in code.
//
// WHAT "DELETED" MEANS HERE. Every row belonging to the account goes, including
// the `accounts` row itself — which frees its `google_sub` (a UNIQUE column). So
// signing in again with the same Google account does not resurrect anything: it
// falls through `/auth`'s normal create path and mints a brand-new account id,
// a brand-new friend code and a starter farm. "As if they had just created the
// account" is therefore not a reset we have to implement and keep faithful; it is
// what the existing sign-in path already does for a Google id it has not seen.
//
// WHY THE TABLE LIST IS WRITTEN OUT, AND WHY IT STILL CANNOT DRIFT. Fifty-three
// tables reference `accounts` across fifty-eight migrations, and this repo adds
// more steadily. A hand-maintained list is correct the day it is written and
// silently wrong a month later — and "silently wrong" here means a deleted
// player's rows left behind, the exact opposite of what the Privacy page promised.
//
// The obvious fix is to read SQLite's own foreign-key metadata at call time. That
// does NOT work: D1 refuses `pragma_foreign_key_list` with `SQLITE_AUTH`, so the
// introspection that runs fine against node:sqlite in a test fails in production —
// which is the worst possible place to discover it.
//
// So the list is explicit here, and `accountDeletion.test.ts` does the
// introspection instead: it loads `schema.sql` into node:sqlite, reads the real
// foreign keys, and asserts they are EXACTLY this array. A migration that adds a
// table referencing accounts turns that test red until it is listed, which puts
// the drift in front of whoever caused it rather than in a player's leftover rows.
//
// WHY ONE ENTRY IS `null` AND NOT A DELETE. `black_market_orders`'s
// `fulfilled_by_account_id` points at whoever FILLED somebody else's order.
// Deleting every row that merely mentions the account would destroy other players'
// completed trades, so that reference is nulled instead. The schema says the same
// thing in its own words — it is the one `ON DELETE SET NULL` among the fifty-nine
// — and the test checks the two agree, so the policy cannot be set here in a way
// the schema contradicts.
import type { D1Database } from "@cloudflare/workers-types";

/** How a reference is cleared. `delete` removes the row; `null` keeps the row and
 *  drops the mention, for a column that points at this account from somebody
 *  else's data. */
type ClearAction = "delete" | "null";

/** Every column in the schema that references `accounts(id)`, and what to do with
 *  it. Kept in step with `schema.sql` by `accountDeletion.test.ts` — do not edit
 *  this list by hand without running that test, and do not "fix" the test to match
 *  an edit here. The schema is the source of truth; this is its mirror. */
export const ACCOUNT_REFERENCES: ReadonlyArray<readonly [string, string, ClearAction?]> = [
  ["account_runtime_v3", "account_id"],
  ["audit_events_v3", "account_id"],
  ["balances", "account_id"],
  ["black_market_orders", "creator_account_id"],
  ["black_market_orders", "fulfilled_by_account_id", "null"],
  ["black_market_receipts", "account_id"],
  ["blocks", "blocked_id"],
  ["blocks", "blocker_id"],
  ["combine_jobs", "account_id"],
  ["command_receipts", "account_id"],
  ["crop_plots", "account_id"],
  ["epic_boss_runs_v3", "account_id"],
  ["epic_boss_sessions_v3", "account_id"],
  ["fallen_v3", "account_id"],
  ["farm_actions", "account_id"],
  ["farm_documents_v3", "account_id"],
  ["farm_state", "account_id"],
  ["friend_requests", "from_id"],
  ["friend_requests", "to_id"],
  ["friendships", "a_id"],
  ["friendships", "b_id"],
  ["game_events", "account_id"],
  ["gameplay_documents_v3", "account_id"],
  ["gifts", "from_id"],
  ["gifts", "to_id"],
  ["grants", "account_id"],
  ["inventory", "account_id"],
  ["inventory_actions", "account_id"],
  ["item_storage", "account_id"],
  ["ledger", "account_id"],
  ["object_actions", "account_id"],
  ["object_counts", "account_id"],
  ["object_documents_v3", "account_id"],
  ["owned_climates", "account_id"],
  ["periodic_quest_documents_v3", "account_id"],
  ["plowed_soil", "account_id"],
  ["presentations_v3", "account_id"],
  ["pvp_defense_v3", "account_id"],
  ["pvp_sessions_v3", "attacker_id"],
  ["pvp_sessions_v3", "defender_id"],
  ["pvp_stats_v3", "account_id"],
  ["quest_completions", "account_id"],
  ["quest_documents_v3", "account_id"],
  ["quest_event_applications", "account_id"],
  ["quest_progress", "account_id"],
  ["raid_checkpoints", "account_id"],
  ["raid_clears", "account_id"],
  ["raid_revivals_v3", "account_id"],
  ["raid_roster_locks", "account_id"],
  ["raid_sessions", "account_id"],
  ["raid_sessions_v3", "account_id"],
  ["raid_state", "account_id"],
  ["raid_state_v3", "account_id"],
  ["roster", "account_id"],
  ["roster_actions", "account_id"],
  ["roster_v3", "account_id"],
  ["saves", "account_id"],
  ["sessions", "account_id"],
  ["storage_actions", "account_id"],
];

/** Black Market business that deletion would strand. Deleting an account cascades
 *  its orders away, so a trade that has not finished settling would take the other
 *  player's owed zombie with it. Rather than write a refund engine for a path a
 *  player takes once, deletion is REFUSED while any of this is outstanding and the
 *  player is asked to finish up first:
 *
 *    - an OPEN order they created, which is holding their own escrow, and which
 *      they can cancel to get back; and
 *    - a FULFILLED order on either side of which the traded zombie has not been
 *      claimed yet, which is the case that would actually destroy someone else's
 *      property.
 *
 *  Deliberately NOT included: an uncollected payout owed TO the deleting player.
 *  Forfeiting that is their own choice and strands nobody. */
export async function unsettledMarketOrders(db: D1Database, accountId: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM black_market_orders
    WHERE (creator_account_id = ?1 OR fulfilled_by_account_id = ?1)
      AND (status = 'OPEN' OR (status = 'FULFILLED' AND claimed_at IS NULL))`)
    .bind(accountId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Is a gameplay operation (a command batch, a raid settlement, a market trade)
 *  mid-flight for this account? Deleting underneath one would settle a fight into
 *  rows that no longer exist.
 *
 *  The expiry check is not optional: `active_batch_id` is never swept, so a marker
 *  left behind by a crashed request stays set forever, and a reader that only
 *  tests the id would lock the account out of deleting itself permanently. */
export async function operationInProgress(db: D1Database, accountId: string, now: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT active_batch_id, active_batch_expires_at FROM account_runtime_v3 WHERE account_id=?`)
    .bind(accountId).first<{ active_batch_id: string | null; active_batch_expires_at: number }>();
  return !!row?.active_batch_id && (row.active_batch_expires_at ?? 0) > now;
}

/** Remove the account and every row that references it.
 *
 *  Ordering matters: children first, the `accounts` row last, because most of the
 *  references are `NO ACTION` and would refuse the parent delete while a child
 *  still pointed at it. Within the children order is irrelevant — the only two
 *  non-account foreign keys in the schema (a raid session's replay row, a market
 *  order's receipts) both cascade from rows being deleted anyway.
 *
 *  Returns the number of statements run, which the caller reports back. */
export async function purgeAccount(db: D1Database, accountId: string): Promise<number> {
  const statements = ACCOUNT_REFERENCES.map(([table, column, action]) =>
    action === "null"
      ? db.prepare(`UPDATE "${table}" SET "${column}"=NULL WHERE "${column}"=?`).bind(accountId)
      : db.prepare(`DELETE FROM "${table}" WHERE "${column}"=?`).bind(accountId));

  statements.push(db.prepare(`DELETE FROM accounts WHERE id=?`).bind(accountId));

  // One batch, so a partial purge cannot survive a mid-flight failure: D1 runs a
  // batch as a single implicit transaction.
  await db.batch(statements);
  return statements.length;
}

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
// WHY THE TABLE LIST IS WRITTEN OUT, AND WHY IT STILL CANNOT DRIFT. Thirty-two
// tables reference `accounts`, and this repo adds more steadily. A hand-maintained
// list is correct the day it is written and silently wrong a month later — and
// "silently wrong" here means a deleted player's rows left behind, the exact
// opposite of what the Privacy page promised.
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
// THE DRIFT THAT TEST CANNOT SEE, AND WHAT DOES. Mirroring `schema.sql` is only as
// good as `schema.sql`'s own fidelity to the database production actually has,
// which is built by replaying `migrations/`. For a long while it was not faithful:
// `schema.sql` still declared 25 pre-v3 tables that migration
// `0020_protocol_v3_reset` had dropped, this list mirrored them, every test built
// its database from `schema.sql` and passed — and every production deletion failed
// on `DELETE FROM combine_jobs`, a table that had not existed for months. Because
// the purge is ONE atomic batch, nothing was half-deleted; the player just saw
// "try again later" forever. `schemaParity.test.ts` now replays the migration chain
// into SQLite and requires `schema.sql` to match it object for object, so this
// list is held to the production schema, not to a snapshot that had wandered.
//
// WHY ONE ENTRY IS `null` AND NOT A DELETE. `black_market_orders`'s
// `fulfilled_by_account_id` points at whoever FILLED somebody else's order.
// Deleting every row that merely mentions the account would destroy other players'
// completed trades, so that reference is nulled instead. The schema says the same
// thing in its own words — it is the one `ON DELETE SET NULL` among the
// thirty-five — and the test checks the two agree, so the policy cannot be set here
// in a way the schema contradicts.
import type { D1Database } from "@cloudflare/workers-types";

/** How a reference is cleared. `delete` removes the row; `null` keeps the row and
 *  drops the mention, for a column that points at this account from somebody
 *  else's data. */
type ClearAction = "delete" | "null";

/** Every column in the schema that references `accounts(id)`, and what to do with
 *  it. Kept in step with `schema.sql` by `accountDeletion.test.ts` (and
 *  `schema.sql` is kept in step with the migrations by `schemaParity.test.ts`) —
 *  do not edit this list by hand without running those tests, and do not "fix" a
 *  test to match an edit here. The schema is the source of truth; this is its
 *  mirror.
 *
 *  Alphabetical, which happens to satisfy the one ordering constraint: a table
 *  with a NO ACTION foreign key into another table in this list must be cleared
 *  AFTER that child (or the child's delete must cascade). Today the only such
 *  pairs — a raid session's revival rows, a market order's receipts — cascade from
 *  the parent, so order does not matter; `accountDeletionPurge.test.ts` runs the
 *  real batch with foreign keys enforced and would fail if that changed. */
export const ACCOUNT_REFERENCES: ReadonlyArray<readonly [string, string, ClearAction?]> = [
  ["account_runtime_v3", "account_id"],
  ["audit_events_v3", "account_id"],
  ["balances", "account_id"],
  ["black_market_orders", "creator_account_id"],
  ["black_market_orders", "fulfilled_by_account_id", "null"],
  ["black_market_receipts", "account_id"],
  ["blocks", "blocked_id"],
  ["blocks", "blocker_id"],
  // Legacy and unused (migration 0022), but it exists on every migrated database
  // with a foreign key into accounts, so the purge must clear it too.
  ["epic_boss_retry_skips_v3", "account_id"],
  ["epic_boss_runs_v3", "account_id"],
  ["epic_boss_sessions_v3", "account_id"],
  ["fallen_v3", "account_id"],
  ["farm_documents_v3", "account_id"],
  ["friend_requests", "from_id"],
  ["friend_requests", "to_id"],
  ["friendships", "a_id"],
  ["friendships", "b_id"],
  ["gameplay_documents_v3", "account_id"],
  ["gifts", "from_id"],
  ["gifts", "to_id"],
  ["grants", "account_id"],
  ["ledger", "account_id"],
  ["object_documents_v3", "account_id"],
  ["periodic_quest_documents_v3", "account_id"],
  ["presentations_v3", "account_id"],
  ["pvp_defense_v3", "account_id"],
  ["pvp_sessions_v3", "attacker_id"],
  ["pvp_sessions_v3", "defender_id"],
  ["pvp_stats_v3", "account_id"],
  ["quest_documents_v3", "account_id"],
  ["raid_revivals_v3", "account_id"],
  ["raid_sessions_v3", "account_id"],
  ["raid_state_v3", "account_id"],
  ["roster_v3", "account_id"],
  ["sessions", "account_id"],
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
 *  Ordering matters: children first, the `accounts` row last, because some of the
 *  references are `NO ACTION` and would refuse the parent delete while a child
 *  still pointed at it. (Most cascade on a migrated database — the v3 reset
 *  recreated the social tables that way — but the purge does not lean on that:
 *  every reference is cleared explicitly, so a database built either way ends up
 *  the same.)
 *
 *  Throws if the batch fails; see `attemptPurge` for the caller-facing shape.
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

/** The outcome of a purge, for the route to answer with. A failure carries the
 *  database's own message: the one time this has failed in production, the message
 *  ("no such table: combine_jobs") was the entire diagnosis, and it had been
 *  discarded into a bare 500. */
export type PurgeOutcome =
  | { ok: true; statements: number }
  | { ok: false; reason: string };

/** `purgeAccount`, with the failure caught and named. Because the batch is atomic,
 *  a failure means NOTHING was deleted — the account is intact and the player can
 *  try again once whatever broke is fixed — so the route can say exactly that
 *  instead of leaving them to wonder whether half a farm survived. */
export async function attemptPurge(db: D1Database, accountId: string): Promise<PurgeOutcome> {
  try {
    return { ok: true, statements: await purgeAccount(db, accountId) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

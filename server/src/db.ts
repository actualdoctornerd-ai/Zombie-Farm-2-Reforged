// Thin data-access layer over D1. Handlers call these; no business rules live here
// (those are in logic.ts / the routes) — just typed queries.
import { friendCodeFromBytes, idFromBytes } from "./logic";
import type { GoogleIdentity } from "./auth";
import type { Balance, Currency, EconomyEvent } from "./economy";
import { applyBatch, clampSeed } from "./economy";
import { cropEcon } from "./catalog";
import {
  planPlant, planHarvest, planZombiePlant, planZombieHarvest, planPlow, plotWithin,
  PLOW_COST, PLOW_FREE_OBJECT, MAX_SEED_PLOTS,
  type FarmAction, type PlantContext, type PlotRecord,
} from "./farm";
import { zombieCropEcon } from "./zombieCropCatalog";
import { raidEcon, winGold, MAX_RAID_WINS } from "./raidCatalog";
import { boostEcon, boostKeyForName, BOOST_KEYS, VOUCHER_KEY, DICE_KEY, CONCENTRATION_KEY, MAX_STACK } from "./boostCatalog";
import { planClaim, planStore, planRetrieve, type StorageAction } from "./storage";
import { SHED_SLOTS, BASE_SHED_SLOTS } from "./objectCatalog";
import { raidLoot, dropEcon, MAX_SEED_ITEMS } from "./raidLootCatalog";
import { rollLoot, resolveLoot, type LootGrant } from "./loot";
import { planBuy, planUse, planGiftRedeem, type InventoryAction } from "./inventory";
import { zombieSell, fertilizeProbability, isKnownZombie, MAX_MUTATION } from "./rosterCatalog";
import { validateUnit, type RosterAction } from "./roster";
import { BASE_FARM_SIZE, sizeTier, nextSize, climateCost } from "./shopCatalog";
import { levelForXp } from "./levels";
import { QUEST_DEFINITIONS, questReward, QUEST_REWARD } from "./questCatalog";
import { objectEcon } from "./objectCatalog";
import { planObjectBuy, planObjectRefund, planObjectUpgrade, type ObjectAction } from "./objects";
import plantCatalogData from "../../public/assets/plants.json";
import zombieCatalogData from "../../public/assets/zombies.json";

export interface Account {
  id: string;
  google_sub: string;
  /** Player-chosen display name; NULL until picked on first sign-in. The ONLY
   *  human-facing name in the system — chosen by the user, not from Google. */
  username: string | null;
  friend_code: string;
  created_at: number;
}

export interface SaveRow {
  blob: string;
  rev: number;
}

export interface Gift {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  created_at: number;
  claimed_at: number | null;
}

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Find an account by Google sub. */
export async function accountByGoogleSub(
  db: D1Database,
  sub: string
): Promise<Account | null> {
  return db
    .prepare("SELECT * FROM accounts WHERE google_sub = ?")
    .bind(sub)
    .first<Account>();
}

export async function accountById(
  db: D1Database,
  id: string
): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
}

export async function accountByFriendCode(
  db: D1Database,
  code: string
): Promise<Account | null> {
  return db
    .prepare("SELECT * FROM accounts WHERE friend_code = ?")
    .bind(code)
    .first<Account>();
}

/** Get the account for this Google identity, creating it (with a unique friend
 *  code) on first sign-in. Retries code generation on the rare collision. */
export async function upsertAccount(
  db: D1Database,
  who: GoogleIdentity,
  now: number
): Promise<Account> {
  const existing = await accountByGoogleSub(db, who.sub);
  if (existing) return existing;
  const id = idFromBytes(rand(16));
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = friendCodeFromBytes(rand(6));
    try {
      await db
        .prepare(
          "INSERT INTO accounts (id, google_sub, friend_code, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind(id, who.sub, code, now)
        .run();
      return {
        id,
        google_sub: who.sub,
        username: null,
        friend_code: code,
        created_at: now,
      };
    } catch (e) {
      // Unique-constraint clash on friend_code → try another; re-check sub in case
      // of a concurrent first sign-in for the same Google user.
      const dupe = await accountByGoogleSub(db, who.sub);
      if (dupe) return dupe;
      if (attempt === 4) throw e;
    }
  }
  throw new Error("could not allocate friend code");
}

/** Set the player-chosen display name. Non-unique by design. */
export async function setUsername(
  db: D1Database,
  accountId: string,
  username: string
): Promise<void> {
  await db
    .prepare("UPDATE accounts SET username = ? WHERE id = ?")
    .bind(username, accountId)
    .run();
}

export async function getSave(
  db: D1Database,
  accountId: string
): Promise<SaveRow | null> {
  return db
    .prepare("SELECT blob, rev FROM saves WHERE account_id = ?")
    .bind(accountId)
    .first<SaveRow>();
}

/** Atomic optimistic-concurrency write. Succeeds only if the stored rev is exactly
 *  `expectedRev`, and returns the new rev; returns null on a rev mismatch (stale
 *  write / concurrent writer). This is a real compare-and-swap in SQL, so two
 *  concurrent PUTs that both read rev N can no longer both commit N+1 — the second
 *  UPDATE changes 0 rows and gets null.
 *
 *  expectedRev 0 means "there is no save yet": we INSERT and treat a conflict
 *  (someone else created it first) as a mismatch, so first-save creation is safe
 *  under concurrency too. */
export async function casWriteSave(
  db: D1Database,
  accountId: string,
  blob: string,
  expectedRev: number,
  now: number
): Promise<number | null> {
  if (expectedRev === 0) {
    const res = await db
      .prepare(
        `INSERT INTO saves (account_id, blob, rev, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(account_id) DO NOTHING`
      )
      .bind(accountId, blob, now)
      .run();
    return (res.meta.changes ?? 0) === 1 ? 1 : null;
  }
  const res = await db
    .prepare(
      `UPDATE saves SET blob = ?, rev = rev + 1, updated_at = ?
       WHERE account_id = ? AND rev = ?`
    )
    .bind(blob, now, accountId, expectedRev)
    .run();
  return (res.meta.changes ?? 0) === 1 ? expectedRev + 1 : null;
}

/** My friends (both-directions storage means one indexed lookup). */
export async function listFriends(
  db: D1Database,
  accountId: string
): Promise<Account[]> {
  const res = await db
    .prepare(
      `SELECT a.* FROM accounts a
       JOIN friendships f ON f.b_id = a.id
       WHERE f.a_id = ?
       ORDER BY a.username COLLATE NOCASE`
    )
    .bind(accountId)
    .all<Account>();
  return res.results ?? [];
}

/** Account ids this sender has already gifted in a server-owned day bucket. */
export async function giftedRecipientIds(
  db: D1Database,
  accountId: string,
  giftDayBucket: number
): Promise<Set<string>> {
  const res = await db
    .prepare("SELECT to_id FROM gifts WHERE from_id = ? AND day_bucket = ?")
    .bind(accountId, giftDayBucket)
    .all<{ to_id: string }>();
  return new Set((res.results ?? []).map((row) => row.to_id));
}

export async function areFriends(
  db: D1Database,
  a: string,
  b: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM friendships WHERE a_id = ? AND b_id = ?")
    .bind(a, b)
    .first<{ x: number }>();
  return !!row;
}

/** Create the friendship in both directions (idempotent via INSERT OR IGNORE).
 *  Called only from an accepted request — never directly from /friends/add. */
export async function addFriendship(
  db: D1Database,
  a: string,
  b: string,
  now: number
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)"
      )
      .bind(a, b, now),
    db
      .prepare(
        "INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)"
      )
      .bind(b, a, now),
  ]);
}

/** Remove a friendship in both directions. */
export async function removeFriendship(
  db: D1Database,
  a: string,
  b: string
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM friendships WHERE a_id = ? AND b_id = ?").bind(a, b),
    db.prepare("DELETE FROM friendships WHERE a_id = ? AND b_id = ?").bind(b, a),
  ]);
}

export async function countFriends(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM friendships WHERE a_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- friend requests (consent) ------------------------------------------
/** File a pending request from -> to (idempotent). No-op if it already exists. */
export async function createFriendRequest(
  db: D1Database,
  from: string,
  to: string,
  now: number
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)"
    )
    .bind(from, to, now)
    .run();
}

/** Whether a pending request from -> to already exists. */
export async function requestExists(
  db: D1Database,
  from: string,
  to: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?")
    .bind(from, to)
    .first<{ x: number }>();
  return !!row;
}

export interface IncomingRequest {
  fromAccountId: string;
  name: string;
  friendCode: string;
  created_at: number;
}

/** Pending requests addressed TO `accountId` (people asking to befriend me). */
export async function incomingRequests(
  db: D1Database,
  accountId: string,
  limit: number
): Promise<IncomingRequest[]> {
  const res = await db
    .prepare(
      `SELECT r.from_id AS fromAccountId, r.created_at AS created_at,
              COALESCE(a.username, 'Player') AS name, a.friend_code AS friendCode
       FROM friend_requests r JOIN accounts a ON a.id = r.from_id
       WHERE r.to_id = ?
       ORDER BY r.created_at ASC
       LIMIT ?`
    )
    .bind(accountId, limit)
    .all<IncomingRequest>();
  return res.results ?? [];
}

export async function countIncomingRequests(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE to_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Accept a pending request from `from` to `me`: promote to a friendship (both
 *  directions) and clear any request in either direction. Returns false if there
 *  was no such pending request (nothing accepted). */
export async function acceptRequest(
  db: D1Database,
  me: string,
  from: string,
  now: number
): Promise<boolean> {
  const pending = await requestExists(db, from, me);
  if (!pending) return false;
  await db.batch([
    db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(from, me),
    db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(me, from),
    db
      .prepare("INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)")
      .bind(me, from, now),
    db
      .prepare("INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)")
      .bind(from, me, now),
  ]);
  return true;
}

/** Reject/withdraw a pending request in either direction. */
export async function deleteRequest(
  db: D1Database,
  a: string,
  b: string
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(a, b),
    db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(b, a),
  ]);
}

// ---- blocks -------------------------------------------------------------
/** Block `blocked` for `blocker`: record it and tear down any existing edge or
 *  pending request in either direction. */
export async function addBlock(
  db: D1Database,
  blocker: string,
  blocked: string,
  now: number
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)")
      .bind(blocker, blocked, now),
    db.prepare("DELETE FROM friendships WHERE a_id = ? AND b_id = ?").bind(blocker, blocked),
    db.prepare("DELETE FROM friendships WHERE a_id = ? AND b_id = ?").bind(blocked, blocker),
    db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(blocker, blocked),
    db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(blocked, blocker),
  ]);
}

/** Whether either account has blocked the other (relationship is dead both ways). */
export async function blockedEitherWay(
  db: D1Database,
  x: string,
  y: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM blocks
       WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
       LIMIT 1`
    )
    .bind(x, y, y, x)
    .first<{ x: number }>();
  return !!row;
}

/** Send a gift, enforcing "once per UTC day per recipient" ATOMICALLY. The unique
 *  index idx_gifts_once (from_id, to_id, day_bucket) means a second send in the
 *  same bucket conflicts and inserts nothing — no read-then-insert race. Returns
 *  true if a gift was created, false if the daily gate already fired. */
export async function insertGiftOnce(
  db: D1Database,
  from: string,
  to: string,
  bucket: number,
  now: number
): Promise<boolean> {
  const id = idFromBytes(rand(16));
  const res = await db
    .prepare(
      `INSERT INTO gifts (id, from_id, to_id, type, created_at, day_bucket)
       VALUES (?, ?, ?, 'brain', ?, ?)
       ON CONFLICT (from_id, to_id, day_bucket) DO NOTHING`
    )
    .bind(id, from, to, now, bucket)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/** Count of unclaimed gifts sitting in `to`'s inbox (for the inbox cap). */
export async function countUnclaimedTo(db: D1Database, to: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM gifts WHERE to_id = ? AND claimed_at IS NULL")
    .bind(to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface InboxGift {
  id: string;
  type: string;
  created_at: number;
  fromName: string;
}

export async function inbox(
  db: D1Database,
  accountId: string,
  limit: number
): Promise<InboxGift[]> {
  const res = await db
    .prepare(
      `SELECT g.id, g.type, g.created_at, COALESCE(a.username, 'Player') AS fromName
       FROM gifts g JOIN accounts a ON a.id = g.from_id
       WHERE g.to_id = ? AND g.claimed_at IS NULL
       ORDER BY g.created_at ASC
       LIMIT ?`
    )
    .bind(accountId, limit)
    .all<InboxGift>();
  return res.results ?? [];
}

/** A single unclaimed gift addressed to `accountId`, or null. */
export async function claimableGift(
  db: D1Database,
  giftId: string,
  accountId: string
): Promise<Gift | null> {
  return db
    .prepare(
      "SELECT * FROM gifts WHERE id = ? AND to_id = ? AND claimed_at IS NULL"
    )
    .bind(giftId, accountId)
    .first<Gift>();
}

export async function markGiftClaimed(
  db: D1Database,
  giftId: string,
  now: number
): Promise<void> {
  await db
    .prepare("UPDATE gifts SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
    .bind(now, giftId)
    .run();
}

/** Atomically consume an addressed gift, record its idempotency grant, and credit one
 * brain. Every side effect is guarded by this attempt's grant id, so concurrent claims
 * have one winner and a failed batch cannot hide a gift without its brain. */
export async function claimGiftBrain(
  db: D1Database,
  giftId: string,
  accountId: string,
  grantId: string,
  now: number,
  seed: Balance
): Promise<boolean> {
  await getOrSeedBalance(db, accountId, seed);
  const guard = "EXISTS(SELECT 1 FROM grants WHERE id=? AND source_gift_id=? AND account_id=?)";
  const result = await db.batch([
    db.prepare(`UPDATE account_runtime_v3 SET active_batch_id=?,active_batch_expires_at=?,
      account_version=account_version+1,updated_at=? WHERE account_id=?
      AND (active_batch_id IS NULL OR active_batch_expires_at<=?)`)
      .bind(grantId, now + 120_000, now, accountId, now),
    db.prepare(`INSERT OR IGNORE INTO grants
      (id,account_id,kind,amount,source_gift_id,created_at,settled_at)
      SELECT ?,?,'brain',1,id,?,? FROM gifts
      WHERE id=? AND to_id=? AND claimed_at IS NULL
      AND EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=? AND active_batch_id=?)`)
      .bind(grantId, accountId, now, now, giftId, accountId, accountId, grantId),
    db.prepare(`UPDATE balances SET brains=brains+1 WHERE account_id=? AND ${guard}`)
      .bind(accountId, grantId, giftId, accountId),
    db.prepare(`UPDATE gifts SET claimed_at=? WHERE id=? AND to_id=? AND claimed_at IS NULL AND ${guard}`)
      .bind(now, giftId, accountId, grantId, giftId, accountId),
    db.prepare(`UPDATE account_runtime_v3 SET active_batch_id=NULL,active_batch_expires_at=0,updated_at=?
      WHERE account_id=? AND active_batch_id=?`).bind(now, accountId, grantId),
  ]);
  return (result[0]?.meta.changes ?? 0) === 1 && (result[1]?.meta.changes ?? 0) === 1 &&
    (result[2]?.meta.changes ?? 0) === 1 && (result[3]?.meta.changes ?? 0) === 1;
}

/** Record a PENDING grant (settled_at NULL) keyed by its source gift id, IF one
 *  doesn't already exist. `id` is caller-supplied so the caller can then settle it.
 *  Returns true if THIS call inserted it (this caller "won" the claim), false if a
 *  grant for that gift already existed (idempotent). The UNIQUE(source_gift_id)
 *  index is the serialization point that makes a double-claim impossible. */
export async function insertGrantIfAbsent(
  db: D1Database,
  id: string,
  accountId: string,
  kind: string,
  amount: number,
  sourceGiftId: string,
  now: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO grants (id, account_id, kind, amount, source_gift_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_gift_id) DO NOTHING`
    )
    .bind(id, accountId, kind, amount, sourceGiftId, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/** Credit a pending grant's `amount` brains into the server-authoritative BALANCE,
 *  exactly once. settled_at is the single-apply gate (only one caller wins the
 *  flip); the credit is then an atomic increment on the balances row — no save-blob
 *  CAS, no churn, no deferred/rollback dance the old blob credit needed. `seed` is
 *  the save's current currency, used only to lazily create the balances row on the
 *  very first credit (post-migration it already exists). Returns true if credited. */
export async function settleGrant(
  db: D1Database,
  grantId: string,
  amount: number,
  accountId: string,
  now: number,
  seed: Balance
): Promise<boolean> {
  const won = await db
    .prepare("UPDATE grants SET settled_at = ? WHERE id = ? AND settled_at IS NULL")
    .bind(now, grantId)
    .run();
  if ((won.meta.changes ?? 0) !== 1) return false; // already settled by someone
  await getOrSeedBalance(db, accountId, seed); // ensure the balances row exists
  await db
    .prepare("UPDATE balances SET brains = brains + ? WHERE account_id = ?")
    .bind(amount, accountId)
    .run();
  return true;
}

/** Settle any still-pending grants for an account (crash-window recovery: a grant
 *  whose settled_at flip committed but whose credit didn't). Cheap when nothing is
 *  pending (one indexed read). `seed` lazily creates the balances row if needed. */
export async function reconcilePendingGrants(
  db: D1Database,
  accountId: string,
  now: number,
  seed: Balance
): Promise<number> {
  const res = await db
    .prepare(
      "SELECT id, amount FROM grants WHERE account_id = ? AND kind = 'brain' AND settled_at IS NULL"
    )
    .bind(accountId)
    .all<{ id: string; amount: number }>();
  const pending = res.results ?? [];
  let applied = 0;
  for (const g of pending) {
    if (await settleGrant(db, g.id, g.amount, accountId, now, seed)) applied++;
  }
  return applied;
}

/** Assign a fresh unique friend code to an account (rotation). Retries on the rare
 *  collision, mirroring account creation. Returns the new code. */
export async function rotateFriendCode(db: D1Database, accountId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = friendCodeFromBytes(rand(12));
    const res = await db
      .prepare("UPDATE accounts SET friend_code = ? WHERE id = ?")
      .bind(code, accountId)
      .run()
      .catch(() => null);
    if (res && (res.meta.changes ?? 0) === 1) return code;
    if (attempt === 4) throw new Error("could not allocate friend code");
  }
  throw new Error("could not allocate friend code");
}

// ---- sessions (revocable) -----------------------------------------------
/** Open a new session row; its id goes in the access-token JWT (sid). `label` is a
 *  server-derived device string (e.g. "Chrome on Windows") for the Account menu's
 *  device list — never client-supplied. */
export async function createSession(
  db: D1Database,
  accountId: string,
  now: number,
  label: string | null = null
): Promise<string> {
  const id = idFromBytes(rand(16));
  await db
    .prepare(
      "INSERT INTO sessions (id, account_id, created_at, last_used_at, label) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(id, accountId, now, now, label)
    .run();
  return id;
}

/** Interval below which we DON'T rewrite last_used_at. Auth still checks the live
 *  session on every request; we just avoid a D1 write on each one (the free-tier
 *  bottleneck). A ~15-min resolution is plenty for an idle-session sweep. */
export const SESSION_TOUCH_MS = 15 * 60 * 1000;

/** Idle-expiry: a session unused for this long is treated as dead at auth time,
 *  even before the cleanup cron deletes it. Matches the cron's idle purge cutoff
 *  (index.ts runCleanup) and comfortably exceeds the access-token TTL, so an idle
 *  session can't be resurrected by a still-unexpired JWT. This is the policy the
 *  device list enforces: revoked OR idle-expired sessions never appear or authorize. */
export const SESSION_IDLE_MAX_MS = 8 * 24 * 60 * 60 * 1000;

/** The account id for a live session (existing, non-revoked, and not idle-expired),
 *  or null. Bumps last_used_at only when it's gone stale (throttled), so most authed
 *  requests incur ZERO session writes. */
export async function sessionAccount(
  db: D1Database,
  sessionId: string,
  now: number
): Promise<string | null> {
  const row = await db
    .prepare("SELECT account_id, last_used_at FROM sessions WHERE id = ? AND revoked_at IS NULL")
    .bind(sessionId)
    .first<{ account_id: string; last_used_at: number }>();
  if (!row) return null;
  if (now - row.last_used_at > SESSION_IDLE_MAX_MS) return null; // idle-expired
  if (now - row.last_used_at > SESSION_TOUCH_MS) {
    await db
      .prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
      .bind(now, sessionId)
      .run();
  }
  return row.account_id;
}

/** A live session as shown in the Account menu's device list. */
export interface SessionInfo {
  id: string;
  created_at: number;
  last_used_at: number;
  label: string | null;
}

/** List an account's live (non-revoked, non-idle-expired) sessions, most-recently
 *  used first — the device list. Idle-expired rows are filtered so the list matches
 *  exactly what sessionAccount would still authorize. */
export async function listSessions(
  db: D1Database,
  accountId: string,
  now: number
): Promise<SessionInfo[]> {
  const idleCutoff = now - SESSION_IDLE_MAX_MS;
  const res = await db
    .prepare(
      `SELECT id, created_at, last_used_at, label FROM sessions
       WHERE account_id = ? AND revoked_at IS NULL AND last_used_at >= ?
       ORDER BY last_used_at DESC`
    )
    .bind(accountId, idleCutoff)
    .all<SessionInfo>();
  return res.results ?? [];
}

/** Revoke ONE session, but only if it belongs to `accountId` (so a request can't
 *  revoke another account's session by guessing an id). Returns true if a live
 *  session was revoked, false if there was nothing to revoke (unknown / foreign /
 *  already revoked) — the route maps false to 404. */
export async function revokeSessionForAccount(
  db: D1Database,
  sessionId: string,
  accountId: string,
  now: number
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL"
    )
    .bind(now, sessionId, accountId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Revoke a single session (sign out this device). */
export async function revokeSession(db: D1Database, sessionId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(now, sessionId)
    .run();
}

/** Revoke every session for an account (sign out everywhere / emergency). */
export async function revokeAllSessions(db: D1Database, accountId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
    .bind(now, accountId)
    .run();
}

// ---- economy (server-authoritative balances + ledger) ------------------
/** Read the account's balance, seeding it once from `seed` (the player's current
 *  save currency) if no row exists yet — so migration doesn't wipe anyone's gold.
 *  Race-safe: INSERT OR IGNORE then SELECT. */
export async function getOrSeedBalance(
  db: D1Database,
  accountId: string,
  seed: Balance
): Promise<Balance> {
  const s = clampSeed(seed);
  // Initialize claimed_level to the seed's level so a brand-new/migrated account only
  // ever pays out level-ups earned AFTER creation (not a retroactive windfall). Rows
  // that predate the column keep the DEFAULT 0 sentinel, handled by creditLevelUps.
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO balances (account_id, gold, brains, xp, claimed_level) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(accountId, s.gold, s.brains, s.xp, levelForXp(s.xp)),
    db
      .prepare(
        `INSERT INTO account_import_state (account_id, balance_seeded)
         VALUES (?, 1) ON CONFLICT(account_id) DO UPDATE SET balance_seeded = 1`
      )
      .bind(accountId),
  ]);
  const row = await db
    .prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?")
    .bind(accountId)
    .first<Balance>();
  return row ?? { gold: 0, brains: 0, xp: 0 };
}

/** Credit the +1-brain-per-level reward for any levels the account has reached but not
 *  yet been paid for, deriving the level from server-owned `balances.xp`. Returns the
 *  number of brains granted (0 if none / on the initial sentinel adoption). Idempotent
 *  and race-safe: the grant is a conditional UPDATE on the exact prior claimed_level
 *  (a CAS), so concurrent callers can't double-pay; the ledger row is keyed by target
 *  level. Call after any operation that raises xp (harvest, raid, quest) and on sync.
 *
 *  claimed_level == 0 is the "uninitialized" sentinel (a row created before this
 *  feature): we adopt the current level without paying, so pre-server progress isn't a
 *  retroactive windfall. Rows created by getOrSeedBalance already start at their level. */
export async function creditLevelUps(
  db: D1Database,
  accountId: string,
  now: number
): Promise<number> {
  const row = await db
    .prepare("SELECT xp, claimed_level FROM balances WHERE account_id = ?")
    .bind(accountId)
    .first<{ xp: number; claimed_level: number }>();
  if (!row) return 0;
  const level = levelForXp(row.xp);
  if (row.claimed_level === 0) {
    // Adopt current level, grant nothing (guarded so a concurrent real grant wins).
    await db
      .prepare("UPDATE balances SET claimed_level = ? WHERE account_id = ? AND claimed_level = 0")
      .bind(level, accountId)
      .run();
    return 0;
  }
  if (level <= row.claimed_level) return 0;
  const brains = level - row.claimed_level;
  const upd = await db
    .prepare(
      "UPDATE balances SET brains = brains + ?, claimed_level = ? WHERE account_id = ? AND claimed_level = ?"
    )
    .bind(brains, level, accountId, row.claimed_level)
    .run();
  if ((upd.meta.changes ?? 0) !== 1) return 0; // lost the CAS race; the winner paid
  await db
    .prepare(
      "INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'brains', ?, 'levelup', ?)"
    )
    .bind(`lvl:${accountId}:${level}`, accountId, brains, now)
    .run();
  return brains;
}

export interface QuestResult {
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  balance: Balance;
  /** What was actually credited to the balance this call (0s on duplicate/item/zombie). */
  granted: { gold: number; brains: number; xp: number };
  /** True when the quest's reward is an item/zombie: the completion is recorded (so it
   *  can't be re-run) but nothing was credited — and the client grants nothing for it
   *  either, so the two agree. See questCatalog's header for why. */
  deferred: boolean;
}

/** Complete a quest and grant its SERVER-CATALOG reward exactly once. The amount comes
 *  from questCatalog (never the client), and the (account, quest) PRIMARY KEY is the
 *  once-guard: the INSERT elects a single winner that credits the reward; a duplicate
 *  credits nothing. Currency rewards (Xp/Gold/Brains) hit the balance ledger and, for
 *  xp, trigger any owed level-up; Item/Zombie rewards are recorded-only — the client
 *  grants nothing for them either (see questCatalog's header), so there's nothing to
 *  mirror. Requirement proof is still client-side (bounded-once, not proven-earned). */
export async function completeQuest(
  db: D1Database,
  accountId: string,
  questId: string,
  now: number
): Promise<QuestResult> {
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const zero = { gold: 0, brains: 0, xp: 0 };
  const reward = questReward(questId);
  if (!reward) {
    return { status: "rejected", error: "bad_quest", balance: bal, granted: zero, deferred: false };
  }

  const isCurrency =
    reward.rewardType === QUEST_REWARD.Xp ||
    reward.rewardType === QUEST_REWARD.Gold ||
    reward.rewardType === QUEST_REWARD.Brains;
  // Item/Zombie rewards can't be granted until storage/roster creation is server-owned
  // (Phase D); record them with reward_value 0 so re-completion is still blocked.
  const creditValue = isCurrency ? reward.rewardValue : 0;

  // Elect the single completer. ON CONFLICT DO NOTHING → a duplicate changes 0 rows.
  const ins = await db
    .prepare(
      `INSERT INTO quest_completions (account_id, quest_id, reward_type, reward_value, completed_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, quest_id) DO NOTHING`
    )
    .bind(accountId, questId, reward.rewardType, creditValue, now)
    .run();
  if ((ins.meta.changes ?? 0) !== 1) {
    return { status: "duplicate", balance: bal, granted: zero, deferred: false };
  }

  if (!isCurrency) {
    // Supported item rewards now enter authoritative inventory/storage. Zombie reward
    // keys intentionally remain no-grant because they do not resolve to catalog units.
    if (reward.rewardType === QUEST_REWARD.Item && reward.rewardItemKey) {
      const boost = boostKeyForName(reward.rewardItemKey);
      if (boost) {
        await db
          .prepare(
            `INSERT INTO inventory (account_id, item_key, count) VALUES (?, ?, 1)
             ON CONFLICT(account_id, item_key) DO UPDATE SET count = count + 1`
          )
          .bind(accountId, boost)
          .run();
      } else if (dropEcon(reward.rewardItemKey)) {
        await addStorageStmt(db, accountId, "received", reward.rewardItemKey, 1).run();
      }
    }
    return {
      status: "applied",
      balance: bal,
      granted: zero,
      deferred: reward.rewardType === QUEST_REWARD.Zombie,
    };
  }

  const granted = { gold: 0, brains: 0, xp: 0 };
  const currency: Currency =
    reward.rewardType === QUEST_REWARD.Gold ? "gold" : reward.rewardType === QUEST_REWARD.Brains ? "brains" : "xp";
  granted[currency] = reward.rewardValue;
  await db.batch([
    db
      .prepare(`UPDATE balances SET ${currency} = ${currency} + ? WHERE account_id = ?`)
      .bind(reward.rewardValue, accountId),
    db
      .prepare(
        "INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, 'quest', ?)"
      )
      .bind(`quest:${accountId}:${questId}`, accountId, currency, reward.rewardValue, now),
  ]);
  bal[currency] += reward.rewardValue;

  // A quest xp reward may have crossed a level threshold — pay owed level-up brains.
  if (currency === "xp") {
    const lvlBrains = await creditLevelUps(db, accountId, now);
    bal.brains += lvlBrains;
    granted.brains += lvlBrains;
  }
  return { status: "applied", balance: bal, granted, deferred: false };
}

const TRUSTED_QUEST_EVENTS = new Set([
  "kSoilPlowedNotification",
  "kNewSoilPlowedNotification",
  "kCropPlantedNotification",
  "kCropHarvestedNotification",
  "kCropHarvestedZombieNotification",
  "kItemBoughtNotification",
  "kCombinerCombinedNotification",
  "kCombinerHarvestedNotification",
  "kInvasionSuccessfulNotification",
  "kInvasionPerfectGameNotification",
  "kLootItemWonNotification",
]);

// Quest rewards are deliberately low-stakes. Keep the event machinery available for
// a future opt-in, but do not put normal gameplay behind asynchronous D1 processing.
// The client advances quests immediately; completeQuest() retains the exactly-once gate.
const SERVER_EVENT_DRIVEN_QUESTS = false;

export interface TrustedGameEvent {
  id: string;
  type: string;
  subject?: string;
  amount?: number;
}

export interface QuestState {
  completed: string[];
  progress: { questId: string; counts: number[] }[];
}

export interface QuestChange {
  questId: string;
  counts: number[];
  completed: boolean;
}

/** Persist events produced by accepted server commands. Event ids are derived from the
 * command/action id, making retries harmless. No public route accepts this shape. */
export async function recordTrustedGameEvents(
  db: D1Database,
  accountId: string,
  events: TrustedGameEvent[],
  now: number
): Promise<void> {
  if (!SERVER_EVENT_DRIVEN_QUESTS) return;
  const valid = events.filter(
    (e) => e && typeof e.id === "string" && e.id.length > 0 && e.id.length <= 160 && TRUSTED_QUEST_EVENTS.has(e.type)
  );
  if (!valid.length) return;
  await db.batch(
    valid.map((e) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO game_events
             (id, account_id, event_type, subject, amount, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          e.id,
          accountId,
          e.type,
          typeof e.subject === "string" ? e.subject.slice(0, 160) : "",
          Number.isInteger(e.amount) ? Math.max(1, Math.min(10_000, e.amount!)) : 1,
          now
        )
    )
  );
}

/** Import only legacy completed ids. Active counters are deliberately ignored and the
 * imported rows carry reward_value=0, so migration never re-pays old rewards. Empty is
 * still a permanent import decision. */
export async function seedLegacyQuestCompletions(
  db: D1Database,
  accountId: string,
  completed: unknown,
  now: number
): Promise<void> {
  const token = crypto.randomUUID();
  const ids = Array.isArray(completed)
    ? [...new Set(completed.filter((x): x is string => typeof x === "string" && !!QUEST_DEFINITIONS[x]))].slice(0, 256)
    : [];
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT OR IGNORE INTO account_import_state (account_id) VALUES (?)").bind(accountId),
    db
      .prepare(
        "UPDATE account_import_state SET quests_seeded = 1, quests_token = ? WHERE account_id = ? AND quests_seeded = 0"
      )
      .bind(token, accountId),
  ];
  for (const id of ids) {
    const q = QUEST_DEFINITIONS[id];
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO quest_completions
             (account_id, quest_id, reward_type, reward_value, completed_at)
           SELECT ?, ?, ?, 0, ? WHERE EXISTS (
             SELECT 1 FROM account_import_state
             WHERE account_id = ? AND quests_seeded = 1 AND quests_token = ?
           )`
        )
        .bind(accountId, id, q.rewardType, now, accountId, token)
    );
  }
  await db.batch(stmts);
}

export async function readQuestState(db: D1Database, accountId: string): Promise<QuestState> {
  const done = await db
    .prepare("SELECT quest_id FROM quest_completions WHERE account_id = ? ORDER BY CAST(quest_id AS INTEGER), quest_id")
    .bind(accountId)
    .all<{ quest_id: string }>();
  const rows = await db
    .prepare(
      "SELECT quest_id, requirement_index, count FROM quest_progress WHERE account_id = ? ORDER BY quest_id, requirement_index"
    )
    .bind(accountId)
    .all<{ quest_id: string; requirement_index: number; count: number }>();
  const byQuest = new Map<string, number[]>();
  for (const row of rows.results ?? []) {
    const q = QUEST_DEFINITIONS[row.quest_id];
    if (!q || row.requirement_index < 0 || row.requirement_index >= q.requirements.length) continue;
    const counts = byQuest.get(row.quest_id) ?? new Array(q.requirements.length).fill(0);
    counts[row.requirement_index] = Math.max(0, Math.min(q.requirements[row.requirement_index].countTotal, row.count));
    byQuest.set(row.quest_id, counts);
  }
  return {
    completed: (done.results ?? []).map((r) => r.quest_id),
    progress: [...byQuest].map(([questId, counts]) => ({ questId, counts })),
  };
}

/** Apply pending trusted events exactly once. Eligibility is snapshotted before each
 * event, so an event completing a prerequisite cannot count for its newly unlocked
 * successor. Application rows and processed_at make interruption safely resumable. */
export async function processQuestEvents(
  db: D1Database,
  accountId: string,
  now: number
): Promise<QuestChange[]> {
  if (!SERVER_EVENT_DRIVEN_QUESTS) return [];
  const pending = await db
    .prepare(
      `SELECT id, event_type, subject, amount FROM game_events
       WHERE account_id = ? AND processed_at IS NULL ORDER BY created_at, id LIMIT 256`
    )
    .bind(accountId)
    .all<{ id: string; event_type: string; subject: string; amount: number }>();
  const changes = new Map<string, QuestChange>();
  for (const event of pending.results ?? []) {
    const before = await readQuestState(db, accountId);
    const completed = new Set(before.completed);
    const level = levelForXp((await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 })).xp);
    for (const [questId, q] of Object.entries(QUEST_DEFINITIONS)) {
      if (q.seasonal || q.epicEvent || completed.has(questId)) continue;
      if (q.prerequisiteQuest >= 0 && !completed.has(String(q.prerequisiteQuest))) continue;
      if (q.levelRequired >= 0 && level < q.levelRequired) continue;
      let touched = false;
      for (let i = 0; i < q.requirements.length; i++) {
        const req = q.requirements[i];
        if (!TRUSTED_QUEST_EVENTS.has(req.notificationID) || req.notificationID !== event.event_type) continue;
        if (req.notificationObject && req.notificationObject.toLowerCase() !== event.subject.toLowerCase()) continue;
        const token = crypto.randomUUID();
        await db.batch([
          db
            .prepare(
              `INSERT OR IGNORE INTO quest_event_applications
                 (account_id, event_id, quest_id, requirement_index, applied_at, attempt_token)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(accountId, event.id, questId, i, now, token),
          db
            .prepare(
              `INSERT INTO quest_progress (account_id, quest_id, requirement_index, count, updated_at)
               SELECT ?, ?, ?, ?, ? WHERE EXISTS (
                 SELECT 1 FROM quest_event_applications
                 WHERE account_id = ? AND event_id = ? AND quest_id = ? AND requirement_index = ? AND attempt_token = ?
               )
               ON CONFLICT(account_id, quest_id, requirement_index) DO UPDATE SET
                 count = MIN(?, quest_progress.count + excluded.count), updated_at = excluded.updated_at`
            )
            .bind(accountId, questId, i, Math.min(req.countTotal, event.amount), now,
              accountId, event.id, questId, i, token, req.countTotal),
        ]);
        const applied = await db
          .prepare(
            `SELECT 1 AS x FROM quest_event_applications
             WHERE account_id = ? AND event_id = ? AND quest_id = ? AND requirement_index = ? AND attempt_token = ?`
          )
          .bind(accountId, event.id, questId, i, token)
          .first<{ x: number }>();
        if (!applied) continue;
        touched = true;
      }
      if (!touched) continue;
      const state = await readQuestState(db, accountId);
      const counts = state.progress.find((p) => p.questId === questId)?.counts ?? new Array(q.requirements.length).fill(0);
      let didComplete = false;
      if (q.requirements.every((r, i) => (counts[i] ?? 0) >= r.countTotal)) {
        didComplete = (await completeQuest(db, accountId, questId, now)).status === "applied";
      }
      changes.set(questId, { questId, counts, completed: didComplete || state.completed.includes(questId) });
    }
    await db
      .prepare("UPDATE game_events SET processed_at = ? WHERE id = ? AND account_id = ? AND processed_at IS NULL")
      .bind(now, event.id, accountId)
      .run();
  }
  return [...changes.values()];
}

/** Apply a batch of economy events atomically & idempotently. Validates each
 *  against the current balance (spends can't overdraw, earns are capped), records
 *  accepted events in the ledger (INSERT OR IGNORE by id), and increments the
 *  balance by the accepted net delta (atomic add, so concurrent flushes of
 *  DIFFERENT events both land; same-id replays are ignored). Returns the resulting
 *  balance and a per-event verdict. */
export async function applyEvents(
  db: D1Database,
  accountId: string,
  events: EconomyEvent[]
): Promise<{
  balance: Balance;
  results: { id: string; status: "applied" | "duplicate" | "rejected"; error?: string }[];
}> {
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });

  // Which of these ids are already in the ledger (idempotency).
  const ids = events.map((e) => e?.id).filter((x): x is string => typeof x === "string" && !!x);
  const applied = new Set<string>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const res = await db
      .prepare(`SELECT id FROM ledger WHERE account_id = ? AND id IN (${placeholders})`)
      .bind(accountId, ...ids)
      .all<{ id: string }>();
    for (const r of res.results ?? []) applied.add(r.id);
  }

  const { balance, results } = applyBatch(events, bal, applied);
  const accepted = events.filter((_, i) => results[i]?.status === "applied");
  if (!accepted.length) return { balance: bal, results };

  const now = Date.now();
  const net = { gold: 0, brains: 0, xp: 0 };
  const stmts = accepted.map((ev) => {
    net[ev.currency] += ev.delta;
    return db
      .prepare(
        "INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(ev.id, accountId, ev.currency, ev.delta, ev.reason, now);
  });
  stmts.push(
    db
      .prepare(
        "UPDATE balances SET gold = gold + ?, brains = brains + ?, xp = xp + ? WHERE account_id = ?"
      )
      .bind(net.gold, net.brains, net.xp, accountId)
  );
  await db.batch(stmts);
  return { balance, results };
}

// ---- farm: exact per-action economics (server-owned crop plots) ---------
interface CropPlotRow extends PlotRecord {
  oc: number;
  pr: number;
}

/** The server-recorded crop at a plot, or null. */
async function getCropPlot(
  db: D1Database,
  accountId: string,
  oc: number,
  pr: number
): Promise<CropPlotRow | null> {
  return db
    .prepare(
      "SELECT oc, pr, crop_key, planted_at, grow_ms, sell, xp, fertilized FROM crop_plots WHERE account_id = ? AND oc = ? AND pr = ?"
    )
    .bind(accountId, oc, pr)
    .first<CropPlotRow>();
}

/** Whether a farm action id was already applied (idempotency). */
async function farmActionSeen(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM farm_actions WHERE id = ?").bind(id).first<{ x: number }>();
  return !!row;
}

/** Whether a plot's soil is recorded PLOWED-and-empty (Phase E) — what a plant needs. */
async function isPlowed(db: D1Database, accountId: string, oc: number, pr: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM plowed_soil WHERE account_id = ? AND oc = ? AND pr = ?")
    .bind(accountId, oc, pr)
    .first<{ x: number }>();
  return !!row;
}

/** The account's OWNED farm size (side length in tiles). Falls back to the base size
 *  rather than seeding, so a plant can't create farm state as a side effect. */
export async function farmSize(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare("SELECT size FROM farm_state WHERE account_id = ?")
    .bind(accountId)
    .first<{ size: number }>();
  return row?.size ?? BASE_FARM_SIZE;
}

/** The account's plow cost: free while it owns a Plowing Monolith. Read from
 *  server-owned object counts, never a client claim. */
async function plowCost(db: D1Database, accountId: string): Promise<number> {
  return (await objectCount(db, accountId, PLOW_FREE_OBJECT)) > 0 ? 0 : PLOW_COST;
}

export interface FarmResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  gold?: number;
  xp?: number;
  fertilized?: boolean; // plant only: whether the SERVER rolled the crop fertilized
  /** Authoritative catalog subject for quest events emitted after a harvest. */
  subject?: string;
  zombie?: boolean;
}

function namedCatalogKey(rows: unknown, key: string): string {
  if (!Array.isArray(rows)) return "";
  const row = rows.find((x) => x && typeof x === "object" && (x as { key?: unknown }).key === key) as
    | { name?: unknown }
    | undefined;
  return typeof row?.name === "string" ? row.name : "";
}

/** Import an existing player's already-PLOWED soil, exactly once (Phase E). Their client
 *  shows that soil as tilled and so refuses to re-till it; without this import the server
 *  would reject every plant there as `not_plowed` and the account would soft-lock.
 *
 *  Guarded by `farm_state.soil_seeded`, NOT by "no rows yet": an empty plowed_soil set is
 *  a legitimate steady state, so seed-once-if-empty would let a client re-import free
 *  soil (worth the plow cost + 1 xp each) any time it had none. Callers gate this on
 *  MIGRATION_CUTOFF_MS, like every other seed-from-save. Returns the authoritative set.
 *
 *  No xp/gold is granted for imported soil — it was already paid for pre-migration. */
export async function seedPlowedSoil(
  db: D1Database,
  accountId: string,
  plots: unknown,
  now: number
): Promise<{ oc: number; pr: number }[]> {
  const size = await farmSize(db, accountId);
  const row = await db
    .prepare("SELECT soil_seeded FROM farm_state WHERE account_id = ?")
    .bind(accountId)
    .first<{ soil_seeded: number }>();
  // No farm_state row yet => the account hasn't initialized its shop state; treat as
  // un-seeded but still mark it, creating the row so the import can't run twice.
  if (!row?.soil_seeded) {
    const list = Array.isArray(plots) ? plots.slice(0, MAX_SEED_PLOTS) : [];
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          "INSERT INTO farm_state (account_id, size, soil_seeded) VALUES (?, ?, 1) ON CONFLICT(account_id) DO UPDATE SET soil_seeded = 1"
        )
        .bind(accountId, size),
    ];
    for (const p of list) {
      const oc = (p as { oc?: unknown })?.oc;
      const pr = (p as { or?: unknown; pr?: unknown })?.or ?? (p as { pr?: unknown })?.pr;
      // Same bound a real plow gets: inside the OWNED farm, on the plot lattice.
      if (!Number.isInteger(oc) || !Number.isInteger(pr)) continue;
      if (!plotWithin(oc as number, pr as number, size)) continue;
      stmts.push(
        db
          .prepare("INSERT OR IGNORE INTO plowed_soil (account_id, oc, pr, plowed_at) VALUES (?, ?, ?, ?)")
          .bind(accountId, oc, pr, now)
      );
    }
    await db.batch(stmts);
  }
  return readPlowedSoil(db, accountId);
}

/** Every plot the account has recorded as plowed-and-empty. */
export async function readPlowedSoil(db: D1Database, accountId: string): Promise<{ oc: number; pr: number }[]> {
  const res = await db
    .prepare("SELECT oc, pr FROM plowed_soil WHERE account_id = ? ORDER BY oc, pr")
    .bind(accountId)
    .all<{ oc: number; pr: number }>();
  return res.results ?? [];
}

/** Apply a batch of farm actions with EXACT, server-computed economics: plow debits the
 *  server's plow cost and records the soil; plant requires that soil, debits the catalog
 *  seed cost and records the crop with server plant time; harvest is gated by grow time
 *  against that plant time and credits the exact sell (x2 if fertilized) + xp. Plant/plow
 *  are also bounded to the OWNED farm size and the account's level. Idempotent by action
 *  id, atomic per action, and the balance is an atomic increment. Returns the resulting
 *  balance + verdicts. */
export async function applyFarmActions(
  db: D1Database,
  accountId: string,
  actions: FarmAction[],
  now: number
): Promise<{ balance: Balance; results: FarmResult[] }> {
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const results: FarmResult[] = [];

  // Fertilize probability from the player's OWNED Garden zombies (server-owned roll,
  // so a modified client can't force the 2x harvest). Read once — the roster doesn't
  // change within a farm batch. Rolled per plant below. (Fidelity note: this counts
  // all owned Garden units; the client only rolls DEPLOYED ones, so this can fertilize
  // slightly more often — player-favourable, never an exploit.)
  let fertP = 0;
  if (actions.some((a) => a?.type === "plant")) {
    const gk = await db.prepare("SELECT key FROM roster WHERE account_id = ?").bind(accountId).all<{ key: string }>();
    fertP = fertilizeProbability((gk.results ?? []).map((r) => r.key));
  }

  // Server-owned facts every plant/plow is judged against. Read once per batch: neither
  // can change within it (a plant can't buy land, and the level-up a plant's xp might
  // trigger is credited after — it can't unlock a crop earlier in the same batch).
  const size = await farmSize(db, accountId);
  const level = levelForXp(bal.xp);

  for (const a of actions) {
    if (!a || typeof a.id !== "string" || !a.id) {
      results.push({ id: a?.id ?? "", status: "rejected", error: "bad_id" });
      continue;
    }
    if (await farmActionSeen(db, a.id)) {
      results.push({ id: a.id, status: "duplicate" });
      continue;
    }

    if (a.type === "plow") {
      // Till a plot: debit the SERVER's plow cost (0 while a Plowing Monolith is owned)
      // + grant 1 xp, and record the soil so a plant can find it. Consuming the plow
      // cost server-side closes the free-plow gap: the old till spent gold locally, which
      // online just reconciled away.
      const plowed = await isPlowed(db, accountId, a.oc, a.or);
      const occupied = !!(await getCropPlot(db, accountId, a.oc, a.or));
      const plan = planPlow(a, bal, size, await plowCost(db, accountId), plowed, occupied);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO farm_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db
          .prepare("INSERT OR IGNORE INTO plowed_soil (account_id, oc, pr, plowed_at) VALUES (?, ?, ?, ?)")
          .bind(accountId, a.oc, a.or, now),
        db.prepare("UPDATE balances SET gold = gold - ?, xp = xp + ? WHERE account_id = ?").bind(plan.cost, plan.xp, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'gold', ?, 'plow', ?)")
          .bind(a.id, accountId, -plan.cost, now),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'xp', ?, 'plow', ?)")
          .bind(`${a.id}#x`, accountId, plan.xp, now),
      ]);
      bal.gold -= plan.cost;
      bal.xp += plan.xp;
      bal.brains += await creditLevelUps(db, accountId, now); // plow xp may cross a level
      results.push({ id: a.id, status: "applied", gold: -plan.cost, xp: plan.xp });
    } else if (a.type === "plant" && zombieCropEcon(a.cropKey)) {
      // Zombie crop: debit the plant cost (gold OR brains) and record a plot that yields
      // a UNIT (not gold) at harvest. Provenance for the future unit is locked in here.
      const occupied = !!(await getCropPlot(db, accountId, a.oc, a.or));
      const ctx: PlantContext = { size, level, plowed: await isPlowed(db, accountId, a.oc, a.or) };
      const plan = planZombiePlant(a, zombieCropEcon(a.cropKey), occupied, bal, now, ctx);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO farm_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        // The plant CONSUMES the plowed soil: the crop_plots row now represents it, so
        // the two tables stay disjoint and re-planting needs a fresh till.
        db.prepare("DELETE FROM plowed_soil WHERE account_id = ? AND oc = ? AND pr = ?").bind(accountId, a.oc, a.or),
        db
          .prepare(
            "INSERT INTO crop_plots (account_id, oc, pr, crop_key, planted_at, grow_ms, sell, xp, fertilized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(accountId, a.oc, a.or, plan.plot.crop_key, plan.plot.planted_at, plan.plot.grow_ms, plan.plot.sell, plan.plot.xp, plan.plot.fertilized),
        db.prepare(`UPDATE balances SET ${plan.currency} = ${plan.currency} - ? WHERE account_id = ?`).bind(plan.cost, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, 'plant', ?)")
          .bind(`${a.id}#z`, accountId, plan.currency, -plan.cost, now),
      ]);
      bal[plan.currency] -= plan.cost;
      results.push({ id: a.id, status: "applied", gold: plan.currency === "gold" ? -plan.cost : 0 });
    } else if (a.type === "plant") {
      const occupied = !!(await getCropPlot(db, accountId, a.oc, a.or));
      const fertilized = Math.random() < fertP; // SERVER-owned fertilize roll
      const ctx: PlantContext = { size, level, plowed: await isPlowed(db, accountId, a.oc, a.or) };
      const plan = planPlant(a, cropEcon(a.cropKey), occupied, bal, now, fertilized, ctx);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO farm_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        // The plant CONSUMES the plowed soil (see the zombie-crop branch above).
        db.prepare("DELETE FROM plowed_soil WHERE account_id = ? AND oc = ? AND pr = ?").bind(accountId, a.oc, a.or),
        db
          .prepare(
            "INSERT INTO crop_plots (account_id, oc, pr, crop_key, planted_at, grow_ms, sell, xp, fertilized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(accountId, a.oc, a.or, plan.plot.crop_key, plan.plot.planted_at, plan.plot.grow_ms, plan.plot.sell, plan.plot.xp, plan.plot.fertilized),
        db.prepare("UPDATE balances SET gold = gold + ? WHERE account_id = ?").bind(plan.goldDelta, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'gold', ?, 'plant', ?)")
          .bind(`${a.id}#g`, accountId, plan.goldDelta, now),
      ]);
      bal.gold += plan.goldDelta;
      results.push({ id: a.id, status: "applied", gold: plan.goldDelta, fertilized: !!plan.plot.fertilized });
    } else if (a.type === "harvest") {
      const plot = (await getCropPlot(db, accountId, a.oc, a.or)) ?? undefined;
      if (plot && zombieCropEcon(plot.crop_key)) {
        // Zombie crop harvest: grow-gated by SERVER time; yields a VERIFIED owned unit
        // (its key was validated at plant, so it's trusted here) + xp, NO gold. The unit
        // enters the roster so it's legitimately sellable and can't be fast-grown.
        const plan = planZombieHarvest(a, plot, now);
        if (!plan.ok) {
          results.push({ id: a.id, status: "rejected", error: plan.error });
          continue;
        }
        await db.batch([
          db.prepare("INSERT INTO farm_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
          db.prepare("DELETE FROM crop_plots WHERE account_id = ? AND oc = ? AND pr = ?").bind(accountId, a.oc, a.or),
          db
            .prepare("INSERT OR IGNORE INTO roster (account_id, id, key, mutation, invasions) VALUES (?, ?, ?, 0, 0)")
            .bind(accountId, a.unitId, plan.unitKey),
          db.prepare("UPDATE balances SET xp = xp + ? WHERE account_id = ?").bind(plan.xpDelta, accountId),
          db
            .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'xp', ?, 'harvest', ?)")
            .bind(`${a.id}#x`, accountId, plan.xpDelta, now),
        ]);
        bal.xp += plan.xpDelta;
        results.push({
          id: a.id,
          status: "applied",
          xp: plan.xpDelta,
          subject: namedCatalogKey(zombieCatalogData, plan.unitKey),
          zombie: true,
        });
        continue;
      }
      const plan = planHarvest(a, plot, now);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO farm_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db.prepare("DELETE FROM crop_plots WHERE account_id = ? AND oc = ? AND pr = ?").bind(accountId, a.oc, a.or),
        db.prepare("UPDATE balances SET gold = gold + ?, xp = xp + ? WHERE account_id = ?").bind(plan.goldDelta, plan.xpDelta, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'gold', ?, 'harvest', ?)")
          .bind(`${a.id}#g`, accountId, plan.goldDelta, now),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'xp', ?, 'harvest', ?)")
          .bind(`${a.id}#x`, accountId, plan.xpDelta, now),
      ]);
      bal.gold += plan.goldDelta;
      bal.xp += plan.xpDelta;
      results.push({
        id: a.id,
        status: "applied",
        gold: plan.goldDelta,
        xp: plan.xpDelta,
        subject: namedCatalogKey(plantCatalogData, plot?.crop_key ?? ""),
        zombie: false,
      });
    } else {
      results.push({ id: (a as { id: string }).id, status: "rejected", error: "bad_type" });
    }
  }
  // Harvest xp may have crossed a level threshold — pay any owed level-up brains.
  bal.brains += await creditLevelUps(db, accountId, now);
  return { balance: bal, results };
}

/** Delete farm-action idempotency records older than `before` (cron cleanup).
 *  crop_plots are live state and are NOT purged. */
export async function purgeOldFarmActions(db: D1Database, before: number): Promise<number> {
  const res = await db.prepare("DELETE FROM farm_actions WHERE created_at < ?").bind(before).run();
  return res.meta.changes ?? 0;
}

/** Delete ledger events older than `before` (cron cleanup — the balance is
 *  materialized, so old events are only an audit trail). */
export async function purgeOldLedger(db: D1Database, before: number): Promise<number> {
  const res = await db
    .prepare("DELETE FROM ledger WHERE created_at < ?")
    .bind(before)
    .run();
  return res.meta.changes ?? 0;
}

// ---- inventory: server-owned consumable boost counts --------------------
/** Every tracked boost's count for an account (0 for keys with no row) — the full
 *  authoritative boost inventory the client mirrors. */
export async function readInventory(
  db: D1Database,
  accountId: string
): Promise<Record<string, number>> {
  const res = await db
    .prepare("SELECT item_key, count FROM inventory WHERE account_id = ?")
    .bind(accountId)
    .all<{ item_key: string; count: number }>();
  const map: Record<string, number> = {};
  for (const k of BOOST_KEYS) map[k] = 0;
  for (const r of res.results ?? []) map[r.item_key] = r.count;
  return map;
}

/** Seed a player's boost counts from their save during the one-time save migration.
 *  Only imports when the account has NO inventory rows yet — truly seed-once, so a
 *  later sync can't inject a new boost key (e.g. a free voucher). Only catalog boost
 *  keys are seeded, each clamped to the stack ceiling. Returns the resulting
 *  authoritative inventory. The caller only reaches this for a migration-eligible
 *  account; everyone else never seeds. */
export async function seedInventory(
  db: D1Database,
  accountId: string,
  counts: Record<string, unknown>
): Promise<Record<string, number>> {
  const token = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT OR IGNORE INTO account_import_state (account_id) VALUES (?)").bind(accountId),
    db
      .prepare("UPDATE account_import_state SET inventory_seeded = 1, inventory_token = ? WHERE account_id = ? AND inventory_seeded = 0")
      .bind(token, accountId),
  ];
  for (const key of BOOST_KEYS) {
    const raw = counts?.[key];
    const n = Number.isInteger(raw) ? Math.max(0, Math.min(MAX_STACK, raw as number)) : 0;
    if (n > 0) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO inventory (account_id, item_key, count)
             SELECT ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM account_import_state
               WHERE account_id = ? AND inventory_seeded = 1 AND inventory_token = ?
             )`
          )
          .bind(accountId, key, n, accountId, token)
      );
    }
  }
  await db.batch(stmts);
  return readInventory(db, accountId);
}

/** Atomically consume one invasion voucher (raid cooldown bypass). Guarded so it only
 *  succeeds when the account actually holds one — a modified client can no longer
 *  bypass the cooldown for free. Returns true iff a voucher was consumed. */
export async function consumeVoucher(db: D1Database, accountId: string): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE inventory SET count = count - 1 WHERE account_id = ? AND item_key = ? AND count > 0"
    )
    .bind(accountId, VOUCHER_KEY)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export interface InventoryResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  /** Gift-voucher redeem only: the zombie key the server granted. */
  unitKey?: string;
}

/** Whether an inventory action id was already applied (idempotency). */
async function invActionSeen(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM inventory_actions WHERE id = ?").bind(id).first<{ x: number }>();
  return !!row;
}

/** Whether the roster already holds any unit of `key` — the gift voucher's "1 per farm". */
async function rosterHasKey(db: D1Database, accountId: string, key: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM roster WHERE account_id = ? AND key = ? LIMIT 1")
    .bind(accountId, key)
    .first<{ x: number }>();
  return !!row;
}

/** Apply a batch of inventory actions with server-authoritative rules: `buy` debits
 *  the EXACT catalog price from the balance and grants perPurchase; `use` decrements
 *  (guarded so it can't go negative), and for a GIFT voucher also grants the zombie the
 *  catalog says it redeems into. There is no public `grant` — boosts enter only through
 *  a priced buy, so a client can't mint a free boost/voucher. Idempotent by
 *  action id, atomic per action. Returns the resulting balance + full boost inventory.
 *  Reads current state per action then applies via atomic add/guarded update — same
 *  read-validate + atomic-write shape as applyEvents/applyFarmActions. */
export async function applyInventoryActions(
  db: D1Database,
  accountId: string,
  actions: InventoryAction[],
  now: number
): Promise<{
  balance: Balance;
  inventory: Record<string, number>;
  results: InventoryResult[];
  farm: Awaited<ReturnType<typeof readFarmPlots>>;
}> {
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const inv = await readInventory(db, accountId);
  const results: InventoryResult[] = [];

  for (const a of actions) {
    if (!a || typeof a.id !== "string" || !a.id) {
      results.push({ id: a?.id ?? "", status: "rejected", error: "bad_id" });
      continue;
    }
    if (await invActionSeen(db, a.id)) {
      results.push({ id: a.id, status: "duplicate" });
      continue;
    }
    const have = inv[a.key] ?? 0;

    if (a.type === "buy") {
      const econ = boostEcon(a.key);
      const plan = planBuy(a, econ, bal, have, levelForXp(bal.xp));
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO inventory_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db
          .prepare(
            "INSERT INTO inventory (account_id, item_key, count) VALUES (?, ?, ?) ON CONFLICT(account_id, item_key) DO UPDATE SET count = count + excluded.count"
          )
          .bind(accountId, a.key, plan.grant),
        db
          .prepare(`UPDATE balances SET ${plan.currency} = ${plan.currency} - ? WHERE account_id = ?`)
          .bind(plan.cost, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, 'purchase', ?)")
          .bind(`inv:${a.id}`, accountId, plan.currency, -plan.cost, now),
      ]);
      bal[plan.currency] -= plan.cost;
      inv[a.key] = have + plan.grant;
      results.push({ id: a.id, status: "applied" });
    } else if (a.type === "use" && boostEcon(a.key)?.gift) {
      // Gift-voucher redeem: consume one voucher and grant the zombie it names, in one
      // batch. The unit is a VERIFIED grant (its key comes from the catalog, and the
      // voucher was bought at full price), so it's legitimately sellable — unlike the
      // old client-only spawn, which the server never saw.
      const econ = boostEcon(a.key);
      const plan = planGiftRedeem(a, econ, have, await rosterHasKey(db, accountId, econ!.gift!));
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      // Guarded decrement first: it elects a single winner, so a concurrent double-redeem
      // can't spend one voucher for two zombies.
      const upd = await db
        .prepare("UPDATE inventory SET count = count - 1 WHERE account_id = ? AND item_key = ? AND count >= 1")
        .bind(accountId, a.key)
        .run();
      if ((upd.meta.changes ?? 0) !== 1) {
        results.push({ id: a.id, status: "rejected", error: "none_owned" });
        continue;
      }
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO inventory_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db
          .prepare("INSERT OR IGNORE INTO roster (account_id, id, key, mutation, invasions) VALUES (?, ?, ?, 0, 0)")
          .bind(accountId, plan.unitId, plan.unitKey),
      ]);
      inv[a.key] = have - 1;
      results.push({ id: a.id, status: "applied", unitKey: plan.unitKey });
    } else if (a.type === "use") {
      const plan = planUse(a, have);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      if (a.key === "insta_grow") {
        if (!Number.isInteger(a.oc) || !Number.isInteger(a.or)) {
          results.push({ id: a.id, status: "rejected", error: "bad_coord" });
          continue;
        }
        const crop = await db
          .prepare(
            "SELECT planted_at, grow_ms FROM crop_plots WHERE account_id = ? AND oc = ? AND pr = ?"
          )
          .bind(accountId, a.oc, a.or)
          .first<{ planted_at: number; grow_ms: number }>();
        if (!crop || crop.planted_at + crop.grow_ms <= now) {
          results.push({ id: a.id, status: "rejected", error: "nothing_growing" });
          continue;
        }
      }
      // Guarded decrement: only applies while the count still covers it, so concurrent
      // uses can't drive the count negative even though `have` was read above.
      const upd = await db
        .prepare("UPDATE inventory SET count = count + ? WHERE account_id = ? AND item_key = ? AND count >= ?")
        .bind(plan.delta, accountId, a.key, -plan.delta)
        .run();
      if ((upd.meta.changes ?? 0) !== 1) {
        results.push({ id: a.id, status: "rejected", error: "none_owned" });
        continue;
      }
      const applied: D1PreparedStatement[] = [
        db.prepare("INSERT OR IGNORE INTO inventory_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
      ];
      if (a.key === "insta_grow") {
        applied.push(
          db
            .prepare(
              "UPDATE crop_plots SET planted_at = ? - grow_ms WHERE account_id = ? AND oc = ? AND pr = ?"
            )
            .bind(now, accountId, a.oc, a.or)
        );
      }
      await db.batch(applied);
      inv[a.key] = have + plan.delta;
      results.push({ id: a.id, status: "applied" });
    } else {
      // No public `grant`: a loot/reward increment must come from a trusted server
      // subsystem, never a client action. Unknown types (incl. a stripped `grant`)
      // are rejected.
      results.push({ id: (a as { id: string }).id, status: "rejected", error: "bad_type" });
    }
  }
  return { balance: bal, inventory: inv, results, farm: await readFarmPlots(db, accountId) };
}

/** Delete inventory-action idempotency records older than `before` (cron cleanup).
 *  The `inventory` counts are live state and are NOT purged. */
export async function purgeOldInventoryActions(db: D1Database, before: number): Promise<number> {
  const res = await db.prepare("DELETE FROM inventory_actions WHERE created_at < ?").bind(before).run();
  return res.meta.changes ?? 0;
}

// ---- objects: server-owned placeable ownership (counts) -----------------
/** The owned count for one object key (0 if no row). */
async function objectCount(db: D1Database, accountId: string, key: string): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM object_counts WHERE account_id = ? AND object_key = ?")
    .bind(accountId, key)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** Every owned object count for an account (keys with a positive count only) — the
 *  authoritative object ownership the client reconciles against for refund eligibility. */
export async function readObjects(db: D1Database, accountId: string): Promise<Record<string, number>> {
  const res = await db
    .prepare("SELECT object_key, count FROM object_counts WHERE account_id = ? AND count > 0")
    .bind(accountId)
    .all<{ object_key: string; count: number }>();
  const map: Record<string, number> = {};
  for (const r of res.results ?? []) map[r.object_key] = r.count;
  return map;
}

/** Seed a player's object counts from their save during the one-time migration. Only
 *  imports when the account has NO object rows yet (seed-once). `counts` is the client's
 *  owned-object tally (placed + stored) per key; only real catalog keys are seeded, each
 *  clamped to a plausibility bound. The caller only reaches this for a migration-eligible
 *  account. Returns the resulting authoritative object counts. */
export async function seedObjects(
  db: D1Database,
  accountId: string,
  counts: Record<string, unknown>
): Promise<Record<string, number>> {
  const token = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT OR IGNORE INTO account_import_state (account_id) VALUES (?)").bind(accountId),
    db
      .prepare("UPDATE account_import_state SET objects_seeded = 1, objects_token = ? WHERE account_id = ? AND objects_seeded = 0")
      .bind(token, accountId),
  ];
  for (const [key, raw] of Object.entries(counts ?? {})) {
    if (!objectEcon(key)) continue; // only real catalog objects
    const n = Number.isInteger(raw) ? Math.max(0, Math.min(8192, raw as number)) : 0;
    if (n > 0) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO object_counts (account_id, object_key, count)
             SELECT ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM account_import_state
               WHERE account_id = ? AND objects_seeded = 1 AND objects_token = ?
             )`
          )
          .bind(accountId, key, n, accountId, token)
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return readObjects(db, accountId);
}

export interface ObjectResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
}

async function objectActionSeen(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM object_actions WHERE id = ?").bind(id).first<{ x: number }>();
  return !!row;
}

/** Apply a batch of object actions with server authority: `buy` debits the EXACT catalog
 *  cost + grants buyXp (which may trigger a level-up) + count++; `refund` credits
 *  floor(cost*0.2) in the buy currency + guarded count-- (can't refund what you don't own).
 *  Idempotent by action id, atomic per action. Returns the resulting balance + object
 *  counts + per-action verdicts. */
export async function applyObjectActions(
  db: D1Database,
  accountId: string,
  actions: ObjectAction[],
  now: number
): Promise<{ balance: Balance; objects: Record<string, number>; results: ObjectResult[] }> {
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const results: ObjectResult[] = [];

  for (const a of actions) {
    if (!a || typeof a.id !== "string" || !a.id) {
      results.push({ id: a?.id ?? "", status: "rejected", error: "bad_id" });
      continue;
    }
    if (await objectActionSeen(db, a.id)) {
      results.push({ id: a.id, status: "duplicate" });
      continue;
    }
    if (a.type === "upgrade") {
      // In-place swap (the shed upgrade): pay the new object's full price and give up
      // the old one. Done as one guarded decrement + one batch so a client can't get the
      // new object without losing the old one, or vice versa.
      const plan = planObjectUpgrade(
        objectEcon(a.fromKey),
        objectEcon(a.toKey),
        bal,
        await objectCount(db, accountId, a.fromKey),
        await objectCount(db, accountId, a.toKey),
        levelForXp(bal.xp)
      );
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      // Only a PRICED `from` has a server count to spend; a free one (the starter shed)
      // was never tracked, so there's nothing to decrement — see planObjectUpgrade.
      if (plan.consumesFrom) {
        const upd = await db
          .prepare("UPDATE object_counts SET count = count - 1 WHERE account_id = ? AND object_key = ? AND count >= 1")
          .bind(accountId, a.fromKey)
          .run();
        if ((upd.meta.changes ?? 0) !== 1) {
          results.push({ id: a.id, status: "rejected", error: "none_owned" });
          continue;
        }
      }
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO object_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db
          .prepare(
            "INSERT INTO object_counts (account_id, object_key, count) VALUES (?, ?, 1) ON CONFLICT(account_id, object_key) DO UPDATE SET count = count + 1"
          )
          .bind(accountId, a.toKey),
        db
          .prepare(`UPDATE balances SET ${plan.currency} = ${plan.currency} - ?, xp = xp + ? WHERE account_id = ?`)
          .bind(plan.cost, plan.xp, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, 'upgrade', ?)")
          .bind(`obj:${a.id}`, accountId, plan.currency, -plan.cost, now),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'xp', ?, 'upgrade', ?)")
          .bind(`obj:${a.id}#x`, accountId, plan.xp, now),
      ]);
      bal[plan.currency] -= plan.cost;
      bal.xp += plan.xp;
      bal.brains += await creditLevelUps(db, accountId, now); // upgrade xp may cross a level
      results.push({ id: a.id, status: "applied" });
      continue;
    }

    const econ = objectEcon(a.key);
    const have = await objectCount(db, accountId, a.key);

    if (a.type === "buy") {
      const plan = planObjectBuy(econ, bal, have, levelForXp(bal.xp));
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO object_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db
          .prepare(
            "INSERT INTO object_counts (account_id, object_key, count) VALUES (?, ?, 1) ON CONFLICT(account_id, object_key) DO UPDATE SET count = count + 1"
          )
          .bind(accountId, a.key),
        db
          .prepare(`UPDATE balances SET ${plan.currency} = ${plan.currency} - ?, xp = xp + ? WHERE account_id = ?`)
          .bind(plan.cost, plan.xp, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, 'purchase', ?)")
          .bind(`obj:${a.id}`, accountId, plan.currency, -plan.cost, now),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'xp', ?, 'purchase', ?)")
          .bind(`obj:${a.id}#x`, accountId, plan.xp, now),
      ]);
      bal[plan.currency] -= plan.cost;
      bal.xp += plan.xp;
      bal.brains += await creditLevelUps(db, accountId, now); // buy xp may cross a level
      results.push({ id: a.id, status: "applied" });
    } else if (a.type === "refund") {
      const plan = planObjectRefund(econ, have);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      // Guarded decrement: only the caller that actually removes a unit credits the
      // refund, so concurrent refunds of the last one can't double-pay.
      const upd = await db
        .prepare("UPDATE object_counts SET count = count - 1 WHERE account_id = ? AND object_key = ? AND count >= 1")
        .bind(accountId, a.key)
        .run();
      if ((upd.meta.changes ?? 0) !== 1) {
        results.push({ id: a.id, status: "rejected", error: "none_owned" });
        continue;
      }
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO object_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db.prepare(`UPDATE balances SET ${plan.currency} = ${plan.currency} + ? WHERE account_id = ?`).bind(plan.refund, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, 'refund', ?)")
          .bind(`obj:${a.id}`, accountId, plan.currency, plan.refund, now),
      ]);
      bal[plan.currency] += plan.refund;
      results.push({ id: a.id, status: "applied" });
    } else {
      results.push({ id: (a as { id: string }).id, status: "rejected", error: "bad_type" });
    }
  }
  return { balance: bal, objects: await readObjects(db, accountId), results };
}

/** Delete object-action idempotency records older than `before` (cron cleanup). The
 *  `object_counts` are live state and are NOT purged. */
export async function purgeOldObjectActions(db: D1Database, before: number): Promise<number> {
  const res = await db.prepare("DELETE FROM object_actions WHERE created_at < ?").bind(before).run();
  return res.meta.changes ?? 0;
}

// ---- roster: server-owned zombie units (validation + money shadow) ------
interface RosterRow {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
  /** DEV_AUTH fixture hint; legacy roster reads do not populate this field. */
  stored?: boolean;
}

export async function readRosterState(db: D1Database, accountId: string): Promise<RosterRow[]> {
  const rows = await db
    .prepare("SELECT id, key, mutation, invasions FROM roster WHERE account_id = ? ORDER BY id")
    .bind(accountId)
    .all<RosterRow>();
  return rows.results ?? [];
}

export async function readFarmPlots(
  db: D1Database,
  accountId: string
): Promise<{
  plowed: { oc: number; pr: number }[];
  crops: CropPlotRow[];
}> {
  const plowed = await readPlowedSoil(db, accountId);
  const crops = await db
    .prepare(
      "SELECT oc, pr, crop_key, planted_at, grow_ms, sell, xp, fertilized FROM crop_plots WHERE account_id = ? ORDER BY oc, pr"
    )
    .bind(accountId)
    .all<CropPlotRow>();
  return { plowed, crops: crops.results ?? [] };
}

/** Seed a player's roster from their save's owned zombies during the one-time save
 *  migration. Only imports when the roster is currently EMPTY — this makes it truly
 *  seed-once and closes the re-injection hole where repeated /roster/sync with fresh
 *  unit ids kept adding (then sell-able) units. Only real catalog units with a
 *  non-empty id are imported, with bounded mutation/invasions. Returns the account's
 *  row count afterward. The caller (the /roster/sync handler) only reaches this for a
 *  migration-eligible account; everyone else never seeds. */
export async function seedRoster(
  db: D1Database,
  accountId: string,
  units: unknown
): Promise<number> {
  const count = async (): Promise<number> => {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM roster WHERE account_id = ?")
      .bind(accountId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  };
  const token = crypto.randomUUID();
  const list = Array.isArray(units) ? units : [];
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT OR IGNORE INTO account_import_state (account_id) VALUES (?)").bind(accountId),
    db
      .prepare("UPDATE account_import_state SET roster_seeded = 1, roster_token = ? WHERE account_id = ? AND roster_seeded = 0")
      .bind(token, accountId),
  ];
  for (const u of list) {
    const g = validateUnit((u as RosterRow)?.id, (u as RosterRow)?.key, (u as RosterRow)?.mutation, (u as RosterRow)?.invasions);
    if (!g.ok) continue;
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO roster (account_id, id, key, mutation, invasions)
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM account_import_state
             WHERE account_id = ? AND roster_seeded = 1 AND roster_token = ?
           )`
        )
        .bind(accountId, g.unitId, g.key, g.mutation, g.invasions, accountId, token)
    );
  }
  await db.batch(stmts);
  return count();
}

/** Integration-test fixture: insert catalog-valid units as authoritative roster
 *  state. The only caller is the DEV_AUTH-gated /dev/fixture/roster route; normal
 *  clients must earn units through trusted gameplay actions. */
export async function grantRosterFixture(
  db: D1Database,
  accountId: string,
  units: unknown
): Promise<number> {
  const list = Array.isArray(units) ? units : [];
  const stmts: D1PreparedStatement[] = [];
  for (const u of list) {
    const row = u as RosterRow;
    const g = validateUnit(row?.id, row?.key, row?.mutation, row?.invasions);
    if (!g.ok) continue;
    stmts.push(db.prepare(
      "INSERT OR IGNORE INTO roster (account_id, id, key, mutation, invasions) VALUES (?, ?, ?, ?, ?)"
    ).bind(accountId, g.unitId, g.key, g.mutation, g.invasions));
    stmts.push(db.prepare(`INSERT OR IGNORE INTO roster_v3
      (account_id,unit_id,zombie_key,mutation,invasions,stored,created_at)
      VALUES(?,?,?,?,?,?,?)`).bind(accountId, g.unitId, g.key, g.mutation, g.invasions,
        row.stored === false ? 0 : 1, Date.now()));
  }
  if (stmts.length) await db.batch(stmts);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM roster_v3 WHERE account_id = ?")
    .bind(accountId).first<{ n: number }>();
  return count?.n ?? 0;
}

/** Whether a roster action id was already applied (idempotency). */
async function rosterActionSeen(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM roster_actions WHERE id = ?").bind(id).first<{ x: number }>();
  return !!row;
}

export interface RosterResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  gold?: number; // sell payout
  subject?: string;
  combinedSubject?: string;
}

/** Apply a batch of roster actions with server authority:
 *   • sell     — price floor(cost/2) from the catalog, remove the unit, credit gold
 *                (a unit the server doesn't own — e.g. one never granted by a trusted
 *                source — is rejected → no gold, which kills grant→sell laundering);
 *   • veteran  — bump invasions for surviving units;
 *   • casualty — remove dead units;
 *   • combineStart/combineCollect — the Zombie Pot, the one server-validated way to
 *                create a unit (result must be one of the two consumed parent keys).
 *  There is no public `grant`. Idempotent by action id, atomic per action. Returns the
 *  resulting balance + per-action verdicts. */
export async function applyRosterActions(
  db: D1Database,
  accountId: string,
  actions: RosterAction[],
  now: number
): Promise<{ balance: Balance; results: RosterResult[] }> {
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const results: RosterResult[] = [];

  for (const a of actions) {
    if (!a || typeof a.id !== "string" || !a.id) {
      results.push({ id: a?.id ?? "", status: "rejected", error: "bad_id" });
      continue;
    }
    if (await rosterActionSeen(db, a.id)) {
      results.push({ id: a.id, status: "duplicate" });
      continue;
    }

    if (a.type === "sell") {
      const unit = await db
        .prepare("SELECT key FROM roster WHERE account_id = ? AND id = ?")
        .bind(accountId, a.unitId)
        .first<{ key: string }>();
      if (!unit) {
        results.push({ id: a.id, status: "rejected", error: "no_unit" });
        continue;
      }
      // Guarded delete: only the caller that actually removes the row credits gold, so
      // concurrent sells of one unit can't double-pay.
      const del = await db
        .prepare(
          `DELETE FROM roster WHERE account_id = ? AND id = ? AND NOT EXISTS (
             SELECT 1 FROM raid_roster_locks WHERE account_id = ? AND unit_id = ?
           )`
        )
        .bind(accountId, a.unitId, accountId, a.unitId)
        .run();
      if ((del.meta.changes ?? 0) !== 1) {
        results.push({ id: a.id, status: "rejected", error: "no_unit" });
        continue;
      }
      const gold = zombieSell(unit.key);
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO roster_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db.prepare("UPDATE balances SET gold = gold + ? WHERE account_id = ?").bind(gold, accountId),
        db
          .prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'gold', ?, 'sell', ?)")
          .bind(`roster:${a.id}`, accountId, gold, now),
      ]);
      bal.gold += gold;
      results.push({ id: a.id, status: "applied", gold });
    } else if (a.type === "veteran" || a.type === "casualty") {
      results.push({ id: a.id, status: "rejected", error: "server_only_raid_result" });
    } else if (a.type === "combineStart") {
      // Consume both parents (must own both, and not already be combining), recording
      // their keys so the result can be validated at collect.
      const busy = await db.prepare("SELECT 1 AS x FROM combine_jobs WHERE account_id = ?").bind(accountId).first<{ x: number }>();
      if (busy) {
        results.push({ id: a.id, status: "rejected", error: "busy" });
        continue;
      }
      const pa = await db
        .prepare(
          `SELECT key FROM roster WHERE account_id = ? AND id = ? AND NOT EXISTS (
             SELECT 1 FROM raid_roster_locks WHERE account_id = ? AND unit_id = ?
           )`
        )
        .bind(accountId, a.parentAId, accountId, a.parentAId)
        .first<{ key: string }>();
      const pb = await db
        .prepare(
          `SELECT key FROM roster WHERE account_id = ? AND id = ? AND NOT EXISTS (
             SELECT 1 FROM raid_roster_locks WHERE account_id = ? AND unit_id = ?
           )`
        )
        .bind(accountId, a.parentBId, accountId, a.parentBId)
        .first<{ key: string }>();
      if (!pa || !pb || a.parentAId === a.parentBId) {
        results.push({ id: a.id, status: "rejected", error: "bad_parent" });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO roster_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db.prepare("DELETE FROM roster WHERE account_id = ? AND id IN (?, ?)").bind(accountId, a.parentAId, a.parentBId),
        db.prepare("INSERT INTO combine_jobs (account_id, key_a, key_b, started_at) VALUES (?, ?, ?, ?)").bind(accountId, pa.key, pb.key, now),
      ]);
      results.push({
        id: a.id,
        status: "applied",
        subject: [namedCatalogKey(zombieCatalogData, pa.key), namedCatalogKey(zombieCatalogData, pb.key)]
          .filter(Boolean)
          .sort()
          .join(" "),
      });
    } else if (a.type === "combineCollect") {
      const job = await db
        .prepare("SELECT key_a, key_b FROM combine_jobs WHERE account_id = ?")
        .bind(accountId)
        .first<{ key_a: string; key_b: string }>();
      if (!job) {
        results.push({ id: a.id, status: "rejected", error: "no_job" });
        continue;
      }
      // The result species is always one of the two parents (the pot merges masks, it
      // never invents a new species) — so a granted result that isn't a parent key is a
      // fabrication and is rejected (the job is still cleared so the client isn't stuck).
      const validKey = (a.key === job.key_a || a.key === job.key_b) && isKnownZombie(a.key);
      const mutation = Number.isInteger(a.mutation) && a.mutation! >= 0 ? Math.min(MAX_MUTATION, a.mutation!) : 0;
      const stmts: D1PreparedStatement[] = [
        db.prepare("INSERT INTO roster_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db.prepare("DELETE FROM combine_jobs WHERE account_id = ?").bind(accountId),
      ];
      if (validKey && typeof a.unitId === "string" && a.unitId) {
        stmts.push(
          db
            .prepare("INSERT OR IGNORE INTO roster (account_id, id, key, mutation, invasions) VALUES (?, ?, ?, ?, 0)")
            .bind(accountId, a.unitId, a.key, mutation)
        );
      }
      await db.batch(stmts);
      results.push({
        id: a.id,
        status: validKey ? "applied" : "rejected",
        error: validKey ? undefined : "bad_result",
        subject: validKey ? namedCatalogKey(zombieCatalogData, a.key) : undefined,
        combinedSubject: validKey
          ? [namedCatalogKey(zombieCatalogData, job.key_a), namedCatalogKey(zombieCatalogData, job.key_b)]
            .filter(Boolean).sort().join(" ")
          : undefined,
      });
    } else {
      results.push({ id: (a as { id: string }).id, status: "rejected", error: "bad_type" });
    }
  }
  return { balance: bal, results };
}

/** Delete roster-action idempotency records older than `before` (cron cleanup). The
 *  `roster` rows are live state and are NOT purged. */
export async function purgeOldRosterActions(db: D1Database, before: number): Promise<number> {
  const res = await db.prepare("DELETE FROM roster_actions WHERE created_at < ?").bind(before).run();
  return res.meta.changes ?? 0;
}

/** Command idempotency survives longer than the maximum client outbox lifetime. */
export async function purgeOldCommandReceipts(db: D1Database, before: number): Promise<number> {
  const res = await db.prepare("DELETE FROM command_receipts WHERE created_at < ?").bind(before).run();
  return res.meta.changes ?? 0;
}

/** Trusted events are retained for investigation, then removed after their application
 * rows so foreign-key enforcement cannot strand old processed events. */
export async function purgeOldGameEvents(db: D1Database, before: number): Promise<number> {
  await db
    .prepare("DELETE FROM quest_event_applications WHERE event_id IN (SELECT id FROM game_events WHERE processed_at IS NOT NULL AND processed_at < ?)")
    .bind(before)
    .run();
  const res = await db
    .prepare("DELETE FROM game_events WHERE processed_at IS NOT NULL AND processed_at < ?")
    .bind(before)
    .run();
  return res.meta.changes ?? 0;
}

/** Delete abandoned combine jobs (started but never collected) older than `before`,
 *  so a crashed combine doesn't block the account's pot forever. */
export async function purgeOldCombineJobs(db: D1Database, before: number): Promise<number> {
  const res = await db.prepare("DELETE FROM combine_jobs WHERE started_at < ?").bind(before).run();
  return res.meta.changes ?? 0;
}

// ---- shop: server-owned farm size + climate skins -----------------------
export interface ShopState {
  size: number;
  climates: string[];
}

/** The account's server-owned farm size + climate set, seeding both ONCE from the
 *  save (so an existing player keeps their real size/skins). `seedSize` is clamped to
 *  a valid tier; unknown seed climates are ignored.
 *
 *  Seeding happens on FIRST initialization only (no farm_state row yet). After that
 *  the seed inputs are ignored and we just read the authoritative state. This is
 *  load-bearing for the climate set: `INSERT OR IGNORE` per terrain is NOT seed-once on
 *  its own (a multi-row set), so without the first-init gate a modified client could
 *  re-POST /shop/state with climates it never bought and have them granted for free,
 *  bypassing /shop/climate entirely. The size scalar was already seed-once (single-row
 *  PK), but is gated here too for one clear rule. The one-time trust of the migrating
 *  client's declared state is the same accepted seed-from-save boundary as balance /
 *  roster / boosts. */
export async function getOrSeedShopState(
  db: D1Database,
  accountId: string,
  seedSize: number,
  seedClimates: unknown
): Promise<ShopState> {
  const token = crypto.randomUUID();
  const size = Number.isInteger(seedSize) && (sizeTier(seedSize) || seedSize === BASE_FARM_SIZE) ? seedSize : BASE_FARM_SIZE;
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT OR IGNORE INTO account_import_state (account_id) VALUES (?)").bind(accountId),
    db
      .prepare("UPDATE account_import_state SET shop_seeded = 1, shop_token = ? WHERE account_id = ? AND shop_seeded = 0")
      .bind(token, accountId),
    db
      .prepare(
        `INSERT OR IGNORE INTO farm_state (account_id, size)
         SELECT ?, ? WHERE EXISTS (
           SELECT 1 FROM account_import_state
           WHERE account_id = ? AND shop_seeded = 1 AND shop_token = ?
         )`
      )
      .bind(accountId, size, accountId, token),
    // Permanently closed imports never receive the token above, but a new account
    // still needs a real authoritative row before it can buy its first size upgrade.
    db
      .prepare("INSERT OR IGNORE INTO farm_state (account_id, size) VALUES (?, ?)")
      .bind(accountId, BASE_FARM_SIZE),
  ];
  if (Array.isArray(seedClimates)) {
    for (const t of seedClimates) {
      if (typeof t === "string" && t !== "grass" && climateCost(t) !== undefined) {
        stmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO owned_climates (account_id, terrain)
               SELECT ?, ? WHERE EXISTS (
                 SELECT 1 FROM account_import_state
                 WHERE account_id = ? AND shop_seeded = 1 AND shop_token = ?
               )`
            )
            .bind(accountId, t, accountId, token)
        );
      }
    }
  }
  await db.batch(stmts);
  return readShopState(db, accountId);
}

/** The account's current server-owned farm size + climate set. */
export async function readShopState(db: D1Database, accountId: string): Promise<ShopState> {
  const sizeRow = await db.prepare("SELECT size FROM farm_state WHERE account_id = ?").bind(accountId).first<{ size: number }>();
  const clim = await db.prepare("SELECT terrain FROM owned_climates WHERE account_id = ?").bind(accountId).all<{ terrain: string }>();
  return { size: sizeRow?.size ?? BASE_FARM_SIZE, climates: (clim.results ?? []).map((r) => r.terrain) };
}

export interface ShopResult {
  ok: boolean;
  error?: string;
  balance: Balance;
  size: number;
  climates: string[];
}

/** Buy the NEXT farm-size tier (sequential; only the immediate next size is valid) for
 *  the exact tier price in the chosen currency. Naturally idempotent: a retry after the
 *  size already advanced fails the "is it the next tier" check and just echoes state. */
export async function buySize(
  db: D1Database,
  accountId: string,
  actionId: string,
  targetSize: number,
  currency: "gold" | "brains",
  now: number
): Promise<ShopResult> {
  const state = await readShopState(db, accountId);
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const fail = (error: string): ShopResult => ({ ok: false, error, balance: bal, size: state.size, climates: state.climates });

  if (targetSize !== nextSize(state.size)) return fail("bad_size");
  const tier = sizeTier(targetSize);
  if (!tier) return fail("bad_size");
  const cost = currency === "brains" ? tier.brains : tier.gold;
  if (bal[currency] < cost) return fail("insufficient");

  const token = crypto.randomUUID();
  const kind = "shop_size";
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO command_receipts
           (account_id, command_kind, action_id, attempt_token, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM farm_state f JOIN balances b ON b.account_id = f.account_id
           WHERE f.account_id = ? AND f.size = ? AND b.${currency} >= ?
         )`
      )
      .bind(accountId, kind, actionId, token, now, accountId, state.size, cost),
    db
      .prepare(
        `UPDATE balances SET ${currency} = ${currency} - ? WHERE account_id = ? AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(cost, accountId, accountId, kind, actionId, token),
    db
      .prepare(
        `UPDATE farm_state SET size = ? WHERE account_id = ? AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(targetSize, accountId, accountId, kind, actionId, token),
    db
      .prepare(
        `INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at)
         SELECT ?, ?, ?, ?, 'upgrade', ? WHERE EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(`size:${accountId}:${actionId}`, accountId, currency, -cost, now, accountId, kind, actionId, token),
  ]);
  const applied = await db
    .prepare(
      "SELECT 1 AS x FROM command_receipts WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?"
    )
    .bind(accountId, kind, actionId, token)
    .first<{ x: number }>();
  const fresh = await readShopState(db, accountId);
  return { ok: !!applied, error: applied ? undefined : "duplicate_or_conflict", balance: await getOrSeedBalance(db, accountId, bal), ...fresh };
}

/** Buy a ground/climate skin for its exact price (gold). Naturally idempotent: a retry
 *  after it's already owned fails the "not owned" check and just echoes state. */
export async function buyClimate(db: D1Database, accountId: string, actionId: string, terrain: string, now: number): Promise<ShopResult> {
  const state = await readShopState(db, accountId);
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const fail = (error: string): ShopResult => ({ ok: false, error, balance: bal, size: state.size, climates: state.climates });

  const cost = climateCost(terrain);
  if (cost === undefined || terrain === "grass") return fail("bad_climate");
  if (state.climates.includes(terrain)) return fail("owned");
  if (bal.gold < cost) return fail("insufficient");

  const token = crypto.randomUUID();
  const kind = "shop_climate";
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO command_receipts
           (account_id, command_kind, action_id, attempt_token, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM balances WHERE account_id = ? AND gold >= ?
         ) AND NOT EXISTS (
           SELECT 1 FROM owned_climates WHERE account_id = ? AND terrain = ?
         )`
      )
      .bind(accountId, kind, actionId, token, now, accountId, cost, accountId, terrain),
    db
      .prepare(
        `UPDATE balances SET gold = gold - ? WHERE account_id = ? AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(cost, accountId, accountId, kind, actionId, token),
    db
      .prepare(
        `INSERT OR IGNORE INTO owned_climates (account_id, terrain)
         SELECT ?, ? WHERE EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(accountId, terrain, accountId, kind, actionId, token),
    db
      .prepare(
        `INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at)
         SELECT ?, ?, 'gold', ?, 'upgrade', ? WHERE EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(`clim:${accountId}:${actionId}`, accountId, -cost, now, accountId, kind, actionId, token),
  ]);
  const applied = await db
    .prepare(
      "SELECT 1 AS x FROM command_receipts WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?"
    )
    .bind(accountId, kind, actionId, token)
    .first<{ x: number }>();
  const fresh = await readShopState(db, accountId);
  return { ok: !!applied, error: applied ? undefined : "duplicate_or_conflict", balance: await getOrSeedBalance(db, accountId, bal), ...fresh };
}

// ---- raids (server-owned cooldown + one-use sessions) -------------------
/** Epoch ms the account last finished a raid (0 if never / no row). Drives the
 *  server-owned between-raids cooldown. */
export async function raidLastAt(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare("SELECT last_raid_at FROM raid_state WHERE account_id = ?")
    .bind(accountId)
    .first<{ last_raid_at: number }>();
  return row?.last_raid_at ?? 0;
}

/** Open a one-use raid session after the cooldown gate has passed, pinning the raid
 *  being fought so /raid/finish can price the reward from the server catalog. */
export async function openRaidSession(
  db: D1Database,
  id: string,
  accountId: string,
  raidId: number,
  startedAt: number,
  expiresAt: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO raid_sessions (id, account_id, raid_id, started_at, expires_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(id, accountId, raidId, startedAt, expiresAt)
    .run();
}

/** Open a raid session ONLY IF the account has no live one — one open raid at a time.
 *  Returns false if a raid is already in progress.
 *
 *  Needed because the cooldown clock only advances at FINISH: without a reserve, a client
 *  could open many sessions in the pre-first-finish window and bank the ids to settle
 *  later. (The cooldown itself is not a bound — skipping it with a voucher is intended
 *  play — so this reserve is what makes "one raid at a time" true.)
 *
 *  Two steps, in this order:
 *
 *  1. REAP. An abandoned session (browser closed mid-raid) is never finished, so it would
 *     hold the account's only slot until the cron purge — a lockout of up to a day. Once
 *     past its TTL it can never be settled (settleRaid refuses it), so it is closed out
 *     here, stamped with the moment it actually expired rather than `now`.
 *  2. RESERVE. `INSERT ... WHERE NOT EXISTS` is a single statement, so the check and the
 *     write can't be split by a concurrent start. `idx_raid_sessions_live` (partial
 *     UNIQUE on unfinished sessions) is the backstop; the reap above is what keeps that
 *     invariant — "at most one UNFINISHED session" — true rather than merely aspirational. */
export async function openRaidSessionOnce(
  db: D1Database,
  id: string,
  accountId: string,
  raidId: number,
  startedAt: number,
  expiresAt: number,
  dice = 0
): Promise<boolean> {
  await db
    .prepare(
      `UPDATE raid_sessions SET finished_at = expires_at
       WHERE account_id = ? AND finished_at IS NULL AND expires_at <= ?`
    )
    .bind(accountId, startedAt)
    .run();
  try {
    const res = await db
      .prepare(
        `INSERT INTO raid_sessions (id, account_id, raid_id, started_at, expires_at, dice)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM raid_sessions WHERE account_id = ? AND finished_at IS NULL
         )`
      )
      .bind(id, accountId, raidId, startedAt, expiresAt, dice, accountId)
      .run();
    return (res.meta.changes ?? 0) === 1;
  } catch {
    // The partial unique index rejected a concurrent reserve.
    return false;
  }
}

/** Atomically reserve a verified v2 raid, consume every requested consumable, and
 * lock the pinned roster. The session insert is the nonce all side effects depend on. */
export async function openVerifiedRaidSession(
  db: D1Database,
  args: {
    id: string;
    accountId: string;
    raidId: number;
    rosterIds: string[];
    configJson: string;
    rulesetVersion: number;
    rngSeed: string;
    useVoucher: boolean;
    concentration: boolean;
    dice: number;
    startedAt: number;
    expiresAt: number;
  }
): Promise<boolean> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM raid_roster_locks WHERE account_id = ? AND session_id IN (
           SELECT id FROM raid_sessions WHERE account_id = ? AND finished_at IS NULL AND expires_at <= ?
         )`
      )
      .bind(args.accountId, args.accountId, args.startedAt),
    db
      .prepare(
        "UPDATE raid_sessions SET finished_at = expires_at, invalid_reason = 'expired' WHERE account_id = ? AND finished_at IS NULL AND expires_at <= ?"
      )
      .bind(args.accountId, args.startedAt),
  ]);
  const dice = Number.isInteger(args.dice) ? Math.max(0, Math.min(MAX_STACK, args.dice)) : 0;
  const ids = [...new Set(args.rosterIds)];
  if (!ids.length || ids.length !== args.rosterIds.length) return false;
  const ph = ids.map(() => "?").join(",");
  const prereq = `
    NOT EXISTS (SELECT 1 FROM raid_sessions WHERE account_id = ? AND finished_at IS NULL)
    AND (SELECT COUNT(*) FROM roster WHERE account_id = ? AND id IN (${ph})) = ?
    AND NOT EXISTS (SELECT 1 FROM raid_roster_locks WHERE account_id = ? AND unit_id IN (${ph}))
    AND (? = 0 OR COALESCE((SELECT count FROM inventory WHERE account_id = ? AND item_key = ?), 0) >= 1)
    AND (? = 0 OR COALESCE((SELECT count FROM inventory WHERE account_id = ? AND item_key = ?), 0) >= 1)
    AND (? = 0 OR COALESCE((SELECT count FROM inventory WHERE account_id = ? AND item_key = ?), 0) >= ?)`;
  const prereqBindings = [
    args.accountId,
    args.accountId,
    ...ids,
    ids.length,
    args.accountId,
    ...ids,
    args.useVoucher ? 1 : 0,
    args.accountId,
    VOUCHER_KEY,
    args.concentration ? 1 : 0,
    args.accountId,
    CONCENTRATION_KEY,
    dice,
    args.accountId,
    DICE_KEY,
    dice,
  ];
  const sessionExists = "EXISTS (SELECT 1 FROM raid_sessions WHERE id = ? AND account_id = ? AND finished_at IS NULL)";
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO raid_sessions
           (id, account_id, raid_id, started_at, expires_at, dice, ruleset_version, rng_seed, config_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${prereq}`
      )
      .bind(
        args.id,
        args.accountId,
        args.raidId,
        args.startedAt,
        args.expiresAt,
        dice,
        args.rulesetVersion,
        args.rngSeed,
        args.configJson,
        ...prereqBindings
      ),
  ];
  if (args.useVoucher) {
    statements.push(
      db
        .prepare(`UPDATE inventory SET count = count - 1 WHERE account_id = ? AND item_key = ? AND ${sessionExists}`)
        .bind(args.accountId, VOUCHER_KEY, args.id, args.accountId)
    );
  }
  if (args.concentration) {
    statements.push(
      db
        .prepare(`UPDATE inventory SET count = count - 1 WHERE account_id = ? AND item_key = ? AND ${sessionExists}`)
        .bind(args.accountId, CONCENTRATION_KEY, args.id, args.accountId)
    );
  }
  if (dice > 0) {
    statements.push(
      db
        .prepare(`UPDATE inventory SET count = count - ? WHERE account_id = ? AND item_key = ? AND ${sessionExists}`)
        .bind(dice, args.accountId, DICE_KEY, args.id, args.accountId)
    );
  }
  for (let position = 0; position < ids.length; position++) {
    const unitId = ids[position];
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO raid_roster_locks
             (account_id, unit_id, session_id, position, snapshot)
           SELECT ?, ?, ?, ?, ? WHERE ${sessionExists}`
        )
        .bind(args.accountId, unitId, args.id, position, args.configJson, args.id, args.accountId)
    );
  }
  try {
    await db.batch(statements);
  } catch {
    return false;
  }
  const row = await db
    .prepare("SELECT 1 AS x FROM raid_sessions WHERE id = ? AND account_id = ? AND finished_at IS NULL")
    .bind(args.id, args.accountId)
    .first<{ x: number }>();
  return !!row;
}

export interface RaidCheckpointRow {
  last_seq: number;
  last_tick: number;
  input_bytes: number;
  state_json: string;
}

export async function readRaidCheckpoint(db: D1Database, sessionId: string, accountId: string): Promise<RaidCheckpointRow | null> {
  return db
    .prepare("SELECT last_seq, last_tick, input_bytes, state_json FROM raid_checkpoints WHERE session_id = ? AND account_id = ?")
    .bind(sessionId, accountId)
    .first<RaidCheckpointRow>();
}

/** CAS the verifier snapshot so duplicate/concurrent checkpoint submissions cannot
 * move the authoritative replay cursor twice. */
export async function storeRaidCheckpoint(
  db: D1Database,
  sessionId: string,
  accountId: string,
  expectedTick: number,
  lastTick: number,
  lastSeq: number,
  inputBytes: number,
  stateJson: string,
  now: number
): Promise<boolean> {
  if (expectedTick === 0) {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO raid_checkpoints
           (session_id, account_id, last_seq, last_tick, input_bytes, state_json, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM raid_sessions WHERE id = ? AND account_id = ? AND finished_at IS NULL
         )`
      )
      .bind(sessionId, accountId, lastSeq, lastTick, inputBytes, stateJson, now, sessionId, accountId)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }
  const res = await db
    .prepare(
      `UPDATE raid_checkpoints SET last_seq = ?, last_tick = ?, input_bytes = ?, state_json = ?, updated_at = ?
       WHERE session_id = ? AND account_id = ? AND last_tick = ?`
    )
    .bind(lastSeq, lastTick, inputBytes, stateJson, now, sessionId, accountId, expectedTick)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/** Consume up to `want` Golden Dice for a raid's loot luck, returning how many were
 *  actually spent. Guarded so it can't drive the count negative, and capped by what's
 *  held — a client asking for more dice than it owns simply gets fewer, and the SESSION
 *  records the real number, so the loot roll's luck can't be inflated. */
export async function consumeDice(db: D1Database, accountId: string, want: number): Promise<number> {
  const n = Number.isInteger(want) ? Math.max(0, Math.min(MAX_STACK, want)) : 0;
  if (n <= 0) return 0;
  const res = await db
    .prepare("UPDATE inventory SET count = count - ? WHERE account_id = ? AND item_key = ? AND count >= ?")
    .bind(n, accountId, DICE_KEY, n)
    .run();
  if ((res.meta.changes ?? 0) === 1) return n;
  // Not enough for the full ask — spend everything held instead of failing the launch.
  const row = await db
    .prepare("SELECT count FROM inventory WHERE account_id = ? AND item_key = ?")
    .bind(accountId, DICE_KEY)
    .first<{ count: number }>();
  const have = Math.max(0, row?.count ?? 0);
  if (have <= 0) return 0;
  const upd = await db
    .prepare("UPDATE inventory SET count = count - ? WHERE account_id = ? AND item_key = ? AND count >= ?")
    .bind(have, accountId, DICE_KEY, have)
    .run();
  return (upd.meta.changes ?? 0) === 1 ? have : 0;
}

/** Pin the dice actually spent onto an open session (see consumeDice). */
export async function setSessionDice(db: D1Database, sessionId: string, dice: number): Promise<void> {
  await db.prepare("UPDATE raid_sessions SET dice = ? WHERE id = ?").bind(dice, sessionId).run();
}

/** Give back a voucher consumed for a bypass that then failed to open a session, so a
 *  lost race can't silently eat a 2000-gold ticket. Not a public action — only the
 *  start handler calls it, immediately after its own consumeVoucher. */
export async function refundVoucher(db: D1Database, accountId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO inventory (account_id, item_key, count) VALUES (?, ?, 1)
       ON CONFLICT(account_id, item_key) DO UPDATE SET count = count + 1`
    )
    .bind(accountId, VOUCHER_KEY)
    .run();
}

// ---- item storage: the Received bucket + the shed -----------------------
export type StorageBucket = "received" | "stored";
export interface StorageState {
  received: Record<string, number>;
  stored: Record<string, number>;
}

/** The account's server-owned item collections. */
export async function readStorage(db: D1Database, accountId: string): Promise<StorageState> {
  const res = await db
    .prepare("SELECT bucket, item_key, count FROM item_storage WHERE account_id = ? AND count > 0")
    .bind(accountId)
    .all<{ bucket: string; item_key: string; count: number }>();
  const out: StorageState = { received: {}, stored: {} };
  for (const r of res.results ?? []) {
    if (r.bucket === "received") out.received[r.item_key] = r.count;
    else if (r.bucket === "stored") out.stored[r.item_key] = r.count;
  }
  return out;
}

/** How many of a loot item the account owns, for the roll's unique/limit filters.
 *
 *  Counts unclaimed loot + the shed, mirroring the client's ownedCount. It ALSO counts a
 *  placed copy via the item's linked placeable (drops.json `tile`) in the server-owned
 *  object counts — which the client can't do, and whose absence it calls out as "a minor
 *  divergence from the source's full ownership check". So a unique you've already placed
 *  won't drop again: closer to the original than the client is. The server owns the roll,
 *  so the two can't disagree in a way the player sees. */
export async function ownedLootCount(db: D1Database, accountId: string, name: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM item_storage WHERE account_id = ? AND item_key = ?")
    .bind(accountId, name)
    .first<{ n: number }>();
  let n = row?.n ?? 0;
  const tile = dropEcon(name)?.tile;
  if (tile) n += await objectCount(db, accountId, tile);
  return n;
}

/** Add `n` of an item to a bucket (n may be negative; the count floors at 0 via the
 *  guarded update in takeStored/claimReceived, so this is only ever called to ADD). */
function addStorageStmt(db: D1Database, accountId: string, bucket: StorageBucket, name: string, n: number) {
  return db
    .prepare(
      `INSERT INTO item_storage (account_id, bucket, item_key, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, bucket, item_key) DO UPDATE SET count = count + excluded.count`
    )
    .bind(accountId, bucket, name, n);
}

/** Import a migrating save's Received + shed items, exactly once. Guarded by
 *  farm_state.storage_seeded rather than "no rows yet": empty storage is a legitimate
 *  state, so an if-empty guard would let a client re-import items forever. Callers gate on
 *  MIGRATION_CUTOFF_MS. Only real drops.json entries are imported. */
export async function seedStorage(
  db: D1Database,
  accountId: string,
  received: unknown,
  stored: unknown
): Promise<StorageState> {
  const row = await db
    .prepare("SELECT storage_seeded FROM farm_state WHERE account_id = ?")
    .bind(accountId)
    .first<{ storage_seeded: number }>();
  if (!row?.storage_seeded) {
    const size = await farmSize(db, accountId);
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO farm_state (account_id, size, storage_seeded) VALUES (?, ?, 1)
           ON CONFLICT(account_id) DO UPDATE SET storage_seeded = 1`
        )
        .bind(accountId, size),
    ];
    // `received` is a LIST of names (duplicates allowed); `stored` is [{key,count}].
    const tally: Record<string, number> = {};
    if (Array.isArray(received)) {
      for (const nm of received.slice(0, MAX_SEED_ITEMS)) {
        if (typeof nm === "string" && dropEcon(nm)) tally[nm] = (tally[nm] ?? 0) + 1;
      }
    }
    for (const [k, n] of Object.entries(tally)) stmts.push(addStorageStmt(db, accountId, "received", k, n));
    if (Array.isArray(stored)) {
      for (const it of stored.slice(0, MAX_SEED_ITEMS)) {
        const key = (it as { key?: unknown })?.key;
        const raw = (it as { count?: unknown })?.count;
        if (typeof key !== "string" || !dropEcon(key)) continue;
        const n = Number.isInteger(raw) ? Math.max(0, Math.min(MAX_STACK, raw as number)) : 0;
        if (n > 0) stmts.push(addStorageStmt(db, accountId, "stored", key, n));
      }
    }
    await db.batch(stmts);
  }
  return readStorage(db, accountId);
}

/** The account's shed capacity, DERIVED from the shed it owns (never stored, so an
 *  edited save can't declare it). Every farm starts with the free Shabby Shed, which is
 *  never server-tracked, so the base capacity is the floor. */
export async function shedCapacity(db: D1Database, accountId: string): Promise<number> {
  const res = await db
    .prepare("SELECT object_key FROM object_counts WHERE account_id = ? AND count > 0")
    .bind(accountId)
    .all<{ object_key: string }>();
  let cap = BASE_SHED_SLOTS;
  for (const r of res.results ?? []) cap = Math.max(cap, SHED_SLOTS[r.object_key] ?? 0);
  return cap;
}

export interface StorageResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
}

async function storageActionSeen(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM storage_actions WHERE id = ?").bind(id).first<{ x: number }>();
  return !!row;
}

/** Apply storage MOVES: claim a Received item into what it represents, or pack an owned
 *  object into the shed / take it back out. None of these create value — they move
 *  something the server already recorded you owning, so there is no `grant` here either.
 *  Idempotent by action id; each move is a guarded decrement + an add. */
export async function applyStorageActions(
  db: D1Database,
  accountId: string,
  actions: StorageAction[],
  now: number
): Promise<{ storage: StorageState; inventory: Record<string, number>; objects: Record<string, number>; results: StorageResult[] }> {
  const results: StorageResult[] = [];
  for (const a of actions) {
    if (!a || typeof a.id !== "string" || !a.id || typeof a.name !== "string") {
      results.push({ id: a?.id ?? "", status: "rejected", error: "bad_id" });
      continue;
    }
    if (await storageActionSeen(db, a.id)) {
      results.push({ id: a.id, status: "duplicate" });
      continue;
    }
    const seen = db.prepare("INSERT OR IGNORE INTO storage_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now);

    if (a.type === "claim") {
      const have = await bucketCount(db, accountId, "received", a.name);
      const plan = planClaim(a.name, have);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      // Guarded: only the caller that actually removes the Received entry grants anything.
      if (!(await takeFrom(db, accountId, "received", a.name))) {
        results.push({ id: a.id, status: "rejected", error: "none_owned" });
        continue;
      }
      await db.batch([
        seen,
        plan.kind === "boost"
          ? db
              .prepare(
                `INSERT INTO inventory (account_id, item_key, count) VALUES (?, ?, 1)
                 ON CONFLICT(account_id, item_key) DO UPDATE SET count = count + 1`
              )
              .bind(accountId, plan.boostKey)
          : db
              .prepare(
                `INSERT INTO object_counts (account_id, object_key, count) VALUES (?, ?, 1)
                 ON CONFLICT(account_id, object_key) DO UPDATE SET count = count + 1`
              )
              .bind(accountId, plan.objectKey),
      ]);
      results.push({ id: a.id, status: "applied" });
    } else if (a.type === "store" || a.type === "retrieve") {
      const storing = a.type === "store";
      const objKey = dropEcon(a.name)?.tile ?? "";
      const haveObj = objKey ? await objectCount(db, accountId, objKey) : 0;
      const haveStored = await bucketCount(db, accountId, "stored", a.name);
      const used = await bucketTotal(db, accountId, "stored");
      const plan = storing
        ? planStore(a.name, haveObj, used, await shedCapacity(db, accountId))
        : planRetrieve(a.name, haveStored);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      const key = plan.kind === "object" ? plan.objectKey : "";
      const took = storing
        ? await takeObject(db, accountId, key)
        : await takeFrom(db, accountId, "stored", a.name);
      if (!took) {
        results.push({ id: a.id, status: "rejected", error: "none_owned" });
        continue;
      }
      await db.batch([
        seen,
        storing
          ? addStorageStmt(db, accountId, "stored", a.name, 1)
          : db
              .prepare(
                `INSERT INTO object_counts (account_id, object_key, count) VALUES (?, ?, 1)
                 ON CONFLICT(account_id, object_key) DO UPDATE SET count = count + 1`
              )
              .bind(accountId, key),
      ]);
      results.push({ id: a.id, status: "applied" });
    } else {
      results.push({ id: (a as { id: string }).id, status: "rejected", error: "bad_type" });
    }
  }
  return {
    storage: await readStorage(db, accountId),
    inventory: await readInventory(db, accountId),
    objects: await readObjects(db, accountId),
    results,
  };
}

async function bucketCount(db: D1Database, accountId: string, bucket: StorageBucket, name: string): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM item_storage WHERE account_id = ? AND bucket = ? AND item_key = ?")
    .bind(accountId, bucket, name)
    .first<{ count: number }>();
  return Math.max(0, row?.count ?? 0);
}

async function bucketTotal(db: D1Database, accountId: string, bucket: StorageBucket): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM item_storage WHERE account_id = ? AND bucket = ?")
    .bind(accountId, bucket)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Guarded remove-one from a bucket; false if there was none to take. */
async function takeFrom(db: D1Database, accountId: string, bucket: StorageBucket, name: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE item_storage SET count = count - 1 WHERE account_id = ? AND bucket = ? AND item_key = ? AND count >= 1")
    .bind(accountId, bucket, name)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/** Guarded remove-one from owned objects; false if there was none to take. */
async function takeObject(db: D1Database, accountId: string, key: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE object_counts SET count = count - 1 WHERE account_id = ? AND object_key = ? AND count >= 1")
    .bind(accountId, key)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/** Lifetime wins per raid id — the account's server-owned raid progress. Drives ability
 *  unlocks on the client (tier N's abilities unlock one per win of raid N). */
export async function readRaidProgress(db: D1Database, accountId: string): Promise<Record<string, number>> {
  const res = await db
    .prepare("SELECT raid_id, wins FROM raid_clears WHERE account_id = ?")
    .bind(accountId)
    .all<{ raid_id: number; wins: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[String(r.raid_id)] = r.wins;
  return out;
}

/** Import a migrating save's lifetime raid wins, exactly once. Without it the server sees
 *  a veteran account as having cleared nothing, so it would re-grant first-clear XP for
 *  every raid (~21,000 XP across the catalog → ~24 free level-up brains), and the client
 *  would lose every ability unlock those wins had earned.
 *
 *  Guarded by `raid_state.progress_seeded`, NOT by "no rows yet": zero clears is a
 *  legitimate state, so an if-empty guard would let a client re-import wins whenever it
 *  had none — and wins buy ability unlocks. Callers gate on MIGRATION_CUTOFF_MS.
 *
 *  Only real catalog raids are imported, wins are clamped to a sane ceiling, and NO xp or
 *  gold is credited — these wins were already paid for pre-migration. */
export async function seedRaidProgress(
  db: D1Database,
  accountId: string,
  completed: unknown,
  now: number
): Promise<Record<string, number>> {
  const row = await db
    .prepare("SELECT progress_seeded FROM raid_state WHERE account_id = ?")
    .bind(accountId)
    .first<{ progress_seeded: number }>();
  if (!row?.progress_seeded) {
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO raid_state (account_id, last_raid_at, progress_seeded) VALUES (?, 0, 1)
           ON CONFLICT(account_id) DO UPDATE SET progress_seeded = 1`
        )
        .bind(accountId),
    ];
    const src = completed && typeof completed === "object" ? (completed as Record<string, unknown>) : {};
    for (const [key, raw] of Object.entries(src)) {
      const id = Number(key);
      if (!Number.isInteger(id) || !raidEcon(id)) continue; // only real catalog raids
      const wins = Number.isInteger(raw) ? Math.max(0, Math.min(MAX_RAID_WINS, raw as number)) : 0;
      if (wins <= 0) continue;
      stmts.push(
        db
          .prepare("INSERT OR IGNORE INTO raid_clears (account_id, raid_id, cleared_at, wins) VALUES (?, ?, ?, ?)")
          .bind(accountId, id, now, wins)
      );
    }
    await db.batch(stmts);
  }
  return readRaidProgress(db, accountId);
}

/** The outcome of settling a raid finish: the (possibly-unchanged) cooldown clock,
 *  the resulting balance, and the amounts CREDITED THIS CALL (0 on a replay or loss)
 *  so the client can reconcile its optimistic reward to server truth. */
export interface RaidSettleResult {
  lastRaidAt: number;
  balance: Balance;
  gold: number;
  xp: number;
  firstClear: boolean;
  /** True when the finish was refused because the session had already expired (the raid
   *  wasn't settled within its TTL). Nothing is credited; distinct from a plain replay. */
  expired?: boolean;
  /** The SERVER's loot roll for this win: the drop's display name + what it became, or
   *  null if nothing dropped / this wasn't a fresh win. The client renders this rather
   *  than rolling its own — the drop is real value. */
  loot?: { name: string; kind: LootGrant["kind"] } | null;
}

export interface VerifiedRaidSessionRow {
  raid_id: number;
  started_at: number;
  finished_at: number | null;
  expires_at: number;
  ruleset_version: number;
  config_json: string;
  result_json: string | null;
  rng_seed: string;
}

export async function verifiedRaidSession(
  db: D1Database,
  sessionId: string,
  accountId: string
): Promise<VerifiedRaidSessionRow | null> {
  return db
    .prepare(
      `SELECT raid_id, started_at, finished_at, expires_at, ruleset_version, config_json, result_json, rng_seed
       FROM raid_sessions WHERE id = ? AND account_id = ?`
    )
    .bind(sessionId, accountId)
    .first<VerifiedRaidSessionRow>();
}

function seededUnit(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/** Server-only premium-currency drop, enabled now that the win is replay-proven. */
export async function grantVerifiedRaidBrains(
  db: D1Database,
  accountId: string,
  sessionId: string,
  recommendedLevel: number,
  rngSeed: string,
  now: number
): Promise<number> {
  const frac = Math.max(0, Math.min(1, recommendedLevel / 20));
  const tiers = [
    { amount: 50, chance: 0.005 + (0.01 - 0.005) * frac },
    { amount: 30, chance: 0.01 + (0.02 - 0.01) * frac },
    { amount: 10, chance: 0.025 + (0.05 - 0.025) * frac },
  ];
  let amount = 0;
  for (let i = 0; i < tiers.length; i++) {
    if (seededUnit(rngSeed, i + 17) < tiers[i].chance) {
      amount = tiers[i].amount;
      break;
    }
  }
  if (!amount) return 0;
  const token = crypto.randomUUID();
  const kind = "raid_brain_drop";
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO command_receipts
           (account_id, command_kind, action_id, attempt_token, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(accountId, kind, sessionId, token, now),
    db
      .prepare(
        `UPDATE balances SET brains = brains + ? WHERE account_id = ? AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(amount, accountId, accountId, kind, sessionId, token),
    db
      .prepare(
        `INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at)
         SELECT ?, ?, 'brains', ?, 'raid_loot', ? WHERE EXISTS (
           SELECT 1 FROM command_receipts
           WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?
         )`
      )
      .bind(`raid:${sessionId}#brain`, accountId, amount, now, accountId, kind, sessionId, token),
  ]);
  const applied = await db
    .prepare(
      "SELECT 1 AS x FROM command_receipts WHERE account_id = ? AND command_kind = ? AND action_id = ? AND attempt_token = ?"
    )
    .bind(accountId, kind, sessionId, token)
    .first<{ x: number }>();
  return applied ? amount : 0;
}

export async function closeInvalidRaidSession(
  db: D1Database,
  sessionId: string,
  accountId: string,
  reason: string,
  now: number
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE raid_sessions SET finished_at = COALESCE(finished_at, ?), invalid_reason = ?
         WHERE id = ? AND account_id = ?`
      )
      .bind(now, reason.slice(0, 80), sessionId, accountId),
    db.prepare("DELETE FROM raid_roster_locks WHERE session_id = ? AND account_id = ?").bind(sessionId, accountId),
  ]);
}

export async function commitVerifiedRaidRoster(
  db: D1Database,
  sessionId: string,
  accountId: string,
  survivors: string[],
  losses: string[],
  resultJson: string
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (survivors.length) {
    const ph = survivors.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `UPDATE roster SET invasions = invasions + 1
           WHERE account_id = ? AND id IN (${ph}) AND EXISTS (
             SELECT 1 FROM raid_roster_locks l
             WHERE l.account_id = roster.account_id AND l.unit_id = roster.id AND l.session_id = ?
           )`
        )
        .bind(accountId, ...survivors, sessionId)
    );
  }
  if (losses.length) {
    const ph = losses.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `DELETE FROM roster WHERE account_id = ? AND id IN (${ph}) AND EXISTS (
             SELECT 1 FROM raid_roster_locks l
             WHERE l.account_id = roster.account_id AND l.unit_id = roster.id AND l.session_id = ?
           )`
        )
        .bind(accountId, ...losses, sessionId)
    );
  }
  statements.push(
    db.prepare("DELETE FROM raid_roster_locks WHERE session_id = ? AND account_id = ?").bind(sessionId, accountId),
    db
      .prepare("UPDATE raid_sessions SET result_json = ? WHERE id = ? AND account_id = ? AND result_json IS NULL")
      .bind(resultJson, sessionId, accountId)
  );
  await db.batch(statements);
}

/** Finish a raid exactly once and credit the SERVER-COMPUTED reward. The server owns
 *  the number: base win gold is computed from the session's pinned raid + the (clamped)
 *  survival fraction, and first-clear XP is granted at most once per (account, raid)
 *  via an atomic INSERT OR IGNORE. Whether the player WON is still client-asserted
 *  (deferred: input replay) — but the credit can't exceed that raid's real ceiling.
 *
 *  Idempotent & atomic: the finished_at CAS elects a single winner that sets the
 *  cooldown and applies the reward; a duplicate/late finish credits nothing and just
 *  echoes the current state. The ledger writes are also keyed by session id, so even a
 *  torn retry can't double-credit. */
export async function settleRaid(
  db: D1Database,
  sessionId: string,
  accountId: string,
  win: boolean,
  survivalFrac: number,
  now: number
): Promise<RaidSettleResult> {
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const echo = async (): Promise<RaidSettleResult> => ({
    lastRaidAt: await raidLastAt(db, accountId),
    balance: bal,
    gold: 0,
    xp: 0,
    firstClear: false,
  });

  const row = await db
    .prepare("SELECT raid_id, finished_at, expires_at, dice, rng_seed FROM raid_sessions WHERE id = ? AND account_id = ?")
    .bind(sessionId, accountId)
    .first<{ raid_id: number | null; finished_at: number | null; expires_at: number; dice: number | null; rng_seed: string | null }>();
  if (!row) return echo(); // unknown / foreign session

  // Elect the single finisher, and REFUSE AN EXPIRED SESSION in the same write. A raid
  // must be settled within its TTL: previously expires_at was only read by the cron
  // purge, so a stale session could be banked and cashed in much later (and, before the
  // one-open-session reserve, banked in bulk). Doing the expiry check inside the CAS
  // rather than as a prior read means a session can't expire between the check and the
  // write. An expired session is closed out (finished_at set) so it can't be retried.
  const won = await db
    .prepare(
      `UPDATE raid_sessions SET finished_at = ?
       WHERE id = ? AND account_id = ? AND finished_at IS NULL AND expires_at > ?`
    )
    .bind(now, sessionId, accountId, now)
    .run();
  if ((won.meta.changes ?? 0) !== 1) {
    // Either a replay (already settled) or expired. Close an expired-but-open session so
    // it stops being live for the one-open-session reserve, then credit nothing.
    if (row.finished_at == null && row.expires_at <= now) {
      await db
        .prepare("UPDATE raid_sessions SET finished_at = ? WHERE id = ? AND finished_at IS NULL")
        .bind(now, sessionId)
        .run();
      return { ...(await echo()), expired: true };
    }
    return echo(); // replay — already settled
  }

  // First finish (win OR loss) starts the between-raids cooldown.
  await db
    .prepare(
      `INSERT INTO raid_state (account_id, last_raid_at) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET last_raid_at = excluded.last_raid_at`
    )
    .bind(accountId, now)
    .run();

  let gold = 0;
  let xp = 0;
  let firstClear = false;
  let loot: RaidSettleResult["loot"] = null;
  const econ = row.raid_id != null ? raidEcon(row.raid_id) : undefined;
  if (win && econ) {
    gold = winGold(econ, survivalFrac);
    // First-clear XP: atomic + idempotent. `changes === 1` means the row was newly
    // inserted, i.e. this is the first time this account has cleared this raid.
    const ins = await db
      .prepare("INSERT OR IGNORE INTO raid_clears (account_id, raid_id, cleared_at, wins) VALUES (?, ?, ?, 1)")
      .bind(accountId, row.raid_id, now)
      .run();
    firstClear = (ins.meta.changes ?? 0) === 1;
    if (firstClear) xp = econ.xp;
    // A repeat win bumps the lifetime count (the insert above already counted the first).
    // Wins drive ability unlocks, so this is authoritative progress, not a statistic.
    else {
      await db
        .prepare("UPDATE raid_clears SET wins = wins + 1 WHERE account_id = ? AND raid_id = ?")
        .bind(accountId, row.raid_id)
        .run();
    }

    const stmts: D1PreparedStatement[] = [];
    if (gold > 0) {
      stmts.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(`raid:${sessionId}#g`, accountId, "gold", gold, "raid_loot", now)
      );
    }
    if (xp > 0) {
      stmts.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(`raid:${sessionId}#x`, accountId, "xp", xp, "raid_loot", now)
      );
    }
    // SERVER-rolled loot (T2). The drop is real value — a boost, bonus gold, or a
    // placeable — so it can't be a client assertion. The luck bracket comes from the dice
    // PINNED on the session at /raid/start (and consumed there), never from this request.
    // Eligibility reads server-owned ownership, so a unique can't be farmed.
    const dice = row.dice ?? 0;
    const name = await rollServerLoot(db, accountId, row.raid_id!, dice, row.rng_seed ?? sessionId);
    const grant = resolveLoot(name, econ.recLevel);
    if (grant.kind === "gold") {
      gold += grant.gold;
      stmts.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(`raid:${sessionId}#b`, accountId, "gold", grant.gold, "raid_loot", now)
      );
    } else if (grant.kind === "boost") {
      // Stacks straight into the server-owned boost inventory, exactly as the client did
      // locally — except the client's version went through the removed `grant` action and
      // was rejected, so this loot silently evaporated online.
      stmts.push(
        db
          .prepare(
            `INSERT INTO inventory (account_id, item_key, count) VALUES (?, ?, 1)
             ON CONFLICT(account_id, item_key) DO UPDATE SET count = count + 1`
          )
          .bind(accountId, grant.key)
      );
    } else if (grant.kind === "item") {
      stmts.push(addStorageStmt(db, accountId, "received", grant.name, 1));
    }
    loot = grant.kind === "none" ? null : { name: grant.name, kind: grant.kind };

    if (gold > 0 || xp > 0) {
      stmts.push(
        db
          .prepare("UPDATE balances SET gold = gold + ?, xp = xp + ? WHERE account_id = ?")
          .bind(gold, xp, accountId)
      );
    }
    if (stmts.length) {
      await db.batch(stmts);
      bal.gold += gold;
      bal.xp += xp;
      // First-clear xp may have crossed a level threshold — pay owed level-up brains.
      bal.brains += await creditLevelUps(db, accountId, now);
    }
  }
  return { lastRaidAt: now, balance: bal, gold, xp, firstClear, loot };
}

/** Roll this win's loot with the SERVER's RNG against server-owned ownership. Separate
 *  from settleRaid only to keep the async owned-count lookups out of its flow. */
async function rollServerLoot(
  db: D1Database,
  accountId: string,
  raidId: number,
  dice: number,
  seed: string
): Promise<string | null> {
  const table = raidLoot(raidId);
  if (!table) return null;
  // Pre-read the counts for every entry this raid can drop, so the pure roll stays sync.
  const names = [...new Set(table.flat())];
  const owned = new Map<string, number>();
  for (const n of names) owned.set(n, await ownedLootCount(db, accountId, n));
  return rollLoot(raidId, dice, (n) => owned.get(n) ?? 0, seededUnit(seed, 31), seededUnit(seed, 47));
}

/** Delete finished/expired raid sessions older than `before` (cron cleanup). */
export async function purgeOldRaidSessions(db: D1Database, before: number): Promise<number> {
  const old = "SELECT id FROM raid_sessions WHERE (finished_at IS NOT NULL AND finished_at < ?) OR expires_at < ?";
  const [, , res] = await db.batch([
    db.prepare(`DELETE FROM raid_checkpoints WHERE session_id IN (${old})`).bind(before, before),
    db.prepare(`DELETE FROM raid_roster_locks WHERE session_id IN (${old})`).bind(before, before),
    db.prepare("DELETE FROM raid_sessions WHERE (finished_at IS NOT NULL AND finished_at < ?) OR expires_at < ?").bind(before, before),
  ]);
  return res.meta.changes ?? 0;
}

// ---- maintenance / cleanup (cron) ---------------------------------------
/** Delete sessions that are safely dead: revoked a while ago, or idle past the
 *  access-token lifetime (so their JWTs have expired anyway). Returns rows removed. */
export async function purgeDeadSessions(
  db: D1Database,
  revokedBefore: number,
  idleBefore: number
): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM sessions
       WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR last_used_at < ?`
    )
    .bind(revokedBefore, idleBefore)
    .run();
  return res.meta.changes ?? 0;
}

/** Delete rate-limit counters from windows that have long since closed. */
export async function purgeOldRateBuckets(db: D1Database, before: number): Promise<number> {
  const res = await db
    .prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .bind(before)
    .run();
  return res.meta.changes ?? 0;
}

/** Delete pending friend requests older than `before` (never accepted/rejected). */
export async function purgeOldFriendRequests(db: D1Database, before: number): Promise<number> {
  const res = await db
    .prepare("DELETE FROM friend_requests WHERE created_at < ?")
    .bind(before)
    .run();
  return res.meta.changes ?? 0;
}

// ---- rate limiting (fixed window) ---------------------------------------
/** Atomically bump the counter for `bucketKey` in the window starting at
 *  `windowStart`, returning the new count. First hit in a window inserts count=1;
 *  a stale window (different windowStart) resets to 1. */
export async function bumpRateLimit(
  db: D1Database,
  bucketKey: string,
  windowStart: number
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket_key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start
                      THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`
    )
    .bind(bucketKey, windowStart)
    .first<{ count: number }>();
  return res?.count ?? 1;
}

/** Account-wide value-command volume, shared across routes. Stored in the existing
 * fixed-window table so it works even when native per-route limiting is configured. */
export async function bumpCommandVolume(
  db: D1Database,
  accountId: string,
  window: "hour" | "day",
  windowStart: number,
  amount: number
): Promise<number> {
  const n = Math.max(0, Math.min(64, Math.trunc(amount)));
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, ?)
       ON CONFLICT (bucket_key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start
                      THEN rate_limits.count + excluded.count ELSE excluded.count END,
         window_start = excluded.window_start
       RETURNING count`
    )
    .bind(`cmd:${window}:${accountId}`, windowStart, n)
    .first<{ count: number }>();
  return row?.count ?? n;
}

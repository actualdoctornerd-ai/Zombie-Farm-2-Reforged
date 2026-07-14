// Thin data-access layer over D1. Handlers call these; no business rules live here
// (those are in logic.ts / the routes) — just typed queries.
import { friendCodeFromBytes, idFromBytes } from "./logic";
import type { GoogleIdentity } from "./auth";
import type { Balance, EconomyEvent } from "./economy";
import { applyBatch, clampSeed } from "./economy";
import { cropEcon } from "./catalog";
import { planPlant, planHarvest, type FarmAction, type PlotRecord } from "./farm";
import { raidEcon, winGold } from "./raidCatalog";
import { boostEcon, BOOST_KEYS, VOUCHER_KEY, MAX_STACK } from "./boostCatalog";
import { planBuy, planUse, planGrant, type InventoryAction } from "./inventory";
import { zombieSell, fertilizeProbability, isKnownZombie, MAX_MUTATION } from "./rosterCatalog";
import { planGrant as planRosterGrant, cleanIds, type RosterAction } from "./roster";
import { BASE_FARM_SIZE, sizeTier, nextSize, climateCost } from "./shopCatalog";

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
  await db
    .prepare(
      "INSERT OR IGNORE INTO balances (account_id, gold, brains, xp) VALUES (?, ?, ?, ?)"
    )
    .bind(accountId, s.gold, s.brains, s.xp)
    .run();
  const row = await db
    .prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?")
    .bind(accountId)
    .first<Balance>();
  return row ?? { gold: 0, brains: 0, xp: 0 };
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

export interface FarmResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  gold?: number;
  xp?: number;
  fertilized?: boolean; // plant only: whether the SERVER rolled the crop fertilized
}

/** Apply a batch of farm actions with EXACT, server-computed economics: plant
 *  debits the catalog seed cost and records the crop with server plant time;
 *  harvest is gated by grow time against that plant time and credits the exact
 *  sell (x2 if fertilized) + xp. Idempotent by action id, atomic per action, and
 *  the balance is an atomic increment. Returns the resulting balance + verdicts. */
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

  for (const a of actions) {
    if (!a || typeof a.id !== "string" || !a.id) {
      results.push({ id: a?.id ?? "", status: "rejected", error: "bad_id" });
      continue;
    }
    if (await farmActionSeen(db, a.id)) {
      results.push({ id: a.id, status: "duplicate" });
      continue;
    }

    if (a.type === "plant") {
      const occupied = !!(await getCropPlot(db, accountId, a.oc, a.or));
      const fertilized = Math.random() < fertP; // SERVER-owned fertilize roll
      const plan = planPlant(a, cropEcon(a.cropKey), occupied, bal, now, fertilized);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO farm_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
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
      results.push({ id: a.id, status: "applied", gold: plan.goldDelta, xp: plan.xpDelta });
    } else {
      results.push({ id: (a as { id: string }).id, status: "rejected", error: "bad_type" });
    }
  }
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

/** Seed a player's boost counts ONCE from their save (INSERT OR IGNORE per key, so an
 *  existing server count is never clobbered). Only catalog boost keys are seeded, each
 *  clamped to the stack ceiling. Returns the resulting authoritative inventory. */
export async function seedInventory(
  db: D1Database,
  accountId: string,
  counts: Record<string, unknown>
): Promise<Record<string, number>> {
  const stmts: D1PreparedStatement[] = [];
  for (const key of BOOST_KEYS) {
    const raw = counts?.[key];
    const n = Number.isInteger(raw) ? Math.max(0, Math.min(MAX_STACK, raw as number)) : 0;
    if (n > 0) {
      stmts.push(
        db
          .prepare("INSERT OR IGNORE INTO inventory (account_id, item_key, count) VALUES (?, ?, ?)")
          .bind(accountId, key, n)
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
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
}

/** Whether an inventory action id was already applied (idempotency). */
async function invActionSeen(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM inventory_actions WHERE id = ?").bind(id).first<{ x: number }>();
  return !!row;
}

/** Apply a batch of inventory actions with server-authoritative rules: `buy` debits
 *  the EXACT catalog price from the balance and grants perPurchase; `use` decrements
 *  (guarded so it can't go negative); `grant` (loot) increments. Idempotent by action
 *  id, atomic per action. Returns the resulting balance + full boost inventory. Reads
 *  current state per action then applies via atomic add/guarded update — same
 *  read-validate + atomic-write shape as applyEvents/applyFarmActions. */
export async function applyInventoryActions(
  db: D1Database,
  accountId: string,
  actions: InventoryAction[],
  now: number
): Promise<{ balance: Balance; inventory: Record<string, number>; results: InventoryResult[] }> {
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
      const plan = planBuy(a, econ, bal, have);
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
    } else if (a.type === "use") {
      const plan = planUse(a, have);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
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
      await db.prepare("INSERT OR IGNORE INTO inventory_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now).run();
      inv[a.key] = have + plan.delta;
      results.push({ id: a.id, status: "applied" });
    } else if (a.type === "grant") {
      const plan = planGrant(a, boostEcon(a.key), have);
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
          .bind(accountId, a.key, plan.delta),
      ]);
      inv[a.key] = have + plan.delta;
      results.push({ id: a.id, status: "applied" });
    } else {
      results.push({ id: (a as { id: string }).id, status: "rejected", error: "bad_type" });
    }
  }
  return { balance: bal, inventory: inv, results };
}

/** Delete inventory-action idempotency records older than `before` (cron cleanup).
 *  The `inventory` counts are live state and are NOT purged. */
export async function purgeOldInventoryActions(db: D1Database, before: number): Promise<number> {
  const res = await db.prepare("DELETE FROM inventory_actions WHERE created_at < ?").bind(before).run();
  return res.meta.changes ?? 0;
}

// ---- roster: server-owned zombie units (validation + money shadow) ------
interface RosterRow {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
}

/** Seed a player's roster ONCE from their save's owned zombies (INSERT OR IGNORE per
 *  unit id, so an existing server record is never clobbered). Only real catalog units
 *  with a non-empty id are seeded, with bounded mutation/invasions. Returns the count
 *  of rows the account has afterward. */
export async function seedRoster(
  db: D1Database,
  accountId: string,
  units: unknown
): Promise<number> {
  const list = Array.isArray(units) ? units : [];
  const stmts: D1PreparedStatement[] = [];
  for (const u of list) {
    const g = planRosterGrant({ id: "seed", type: "grant", unitId: (u as RosterRow)?.id, key: (u as RosterRow)?.key, mutation: (u as RosterRow)?.mutation, invasions: (u as RosterRow)?.invasions });
    if (!g.ok) continue;
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO roster (account_id, id, key, mutation, invasions) VALUES (?, ?, ?, ?, ?)")
        .bind(accountId, g.unitId, g.key, g.mutation, g.invasions)
    );
  }
  if (stmts.length) await db.batch(stmts);
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM roster WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
}

/** Apply a batch of roster actions with server authority:
 *   • sell     — price floor(cost/2) from the catalog, remove the unit, credit gold
 *                (a fabricated unit the server doesn't own is rejected → no gold);
 *   • grant    — record a real catalog unit (crop harvest, gift redeem, combine result);
 *   • veteran  — bump invasions for surviving units;
 *   • casualty — remove dead units.
 *  Idempotent by action id, atomic per action. A combine is a casualty(parents) +
 *  grant(result). Returns the resulting balance + per-action verdicts. */
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
        .prepare("DELETE FROM roster WHERE account_id = ? AND id = ?")
        .bind(accountId, a.unitId)
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
    } else if (a.type === "grant") {
      const plan = planRosterGrant(a);
      if (!plan.ok) {
        results.push({ id: a.id, status: "rejected", error: plan.error });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO roster_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db
          .prepare("INSERT OR IGNORE INTO roster (account_id, id, key, mutation, invasions) VALUES (?, ?, ?, ?, ?)")
          .bind(accountId, plan.unitId, plan.key, plan.mutation, plan.invasions),
      ]);
      results.push({ id: a.id, status: "applied" });
    } else if (a.type === "veteran" || a.type === "casualty") {
      const ids = cleanIds((a as { unitIds: string[] }).unitIds);
      const stmts: D1PreparedStatement[] = [
        db.prepare("INSERT INTO roster_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
      ];
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        stmts.push(
          a.type === "veteran"
            ? db.prepare(`UPDATE roster SET invasions = invasions + 1 WHERE account_id = ? AND id IN (${ph})`).bind(accountId, ...ids)
            : db.prepare(`DELETE FROM roster WHERE account_id = ? AND id IN (${ph})`).bind(accountId, ...ids)
        );
      }
      await db.batch(stmts);
      results.push({ id: a.id, status: "applied" });
    } else if (a.type === "combineStart") {
      // Consume both parents (must own both, and not already be combining), recording
      // their keys so the result can be validated at collect.
      const busy = await db.prepare("SELECT 1 AS x FROM combine_jobs WHERE account_id = ?").bind(accountId).first<{ x: number }>();
      if (busy) {
        results.push({ id: a.id, status: "rejected", error: "busy" });
        continue;
      }
      const pa = await db.prepare("SELECT key FROM roster WHERE account_id = ? AND id = ?").bind(accountId, a.parentAId).first<{ key: string }>();
      const pb = await db.prepare("SELECT key FROM roster WHERE account_id = ? AND id = ?").bind(accountId, a.parentBId).first<{ key: string }>();
      if (!pa || !pb || a.parentAId === a.parentBId) {
        results.push({ id: a.id, status: "rejected", error: "bad_parent" });
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO roster_actions (id, account_id, created_at) VALUES (?, ?, ?)").bind(a.id, accountId, now),
        db.prepare("DELETE FROM roster WHERE account_id = ? AND id IN (?, ?)").bind(accountId, a.parentAId, a.parentBId),
        db.prepare("INSERT INTO combine_jobs (account_id, key_a, key_b, started_at) VALUES (?, ?, ?, ?)").bind(accountId, pa.key, pb.key, now),
      ]);
      results.push({ id: a.id, status: "applied" });
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
      results.push({ id: a.id, status: validKey ? "applied" : "rejected", error: validKey ? undefined : "bad_result" });
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
  const existing = await db.prepare("SELECT 1 AS x FROM farm_state WHERE account_id = ?").bind(accountId).first<{ x: number }>();
  if (!existing) {
    const size = Number.isInteger(seedSize) && (sizeTier(seedSize) || seedSize === BASE_FARM_SIZE) ? seedSize : BASE_FARM_SIZE;
    const stmts: D1PreparedStatement[] = [
      db.prepare("INSERT OR IGNORE INTO farm_state (account_id, size) VALUES (?, ?)").bind(accountId, size),
    ];
    if (Array.isArray(seedClimates)) {
      for (const t of seedClimates) {
        if (typeof t === "string" && t !== "grass" && climateCost(t) !== undefined) {
          stmts.push(db.prepare("INSERT OR IGNORE INTO owned_climates (account_id, terrain) VALUES (?, ?)").bind(accountId, t));
        }
      }
    }
    await db.batch(stmts);
  }
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

  await db.batch([
    db.prepare(`UPDATE balances SET ${currency} = ${currency} - ? WHERE account_id = ?`).bind(cost, accountId),
    db.prepare("INSERT INTO farm_state (account_id, size) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET size = excluded.size").bind(accountId, targetSize),
    db.prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, ?, ?, 'upgrade', ?)").bind(`size:${accountId}:${targetSize}`, accountId, currency, -cost, now),
  ]);
  bal[currency] -= cost;
  return { ok: true, balance: bal, size: targetSize, climates: state.climates };
}

/** Buy a ground/climate skin for its exact price (gold). Naturally idempotent: a retry
 *  after it's already owned fails the "not owned" check and just echoes state. */
export async function buyClimate(db: D1Database, accountId: string, terrain: string, now: number): Promise<ShopResult> {
  const state = await readShopState(db, accountId);
  const bal = await getOrSeedBalance(db, accountId, { gold: 0, brains: 0, xp: 0 });
  const fail = (error: string): ShopResult => ({ ok: false, error, balance: bal, size: state.size, climates: state.climates });

  const cost = climateCost(terrain);
  if (cost === undefined || terrain === "grass") return fail("bad_climate");
  if (state.climates.includes(terrain)) return fail("owned");
  if (bal.gold < cost) return fail("insufficient");

  await db.batch([
    db.prepare("UPDATE balances SET gold = gold - ? WHERE account_id = ?").bind(cost, accountId),
    db.prepare("INSERT OR IGNORE INTO owned_climates (account_id, terrain) VALUES (?, ?)").bind(accountId, terrain),
    db.prepare("INSERT OR IGNORE INTO ledger (id, account_id, currency, delta, reason, created_at) VALUES (?, ?, 'gold', ?, 'upgrade', ?)").bind(`clim:${accountId}:${terrain}`, accountId, -cost, now),
  ]);
  bal.gold -= cost;
  return { ok: true, balance: bal, size: state.size, climates: [...state.climates, terrain] };
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

/** The outcome of settling a raid finish: the (possibly-unchanged) cooldown clock,
 *  the resulting balance, and the amounts CREDITED THIS CALL (0 on a replay or loss)
 *  so the client can reconcile its optimistic reward to server truth. */
export interface RaidSettleResult {
  lastRaidAt: number;
  balance: Balance;
  gold: number;
  xp: number;
  firstClear: boolean;
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
    .prepare("SELECT raid_id, finished_at FROM raid_sessions WHERE id = ? AND account_id = ?")
    .bind(sessionId, accountId)
    .first<{ raid_id: number | null; finished_at: number | null }>();
  if (!row) return echo(); // unknown / foreign session

  // Elect the single finisher.
  const won = await db
    .prepare(
      "UPDATE raid_sessions SET finished_at = ? WHERE id = ? AND account_id = ? AND finished_at IS NULL"
    )
    .bind(now, sessionId, accountId)
    .run();
  if ((won.meta.changes ?? 0) !== 1) return echo(); // replay — already settled

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
  const econ = row.raid_id != null ? raidEcon(row.raid_id) : undefined;
  if (win && econ) {
    gold = winGold(econ, survivalFrac);
    // First-clear XP: atomic + idempotent. `changes === 1` means the row was newly
    // inserted, i.e. this is the first time this account has cleared this raid.
    const ins = await db
      .prepare("INSERT OR IGNORE INTO raid_clears (account_id, raid_id, cleared_at) VALUES (?, ?, ?)")
      .bind(accountId, row.raid_id, now)
      .run();
    firstClear = (ins.meta.changes ?? 0) === 1;
    if (firstClear) xp = econ.xp;

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
    if (gold > 0 || xp > 0) {
      stmts.push(
        db
          .prepare("UPDATE balances SET gold = gold + ?, xp = xp + ? WHERE account_id = ?")
          .bind(gold, xp, accountId)
      );
      await db.batch(stmts);
      bal.gold += gold;
      bal.xp += xp;
    }
  }
  return { lastRaidAt: now, balance: bal, gold, xp, firstClear };
}

/** Delete finished/expired raid sessions older than `before` (cron cleanup). */
export async function purgeOldRaidSessions(db: D1Database, before: number): Promise<number> {
  const res = await db
    .prepare(
      "DELETE FROM raid_sessions WHERE (finished_at IS NOT NULL AND finished_at < ?) OR expires_at < ?"
    )
    .bind(before, before)
    .run();
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

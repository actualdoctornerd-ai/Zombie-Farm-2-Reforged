// Thin data-access layer over D1. Handlers call these; no business rules live here
// (those are in logic.ts / the routes) — just typed queries.
import {
  friendCodeFromBytes, idFromBytes, rollGiftReward, DAY_MS,
  FIRST_DAILY_GIFT_REWARD, type GiftReward,
} from "./logic";
import type { GoogleIdentity } from "./auth";
import type { Balance } from "./economy";
import { clampSeed } from "./economy";
import { validateUnit } from "./roster";
import { levelForXp } from "./levels";

export interface Account {
  id: string;
  google_sub: string;
  /** Player-chosen display name; NULL until picked on first sign-in. The ONLY
   *  human-facing name in the system — chosen by the user, not from Google. */
  username: string | null;
  friend_code: string;
  created_at: number;
  /** Latest known authenticated activity, with the same throttled resolution as
   *  the session heartbeat. Intended for administrative account inspection. */
  last_online_at: number;
}

export interface Gift {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  created_at: number;
  claimed_at: number | null;
  /** Contents rolled at SEND time (migration 0038). Legacy rows default to a brain. */
  reward_kind: "brain" | "gold";
  reward_amount: number;
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
 *  code) on first sign-in. Retries code generation on the rare collision.
 *
 *  With `allowCreate` false (service closedown — see serviceState.ts) an unknown
 *  identity resolves to null instead of registering: sign-in stays open to the
 *  existing player base while the door is shut to new ones. */
export async function upsertAccount(
  db: D1Database,
  who: GoogleIdentity,
  now: number,
  allowCreate = true
): Promise<Account | null> {
  const existing = await accountByGoogleSub(db, who.sub);
  if (existing) return existing;
  if (!allowCreate) return null;
  const id = idFromBytes(rand(16));
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = friendCodeFromBytes(rand(6));
    try {
      await db
        .prepare(
          `INSERT INTO accounts
             (id, google_sub, friend_code, created_at, last_online_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(id, who.sub, code, now, now)
        .run();
      return {
        id,
        google_sub: who.sub,
        username: null,
        friend_code: code,
        created_at: now,
        last_online_at: now,
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

/** My friends (both-directions storage means one indexed lookup).
 *
 *  `head_id` is the friend's WORN Farmer head, so their list entry can show the face
 *  they chose instead of a generic row. It is pulled with json_extract rather than by
 *  shipping the whole core document back: that blob also carries inventory, storage
 *  and pot state, none of which a friend may see. NULL for an account that has never
 *  materialized v3 state. */
export async function listFriends(
  db: D1Database,
  accountId: string
): Promise<Array<Account & { xp: number; head_id: number | null }>> {
  const res = await db
    .prepare(
      `SELECT a.*, COALESCE(b.xp, 0) AS xp,
              json_extract(g.current_json, '$.farmerHeadId') AS head_id
       FROM accounts a
       JOIN friendships f ON f.b_id = a.id
       LEFT JOIN balances b ON b.account_id = a.id
       LEFT JOIN gameplay_documents_v3 g ON g.account_id = a.id
       WHERE f.a_id = ?
       ORDER BY a.username COLLATE NOCASE`
    )
    .bind(accountId)
    .all<Account & { xp: number; head_id: number | null }>();
  return res.results ?? [];
}

/** One row of GET /leaderboard/friends: an account's display identity plus the raw
 *  material its leaderboard entry is projected from. */
export interface FriendLeaderboardRow {
  id: string;
  username: string | null;
  /** Server-owned XP (balances); 0 for an account that has never played online. */
  xp: number;
  head_id: number | null;
  /** The stored `ui.stats` tally as a JSON string, or null when the account has no
   *  presentation blob or its blob carries no tally. Projected by the route through
   *  leaderboardStatsFromJson — never shipped raw. */
  stats_json: string | null;
}

/** The caller and every accepted friend, in one indexed query — the friend-only
 *  leaderboard's roster. Shaped like listFriends' pulls: xp from balances,
 *  head/stats lifted with json_extract rather than by shipping whole documents,
 *  because those blobs carry state a friend may not see. Bounded by MAX_FRIENDS+1
 *  rows. Ordering is left to the client — rank depends on which stat it is
 *  ranking by. */
export async function listFriendLeaderboard(
  db: D1Database,
  accountId: string
): Promise<FriendLeaderboardRow[]> {
  const res = await db
    .prepare(
      `SELECT a.id, a.username, COALESCE(b.xp, 0) AS xp,
              json_extract(g.current_json, '$.farmerHeadId') AS head_id,
              json_extract(p.current_json, '$.ui.stats') AS stats_json
       FROM accounts a
       LEFT JOIN balances b ON b.account_id = a.id
       LEFT JOIN gameplay_documents_v3 g ON g.account_id = a.id
       LEFT JOIN presentations_v3 p ON p.account_id = a.id
       WHERE a.id = ?1 OR a.id IN (SELECT b_id FROM friendships WHERE a_id = ?1)`
    )
    .bind(accountId)
    .all<FriendLeaderboardRow>();
  return res.results ?? [];
}

/** Lifetime gifts each friend has sent ME, keyed by their account id. Claimed and
 *  unclaimed alike — this is a "who actually reciprocates" signal for the friends
 *  list, not an inbox count. One indexed group-by over idx_gifts_inbox (to_id, ...),
 *  so it costs the same whether you have three friends or three hundred. */
export async function giftsReceivedFrom(
  db: D1Database,
  accountId: string
): Promise<Map<string, number>> {
  const res = await db
    .prepare("SELECT from_id, COUNT(*) AS n FROM gifts WHERE to_id = ? GROUP BY from_id")
    .bind(accountId)
    .all<{ from_id: string; n: number }>();
  return new Map((res.results ?? []).map((row) => [row.from_id, row.n]));
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

/** Account ids still holding an UNOPENED gift from this sender. A second gift can't
 *  be sent until they open the first, so nobody stockpiles a pile of them from one
 *  friend — and the friends list can grey out the button before the send is tried. */
export async function pendingGiftRecipientIds(
  db: D1Database,
  accountId: string
): Promise<Set<string>> {
  const res = await db
    .prepare("SELECT DISTINCT to_id FROM gifts WHERE from_id = ? AND claimed_at IS NULL")
    .bind(accountId)
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

/** Graph size cap per account. This bounds ACCEPTING, not receiving: a full account
 *  still collects incoming requests in its inbox (they queue until it makes room),
 *  and only the accept is refused. Because a friendship is stored in BOTH directions,
 *  every accept path has to check BOTH parties — see /friends/accept. */
export const MAX_FRIENDS = 50;

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

/** Gift sending is bounded PER RECIPIENT, not per sender-day: once per UTC day, and
 * never while that recipient still has an unopened gift from this sender. There is no
 * ceiling on how many different friends you may gift in a day — gold is the only
 * brake, and the first two sends each day are free. */
export const FREE_DAILY_GIFTS = 2;
export const GIFT_GOLD_COST = 100;
export const GIFT_XP_REWARD = 5;

export type GiftSendStatus =
  | "sent"
  | "already_gifted_today"
  | "gift_pending"
  | "insufficient_gold"
  | "conflict";

export interface GiftSendResult {
  status: GiftSendStatus;
  balance: Balance;
  accountVersion: number;
  sentToday: number;
  lastRaidAt: number;
}

/** Atomically create a gift, charge any post-free-tier cost, and award sender XP.
 * The conditional INSERT enforces sufficient gold and that the recipient has no
 * unopened gift from this sender, while idx_gifts_once still prevents two sends to
 * the same recipient in one UTC day. Both bounds are per RECIPIENT — a sender may
 * gift as many different friends in a day as they can pay for. The gift's contents
 * are rolled here and stored on the row (see rollGiftReward); neither party learns
 * them until the recipient opens it. */
export async function sendGiftWithReward(
  db: D1Database,
  from: string,
  to: string,
  bucket: number,
  now: number,
  seed: Balance,
  xpAward = GIFT_XP_REWARD,
  rollReward: () => GiftReward = rollGiftReward
): Promise<GiftSendResult> {
  await getOrSeedBalance(db, from, seed);
  const id = idFromBytes(rand(16));
  // Contents are decided HERE, once, and stored on the row — never re-rolled at open
  // time. `reward` is chosen before the conditional INSERT so a gift that fails its
  // pending/gold check simply discards the roll.
  const reward = rollReward();
  const guard = "EXISTS(SELECT 1 FROM gifts WHERE id=? AND from_id=?)";
  const results = await db.batch([
    db.prepare(
      `INSERT INTO gifts (id, from_id, to_id, type, created_at, day_bucket, reward_kind, reward_amount)
       SELECT ?, ?, ?, 'brain', ?, ?, ?, ?
       WHERE NOT EXISTS (
           SELECT 1 FROM gifts WHERE from_id = ? AND to_id = ? AND claimed_at IS NULL
         )
         AND (
           (SELECT COUNT(*) FROM gifts WHERE from_id = ? AND day_bucket = ?) < ?
           OR EXISTS (SELECT 1 FROM balances WHERE account_id = ? AND gold >= ?)
         )
       ON CONFLICT (from_id, to_id, day_bucket) DO NOTHING`
    ).bind(
      id, from, to, now, bucket, reward.kind, reward.amount,
      from, to,
      from, bucket, FREE_DAILY_GIFTS,
      from, GIFT_GOLD_COST
    ),
    db.prepare(`UPDATE balances SET
      gold=gold-CASE WHEN (
        SELECT COUNT(*) FROM gifts WHERE from_id=? AND day_bucket=?
      ) > ? THEN ? ELSE 0 END,
      xp=xp+?
      WHERE account_id=? AND ${guard}`)
      .bind(from, bucket, FREE_DAILY_GIFTS, GIFT_GOLD_COST, xpAward, from, id, from),
    db.prepare(`INSERT INTO ledger (id,account_id,currency,delta,reason,created_at)
      SELECT ?,?,'gold',?,'gift_sent',? WHERE ${guard} AND (
        SELECT COUNT(*) FROM gifts WHERE from_id=? AND day_bucket=?
      ) > ?`)
      .bind(`${id}#gold`, from, -GIFT_GOLD_COST, now, id, from, from, bucket, FREE_DAILY_GIFTS),
    db.prepare(`INSERT INTO ledger (id,account_id,currency,delta,reason,created_at)
      SELECT ?,?,'xp',?,'gift_sent',? WHERE ${guard}`)
      .bind(id, from, xpAward, now, id, from),
    db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=?
      WHERE account_id=? AND ${guard}`).bind(now, from, id, from),
  ]);
  const sent = (results[0]?.meta.changes ?? 0) === 1;
  if (sent) await creditLevelUps(db, from, now);

  const [balance, runtime, duplicate, pending, daily, raidState] = await Promise.all([
    getOrSeedBalance(db, from, seed),
    db.prepare("SELECT account_version FROM account_runtime_v3 WHERE account_id=?")
      .bind(from).first<{ account_version: number }>(),
    sent ? Promise.resolve(null) : db.prepare(
      "SELECT 1 AS found FROM gifts WHERE from_id=? AND to_id=? AND day_bucket=?"
    ).bind(from, to, bucket).first<{ found: number }>(),
    sent ? Promise.resolve(null) : db.prepare(
      "SELECT 1 AS found FROM gifts WHERE from_id=? AND to_id=? AND claimed_at IS NULL"
    ).bind(from, to).first<{ found: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM gifts WHERE from_id=? AND day_bucket=?")
      .bind(from, bucket).first<{ n: number }>(),
    db.prepare("SELECT last_started_at FROM raid_state_v3 WHERE account_id=?")
      .bind(from).first<{ last_started_at: number }>(),
  ]);
  const sentToday = daily?.n ?? 0;
  // Order matters: an unopened gift sent TODAY trips both guards, and the more
  // specific "you already gifted them today" is the more useful thing to say.
  const status: GiftSendStatus = sent ? "sent" : duplicate ? "already_gifted_today" :
    pending ? "gift_pending" :
      sentToday >= FREE_DAILY_GIFTS && balance.gold < GIFT_GOLD_COST ? "insufficient_gold" : "conflict";
  return {
    status,
    balance,
    accountVersion: runtime?.account_version ?? 0,
    sentToday,
    lastRaidAt: raidState?.last_started_at ?? 0,
  };
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

export interface GiftClaimResult {
  claimed: boolean;
  /** What was actually credited (null when nothing was claimed). */
  reward: GiftReward | null;
}

/** Atomically consume an addressed gift, record its idempotency grant, and credit the
 * gift's contents.
 *
 * The FIRST gift an account opens each UTC day always pays a brain, whatever the sender
 * rolled onto it; every later gift that day pays the contents stored at send time. That
 * choice is made INSIDE the SQL (a COUNT of gifts this account already claimed today)
 * rather than by a read-then-write, so claims serialized on the account fence can never
 * both take the daily floor.
 *
 * Legacy versions could leave a grant behind while the gift stayed unclaimed; this
 * transaction heals both settled and pending orphan grants without double credit — an
 * existing grant keeps its recorded kind/amount rather than being re-decided. */
export async function claimGiftReward(
  db: D1Database,
  giftId: string,
  accountId: string,
  grantId: string,
  now: number,
  seed: Balance
): Promise<GiftClaimResult> {
  await getOrSeedBalance(db, accountId, seed);
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const fence = "EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=? AND active_batch_id=?)";
  // Nothing claimed yet today → this open takes the guaranteed daily brain. Served by
  // idx_gifts_inbox (to_id, claimed_at); the gift being claimed is still NULL here
  // because its claimed_at is only stamped by the last statement of this batch.
  const firstToday = "(SELECT COUNT(*) FROM gifts WHERE to_id=? AND claimed_at>=?)=0";
  const result = await db.batch([
    db.prepare(`UPDATE account_runtime_v3 SET active_batch_id=?,active_batch_expires_at=?,
      account_version=account_version+1,updated_at=? WHERE account_id=?
      AND (active_batch_id IS NULL OR active_batch_expires_at<=?)
      AND EXISTS(SELECT 1 FROM gifts WHERE id=? AND to_id=? AND claimed_at IS NULL)`)
      .bind(grantId, now + 120_000, now, accountId, now, giftId, accountId),
    db.prepare(`INSERT OR IGNORE INTO grants
      (id,account_id,kind,amount,source_gift_id,created_at,settled_at)
      SELECT ?,?,
        CASE WHEN ${firstToday} THEN ? ELSE reward_kind END,
        CASE WHEN ${firstToday} THEN ? ELSE reward_amount END,
        id,?,NULL FROM gifts
      WHERE id=? AND to_id=? AND claimed_at IS NULL
      AND EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=? AND active_batch_id=?)`)
      .bind(
        grantId, accountId,
        accountId, dayStart, FIRST_DAILY_GIFT_REWARD.kind,
        accountId, dayStart, FIRST_DAILY_GIFT_REWARD.amount,
        now, giftId, accountId, accountId, grantId
      ),
    db.prepare(`UPDATE balances SET
      brains=brains+COALESCE((SELECT amount FROM grants
        WHERE source_gift_id=? AND account_id=? AND kind='brain' AND settled_at IS NULL),0),
      gold=gold+COALESCE((SELECT amount FROM grants
        WHERE source_gift_id=? AND account_id=? AND kind='gold' AND settled_at IS NULL),0)
      WHERE account_id=? AND EXISTS(SELECT 1 FROM grants WHERE source_gift_id=?
      AND account_id=? AND settled_at IS NULL) AND ${fence}`)
      .bind(giftId, accountId, giftId, accountId, accountId, giftId, accountId, accountId, grantId),
    db.prepare(`UPDATE grants SET settled_at=? WHERE source_gift_id=? AND account_id=?
      AND settled_at IS NULL AND ${fence}`)
      .bind(now, giftId, accountId, accountId, grantId),
    db.prepare(`UPDATE gifts SET claimed_at=? WHERE id=? AND to_id=? AND claimed_at IS NULL
      AND EXISTS(SELECT 1 FROM grants WHERE source_gift_id=? AND account_id=?
        AND settled_at IS NOT NULL) AND ${fence}`)
      .bind(now, giftId, accountId, giftId, accountId, accountId, grantId),
    db.prepare(`UPDATE account_runtime_v3 SET active_batch_id=NULL,active_batch_expires_at=0,updated_at=?
      WHERE account_id=? AND active_batch_id=?`).bind(now, accountId, grantId),
  ]);
  if ((result[0]?.meta.changes ?? 0) !== 1 || (result[4]?.meta.changes ?? 0) !== 1) {
    return { claimed: false, reward: null };
  }
  // Report what the GRANT recorded, not what we intended: an orphan-healed claim pays
  // the pre-existing grant, and the player's toast must match the credited balance.
  const grant = await db
    .prepare("SELECT kind, amount FROM grants WHERE source_gift_id=? AND account_id=?")
    .bind(giftId, accountId)
    .first<{ kind: "brain" | "gold"; amount: number }>();
  return {
    claimed: true,
    reward: grant ? { kind: grant.kind, amount: grant.amount } : null,
  };
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
  await db.batch([
    db.prepare(
      "INSERT INTO sessions (id, account_id, created_at, last_used_at, label) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, accountId, now, now, label),
    db.prepare(
      "UPDATE accounts SET last_online_at = MAX(last_online_at, ?) WHERE id = ?"
    ).bind(now, accountId),
  ]);
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
    await db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
      .bind(now, sessionId).run();
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
  // Protocol v3 permanently removed account_import_state and all client balance
  // imports. Only initialize the authoritative balance row here.
  await db
    .prepare(
      "INSERT OR IGNORE INTO balances (account_id, gold, brains, xp, claimed_level) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(accountId, s.gold, s.brains, s.xp, levelForXp(s.xp))
    .run();
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
  _now: number // retained for call-site stability; level-up no longer credits a ledger entry
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
  // Post-brainflation revert: leveling up no longer grants brains. Still advance
  // claimed_level so this doesn't re-run every call (and stays consistent with any
  // level gating), but credit nothing and write no ledger entry.
  // Reset the protocol-v3 cooldown in the same D1 transaction as claimed_level.
  // Put the reset first and guard it on the level we observed: D1 executes a batch
  // sequentially, so exactly the request that still sees the old claimed_level can
  // reset the cooldown. A stale concurrent request then sees the new level and its
  // reset is a no-op, even if a raid started after the winning batch committed.
  await db.batch([
    db.prepare(`UPDATE raid_state_v3 SET last_started_at = 0 WHERE account_id = ?
      AND EXISTS(SELECT 1 FROM balances WHERE account_id = ? AND claimed_level = ?)`)
      .bind(accountId, accountId, row.claimed_level),
    db.prepare("UPDATE balances SET claimed_level = ? WHERE account_id = ? AND claimed_level = ?")
      .bind(level, accountId, row.claimed_level),
  ]);
  return 0;
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
    // roster_v3 only. This used to shadow every unit into the pre-v3 `roster` table
    // as well, which the v3 reset dropped; the fixture kept working only because the
    // test database was built from a schema.sql that still declared it.
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

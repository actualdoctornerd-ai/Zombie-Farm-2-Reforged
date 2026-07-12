// Thin data-access layer over D1. Handlers call these; no business rules live here
// (those are in logic.ts / the routes) — just typed queries.
import { friendCodeFromBytes, idFromBytes } from "./logic";
import type { GoogleIdentity } from "./auth";

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

/** Insert-or-update the save at a new rev. Caller has already checked baseRev. */
export async function writeSave(
  db: D1Database,
  accountId: string,
  blob: string,
  rev: number,
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO saves (account_id, blob, rev, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET blob = excluded.blob, rev = excluded.rev, updated_at = excluded.updated_at`
    )
    .bind(accountId, blob, rev, now)
    .run();
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
       ORDER BY a.name COLLATE NOCASE`
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

/** Create the friendship in both directions (idempotent via INSERT OR IGNORE). */
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

/** Epoch ms of the most recent gift from `from` to `to`, or null if never. */
export async function lastGiftAt(
  db: D1Database,
  from: string,
  to: string
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT MAX(created_at) AS last FROM gifts WHERE from_id = ? AND to_id = ?"
    )
    .bind(from, to)
    .first<{ last: number | null }>();
  return row?.last ?? null;
}

export async function insertGift(
  db: D1Database,
  from: string,
  to: string,
  now: number
): Promise<void> {
  const id = idFromBytes(rand(16));
  await db
    .prepare(
      "INSERT INTO gifts (id, from_id, to_id, type, created_at) VALUES (?, ?, ?, 'brain', ?)"
    )
    .bind(id, from, to, now)
    .run();
}

export interface InboxGift {
  id: string;
  type: string;
  created_at: number;
  fromName: string;
}

export async function inbox(
  db: D1Database,
  accountId: string
): Promise<InboxGift[]> {
  const res = await db
    .prepare(
      `SELECT g.id, g.type, g.created_at, COALESCE(a.username, 'Player') AS fromName
       FROM gifts g JOIN accounts a ON a.id = g.from_id
       WHERE g.to_id = ? AND g.claimed_at IS NULL
       ORDER BY g.created_at ASC`
    )
    .bind(accountId)
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
    .prepare("UPDATE gifts SET claimed_at = ? WHERE id = ?")
    .bind(now, giftId)
    .run();
}

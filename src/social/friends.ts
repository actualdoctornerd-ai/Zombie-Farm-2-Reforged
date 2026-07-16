// ---------------------------------------------------------------------------
// Friends (offline stub)
// ---------------------------------------------------------------------------
// A local, no-server "friends" list — the OFFLINE-BUILD fallback. Every friend
// here is a purely local entry with no real account behind it. The online friend
// system (sign-in + accounts) has landed and lives server-side (net/api.ts +
// server/): there, a friend is a real account, adds go through friend codes, and
// a gift is a network call that credits the friend's account. This local list is
// what remains when no server is configured; adding a friend is just a name, and
// gifting is recorded locally.
//
// Gifting: each friend can be sent a gift of one brain. Sending is FREE to the
// player (a social faucet, matching the classic daily-gift mechanic) — the brain
// is created for the recipient, not deducted from the sender. Offline there is no
// recipient to deliver to, so the gift is only recorded on the friend.
//
// The once-per-day limit is modelled here with lastGiftAt + GIFT_COOLDOWN_MS.
// ---------------------------------------------------------------------------

export interface Friend {
  /** Stable id. Offline: a local "fN". Online: the friend's server account id. */
  id: string;
  /** Display name. */
  name: string;
  /** Epoch ms this friend was added. */
  addedAt: number;
  /** Epoch ms of the last brain we gifted this friend. Absent = never gifted.
   *  Drives the offline once-per-day gift gate. */
  lastGiftAt?: number;
  /** Lifetime brains gifted to this friend. */
  giftsSent: number;
  /** The friend's shareable code (online friends only). */
  friendCode?: string;
  /** Authoritative online status for the server's current daily gift window. */
  giftOnCooldown?: boolean;
}

/** Milliseconds in a day — the offline gift cooldown window. */
export const GIFT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Whether an offline brain can be gifted to `f` right now. */
export function canGiftBrain(
  f: Friend,
  now: number
): boolean {
  return f.lastGiftAt === undefined || now - f.lastGiftAt >= GIFT_COOLDOWN_MS;
}

/** Pick the lowest free "fN" id not already taken by `existing`. Mirrors the
 *  profile id scheme (profiles.ts) so ids stay short and human-readable. */
export function nextFriendId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`f${n}`)) n++;
  return `f${n}`;
}

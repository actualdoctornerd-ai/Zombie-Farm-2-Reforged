// ---------------------------------------------------------------------------
// Friends (offline stub)
// ---------------------------------------------------------------------------
// A local, no-server "friends" list. Every friend here is a purely local entry —
// there is no real connection, invite, or account behind it yet. This is the seam
// the future online friend system slots into: when sign-in + accounts land, a
// Friend's `id` becomes a real account id and `sendGift` becomes a network call
// that credits the friend's account. Until then, adding a friend is just a name,
// and gifting is recorded locally.
//
// Gifting: each friend can be sent a gift of one brain. Sending is FREE to the
// player (a social faucet, matching the classic daily-gift mechanic) — the brain
// is created for the recipient, not deducted from the sender. Offline there is no
// recipient to deliver to, so the gift is only recorded on the friend.
//
// The once-per-day limit is modelled here (lastGiftAt + GIFT_COOLDOWN_MS) but NOT
// yet enforced: canGiftBrain defaults enforceDaily=false so a brain can always be
// gifted for now. Flip that default (or pass true) when the daily gate lands.
// ---------------------------------------------------------------------------

export interface Friend {
  /** Stable id. Offline: a local "fN". Online: the friend's server account id. */
  id: string;
  /** Display name. */
  name: string;
  /** Epoch ms this friend was added. */
  addedAt: number;
  /** Epoch ms of the last brain we gifted this friend. Absent = never gifted.
   *  Drives the (future) once-per-day gift gate. */
  lastGiftAt?: number;
  /** Lifetime brains gifted to this friend. */
  giftsSent: number;
  /** The friend's shareable code (online friends only). */
  friendCode?: string;
}

/** Milliseconds in a day — the gift cooldown window (not yet enforced). */
export const GIFT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Whether a brain can be gifted to `f` right now.
 *
 *  The once-per-day rule is DEFERRED: with the default `enforceDaily=false` this
 *  always returns true. When the daily limit lands, enforce it here (or pass
 *  `true`) and this becomes the single gate every caller shares. */
export function canGiftBrain(
  f: Friend,
  now: number,
  enforceDaily = false
): boolean {
  if (!enforceDaily) return true;
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

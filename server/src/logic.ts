// Pure, framework-free logic — no D1, no Hono, no crypto side effects. Everything
// here is unit-tested (test/logic.test.ts) and reused by the route handlers.
import type { SaveGame } from "./env";
import { refuseName, type NameRefusal } from "./nameFilter";

/** Milliseconds in a day — the gift cooldown window. Server owns this clock. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Friend-code alphabet: no 0/O/1/I/L to stay unambiguous when read aloud/typed. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Default friend-code body length. 10 chars over a 31-char alphabet ≈ 8.2×10^14
 *  codes — far beyond feasible enumeration, unlike the old 4-char (923,521) space.
 *  Combined with rate limiting and a non-oracle /friends/add, codes are no longer
 *  a practical way to discover or force a relationship with arbitrary accounts. */
export const FRIEND_CODE_LEN = 10;

/** Format N random bytes into a "ZF-XXXXXXXXXX" friend code. Deterministic in
 *  `bytes`, so it's unit-testable; the caller supplies crypto-random bytes at
 *  runtime. Needs at least `len` bytes of entropy for a full-strength code. */
export function friendCodeFromBytes(bytes: Uint8Array, len = FRIEND_CODE_LEN): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[bytes[i % bytes.length] % CODE_ALPHABET.length];
  }
  return `ZF-${s}`;
}

/** UTC day bucket for a timestamp — the once-a-day gift window key. Two sends to
 *  the same recipient in the same bucket collide on the gifts UNIQUE index. */
export function dayBucket(now: number): number {
  return Math.floor(now / DAY_MS);
}

/** Format random bytes into a lowercase hex id of `len` chars (account/gift ids). */
export function idFromBytes(bytes: Uint8Array, len = 24): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.slice(0, len);
}

/** Whether a gift may be sent to a recipient now, given the last time we gifted
 *  THAT recipient. Once per rolling 24h. `lastSentAt` null = never gifted. */
export function canSendGift(lastSentAt: number | null, now: number): boolean {
  return lastSentAt === null || now - lastSentAt >= DAY_MS;
}

/** How recently a friend played, at the only resolution friends are shown it.
 *  Deliberately coarse: the exact timestamp is a behavioural detail about when
 *  someone is at their computer, and nothing in the UI needs more than this. */
export type FriendActivity = "today" | "week" | "away";

/** Bucket a last-online instant for display to a FRIEND. The raw value never
 *  leaves the server — /friends projects this enum instead. */
export function friendActivity(lastOnlineAt: number, now: number): FriendActivity {
  const elapsed = now - lastOnlineAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return "today"; // clock skew ⇒ most recent
  if (elapsed < DAY_MS) return "today";
  if (elapsed < 7 * DAY_MS) return "week";
  return "away";
}

/** What a claimed gift pays out. `amount` is brains for "brain", gold for "gold". */
export interface GiftReward {
  kind: "brain" | "gold";
  amount: number;
}

/** The contents of a gift are rolled ONCE, when it is sent, and stored on the gift
 *  row — never at open time. That removes any incentive to hoard, re-open, or time
 *  claims: what is in the box was decided by the server the moment the sender
 *  clicked, and the recipient cannot influence it. Weights are percent and sum to
 *  100 (asserted by GIFT_REWARD_TOTAL_WEIGHT below). */
export const GIFT_REWARD_TABLE: readonly { weight: number; reward: GiftReward }[] = [
  { weight: 10, reward: { kind: "brain", amount: 1 } },
  { weight: 25, reward: { kind: "gold", amount: 150 } },
  { weight: 25, reward: { kind: "gold", amount: 300 } },
  { weight: 25, reward: { kind: "gold", amount: 500 } },
  { weight: 15, reward: { kind: "gold", amount: 1000 } },
];

/** Sum of GIFT_REWARD_TABLE weights — the exclusive upper bound for a roll. */
export const GIFT_REWARD_TOTAL_WEIGHT = GIFT_REWARD_TABLE.reduce(
  (total, entry) => total + entry.weight,
  0
);

/** The FIRST gift a player opens each UTC day always pays a brain, whatever the
 *  sender's roll stored on it. This is the daily floor that keeps the social loop
 *  worth checking; every later gift that day pays its own rolled contents. */
export const FIRST_DAILY_GIFT_REWARD: GiftReward = { kind: "brain", amount: 1 };

/** Map a roll in [0, GIFT_REWARD_TOTAL_WEIGHT) onto the reward table. Pure and
 *  deterministic in `roll` so the distribution is unit-testable; the caller
 *  supplies crypto randomness (rollGiftReward below). */
export function giftRewardForRoll(roll: number): GiftReward {
  let cursor = Math.min(Math.max(Math.floor(roll), 0), GIFT_REWARD_TOTAL_WEIGHT - 1);
  for (const entry of GIFT_REWARD_TABLE) {
    if (cursor < entry.weight) return { ...entry.reward };
    cursor -= entry.weight;
  }
  return { ...GIFT_REWARD_TABLE[GIFT_REWARD_TABLE.length - 1].reward };
}

/** Roll a gift's contents with crypto randomness. Rejection-samples the 32-bit
 *  draw so the weights stay exact rather than skewed by a modulo remainder. */
export function rollGiftReward(): GiftReward {
  const limit = Math.floor(0x1_0000_0000 / GIFT_REWARD_TOTAL_WEIGHT) * GIFT_REWARD_TOTAL_WEIGHT;
  const buffer = new Uint32Array(1);
  let draw = limit;
  do {
    crypto.getRandomValues(buffer);
    draw = buffer[0];
  } while (draw >= limit);
  return giftRewardForRoll(draw % GIFT_REWARD_TOTAL_WEIGHT);
}

/** Optimistic-concurrency check: a PUT /save is stale if its baseRev no longer
 *  matches the stored rev (another device wrote in between). */
export function isStaleWrite(baseRev: number, currentRev: number): boolean {
  return baseRev !== currentRev;
}

/** Whether an account may import its pre-existing save into server-owned state: it
 *  must have been created strictly before the migration cutoff, and the cutoff must be
 *  a positive instant (0 / unset = imports closed → everyone gets server defaults).
 *  This is the single security decision behind every seed-from-client path (the sync
 *  endpoints AND the gift-claim/grant balance seed), so it lives here as a pure,
 *  unit-tested function rather than inline in the handler. */
export function importEligible(createdAt: number, cutoffMs: number): boolean {
  return (
    Number.isFinite(cutoffMs) &&
    cutoffMs > 0 &&
    Number.isFinite(createdAt) &&
    createdAt < cutoffMs
  );
}

/** Project a friend's save down to the read-only slice a visitor is allowed to
 *  see: the farm layout (terrain, plots, crops), placed objects, and the owned
 *  zombies (so they can be walked up to and inspected). This is defense-in-depth
 *  for the "visit a friend's farm" feature — even a tampered client only ever
 *  receives what this ALLOWLIST returns, so private balances and progression
 *  never leave the server.
 *
 *  Allowlist (not denylist) on purpose: any field added to SaveGame later is
 *  excluded by default until someone deliberately opts it in here.
 *
 *  Kept: version/savedAt (savedAt drives the visitor's offline-growth math so
 *  crops render at the right stage), farm, objects, ownedZombies, zombiePot, and
 *  a sanitized player (name + zombie capacity only — currency/xp zeroed).
 *  Dropped: gold/brains/xp balances, unlockedAbilities, storage, boosts, quests,
 *  raids, and the entire social block (their friends list). */
export function projectFriendSave(save: SaveGame): SaveGame {
  const active = save.player?.petCollection?.active ?? null;
  const pen = [...new Set(save.player?.petCollection?.pen ?? [])].slice(0, 4);
  const visiblePets = [...new Set([...(active ? [active] : []), ...pen])];
  return {
    version: save.version,
    savedAt: save.savedAt,
    player: {
      name: save.player?.name ?? "Zombie Farmer",
      // Capacity is shown as context on the roster; balances/xp are private.
      zombieMax: save.player?.zombieMax ?? 0,
      zombieCount: save.player?.zombieCount ?? 0,
      gold: 0,
      brains: 0,
      xp: 0,
      petCollection: { owned: visiblePets, active, pen },
    },
    farm: save.farm,
    objects: save.objects,
    ownedZombies: save.ownedZombies,
    zombiePot: save.zombiePot,
  };
}

/** Min/max length for a chosen username (display name — not unique). */
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 20;

/** Why a username was refused, for a caller that wants to say something more
 *  useful than "no". `shape` covers length and illegal characters. */
export type UsernameRefusal = "shape" | NameRefusal;

/** Validate a chosen username in both halves — shape, then content.
 *
 *  The SHAPE rule is an allowlist on purpose: only letters, numbers and five
 *  punctuation marks get in, which rejects zero-width characters, RTL overrides,
 *  stacked combining marks and emoji before the content filter ever runs. The
 *  CONTENT rule is `refuseName` (see `nameFilter.ts`), which is where slurs,
 *  profanity and staff impersonation are caught.
 *
 *  Both live behind this one function because a name has exactly one way in, and
 *  a second entry point is how a filter quietly stops applying. */
export function validateUsername(raw: string): { name: string } | { refused: UsernameRefusal } {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned.length < USERNAME_MIN || cleaned.length > USERNAME_MAX) return { refused: "shape" };
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(cleaned)) return { refused: "shape" };
  const refused = refuseName(cleaned);
  return refused ? { refused } : { name: cleaned };
}

/** Normalize + validate a chosen username: trim, collapse internal runs of
 *  whitespace to single spaces, require 2–20 chars of letters/numbers/spaces or
 *  `_ - . '`, and refuse a name the content filter rejects. Returns the cleaned
 *  name, or null if it doesn't qualify. Not unique — two players may share one. */
export function normalizeUsername(raw: string): string | null {
  const result = validateUsername(raw);
  return "name" in result ? result.name : null;
}

/** Normalize/validate a friend code typed by a user (trim, upper, tolerate a
 *  missing "ZF-" prefix and stray spaces). Returns null if it can't be a code. */
export function normalizeFriendCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!cleaned) return null;
  const body = cleaned.startsWith("ZF-")
    ? cleaned.slice(3)
    : cleaned.startsWith("ZF")
      ? cleaned.slice(2)
      : cleaned;
  // 3–12 chars tolerates both legacy 4-char codes and current 10-char codes.
  if (!/^[0-9A-Z]{3,12}$/.test(body)) return null;
  return `ZF-${body}`;
}

/** Derive a short, human device label ("Chrome on Windows") from a User-Agent, for
 *  the Account menu's device list. Coarse on purpose — enough to tell your phone
 *  from your laptop, never a fingerprint. Returns null for a missing/blank UA (shown
 *  as "Unknown device"). Order matters: Edge/Opera advertise "Chrome" too, so they're
 *  matched first; iPadOS Safari reports "Macintosh", so tablet/phone tokens win. */
export function deviceLabel(ua: string | null | undefined): string | null {
  if (!ua || !ua.trim()) return null;
  const s = ua.slice(0, 400); // bound the scan; UA can be attacker-influenced
  const os = /iPhone/.test(s) ? "iPhone"
    : /iPad/.test(s) ? "iPad"
    : /Android/.test(s) ? "Android"
    : /Windows/.test(s) ? "Windows"
    : /Mac OS X|Macintosh/.test(s) ? "macOS"
    : /CrOS/.test(s) ? "ChromeOS"
    : /Linux/.test(s) ? "Linux"
    : "device";
  const br = /Edg(?:e|A|iOS)?\//.test(s) ? "Edge"
    : /OPR\/|Opera/.test(s) ? "Opera"
    : /Firefox\/|FxiOS\//.test(s) ? "Firefox"
    : /Chrome\/|CriOS\//.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari"
    : "Browser";
  return `${br} on ${os}`;
}

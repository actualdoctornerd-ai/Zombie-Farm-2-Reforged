// Pure, framework-free logic — no D1, no Hono, no crypto side effects. Everything
// here is unit-tested (test/logic.test.ts) and reused by the route handlers.
import type { SaveGame } from "./env";

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

/** Optimistic-concurrency check: a PUT /save is stale if its baseRev no longer
 *  matches the stored rev (another device wrote in between). */
export function isStaleWrite(baseRev: number, currentRev: number): boolean {
  return baseRev !== currentRev;
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

/** Normalize + validate a chosen username: trim, collapse internal runs of
 *  whitespace to single spaces, and require 2–20 chars of letters/numbers/spaces
 *  or `_ - . '`. Returns the cleaned name, or null if it doesn't qualify. Not
 *  unique — two players may share one. */
export function normalizeUsername(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned.length < USERNAME_MIN || cleaned.length > USERNAME_MAX) return null;
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(cleaned)) return null;
  return cleaned;
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

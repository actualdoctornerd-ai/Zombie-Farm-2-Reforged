// Pure, framework-free logic — no D1, no Hono, no crypto side effects. Everything
// here is unit-tested (test/logic.test.ts) and reused by the route handlers.

/** Milliseconds in a day — the gift cooldown window. Server owns this clock. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Friend-code alphabet: no 0/O/1/I/L to stay unambiguous when read aloud/typed. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Format N random bytes into a "ZF-XXXX" friend code. Deterministic in `bytes`,
 *  so it's unit-testable; the caller supplies crypto-random bytes at runtime. */
export function friendCodeFromBytes(bytes: Uint8Array, len = 4): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[bytes[i % bytes.length] % CODE_ALPHABET.length];
  }
  return `ZF-${s}`;
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
  if (!/^[0-9A-Z]{3,8}$/.test(body)) return null;
  return `ZF-${body}`;
}

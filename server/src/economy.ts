// Pure, framework-free economy rules — no D1, no Hono. Unit-tested; reused by the
// /economy route handlers and db.applyEvents.
//
// The server owns the balance; each currency change is a validated, idempotent
// ledger EVENT. What's enforced today:
//   • spends can never overdraw the balance;
//   • earns are bounded by a per-currency cap (a plausibility ceiling);
//   • the reason must be a known one; xp can only ever be earned.
// What's NOT yet enforced (the transitional gap): the EXACT amount of an earn is
// still client-computed — the server bounds it but doesn't yet recompute "this
// carrot is worth N" from its own farm/roster state. Closing that is the next
// layer (server-owned farm simulation); see SECURITY.md items 1-2.

export type Currency = "gold" | "brains" | "xp";
export const CURRENCIES: readonly Currency[] = ["gold", "brains", "xp"] as const;

export interface Balance {
  gold: number;
  brains: number;
  xp: number;
}

/** One currency change. `id` is a client-generated idempotency key (uuid): the same
 *  id is applied at most once, so retries and concurrent flushes are safe. */
export interface EconomyEvent {
  id: string;
  currency: Currency;
  delta: number; // signed; >0 earn, <0 spend
  reason: string;
}

/** Per-event earn ceiling per currency — a plausibility bound, generous enough for
 *  the biggest legitimate single credit (a high raid payout, a valuable sell) yet
 *  finite so a modified client can't mint an arbitrary balance. Spends have no cap
 *  beyond "can't overdraw". */
export const EARN_CAP: Record<Currency, number> = {
  gold: 500_000,
  brains: 1_000,
  xp: 500_000,
};

/** Reasons we accept on a ledger event. An unknown reason is rejected outright so a
 *  client can't smuggle an unmodelled credit through. */
export const REASONS: ReadonlySet<string> = new Set([
  // earns
  "harvest", "sell", "raid_loot", "quest", "levelup", "gift", "refund", "tutorial",
  // spends
  "purchase", "upgrade", "plow", "plant", "pot", "combine",
  // catch-alls (still bounded/overdraw-checked)
  "misc",
]);

/** Sane upper bounds when SEEDING the server balance from a player's existing save
 *  (one-time migration). Clamps a wildly-inflated save so a pre-existing edit can't
 *  seed an absurd authoritative balance; legitimate progress is far below these. */
const SEED_MAX: Record<Currency, number> = {
  gold: 100_000_000,
  brains: 10_000_000,
  xp: 1_000_000_000,
};

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && Number.isFinite(n);
}

/** Clamp a seed balance to non-negative integers within SEED_MAX. */
export function clampSeed(raw: Partial<Balance> | null | undefined): Balance {
  const one = (v: unknown, c: Currency) =>
    isInt(v) ? Math.max(0, Math.min(SEED_MAX[c], v as number)) : 0;
  return {
    gold: one(raw?.gold, "gold"),
    brains: one(raw?.brains, "brains"),
    xp: one(raw?.xp, "xp"),
  };
}

/** Validate one event against the current balance. Does NOT mutate. Returns ok, or
 *  the reason it was rejected. Callers apply accepted events in order, updating the
 *  running balance between them (a spend depends on prior events in the batch). */
export function validateEvent(
  ev: EconomyEvent,
  bal: Balance
): { ok: true } | { ok: false; error: string } {
  if (!ev || typeof ev.id !== "string" || !ev.id) return { ok: false, error: "bad_id" };
  if (!CURRENCIES.includes(ev.currency)) return { ok: false, error: "bad_currency" };
  if (!isInt(ev.delta)) return { ok: false, error: "bad_delta" };
  if (!REASONS.has(ev.reason)) return { ok: false, error: "bad_reason" };
  if (ev.delta === 0) return { ok: false, error: "zero_delta" };
  if (ev.currency === "xp" && ev.delta < 0) return { ok: false, error: "xp_no_spend" };
  if (ev.delta > 0) {
    if (ev.delta > EARN_CAP[ev.currency]) return { ok: false, error: "earn_over_cap" };
  } else {
    if (bal[ev.currency] + ev.delta < 0) return { ok: false, error: "insufficient" };
  }
  return { ok: true };
}

/** Apply a batch of events to a balance in order, skipping any that fail validation
 *  or duplicate an already-applied id. Pure: returns the resulting balance plus a
 *  per-event verdict. The caller persists the balance and the accepted event ids. */
export function applyBatch(
  events: EconomyEvent[],
  start: Balance,
  alreadyApplied: ReadonlySet<string>
): {
  balance: Balance;
  results: { id: string; status: "applied" | "duplicate" | "rejected"; error?: string }[];
} {
  const balance: Balance = { ...start };
  const seen = new Set(alreadyApplied);
  const results: { id: string; status: "applied" | "duplicate" | "rejected"; error?: string }[] = [];
  for (const ev of events) {
    if (ev && typeof ev.id === "string" && seen.has(ev.id)) {
      results.push({ id: ev.id, status: "duplicate" });
      continue;
    }
    const v = validateEvent(ev, balance);
    if (!v.ok) {
      results.push({ id: ev?.id ?? "", status: "rejected", error: v.error });
      continue;
    }
    balance[ev.currency] += ev.delta;
    seen.add(ev.id);
    results.push({ id: ev.id, status: "applied" });
  }
  return { balance, results };
}

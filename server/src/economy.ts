// Pure, framework-free economy rules — no D1, no Hono. Unit-tested; reused by the
// /economy route handlers and db.applyEvents.
//
// The server owns the balance; each currency change is a validated, idempotent
// ledger EVENT. This endpoint is now SPEND-ONLY: a public request may only ever
// DEBIT the balance. What's enforced:
//   • no client-authored EARN — any delta > 0 is rejected (earn_forbidden);
//   • spends can never overdraw the balance;
//   • the reason must be a known spend reason.
// Rationale (SECURITY.md "own-account manipulation"): a positive delta let a
// modified client mint currency at will (reason "misc"/"sell"/… up to a cap, with
// fresh ids, unbounded batches). Earns must instead be derived by the server from
// a trusted source — crop harvest (/farm/actions), roster sell (/roster/actions),
// shop refunds, gift claim, and (later) server-owned quest/level/raid grants. Until
// those cover every source, an un-migrated earn simply doesn't persist; that's the
// intended transitional behaviour, not a hole.

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

/** Reasons we accept on a (spend-only) ledger event. Every one is a DEBIT reason;
 *  earn reasons were removed with the earn path. An unknown reason is rejected
 *  outright so a client can't smuggle an unmodelled change through. */
export const REASONS: ReadonlySet<string> = new Set([
  // spends only
  "purchase", "upgrade", "plow", "plant", "pot", "combine",
  // catch-all (still a debit; overdraw-checked)
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
  // SPEND-ONLY: no public request may author a positive currency delta. Earns must
  // be derived by the server from a trusted source, never asserted by the client.
  if (ev.delta > 0) return { ok: false, error: "earn_forbidden" };
  // xp is never spent (and never earned here) — reject any xp event outright.
  if (ev.currency === "xp") return { ok: false, error: "xp_no_spend" };
  if (bal[ev.currency] + ev.delta < 0) return { ok: false, error: "insufficient" };
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

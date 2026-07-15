// Pure rules for server-owned boost inventory actions — no D1, no Hono. Unit-tested;
// db.applyInventoryActions supplies the current count / balance and persists the
// computed effects (count deltas + a currency debit for a buy).
import type { Balance } from "./economy";
import { type BoostEcon, MAX_STACK } from "./boostCatalog";
import { levelAllows } from "./farm";

// NOTE: there is deliberately no public `grant`. A grant would let a modified client
// mint any boost (including the raid-cooldown voucher) for free. Boosts enter the
// inventory only through a priced `buy`; loot/reward grants must come from a trusted
// server subsystem with a unique source id (SECURITY.md own-account plan, item 3).
export type InventoryAction =
  | { id: string; type: "buy"; key: string } // grants perPurchase, debits the catalog cost
  // consume. For a GIFT voucher (econ.gift set) a use is a redeem: it consumes exactly
  // one voucher and grants that zombie, so `unitId` (the client's id for the new unit)
  // is required and `qty` is ignored.
  | { id: string; type: "use"; key: string; qty?: number; unitId?: string };

/** Currency a buy debits, plus the count it grants. */
export type BuyPlan =
  | { ok: true; currency: "gold" | "brains"; cost: number; grant: number }
  | { ok: false; error: string };

/** A buy: the boost must exist, be unlocked at the player's level, and the player must
 *  afford the EXACT catalog cost. `have` is the current count; capped so a buy can't
 *  overflow the stack ceiling. `level` is derived from server-owned xp, never client-sent
 *  (the gift vouchers are level 25 — without this a level-1 client could buy one). */
export function planBuy(
  _a: Extract<InventoryAction, { type: "buy" }>,
  econ: BoostEcon | undefined,
  bal: Balance,
  have: number,
  level: number
): BuyPlan {
  if (!econ) return { ok: false, error: "bad_item" };
  if (!levelAllows(level, econ.level)) return { ok: false, error: "locked" };
  const currency = econ.brains ? "brains" : "gold";
  if (bal[currency] < econ.cost) return { ok: false, error: "insufficient" };
  if (have + econ.perPurchase > MAX_STACK) return { ok: false, error: "stack_full" };
  return { ok: true, currency, cost: econ.cost, grant: econ.perPurchase };
}

export type CountPlan = { ok: true; delta: number } | { ok: false; error: string };

/** Normalize an optional quantity to a positive integer (default 1). */
function qtyOf(q: unknown): number {
  return Number.isInteger(q) && (q as number) > 0 ? (q as number) : 1;
}

/** A use: must own at least `qty`. Returns the negative count delta to apply. */
export function planUse(a: Extract<InventoryAction, { type: "use" }>, have: number): CountPlan {
  const qty = qtyOf(a.qty);
  if (have < qty) return { ok: false, error: "none_owned" };
  return { ok: true, delta: -qty };
}

/** Redeeming a gift voucher: consume exactly one and grant `econ.gift` as an owned unit. */
export type RedeemPlan =
  | { ok: true; delta: -1; unitId: string; unitKey: string }
  | { ok: false; error: string };

/** A gift-voucher use. The zombie comes from the CATALOG (`econ.gift`), never from the
 *  client, so a redeem can't name a richer zombie than the voucher grants. `ownsGift`
 *  is whether the roster already holds that zombie — the game's "1 per farm" rule, which
 *  also bounds the redeem: one voucher in, at most one unit out, and never a duplicate.
 *  The client supplies only `unitId` (the roster id to file it under), which decides no
 *  value but makes the grant idempotent and lets the client match up its optimistic unit. */
export function planGiftRedeem(
  a: Extract<InventoryAction, { type: "use" }>,
  econ: BoostEcon | undefined,
  have: number,
  ownsGift: boolean
): RedeemPlan {
  if (!econ?.gift) return { ok: false, error: "not_a_gift" };
  if (have < 1) return { ok: false, error: "none_owned" };
  if (typeof a.unitId !== "string" || !a.unitId) return { ok: false, error: "bad_unit" };
  if (ownsGift) return { ok: false, error: "already_owned" };
  return { ok: true, delta: -1, unitId: a.unitId, unitKey: econ.gift };
}

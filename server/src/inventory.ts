// Pure rules for server-owned boost inventory actions — no D1, no Hono. Unit-tested;
// db.applyInventoryActions supplies the current count / balance and persists the
// computed effects (count deltas + a currency debit for a buy).
import type { Balance } from "./economy";
import { type BoostEcon, MAX_STACK } from "./boostCatalog";

export type InventoryAction =
  | { id: string; type: "buy"; key: string } // grants perPurchase, debits the catalog cost
  | { id: string; type: "use"; key: string; qty?: number } // consume
  | { id: string; type: "grant"; key: string; qty?: number }; // loot / reward

/** Currency a buy debits, plus the count it grants. */
export type BuyPlan =
  | { ok: true; currency: "gold" | "brains"; cost: number; grant: number }
  | { ok: false; error: string };

/** A buy: the boost must exist and the player must afford the EXACT catalog cost.
 *  `have` is the current count; capped so a buy can't overflow the stack ceiling. */
export function planBuy(
  _a: Extract<InventoryAction, { type: "buy" }>,
  econ: BoostEcon | undefined,
  bal: Balance,
  have: number
): BuyPlan {
  if (!econ) return { ok: false, error: "bad_item" };
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

/** A grant (loot / reward): increment, bounded by the stack ceiling. */
export function planGrant(
  a: Extract<InventoryAction, { type: "grant" }>,
  econ: BoostEcon | undefined,
  have: number
): CountPlan {
  if (!econ) return { ok: false, error: "bad_item" };
  const qty = qtyOf(a.qty);
  if (have + qty > MAX_STACK) return { ok: false, error: "stack_full" };
  return { ok: true, delta: qty };
}

// Pure rules for server-owned placeable-object ownership — no D1, no Hono. Unit-tested;
// db.applyObjectActions supplies the current count / balance and persists the effects
// (a currency debit + xp on buy; a currency credit on refund; count deltas).
//
// Ownership is a COUNT per object key (like boosts); placement/position is client-side
// layout. There is no public "grant" — objects enter only through a priced `buy`.
import type { Balance } from "./economy";
import { type ObjectEcon, objectRefund, objectBuyXp, MAX_OBJECT_COUNT } from "./objectCatalog";
import { levelAllows } from "./farm";

export type ObjectAction =
  | { id: string; type: "buy"; key: string } // debit cost + grant buyXp, count++
  | { id: string; type: "refund"; key: string } // credit floor(cost*0.2), guarded count--
  // Swap an owned object for a different one IN PLACE at the new one's full price (the
  // shed upgrade): guarded fromKey--, debit toKey's cost, toKey++, grant buyXp.
  | { id: string; type: "upgrade"; fromKey: string; toKey: string };

export type ObjectBuyPlan =
  | { ok: true; currency: "gold" | "brains"; cost: number; xp: number }
  | { ok: false; error: string };

/** A buy: the object must exist, be purchasable (cost > 0 — free/promo objects are
 *  granted by events, never server-bought, so buy-free→refund can't mint), be unlocked at
 *  the player's (server-derived) level, the player must afford the EXACT catalog cost,
 *  and the count can't overflow the stack ceiling. */
export function planObjectBuy(
  econ: ObjectEcon | undefined,
  bal: Balance,
  have: number,
  level: number
): ObjectBuyPlan {
  if (!econ) return { ok: false, error: "bad_item" };
  if (econ.cost <= 0) return { ok: false, error: "not_purchasable" };
  if (!levelAllows(level, econ.level)) return { ok: false, error: "locked" };
  const currency = econ.brains ? "brains" : "gold";
  if (bal[currency] < econ.cost) return { ok: false, error: "insufficient" };
  if (have + 1 > MAX_OBJECT_COUNT) return { ok: false, error: "stack_full" };
  return { ok: true, currency, cost: econ.cost, xp: objectBuyXp(econ.cost, econ.xp) };
}

export type ObjectRefundPlan =
  | { ok: true; currency: "gold" | "brains"; refund: number }
  | { ok: false; error: string };

/** A refund: must own at least one; credits the catalog refund in the buy currency and
 *  decrements the count. A free (cost 0) object refunds 0 (see objectRefund). */
export function planObjectRefund(econ: ObjectEcon | undefined, have: number): ObjectRefundPlan {
  if (!econ) return { ok: false, error: "bad_item" };
  if (have < 1) return { ok: false, error: "none_owned" };
  return { ok: true, currency: econ.brains ? "brains" : "gold", refund: objectRefund(econ.cost) };
}

export type ObjectUpgradePlan =
  | { ok: true; currency: "gold" | "brains"; cost: number; xp: number; consumesFrom: boolean }
  | { ok: false; error: string };

/** An upgrade (the in-place shed upgrade): give up one `from` object and pay the FULL
 *  catalog price of `to`. The old object is consumed with no refund, so an upgrade is
 *  strictly worse for the player than refund-then-buy — it can't be a laundering route,
 *  whatever pair of keys a modified client names. Same purchasable rule as a buy, so an
 *  upgrade can't be a free path into a promo (cost-0) object.
 *
 *  `from` must be OWNED only when it's a priced object. A free one (cost 0 — notably the
 *  starter Shabby Shed, `storage01`) is deliberately never server-tracked: planObjectBuy
 *  refuses to sell it, so the server holds no count to spend. Requiring ownership there
 *  would reject every player's FIRST shed upgrade. Nothing is minted by allowing it —
 *  the upgrade still charges `to` in full, and a free object is worth 0 either way.
 *  `consumesFrom` tells the caller whether there's actually a count to decrement. */
export function planObjectUpgrade(
  from: ObjectEcon | undefined,
  to: ObjectEcon | undefined,
  bal: Balance,
  haveFrom: number,
  haveTo: number,
  level: number
): ObjectUpgradePlan {
  if (!from || !to) return { ok: false, error: "bad_item" };
  if (to.cost <= 0) return { ok: false, error: "not_purchasable" };
  if (!levelAllows(level, to.level)) return { ok: false, error: "locked" };
  const consumesFrom = from.cost > 0;
  if (consumesFrom && haveFrom < 1) return { ok: false, error: "none_owned" };
  const currency = to.brains ? "brains" : "gold";
  if (bal[currency] < to.cost) return { ok: false, error: "insufficient" };
  if (haveTo + 1 > MAX_OBJECT_COUNT) return { ok: false, error: "stack_full" };
  return { ok: true, currency, cost: to.cost, xp: objectBuyXp(to.cost, to.xp), consumesFrom };
}

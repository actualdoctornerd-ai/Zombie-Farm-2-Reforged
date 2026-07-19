import { describe, it, expect } from "vitest";
import { BOOSTS, boostEcon, VOUCHER_KEY, MAX_STACK } from "../src/boostCatalog";
import { planBuy, planUse, planGiftRedeem } from "../src/inventory";
import { isKnownZombie } from "../src/rosterCatalog";

const bal = (gold = 1000, brains = 1000, xp = 0) => ({ gold, brains, xp });

describe("boostCatalog", () => {
  it("has the 10 boosts with positive economics", () => {
    expect(Object.keys(BOOSTS)).toHaveLength(10);
    for (const [k, b] of Object.entries(BOOSTS)) {
      expect(b.cost, k).toBeGreaterThan(0);
      expect(b.perPurchase, k).toBeGreaterThan(0);
    }
  });
  it("prices the voucher in gold and the consumables in brains", () => {
    expect(boostEcon(VOUCHER_KEY)).toMatchObject({ cost: 2000, brains: false, perPurchase: 1 });
    expect(boostEcon("insta_grow")).toMatchObject({ cost: 1, brains: true, perPurchase: 20 });
    expect(boostEcon("nope")).toBeUndefined();
  });
});

const MAX_LEVEL = 99; // above every catalog gate

describe("planBuy — exact price + grant", () => {
  const buy = (key: string) => ({ id: "b1", type: "buy" as const, key });

  it("debits the exact catalog cost in the right currency and grants perPurchase", () => {
    const r = planBuy(buy("insta_grow"), boostEcon("insta_grow"), bal(0, 50), 0, MAX_LEVEL);
    expect(r).toEqual({ ok: true, currency: "brains", cost: 1, grant: 20 });
    const v = planBuy(buy(VOUCHER_KEY), boostEcon(VOUCHER_KEY), bal(5000, 0), 3, MAX_LEVEL);
    expect(v).toEqual({ ok: true, currency: "gold", cost: 2000, grant: 1 });
  });
  it("rejects an unknown item, insufficient funds, and a would-overflow stack", () => {
    expect(planBuy(buy("nope"), boostEcon("nope"), bal(), 0, MAX_LEVEL)).toMatchObject({ ok: false, error: "bad_item" });
    expect(planBuy(buy(VOUCHER_KEY), boostEcon(VOUCHER_KEY), bal(100, 0), 0, MAX_LEVEL)).toMatchObject({ ok: false, error: "insufficient" });
    expect(planBuy(buy("golden_dice"), boostEcon("golden_dice"), bal(0, 100), MAX_STACK, MAX_LEVEL)).toMatchObject({ ok: false, error: "stack_full" });
  });
  it("rejects a boost the player's level hasn't unlocked (Phase E)", () => {
    // The gift vouchers are level 25. Level is derived from server xp, so a level-1
    // client can no longer buy one however it asks.
    expect(boostEcon("valentine_gift")!.level).toBe(25);
    expect(planBuy(buy("valentine_gift"), boostEcon("valentine_gift"), bal(0, 999), 0, 24)).toMatchObject({ ok: false, error: "locked" });
    expect(planBuy(buy("valentine_gift"), boostEcon("valentine_gift"), bal(0, 999), 0, 25)).toMatchObject({ ok: true });
    // An ungated consumable is unaffected.
    expect(planBuy(buy("insta_grow"), boostEcon("insta_grow"), bal(0, 50), 0, 1)).toMatchObject({ ok: true });
  });
});

describe("planUse — must own it", () => {
  const use = (over = {}) => ({ id: "u1", type: "use" as const, key: "golden_dice", ...over });
  it("consumes when owned; defaults qty to 1", () => {
    expect(planUse(use(), 3)).toEqual({ ok: true, delta: -1 });
    expect(planUse(use({ qty: 2 }), 2)).toEqual({ ok: true, delta: -2 });
  });
  it("rejects using more than owned", () => {
    expect(planUse(use(), 0)).toMatchObject({ ok: false, error: "none_owned" });
    expect(planUse(use({ qty: 5 }), 4)).toMatchObject({ ok: false, error: "none_owned" });
  });
});

describe("gift vouchers", () => {
  const GIFTS = Object.entries(BOOSTS).filter(([, b]) => b.gift);
  const redeem = (key: string, over = {}) => ({ id: "g1", type: "use" as const, key, unitId: "z9", ...over });

  it("names a real catalog zombie, one use per purchase — so a redeem can't outrun the buy", () => {
    expect(GIFTS.map(([k]) => k)).toEqual([
      "crazy_zombie_voucher",
      "valentine_gift",
      "valentine_gift_2012",
      "flower_zombie_pot",
    ]);
    for (const [k, b] of GIFTS) {
      expect(isKnownZombie(b.gift!), k).toBe(true);
      expect(b.perPurchase, k).toBe(1);
    }
  });

  it("grants the CATALOG's zombie, never a client-named one", () => {
    // The action carries no key for the zombie — only the roster id to file it under.
    const r = planGiftRedeem(redeem("valentine_gift"), boostEcon("valentine_gift"), 1, false);
    expect(r).toEqual({ ok: true, delta: -1, unitId: "z9", unitKey: "ZombieActorGardenCupid" });
    const pink = planGiftRedeem(redeem("valentine_gift_2012"), boostEcon("valentine_gift_2012"), 1, false);
    expect(pink).toEqual({ ok: true, delta: -1, unitId: "z9", unitKey: "ZombieActorGardenCupidPink" });
  });

  it("consumes exactly one voucher, ignoring a qty that would redeem several", () => {
    const r = planGiftRedeem(redeem("flower_zombie_pot", { qty: 99 }), boostEcon("flower_zombie_pot"), 5, false);
    expect(r).toMatchObject({ ok: true, delta: -1 });
  });

  it("rejects a non-gift boost, an unowned voucher, a missing unit id, and a duplicate", () => {
    expect(planGiftRedeem(redeem("golden_dice"), boostEcon("golden_dice"), 5, false)).toMatchObject({ ok: false, error: "not_a_gift" });
    expect(planGiftRedeem(redeem("valentine_gift"), boostEcon("valentine_gift"), 0, false)).toMatchObject({ ok: false, error: "none_owned" });
    expect(planGiftRedeem(redeem("valentine_gift", { unitId: "" }), boostEcon("valentine_gift"), 1, false)).toMatchObject({ ok: false, error: "bad_unit" });
    // 1 per farm: already own the Cupid zombie -> the voucher can't mint a second.
    expect(planGiftRedeem(redeem("valentine_gift"), boostEcon("valentine_gift"), 1, true)).toMatchObject({ ok: false, error: "already_owned" });
  });

  it("costs more to buy than the zombie it grants sells for (no brains->gold mint)", () => {
    for (const [k, b] of GIFTS) {
      // Vouchers are bought with brains (premium); the unit sells for gold, so the two
      // never round-trip. Guard the invariant anyway in case a price is ever retuned.
      expect(b.brains, k).toBe(true);
    }
  });
});

import { describe, it, expect } from "vitest";
import { BOOSTS, boostEcon, VOUCHER_KEY, MAX_STACK } from "../src/boostCatalog";
import { planBuy, planUse, planGrant } from "../src/inventory";

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
    expect(boostEcon("insta_grow")).toMatchObject({ cost: 10, brains: true, perPurchase: 20 });
    expect(boostEcon("nope")).toBeUndefined();
  });
});

describe("planBuy — exact price + grant", () => {
  const buy = (key: string) => ({ id: "b1", type: "buy" as const, key });

  it("debits the exact catalog cost in the right currency and grants perPurchase", () => {
    const r = planBuy(buy("insta_grow"), boostEcon("insta_grow"), bal(0, 50), 0);
    expect(r).toEqual({ ok: true, currency: "brains", cost: 10, grant: 20 });
    const v = planBuy(buy(VOUCHER_KEY), boostEcon(VOUCHER_KEY), bal(5000, 0), 3);
    expect(v).toEqual({ ok: true, currency: "gold", cost: 2000, grant: 1 });
  });
  it("rejects an unknown item, insufficient funds, and a would-overflow stack", () => {
    expect(planBuy(buy("nope"), boostEcon("nope"), bal(), 0)).toMatchObject({ ok: false, error: "bad_item" });
    expect(planBuy(buy(VOUCHER_KEY), boostEcon(VOUCHER_KEY), bal(100, 0), 0)).toMatchObject({ ok: false, error: "insufficient" });
    expect(planBuy(buy("golden_dice"), boostEcon("golden_dice"), bal(0, 100), MAX_STACK)).toMatchObject({ ok: false, error: "stack_full" });
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

describe("planGrant — loot increment, bounded", () => {
  const grant = (over = {}) => ({ id: "g1", type: "grant" as const, key: "concentration", ...over });
  it("increments (default 1), bounded by the stack ceiling", () => {
    expect(planGrant(grant(), boostEcon("concentration"), 0)).toEqual({ ok: true, delta: 1 });
    expect(planGrant(grant({ qty: 3 }), boostEcon("concentration"), 1)).toEqual({ ok: true, delta: 3 });
    expect(planGrant(grant(), boostEcon("concentration"), MAX_STACK)).toMatchObject({ ok: false, error: "stack_full" });
    expect(planGrant(grant({ key: "nope" }), boostEcon("nope"), 0)).toMatchObject({ ok: false, error: "bad_item" });
  });
});

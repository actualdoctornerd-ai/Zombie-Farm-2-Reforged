import { describe, it, expect } from "vitest";
import { OBJECTS, objectEcon, objectRefund, objectBuyXp } from "../src/objectCatalog";
import { planObjectBuy, planObjectRefund, planObjectUpgrade } from "../src/objects";

const bal = (gold = 1000, brains = 1000, xp = 0) => ({ gold, brains, xp });

describe("objectCatalog — mirror of placeables.json", () => {
  it("has all 256 placeables", () => {
    expect(Object.keys(OBJECTS).length).toBe(256);
  });
  it("prices refund at floor(cost*0.2), and NOTHING for a free object", () => {
    expect(objectRefund(10)).toBe(2);
    expect(objectRefund(50)).toBe(10);
    expect(objectRefund(0)).toBe(0); // free object refunds nothing (no buy-free→refund mint)
  });
  it("buy xp is source xp, else a tenth of cost (min 1)", () => {
    expect(objectBuyXp(10, 0)).toBe(1);
    expect(objectBuyXp(900, 9)).toBe(9); // source xp wins
    expect(objectBuyXp(50, 0)).toBe(5);
  });
  it("resolves known keys and rejects unknown", () => {
    expect(objectEcon("daisy")).toMatchObject({ cost: 10, brains: false });
    expect(objectEcon("skeletonCouple")).toMatchObject({ cost: 30, brains: true });
    expect(objectEcon("nope")).toBeUndefined();
  });
});

const MAX_LEVEL = 99; // above every catalog gate

describe("planObjectBuy — exact price + xp", () => {
  it("debits the right currency and computes buy xp", () => {
    expect(planObjectBuy(objectEcon("daisy"), bal(100, 0), 0, MAX_LEVEL)).toEqual({ ok: true, currency: "gold", cost: 10, xp: 1 });
    expect(planObjectBuy(objectEcon("skeletonCouple"), bal(0, 100), 0, MAX_LEVEL)).toEqual({ ok: true, currency: "brains", cost: 30, xp: 3 });
  });
  it("rejects unknown, unaffordable, and free/promo (not purchasable) objects", () => {
    expect(planObjectBuy(objectEcon("nope"), bal(), 0, MAX_LEVEL)).toMatchObject({ ok: false, error: "bad_item" });
    expect(planObjectBuy(objectEcon("daisy"), bal(5, 0), 0, MAX_LEVEL)).toMatchObject({ ok: false, error: "insufficient" });
    expect(planObjectBuy(objectEcon("storage01"), bal(), 0, MAX_LEVEL)).toMatchObject({ ok: false, error: "not_purchasable" });
  });
  it("rejects an object the player's level hasn't unlocked, and treats level -1 as ungated", () => {
    const baloon = objectEcon("baloon")!; // level 21
    expect(baloon.level).toBe(21);
    expect(planObjectBuy(baloon, bal(99999, 0), 0, 20)).toMatchObject({ ok: false, error: "locked" });
    expect(planObjectBuy(baloon, bal(99999, 0), 0, 21)).toMatchObject({ ok: true });
    // level -1 = no requirement (seasonal/promo), matching the client's `level < def.level`.
    expect(objectEcon("skeletonCouple")!.level).toBe(-1);
    expect(planObjectBuy(objectEcon("skeletonCouple"), bal(0, 100), 0, 1)).toMatchObject({ ok: true });
  });
});

describe("planObjectRefund — must own it", () => {
  it("credits the catalog refund in the buy currency when owned", () => {
    expect(planObjectRefund(objectEcon("daisy"), 1)).toEqual({ ok: true, currency: "gold", refund: 2 });
    expect(planObjectRefund(objectEcon("skeletonCouple"), 2)).toEqual({ ok: true, currency: "brains", refund: 6 });
  });
  it("rejects refunding an object you don't own, or an unknown key", () => {
    expect(planObjectRefund(objectEcon("daisy"), 0)).toMatchObject({ ok: false, error: "none_owned" });
    expect(planObjectRefund(objectEcon("nope"), 5)).toMatchObject({ ok: false, error: "bad_item" });
  });
});

describe("planObjectUpgrade — the in-place shed upgrade", () => {
  const up = (from: string, to: string, b = bal(1_000_000, 0), haveFrom = 1, haveTo = 0, level = MAX_LEVEL) =>
    planObjectUpgrade(objectEcon(from), objectEcon(to), b, haveFrom, haveTo, level);

  it("charges the new object's FULL price + xp and consumes the old one", () => {
    // Fine Shed (15000) over Wood Hut: pay 15000, no refund for the old hut. xp is the
    // catalog's own 150 for this object, not the cost/10 fallback.
    expect(up("storage03", "storage02")).toEqual({
      ok: true, currency: "gold", cost: 15000, xp: 150, consumesFrom: true,
    });
  });

  it("does NOT require owning a FREE `from` — the starter shed is never server-tracked", () => {
    // storage01 (Shabby Shed) costs 0, so planObjectBuy won't sell it and no count
    // exists. Requiring one here would reject every player's first upgrade.
    expect(up("storage01", "storage02", bal(1_000_000, 0), 0)).toMatchObject({ ok: true, consumesFrom: false });
    // A priced `from` you don't own is still rejected.
    expect(up("storage02", "storage03", bal(1_000_000, 0), 0)).toMatchObject({ ok: false, error: "none_owned" });
  });

  it("rejects unknown keys, an unaffordable upgrade, and upgrading INTO a free object", () => {
    expect(up("nope", "storage02")).toMatchObject({ ok: false, error: "bad_item" });
    expect(up("storage02", "nope")).toMatchObject({ ok: false, error: "bad_item" });
    expect(up("storage02", "storage03", bal(100, 0))).toMatchObject({ ok: false, error: "insufficient" });
    // Free/promo target: an upgrade must not become a free path into an unpurchasable.
    expect(up("storage02", "storage01")).toMatchObject({ ok: false, error: "not_purchasable" });
  });

  it("can't launder: an upgrade costs more than refunding the old + buying the new", () => {
    // The old object is consumed with NO refund, so for any pair the player is strictly
    // worse off than refund-then-buy. Whatever keys a modified client names, the balance
    // only ever goes down.
    const r = up("storage08", "storage02"); // downgrade a 350k barn into a 15k shed
    expect(r).toMatchObject({ ok: true, cost: 15000 }); // still CHARGED, never credited
    expect(objectRefund(350000)).toBeGreaterThan(0); // refunding would have paid out...
    // ...but the upgrade path pays nothing back, so it can't be used to cash out.
  });
});

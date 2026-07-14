import { describe, it, expect } from "vitest";
import { planPlant, planHarvest, type PlotRecord } from "../src/farm";
import { cropEcon, CROPS } from "../src/catalog";

const bal = (gold = 1000, brains = 0, xp = 0) => ({ gold, brains, xp });
const NOW = 1_700_000_000_000;

describe("catalog", () => {
  it("has the 12 veggie crops with positive economics", () => {
    expect(Object.keys(CROPS)).toHaveLength(12);
    for (const [k, c] of Object.entries(CROPS)) {
      expect(c.cost, k).toBeGreaterThan(0);
      expect(c.sell, k).toBeGreaterThan(0);
      expect(c.growMs, k).toBeGreaterThan(0);
    }
  });
});

describe("planPlant — exact seed cost + plot record", () => {
  const plant = (over = {}) => ({ id: "p1", type: "plant" as const, oc: 2, or: 3, cropKey: "carrot", ...over });

  it("debits the exact catalog cost and locks the crop's economics", () => {
    const r = planPlant(plant(), cropEcon("carrot"), false, bal(100), NOW, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goldDelta).toBe(-5); // carrot cost
      expect(r.plot).toMatchObject({ crop_key: "carrot", planted_at: NOW, grow_ms: 900000, sell: 16, xp: 1, fertilized: 0 });
    }
  });

  it("records fertilization from the SERVER-decided flag, not the client action", () => {
    // fertilized is now the 6th arg (the db layer's Garden-roster roll), not a.fertilized.
    const r = planPlant(plant({ fertilized: false }), cropEcon("carrot"), false, bal(100), NOW, true);
    expect(r.ok && r.plot.fertilized).toBe(1);
  });

  it("rejects an unknown crop, an occupied plot, insufficient gold, bad coords", () => {
    expect(planPlant(plant({ cropKey: "diamond" }), cropEcon("diamond"), false, bal(100), NOW, false)).toMatchObject({ ok: false, error: "bad_crop" });
    expect(planPlant(plant(), cropEcon("carrot"), true, bal(100), NOW, false)).toMatchObject({ ok: false, error: "plot_occupied" });
    expect(planPlant(plant({ cropKey: "potato" }), cropEcon("potato"), false, bal(10), NOW, false)).toMatchObject({ ok: false, error: "insufficient" });
    expect(planPlant(plant({ oc: -1 }), cropEcon("carrot"), false, bal(100), NOW, false)).toMatchObject({ ok: false, error: "bad_coord" });
    expect(planPlant(plant({ or: 9999 }), cropEcon("carrot"), false, bal(100), NOW, false)).toMatchObject({ ok: false, error: "bad_coord" });
  });
});

describe("planHarvest — server-time grow gate + exact reward", () => {
  const harvest = (over = {}) => ({ id: "h1", type: "harvest" as const, oc: 2, or: 3, ...over });
  const plot = (over: Partial<PlotRecord> = {}): PlotRecord => ({
    crop_key: "carrot", planted_at: NOW, grow_ms: 900000, sell: 16, xp: 1, fertilized: 0, ...over,
  });

  it("rejects a harvest well before the crop has grown (server clock)", () => {
    const r = planHarvest(harvest(), plot(), NOW + 700000); // grow 900000, grace 120000
    expect(r).toMatchObject({ ok: false, error: "not_grown" });
  });

  it("credits the exact sell + xp once grown", () => {
    const r = planHarvest(harvest(), plot(), NOW + 900000);
    expect(r).toMatchObject({ ok: true, goldDelta: 16, xpDelta: 1 });
  });

  it("allows a harvest within the grace window (flush-delay offset)", () => {
    // 100s before the nominal grow time — inside the 120s grace, so a legit harvest
    // at the client's ripe boundary isn't wrongly rejected by the later server clock.
    const r = planHarvest(harvest(), plot(), NOW + 900000 - 100000);
    expect(r).toMatchObject({ ok: true, goldDelta: 16 });
  });

  it("doubles the reward for a fertilized crop (2x cap)", () => {
    const r = planHarvest(harvest(), plot({ fertilized: 1 }), NOW + 900000);
    expect(r).toMatchObject({ ok: true, goldDelta: 32, xpDelta: 1 });
  });

  it("rejects harvesting an empty plot", () => {
    expect(planHarvest(harvest(), undefined, NOW + 999999999)).toMatchObject({ ok: false, error: "nothing_planted" });
  });
});

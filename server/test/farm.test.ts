import { describe, it, expect } from "vitest";
import {
  planPlant, planHarvest, planZombiePlant, planZombieHarvest, planPlow, plotWithin,
  PLOT, PLOW_COST, type PlantContext, type PlotRecord,
} from "../src/farm";
import { cropEcon, CROPS } from "../src/catalog";
import { zombieCropEcon, ZOMBIE_CROPS } from "../src/zombieCropCatalog";
import plants from "../../public/assets/plants.json";

const bal = (gold = 1000, brains = 0, xp = 0) => ({ gold, brains, xp });
const NOW = 1_700_000_000_000;
/** A plot on plowed soil, well inside a base 30x30 farm, at max level. */
const ctx = (over: Partial<PlantContext> = {}): PlantContext => ({ size: 30, level: 99, plowed: true, ...over });

describe("catalog", () => {
  it("exactly mirrors every frontend veggie crop and its verified economics", () => {
    const frontend = Object.fromEntries(plants.map((p) => [p.key, {
      cost: p.cost, sell: p.sell, xp: p.xp, growMs: p.growMs, level: p.level,
    }]));
    expect(CROPS).toEqual(frontend);
    expect(Object.keys(CROPS)).toHaveLength(35);
    for (const [k, c] of Object.entries(CROPS)) {
      expect(c.cost, k).toBeGreaterThan(0);
      expect(c.sell, k).toBeGreaterThan(0);
      expect(c.growMs, k).toBeGreaterThan(0);
    }
  });

  it("keeps zombie harvest XP in the intended 1-2 XP range", () => {
    for (const [key, zombie] of Object.entries(ZOMBIE_CROPS)) {
      expect(zombie.xp, key).toBeGreaterThanOrEqual(1);
      expect(zombie.xp, key).toBeLessThanOrEqual(2);
    }
  });
});

describe("planPlant — exact seed cost + plot record", () => {
  const plant = (over = {}) => ({ id: "p1", type: "plant" as const, oc: 2, or: 3, cropKey: "carrot", ...over });

  it("debits the exact catalog cost and locks the crop's economics", () => {
    const r = planPlant(plant(), cropEcon("carrot"), false, bal(100), NOW, false, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goldDelta).toBe(-5); // carrot cost
      expect(r.plot).toMatchObject({ crop_key: "carrot", planted_at: NOW, grow_ms: 900000, sell: 16, xp: 1, fertilized: 0 });
    }
  });

  it("records fertilization from the SERVER-decided flag, not the client action", () => {
    // fertilized is the 6th arg (the db layer's Garden-roster roll), not a.fertilized.
    const r = planPlant(plant({ fertilized: false }), cropEcon("carrot"), false, bal(100), NOW, true, ctx());
    expect(r.ok && r.plot.fertilized).toBe(1);
  });

  it("rejects an unknown crop, an occupied plot, insufficient gold, bad coords", () => {
    expect(planPlant(plant({ cropKey: "diamond" }), cropEcon("diamond"), false, bal(100), NOW, false, ctx())).toMatchObject({ ok: false, error: "bad_crop" });
    expect(planPlant(plant(), cropEcon("carrot"), true, bal(100), NOW, false, ctx())).toMatchObject({ ok: false, error: "plot_occupied" });
    expect(planPlant(plant({ cropKey: "potato" }), cropEcon("potato"), false, bal(10), NOW, false, ctx())).toMatchObject({ ok: false, error: "insufficient" });
    expect(planPlant(plant({ oc: -1 }), cropEcon("carrot"), false, bal(100), NOW, false, ctx())).toMatchObject({ ok: false, error: "bad_coord" });
    expect(planPlant(plant({ or: 9999 }), cropEcon("carrot"), false, bal(100), NOW, false, ctx())).toMatchObject({ ok: false, error: "bad_coord" });
  });

  // ---- Phase E gates ----
  it("rejects planting outside the OWNED farm, even well inside the structural cap", () => {
    // A 30x30 farm: the last plot that fits starts at 26 (26+4 = 30). 27 pokes out, and
    // 40 is land the player never bought — both used to be accepted (coord < 128).
    expect(planPlant(plant({ oc: 27 }), cropEcon("carrot"), false, bal(100), NOW, false, ctx())).toMatchObject({ ok: false, error: "outside_farm" });
    expect(planPlant(plant({ oc: 40, or: 40 }), cropEcon("carrot"), false, bal(100), NOW, false, ctx())).toMatchObject({ ok: false, error: "outside_farm" });
    expect(planPlant(plant({ oc: 26, or: 26 }), cropEcon("carrot"), false, bal(100), NOW, false, ctx())).toMatchObject({ ok: true });
    // ...and that same plot IS legal once the farm has been expanded to 40.
    expect(planPlant(plant({ oc: 27 }), cropEcon("carrot"), false, bal(100), NOW, false, ctx({ size: 40 }))).toMatchObject({ ok: true });
  });

  it("rejects a crop the player's level hasn't unlocked", () => {
    const potato = cropEcon("potato")!;
    expect(potato.level).toBeGreaterThan(1); // guard the fixture
    expect(planPlant(plant({ cropKey: "potato" }), potato, false, bal(999), NOW, false, ctx({ level: 1 })))
      .toMatchObject({ ok: false, error: "locked" });
    expect(planPlant(plant({ cropKey: "potato" }), potato, false, bal(999), NOW, false, ctx({ level: potato.level })))
      .toMatchObject({ ok: true });
  });

  it("rejects planting on soil that was never plowed", () => {
    expect(planPlant(plant(), cropEcon("carrot"), false, bal(100), NOW, false, ctx({ plowed: false })))
      .toMatchObject({ ok: false, error: "not_plowed" });
  });

  it("reports an occupied plot as occupied, not as unplowed", () => {
    // A plant consumes its soil, so in practice `occupied` always implies `!plowed` —
    // that's the real shape of a replant. Occupied must be checked first or the specific
    // verdict is unreachable and every replant reports the confusing "not_plowed".
    expect(planPlant(plant(), cropEcon("carrot"), true, bal(100), NOW, false, ctx({ plowed: false })))
      .toMatchObject({ ok: false, error: "plot_occupied" });
  });
});

describe("plotWithin — the owned-farm bound", () => {
  it("mirrors Field.fits(): the whole PLOT block must be inside the farm", () => {
    expect(PLOT).toBe(4);
    expect(plotWithin(0, 0, 30)).toBe(true);
    expect(plotWithin(26, 26, 30)).toBe(true); // 26+4 = 30, the last fitting plot
    expect(plotWithin(27, 26, 30)).toBe(false); // pokes one tile out
    expect(plotWithin(-1, 0, 30)).toBe(false);
  });
});

describe("planPlow — server-owned till", () => {
  const plow = (over = {}) => ({ id: "t1", type: "plow" as const, oc: 8, or: 8, ...over });

  it("charges the server's plow cost and grants 1 xp", () => {
    expect(planPlow(plow(), bal(100), 30, PLOW_COST, false, false)).toEqual({ ok: true, cost: 10, xp: 1 });
  });

  it("is free while a Plowing Monolith is owned (the SERVER decides that, not the client)", () => {
    expect(planPlow(plow(), bal(0), 30, 0, false, false)).toEqual({ ok: true, cost: 0, xp: 0 });
  });

  it("rejects re-plowing already-plowed soil, so a till can't be farmed for xp", () => {
    expect(planPlow(plow(), bal(100), 30, PLOW_COST, true, false)).toMatchObject({ ok: false, error: "already_plowed" });
  });

  it("rejects plowing outside the owned farm, an occupied plot, and with no gold", () => {
    expect(planPlow(plow({ oc: 40 }), bal(100), 30, PLOW_COST, false, false)).toMatchObject({ ok: false, error: "outside_farm" });
    expect(planPlow(plow(), bal(100), 30, PLOW_COST, false, true)).toMatchObject({ ok: false, error: "plot_occupied" });
    expect(planPlow(plow(), bal(5), 30, PLOW_COST, false, false)).toMatchObject({ ok: false, error: "insufficient" });
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

  it("adds 1 xp to a harvest while a Plowing Monolith is active", () => {
    expect(planHarvest(harvest(), plot({ xp: 3 }), NOW + 900000, true))
      .toMatchObject({ ok: true, goldDelta: 16, xpDelta: 4 });
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

// ---- zombie crops (plant a seed -> grow -> harvest an owned unit) --------
const GOLD_Z = "ZombieActorRegularTier1"; // 35 gold, grow 600000, xp 1
const BRAINS_Z = "ZombieActorBombie"; // permanent special: 5 brains, level 20

describe("planZombiePlant — cost in gold OR brains, yields a unit", () => {
  const plant = (over = {}) => ({ id: "zp", type: "plant" as const, oc: 4, or: 4, cropKey: GOLD_Z, ...over });

  it("debits gold for a gold zombie crop and records a sell-0 plot", () => {
    const r = planZombiePlant(plant(), zombieCropEcon(GOLD_Z), false, bal(100), NOW, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r).toMatchObject({ currency: "gold", cost: 35 });
      expect(r.plot).toMatchObject({ crop_key: GOLD_Z, planted_at: NOW, grow_ms: 600000, sell: 0, xp: 1 });
    }
  });

  it("debits brains for a brains zombie crop", () => {
    const r = planZombiePlant(plant({ cropKey: BRAINS_Z }), zombieCropEcon(BRAINS_Z), false, bal(0, 100), NOW, ctx());
    expect(r).toMatchObject({ ok: true, currency: "brains", cost: 5 });
  });

  it("rejects an unknown crop, an occupied plot, insufficient funds, bad coords", () => {
    expect(planZombiePlant(plant({ cropKey: "carrot" }), zombieCropEcon("carrot"), false, bal(100), NOW, ctx())).toMatchObject({ ok: false, error: "bad_crop" });
    expect(planZombiePlant(plant(), zombieCropEcon(GOLD_Z), true, bal(100), NOW, ctx())).toMatchObject({ ok: false, error: "plot_occupied" });
    expect(planZombiePlant(plant(), zombieCropEcon(GOLD_Z), false, bal(10), NOW, ctx())).toMatchObject({ ok: false, error: "insufficient" });
    expect(planZombiePlant(plant({ cropKey: BRAINS_Z }), zombieCropEcon(BRAINS_Z), false, bal(9999, 4), NOW, ctx())).toMatchObject({ ok: false, error: "insufficient" });
    expect(planZombiePlant(plant({ oc: -1 }), zombieCropEcon(GOLD_Z), false, bal(100), NOW, ctx())).toMatchObject({ ok: false, error: "bad_coord" });
  });

  // A zombie crop yields a sellable UNIT, so it must not be the softer path: it gets the
  // same owned-farm / level / plowed gates a veggie plant does.
  it("applies the same Phase E gates as a veggie plant", () => {
    expect(planZombiePlant(plant({ oc: 40, or: 40 }), zombieCropEcon(GOLD_Z), false, bal(100), NOW, ctx())).toMatchObject({ ok: false, error: "outside_farm" });
    expect(planZombiePlant(plant(), zombieCropEcon(GOLD_Z), false, bal(100), NOW, ctx({ plowed: false }))).toMatchObject({ ok: false, error: "not_plowed" });
    const GATED_Z = "ZombieActorGardenTier1"; // 150 gold, level 6
    expect(zombieCropEcon(GATED_Z)!.level).toBe(6); // guard the fixture
    expect(planZombiePlant(plant({ cropKey: GATED_Z }), zombieCropEcon(GATED_Z), false, bal(999), NOW, ctx({ level: 5 })))
      .toMatchObject({ ok: false, error: "locked" });
    expect(planZombiePlant(plant({ cropKey: GATED_Z }), zombieCropEcon(GATED_Z), false, bal(999), NOW, ctx({ level: 6 })))
      .toMatchObject({ ok: true });
  });
});

describe("planZombieHarvest — grow gate + verified unit yield", () => {
  const harvest = (over = {}) => ({ id: "zh", type: "harvest" as const, oc: 4, or: 4, unitId: "z7", ...over });
  const plot = (over: Partial<PlotRecord> = {}): PlotRecord => ({
    crop_key: GOLD_Z, planted_at: NOW, grow_ms: 600000, sell: 0, xp: 1, fertilized: 0, ...over,
  });

  it("yields the plot's unit key + xp once grown", () => {
    const r = planZombieHarvest(harvest(), plot(), NOW + 600000);
    expect(r).toMatchObject({ ok: true, unitKey: GOLD_Z, xpDelta: 1 });
  });

  it("adds 1 xp to a zombie harvest while a Plowing Monolith is active", () => {
    expect(planZombieHarvest(harvest(), plot(), NOW + 600000, true))
      .toMatchObject({ ok: true, unitKey: GOLD_Z, xpDelta: 2 });
  });

  it("exposes dual-route specials but keeps gift-only and Epic rewards unplantable", () => {
    expect(zombieCropEcon("ZombieActorGardenCupid")).toMatchObject({ cost: 5, brains: true, level: 20 });
    expect(zombieCropEcon("ZombieActorRegularCrazy")).toMatchObject({ cost: 5, brains: true, level: 20 });
    expect(zombieCropEcon("ZombieActorGardenTier3GreenFlower")).toBeUndefined();
    expect(zombieCropEcon("ZombieActorGardenCupidPink")).toBeUndefined();
    expect(zombieCropEcon("ZombieActorGardenTier5")).toBeUndefined();
    expect(zombieCropEcon("ZombieActorZomtar")).toBeUndefined();
  });

  it("uses current catalog XP for a zombie planted with the old bad reward", () => {
    const carrotZombie = "ZombieActorRegularTier1Carrots";
    const r = planZombieHarvest(harvest(), plot({ crop_key: carrotZombie, xp: 900 }), NOW + 600000);
    expect(r).toMatchObject({ ok: true, unitKey: carrotZombie, xpDelta: 1 });
  });

  it("rejects before it has grown, an empty plot, and a missing unit id", () => {
    expect(planZombieHarvest(harvest(), plot(), NOW + 100000)).toMatchObject({ ok: false, error: "not_grown" });
    expect(planZombieHarvest(harvest(), undefined, NOW + 999999999)).toMatchObject({ ok: false, error: "nothing_planted" });
    expect(planZombieHarvest(harvest({ unitId: "" }), plot(), NOW + 600000)).toMatchObject({ ok: false, error: "bad_unit" });
  });
});

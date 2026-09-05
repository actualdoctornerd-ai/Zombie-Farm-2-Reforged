import { describe, it, expect } from "vitest";
import {
  BASE_FARM_SIZE,
  MAX_FARM_SIZE,
  SIZE_TIERS,
  CLIMATE_COST,
  sizeTier,
  nextSize,
  isValidSize,
  climateCost,
} from "../src/shopCatalog";
import { MAX_FARM_PLOTS, PLOT_SIZE } from "../src/v3/engine";
import upgrades from "../../public/assets/upgrades.json";

// P16 — server-owned farm-size (a sequential scalar) + climate skins (an owned set).
// These pure catalog helpers are the price + validity source of truth; the db layer
// (buySize/buyClimate) leans entirely on them, so a wrong bound here is a real exploit.

describe("shopCatalog — farm size tiers", () => {
  it("has four ascending tiers with strictly increasing size + gold price", () => {
    expect(SIZE_TIERS.map((t) => t.size)).toEqual([40, 50, 60, 70]);
    for (let i = 1; i < SIZE_TIERS.length; i++) {
      expect(SIZE_TIERS[i].size).toBeGreaterThan(SIZE_TIERS[i - 1].size);
      expect(SIZE_TIERS[i].gold).toBeGreaterThan(SIZE_TIERS[i - 1].gold);
      expect(SIZE_TIERS[i].brains).toBeGreaterThan(SIZE_TIERS[i - 1].brains);
      expect(SIZE_TIERS[i].level).toBeGreaterThan(SIZE_TIERS[i - 1].level);
    }
  });

  // These prices are duplicated in public/assets/upgrades.json (the client's card
  // catalog) and generated from EXTRA_SIZE_TIERS in tools/reforge_economy.py. The
  // server is the authority: if the two drift, the client offers a card whose
  // purchase the server rejects. Pin the ladder so a one-sided edit fails here.
  it("keeps the source progression: +10 size, +10 level, x5 gold, doubling brains", () => {
    const steps: number[] = [];
    for (let i = 1; i < SIZE_TIERS.length; i++) {
      const prev = SIZE_TIERS[i - 1], cur = SIZE_TIERS[i];
      expect(cur.size - prev.size).toBe(10);
      expect(cur.level - prev.level).toBe(10);
      expect(cur.gold).toBe(prev.gold * 5);
      steps.push(cur.brains - prev.brains);
    }
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBe(steps[i - 1] * 2);
  });

  // MAX_FARM_PLOTS used to be the literal 225 — exactly right for the 60x60 farm that
  // was then the top tier, and a trap the moment 70x70 was added: the farm grew, the
  // cap did not, and the last 64 plots of a 1,250,000-gold upgrade could never be
  // plowed. Every tier must be fully plowable, and the cap must not be looser than the
  // largest farm either (that would let a forged size claim plots off the field).
  it("lets every size tier plow every plot it has room for", () => {
    const plotsIn = (size: number) => Math.floor(size / PLOT_SIZE) ** 2;
    expect(MAX_FARM_SIZE).toBe(SIZE_TIERS[SIZE_TIERS.length - 1].size);
    expect(MAX_FARM_PLOTS).toBe(plotsIn(MAX_FARM_SIZE));
    for (const tier of [{ size: BASE_FARM_SIZE }, ...SIZE_TIERS]) {
      expect(plotsIn(tier.size), `${tier.size}x${tier.size}`).toBeLessThanOrEqual(MAX_FARM_PLOTS);
    }
  });

  it("sizeTier resolves only exact tier sizes, never the base or in-between", () => {
    expect(sizeTier(40)).toMatchObject({ size: 40, gold: 10000, brains: 6 });
    expect(sizeTier(60)).toMatchObject({ size: 60, gold: 250000, brains: 12 });
    expect(sizeTier(70)).toMatchObject({ size: 70, gold: 1250000, brains: 20 });
    expect(sizeTier(30)).toBeUndefined(); // base isn't a purchasable tier
    expect(sizeTier(45)).toBeUndefined(); // between tiers
    expect(sizeTier(80)).toBeUndefined(); // above max
    expect(sizeTier(0)).toBeUndefined();
    expect(sizeTier(-40)).toBeUndefined();
    expect(sizeTier(NaN)).toBeUndefined();
  });

  it("nextSize returns strictly the immediate next tier (no skipping)", () => {
    expect(nextSize(30)).toBe(40); // base → first tier
    expect(nextSize(40)).toBe(50);
    expect(nextSize(50)).toBe(60);
    expect(nextSize(60)).toBe(70);
    expect(nextSize(70)).toBeUndefined(); // already max
    expect(nextSize(999)).toBeUndefined();
  });

  it("nextSize from an off-ladder value still yields the smallest larger tier", () => {
    // A save-forged in-between size shouldn't let you buy a skip. From 45 the only
    // buyable is 50, and buySize additionally requires the size to actually be 45's
    // successor, so this is belt-and-suspenders.
    expect(nextSize(45)).toBe(50);
    expect(nextSize(35)).toBe(40);
    expect(nextSize(0)).toBe(40);
    expect(nextSize(-100)).toBe(40);
  });

  it("isValidSize accepts base + real tiers, rejects everything else", () => {
    expect(isValidSize(BASE_FARM_SIZE)).toBe(true);
    expect(isValidSize(40)).toBe(true);
    expect(isValidSize(60)).toBe(true);
    expect(isValidSize(70)).toBe(true);
    expect(isValidSize(45)).toBe(false);
    expect(isValidSize(31)).toBe(false);
    expect(isValidSize(80)).toBe(false);
    expect(isValidSize(0)).toBe(false);
  });
});

describe("shopCatalog — climate skins", () => {
  it("prices each purchasable skin exactly; grass is free/default", () => {
    expect(climateCost("grass")).toBe(0);
    expect(climateCost("stone")).toBe(1000);
    expect(climateCost("dirt")).toBe(2000);
    expect(climateCost("autumn")).toBe(3000);
    expect(climateCost("snow")).toBe(5000);
    expect(climateCost("sand")).toBe(5000);
    expect(climateCost("water")).toBe(10000);
  });

  // The client's card catalog (public/assets/upgrades.json, generated by
  // tools/prep_upgrades.py) and this table are written separately and must agree.
  // A skin in one and not the other means the Market shows a card the server
  // refuses as `bad_climate`, or a price the player isn't actually charged.
  it("matches the client catalog skin-for-skin and price-for-price", () => {
    for (const entry of upgrades.climate) {
      const cost = climateCost(entry.terrain);
      expect(cost, `${entry.terrain} unpriced on the server`).toBeDefined();
      expect(cost, `${entry.terrain} price mismatch`).toBe(entry.gold);
    }
    const sold = new Set(upgrades.climate.map((c) => c.terrain));
    for (const terrain of Object.keys(CLIMATE_COST)) {
      expect(sold.has(terrain), `${terrain} priced but not on sale`).toBe(true);
    }
  });

  it("returns undefined for a fabricated / unknown terrain", () => {
    expect(climateCost("lava")).toBeUndefined();
    expect(climateCost("")).toBeUndefined();
    expect(climateCost("STONE")).toBeUndefined(); // case-sensitive
    // Prototype pollution guard: hasOwnProperty is used, so inherited props miss.
    expect(climateCost("toString")).toBeUndefined();
    expect(climateCost("constructor")).toBeUndefined();
    expect(climateCost("__proto__")).toBeUndefined();
  });

  it("every CLIMATE_COST entry is a positive integer", () => {
    for (const [k, v] of Object.entries(CLIMATE_COST)) {
      expect(Number.isInteger(v), k).toBe(true);
      expect(v, k).toBeGreaterThan(0);
    }
  });
});

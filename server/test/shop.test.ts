import { describe, it, expect } from "vitest";
import {
  BASE_FARM_SIZE,
  SIZE_TIERS,
  CLIMATE_COST,
  sizeTier,
  nextSize,
  isValidSize,
  climateCost,
} from "../src/shopCatalog";

// P16 — server-owned farm-size (a sequential scalar) + climate skins (an owned set).
// These pure catalog helpers are the price + validity source of truth; the db layer
// (buySize/buyClimate) leans entirely on them, so a wrong bound here is a real exploit.

describe("shopCatalog — farm size tiers", () => {
  it("has three ascending tiers with strictly increasing size + gold price", () => {
    expect(SIZE_TIERS.map((t) => t.size)).toEqual([40, 50, 60]);
    for (let i = 1; i < SIZE_TIERS.length; i++) {
      expect(SIZE_TIERS[i].size).toBeGreaterThan(SIZE_TIERS[i - 1].size);
      expect(SIZE_TIERS[i].gold).toBeGreaterThan(SIZE_TIERS[i - 1].gold);
    }
  });

  it("sizeTier resolves only exact tier sizes, never the base or in-between", () => {
    expect(sizeTier(40)).toMatchObject({ size: 40, gold: 10000, brains: 60 });
    expect(sizeTier(60)).toMatchObject({ size: 60, gold: 250000, brains: 120 });
    expect(sizeTier(30)).toBeUndefined(); // base isn't a purchasable tier
    expect(sizeTier(45)).toBeUndefined(); // between tiers
    expect(sizeTier(70)).toBeUndefined(); // above max
    expect(sizeTier(0)).toBeUndefined();
    expect(sizeTier(-40)).toBeUndefined();
    expect(sizeTier(NaN)).toBeUndefined();
  });

  it("nextSize returns strictly the immediate next tier (no skipping)", () => {
    expect(nextSize(30)).toBe(40); // base → first tier
    expect(nextSize(40)).toBe(50);
    expect(nextSize(50)).toBe(60);
    expect(nextSize(60)).toBeUndefined(); // already max
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
    expect(isValidSize(45)).toBe(false);
    expect(isValidSize(31)).toBe(false);
    expect(isValidSize(70)).toBe(false);
    expect(isValidSize(0)).toBe(false);
  });
});

describe("shopCatalog — climate skins", () => {
  it("prices each purchasable skin exactly; grass is free/default", () => {
    expect(climateCost("grass")).toBe(0);
    expect(climateCost("stone")).toBe(1000);
    expect(climateCost("dirt")).toBe(2000);
    expect(climateCost("snow")).toBe(5000);
    expect(climateCost("sand")).toBe(5000);
    expect(climateCost("water")).toBe(10000);
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

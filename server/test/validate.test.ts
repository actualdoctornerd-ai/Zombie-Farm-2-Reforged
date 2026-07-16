import { describe, it, expect } from "vitest";
import {
  validateSave,
  farmDimsWithinBounds,
  MAX_FIELD_DIM,
  LIMITS,
} from "../src/validate";

/** A minimal but valid save the game would actually write. */
function goodSave(): Record<string, unknown> {
  return {
    version: 1,
    savedAt: 1_700_000_000_000,
    player: { name: "Zoe", gold: 100, brains: 3, xp: 500, zombieMax: 8, zombieCount: 2 },
    farm: { fieldId: "default", w: 20, h: 20, plots: [{ oc: 0, or: 0, state: "plowed" }] },
  };
}

describe("validateSave — accepts legitimate saves", () => {
  it("accepts a minimal valid save", () => {
    expect(validateSave(goodSave()).ok).toBe(true);
  });
  it("accepts a planted crop with timings", () => {
    const s = goodSave();
    (s.farm as any).plots = [
      { oc: 0, or: 0, state: "planted", crop: { key: "carrot", plantedAt: 1, growMs: 8000 } },
    ];
    expect(validateSave(s).ok).toBe(true);
  });
  it("accepts a selected farm background", () => {
    const s = goodSave();
    (s.farm as any).background = "light-meadow";
    expect(validateSave(s).ok).toBe(true);
  });
  it("tolerates unknown forward-compat fields", () => {
    const s = goodSave();
    (s as any).futureThing = { anything: [1, 2, 3] };
    expect(validateSave(s).ok).toBe(true);
  });
});

describe("validateSave — rejects malformed / abusive saves", () => {
  it("rejects a non-object", () => {
    expect(validateSave(null).ok).toBe(false);
    expect(validateSave(42).ok).toBe(false);
  });
  it("rejects negative or non-integer currency", () => {
    const s = goodSave();
    (s.player as any).gold = -5;
    expect(validateSave(s).ok).toBe(false);
    const s2 = goodSave();
    (s2.player as any).brains = 1.5;
    expect(validateSave(s2).ok).toBe(false);
  });
  it("rejects a NaN/Infinity timestamp", () => {
    const s = goodSave();
    (s as any).savedAt = Infinity;
    expect(validateSave(s).ok).toBe(false);
  });
  it("rejects an out-of-bounds field size (allocation bomb)", () => {
    const s = goodSave();
    (s.farm as any).w = 1_000_000;
    const r = validateSave(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_farm_w");
  });
  it("rejects a zero/absent field dimension", () => {
    const s = goodSave();
    (s.farm as any).h = 0;
    expect(validateSave(s).ok).toBe(false);
  });
  it("rejects too many plots (high-cardinality)", () => {
    const s = goodSave();
    (s.farm as any).plots = new Array(LIMITS.plots + 1).fill({ oc: 0, or: 0, state: "dirt" });
    const r = validateSave(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_many_plots");
  });
  it("rejects duplicate zombie instance ids", () => {
    const s = goodSave();
    (s as any).ownedZombies = [
      { id: "z1", key: "regular" },
      { id: "z1", key: "regular" },
    ];
    const r = validateSave(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("dup_zombie_id");
  });
  it("rejects too many owned zombies", () => {
    const s = goodSave();
    (s as any).ownedZombies = Array.from({ length: LIMITS.ownedZombies + 1 }, (_, i) => ({
      id: `z${i}`,
      key: "regular",
    }));
    expect(validateSave(s).ok).toBe(false);
  });
  it("rejects an over-long player name", () => {
    const s = goodSave();
    (s.player as any).name = "x".repeat(LIMITS.nameLen + 1);
    expect(validateSave(s).ok).toBe(false);
  });
  it("rejects an unknown farm background", () => {
    const s = goodSave();
    (s.farm as any).background = "empty-void";
    const r = validateSave(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_farm_background");
  });
});

describe("farmDimsWithinBounds — visitor allocation guard", () => {
  it("accepts real dimensions", () => {
    expect(farmDimsWithinBounds(20, 20)).toBe(true);
    expect(farmDimsWithinBounds(MAX_FIELD_DIM, MAX_FIELD_DIM)).toBe(true);
  });
  it("rejects oversized, zero, negative, or non-integer dims", () => {
    expect(farmDimsWithinBounds(MAX_FIELD_DIM + 1, 20)).toBe(false);
    expect(farmDimsWithinBounds(0, 20)).toBe(false);
    expect(farmDimsWithinBounds(-1, 20)).toBe(false);
    expect(farmDimsWithinBounds(1.5, 20)).toBe(false);
    expect(farmDimsWithinBounds("20", 20)).toBe(false);
  });
});

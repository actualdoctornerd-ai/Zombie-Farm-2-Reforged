import { describe, it, expect } from "vitest";
import { RAIDS, raidEcon, winGold } from "../src/raidCatalog";

describe("raidCatalog", () => {
  it("has the 11 playable raids with positive reward data", () => {
    expect(Object.keys(RAIDS)).toHaveLength(11);
    for (const [id, r] of Object.entries(RAIDS)) {
      expect(r.gold, id).toBeGreaterThan(0);
      expect(r.xp, id).toBeGreaterThan(0);
    }
  });
  it("raidEcon looks up known ids and rejects unknown", () => {
    expect(raidEcon(1)).toMatchObject({ gold: 1200, bonus: 400, xp: 100 });
    expect(raidEcon(6)).toMatchObject({ gold: 4000, bonus: 2000 });
    expect(raidEcon(999)).toBeUndefined();
    expect(raidEcon(0)).toBeUndefined();
  });
});

describe("winGold — server mirror of RaidCatalog.winGold", () => {
  const mc = RAIDS[1]; // McDonnell: base 1200, bonus 400

  it("pays base + bonus on a flawless win", () => {
    expect(winGold(mc, 1)).toBe(1600);
  });
  it("scales base and bonus by the survival fraction", () => {
    expect(winGold(mc, 0.5)).toBe(600 + 200); // round(1200*.5)+round(400*.5)
    expect(winGold(mc, 0)).toBe(0);
  });
  it("clamps the survival fraction to [0,1] — no reward above the raid ceiling", () => {
    expect(winGold(mc, 5)).toBe(1600); // clamped to 1
    expect(winGold(mc, -3)).toBe(0); // clamped to 0
    // Non-finite garbage pays nothing (conservative) rather than the ceiling.
    expect(winGold(mc, NaN)).toBe(0);
    expect(winGold(mc, Infinity)).toBe(0);
  });
  it("matches the biggest raid's ceiling", () => {
    expect(winGold(RAIDS[9], 1)).toBe(5000 + 1200); // Video Games
  });
});

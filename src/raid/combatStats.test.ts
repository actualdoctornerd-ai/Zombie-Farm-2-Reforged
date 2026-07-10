import { describe, it, expect } from "vitest";
import {
  finalPower,
  finalAttackInterval,
  finalDamageReduction,
  finalHitPoints,
  applyDamage,
  veterancyScale,
  pickByFrequency,
  VET_RANK_STEP,
  levelScaleT,
  levelScaleStat,
  LEVEL_SCALE_ENDPOINTS,
} from "./combatStats";

// Ground truth: Actor calculateFinal* / Actor damage: / rollAgainstFrequencyInArray:
// (docs/mechanics/COMBAT_STATS_RECOVERED.md). Each `final*` folds a passive + a
// temporary modifier channel onto a base stat with the binary's exact caps.

describe("finalPower — power × max(0, 1 + passive + temporary)", () => {
  it("is the base when unmodified", () => expect(finalPower(100)).toBe(100));
  it("adds passive + temporary as a multiplier", () =>
    expect(finalPower(100, 0.2, 0.3)).toBeCloseTo(150));
  it("floors the multiplier at 0 (combined ≤ −1 zeroes output)", () => {
    expect(finalPower(100, -1.5)).toBe(0);
    expect(finalPower(100, -0.7, -0.7)).toBe(0);
  });
});

describe("finalAttackInterval — interval × (1 − change)", () => {
  it("is the base when unmodified", () => expect(finalAttackInterval(1000)).toBe(1000));
  it("a positive change shortens the interval (faster)", () =>
    expect(finalAttackInterval(1000, 0.3)).toBeCloseTo(700));
  it("caps the passive contribution at +0.5", () =>
    expect(finalAttackInterval(1000, 0.9)).toBeCloseTo(500)); // min(.9,.5)=.5
  it("floors the combined change at −0.5 (multiplier ≤ 1.5)", () =>
    expect(finalAttackInterval(1000, -0.9)).toBeCloseTo(1500));
  it("passive is capped BEFORE temporary is added", () =>
    // min(0.9,0.5)=0.5, +0.2 temp = 0.7 change -> 1000*0.3
    expect(finalAttackInterval(1000, 0.9, 0.2)).toBeCloseTo(300));
});

describe("finalDamageReduction — clamp(passive, ±0.5) + temporary", () => {
  it("passes small passive DR through", () => expect(finalDamageReduction(0.3)).toBeCloseTo(0.3));
  it("caps passive DR at +0.5", () => expect(finalDamageReduction(0.9)).toBeCloseTo(0.5));
  it("floors passive DR at −0.5", () => expect(finalDamageReduction(-0.9)).toBeCloseTo(-0.5));
  it("stacks temporary DR uncapped on top", () =>
    expect(finalDamageReduction(0.5, 0.2)).toBeCloseTo(0.7));
});

describe("finalHitPoints — max(1, hp × (1 + change))", () => {
  it("is the base when unmodified", () => expect(finalHitPoints(250)).toBe(250));
  it("scales by the change", () => expect(finalHitPoints(250, 0.1)).toBeCloseTo(275));
  it("never drops below 1", () => expect(finalHitPoints(250, -5)).toBe(1));
});

describe("applyDamage — max(0, incoming − armor) × (1 − DR)", () => {
  it("passes plain damage through", () => expect(applyDamage(100)).toBe(100));
  it("subtracts flat armor first", () => expect(applyDamage(100, 30)).toBe(70));
  it("applies % reduction after armor", () => expect(applyDamage(100, 20, 0.5)).toBe(40));
  it("armor ≥ incoming fully blocks", () => expect(applyDamage(50, 80)).toBe(0));
  it("cannot go negative", () => expect(applyDamage(10, 0, 2)).toBeLessThanOrEqual(0));
});

describe("veterancyScale — +5% per survived-invasion rank", () => {
  it("uses the 0.05 coefficient literal from the binary", () => expect(VET_RANK_STEP).toBe(0.05));
  it("rank 0 is 1.0", () => expect(veterancyScale(0)).toBe(1));
  it("rank 5 (Master) is 1.25", () => expect(veterancyScale(5)).toBeCloseTo(1.25));
  it("clamps negative ranks to 0", () => expect(veterancyScale(-3)).toBe(1));
});

describe("levelScaleT — 0 at level ≤8, 1 at level ≥25", () => {
  it("is 0 at or below level 8", () => {
    expect(levelScaleT(8)).toBe(0);
    expect(levelScaleT(1)).toBe(0);
  });
  it("is 1 at or above level 25", () => {
    expect(levelScaleT(25)).toBe(1);
    expect(levelScaleT(60)).toBe(1);
  });
  it("is 0.5 at the midpoint (level 16.5)", () => expect(levelScaleT(16.5)).toBeCloseTo(0.5));
});

describe("levelScaleStat — lerp(endpoint, base, t) for str/con/dex", () => {
  it("returns the group floor at level ≤8", () => {
    expect(levelScaleStat("Headless", "con", 29.7, 8)).toBeCloseTo(11.0); // Headless con floor
    expect(levelScaleStat("Large", "str", 23.32, 5)).toBeCloseTo(8.5); // Large str floor
  });
  it("returns the full base stat at level ≥25", () => {
    expect(levelScaleStat("Headless", "con", 29.7, 25)).toBeCloseTo(29.7);
    expect(levelScaleStat("Small", "str", 7.5, 30)).toBeCloseTo(7.5);
  });
  it("interpolates linearly in between", () => {
    // Headless con 11 -> 29.7 at t=0.5 (level 16.5)
    expect(levelScaleStat("Headless", "con", 29.7, 16.5)).toBeCloseTo((11 + 29.7) / 2);
  });
  it("is flat where the dex floor equals the base (the mapping proof)", () => {
    // Large/Headless/Regular/Garden have endpoint dex == base dex, so dex never changes.
    for (const lvl of [1, 8, 15, 25, 40]) {
      expect(levelScaleStat("Large", "dex", 1.3, lvl)).toBeCloseTo(1.3);
      expect(levelScaleStat("Headless", "dex", 1.0, lvl)).toBeCloseTo(1.0);
      expect(levelScaleStat("Regular", "dex", 2.0, lvl)).toBeCloseTo(2.0);
    }
  });
  it("can shrink a stat when the floor exceeds the base (Regular str 5→2)", () => {
    expect(levelScaleStat("Regular", "str", 2.0, 8)).toBeCloseTo(5.0); // floor above base
    expect(levelScaleStat("Regular", "str", 2.0, 25)).toBeCloseTo(2.0);
  });
  it("falls back to default endpoints for an unknown group", () => {
    // default {str:5, con:5, dex:2}
    expect(levelScaleStat("Nonsense", "str", 100, 8)).toBeCloseTo(5.0);
    expect(levelScaleStat("Nonsense", "dex", 100, 8)).toBeCloseTo(2.0);
  });
  it("exposes the transcribed endpoint table", () => {
    expect(LEVEL_SCALE_ENDPOINTS.Headless).toEqual({ str: 3.0, con: 11.0, dex: 1.0 });
    expect(LEVEL_SCALE_ENDPOINTS.Large).toEqual({ str: 8.5, con: 6.5, dex: 1.3 });
    expect(LEVEL_SCALE_ENDPOINTS.Small).toEqual({ str: 3.125, con: 2.75, dex: 4.0 });
  });
});

describe("pickByFrequency — cumulative arc4random_uniform(Σfreq)", () => {
  const E = [
    { name: "a", frequency: 10 },
    { name: "b", frequency: 30 },
    { name: "c", frequency: 60 },
  ];
  it("selects by cumulative weight, not index", () => {
    expect(pickByFrequency(E, () => 0.05)!.name).toBe("a"); // 5 < 10
    expect(pickByFrequency(E, () => 0.3)!.name).toBe("b"); // 30 in (10,40]
    expect(pickByFrequency(E, () => 0.99)!.name).toBe("c"); // 99 in (40,100]
  });
  it("returns null for an empty or all-zero-weight list", () => {
    expect(pickByFrequency([], () => 0.5)).toBeNull();
    expect(pickByFrequency([{ frequency: 0 }], () => 0.5)).toBeNull();
  });
  it("treats frequency as a weight (a 90-weight entry dominates)", () => {
    const skew = [
      { name: "rare", frequency: 10 },
      { name: "common", frequency: 90 },
    ];
    let common = 0;
    for (let i = 0; i < 100; i++) {
      if (pickByFrequency(skew, () => (i + 0.5) / 100)!.name === "common") common++;
    }
    expect(common).toBe(90); // exactly the 90% weight band
  });
});

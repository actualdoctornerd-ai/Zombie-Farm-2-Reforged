import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import rules from "../tools/life_force.json";
import drops from "../public/assets/raids/drops.json";
import type { PlaceableDef } from "./assets";
import { awardedSellValue } from "./awardSellValue";

const catalog = placeables as PlaceableDef[];
const byKey = new Map(catalog.map((p) => [p.key, p]));

/** Purchase-equivalent gold value of an item — mirrors worth() in tools/life_force.py. */
function worthOf(p: PlaceableDef): number {
  const curve = rules.worthCurve;
  const cost = p.cost ?? 0;
  if (cost > 0) return cost * ((p as { brainsNeeded?: boolean }).brainsNeeded ? curve.brainGold / curve.sellBack : 1);
  return (awardedSellValue(p.key) ?? 0) / curve.sellBack;
}

function bonusOf(p: PlaceableDef): number {
  const base = baseOf(p) ?? 0;
  let bonus = 0;
  for (const [floor, flat, pct] of rules.worthCurve.bands) {
    if (worthOf(p) >= floor) bonus = Math.max(flat, Math.round(base * pct));
  }
  return bonus;
}

/** Area counted up to the cap, then gently beyond it — mirrors sized() in life_force.py. */
function sized(area: number): number {
  const cap = rules.footprintCap;
  return area <= cap ? area : cap + Math.min(rules.overCapMax, Math.floor((area - cap) / rules.overCapStep));
}

/** The pre-bonus estimate, or null for a value that is documented / overridden / inherited. */
function baseOf(p: PlaceableDef): number | null {
  if (p.lifeForceSource === "footprint") return sized(p.tileW * p.tileH);
  if (p.lifeForceSource === "tree") return sized(p.tileW * p.tileH + rules.treeBonus);
  if (p.lifeForceSource === "producing-tree") return rules.producingTreeValue;
  return null;
}

describe("Life Force catalog data", () => {
  it("every placeable has a whole-number Life Force of at least 0", () => {
    const bad = catalog.filter((p) => !Number.isInteger(p.lifeForce) || (p.lifeForce as number) < 0);
    expect(bad.map((p) => p.key)).toEqual([]);
  });

  it("every placeable says where its number came from", () => {
    expect(catalog.filter((p) => !p.lifeForceSource).map((p) => p.key)).toEqual([]);
  });

  it("covers all decor, which is where Life Force mostly comes from", () => {
    const decor = catalog.filter((p) => p.category === "decor");
    expect(decor.length).toBeGreaterThan(300);
    expect(decor.every((p) => (p.lifeForce ?? -1) >= 0)).toBe(true);
  });

  it("uses the documented ZF1 value wherever one exists", () => {
    for (const [key, d] of Object.entries(rules.documented)) {
      expect(byKey.get(key)?.lifeForce, key).toBe(d.value);
      expect(byKey.get(key)?.lifeForceSource, key).toBe("documented");
    }
  });

  it("keeps estimates under the over-cap ceiling plus the biggest worth bonus", () => {
    const top = rules.footprintCap + rules.overCapMax;
    const ceiling = top + Math.max(...rules.worthCurve.bands.map(([, flat, pct]) => Math.max(flat, Math.round(top * pct))));
    const over = catalog.filter(
      (p) => p.lifeForceSource !== "documented" && p.lifeForceSource !== "override"
        && p.lifeForceSource !== "variant" && (p.lifeForce as number) > ceiling
    );
    expect(over.map((p) => p.key)).toEqual([]);
  });

  it("gives a recolour its base item's value (unless a ZF1 value is documented for it)", () => {
    const off = catalog.filter(
      (p) => p.variantOf && p.lifeForceSource === "variant"
        && byKey.get(p.variantOf)?.lifeForce !== p.lifeForce
    );
    expect(off.map((p) => p.key)).toEqual([]);
  });

  it("scores producing trees a little below ordinary trees, before the worth bonus", () => {
    for (const key of rules.producingTrees) {
      expect(byKey.get(key)?.lifeForce, key).toBe(rules.producingTreeValue + bonusOf(byKey.get(key)!));
    }
    // An ordinary 1x1 tree is area (1) + bonus (2) = 3; a producing tree is one lower.
    const oak = byKey.get("oakTree")!;
    expect(oak.lifeForce).toBe(oak.tileW * oak.tileH + rules.treeBonus + bonusOf(oak));
    expect(rules.producingTreeValue).toBeLessThan(oak.tileW * oak.tileH + rules.treeBonus);
  });

  describe("worth curve: later-game and dearer items give a little more", () => {
    it("estimated values are exactly their base plus the band bonus for their worth", () => {
      const wrong = catalog.filter((p) => {
        const base = baseOf(p);
        return base !== null && p.lifeForce !== base + bonusOf(p);
      });
      expect(wrong.map((p) => p.key)).toEqual([]);
    });

    it("is monotonic: a dearer item never gets a smaller bonus", () => {
      const bands = rules.worthCurve.bands;
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i][0]).toBeGreaterThan(bands[i - 1][0]);
        expect(bands[i][1]).toBeGreaterThan(bands[i - 1][1]);
        expect(bands[i][2]).toBeGreaterThan(bands[i - 1][2]);
      }
    });

    it("scales with size: among equally dear items a bigger one gains a bigger bonus", () => {
      // A 4x4 in the 20k band: its bonus is the 30% share, not the flat floor of 3.
      const cabin = byKey.get("logCabin")!; // 4x4, worth 20,000
      const gain = (cabin.lifeForce as number) - sized(cabin.tileW * cabin.tileH);
      expect(gain).toBeGreaterThan(rules.worthCurve.bands[2][1]); // beats the flat floor
    });

    it("keeps counting size past the cap, so a 6x6 outranks a 4x4 of equal worth", () => {
      expect(byKey.get("rockyRhinosCave")!.lifeForce).toBeGreaterThan(byKey.get("hideout")!.lifeForce as number);
      expect(byKey.get("swamp_Cabin")!.lifeForce).toBeGreaterThan(byKey.get("hideout")!.lifeForce as number);
    });

    it("pays the golden statue more than its stone twin, and a late invasion's prize more than a trinket", () => {
      expect(byKey.get("bossStatueBroBotGolden")!.lifeForce).toBeGreaterThan(byKey.get("bossStatueBroBot")!.lifeForce as number);
      expect(byKey.get("pixelCampfire")!.lifeForce).toBeGreaterThan(byKey.get("pixelBanner")!.lifeForce as number);
    });

    it("leaves documented ZF1 values and overrides alone", () => {
      for (const p of catalog) {
        if (p.lifeForceSource === "documented") expect(p.lifeForce, p.key).toBe((rules.documented as Record<string, { value: number }>)[p.key].value);
      }
    });

    it("gives every invasion reward at least 1 Life Force", () => {
      const zero = Object.values(drops as Record<string, { tile?: string }>)
        .filter((d) => d.tile && byKey.has(d.tile) && !((byKey.get(d.tile)!.lifeForce as number) >= 1));
      expect(zero).toEqual([]);
    });
  });

  it("names only catalog keys in the rules file", () => {
    const named = [
      ...Object.keys(rules.documented), ...Object.keys(rules.overrides),
      ...rules.trees, ...rules.producingTrees,
    ];
    expect(named.filter((k) => !byKey.has(k))).toEqual([]);
  });
});

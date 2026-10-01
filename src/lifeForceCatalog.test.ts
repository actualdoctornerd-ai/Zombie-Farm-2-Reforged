import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import rules from "../tools/life_force.json";
import type { PlaceableDef } from "./assets";

const catalog = placeables as PlaceableDef[];
const byKey = new Map(catalog.map((p) => [p.key, p]));

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

  it("keeps estimates at or under the footprint cap", () => {
    const over = catalog.filter(
      (p) => p.lifeForceSource !== "documented" && p.lifeForceSource !== "override"
        && p.lifeForceSource !== "variant" && (p.lifeForce as number) > rules.footprintCap
    );
    expect(over.map((p) => p.key)).toEqual([]);
  });

  it("gives a recolour its base item's value", () => {
    const off = catalog.filter(
      (p) => p.variantOf && byKey.get(p.variantOf)?.lifeForce !== p.lifeForce
    );
    expect(off.map((p) => p.key)).toEqual([]);
  });

  it("scores producing trees a little below ordinary trees", () => {
    for (const key of rules.producingTrees) expect(byKey.get(key)?.lifeForce, key).toBe(rules.producingTreeValue);
    // An ordinary 1x1 tree is area (1) + bonus (2) = 3; a producing tree is one lower.
    const oak = byKey.get("oakTree")!;
    expect(oak.lifeForce).toBe(oak.tileW * oak.tileH + rules.treeBonus);
    expect(rules.producingTreeValue).toBeLessThan(oak.lifeForce as number);
  });

  it("names only catalog keys in the rules file", () => {
    const named = [
      ...Object.keys(rules.documented), ...Object.keys(rules.overrides),
      ...rules.trees, ...rules.producingTrees,
    ];
    expect(named.filter((k) => !byKey.has(k))).toEqual([]);
  });
});

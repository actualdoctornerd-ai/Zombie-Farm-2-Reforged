import { describe, expect, it } from "vitest";
import placeables from "../../public/assets/placeables.json";
import { LIFE_FORCE, lifeForceOf } from "../src/objectCatalog";

describe("server Life Force mirror", () => {
  it("has an entry for every placeable, equal to the catalog's lifeForce", () => {
    const rows = placeables as { key: string; lifeForce: number }[];
    expect(Object.keys(LIFE_FORCE).sort()).toEqual(rows.map((r) => r.key).sort());
    for (const r of rows) expect(lifeForceOf(r.key), r.key).toBe(r.lifeForce);
  });

  it("reads 0 for a key the catalog does not know", () => {
    expect(lifeForceOf("notAThing")).toBe(0);
    expect(lifeForceOf("__proto__")).toBe(0);
  });
});

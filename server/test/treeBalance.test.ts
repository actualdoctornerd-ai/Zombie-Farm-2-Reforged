import { describe, expect, it } from "vitest";
import placeables from "../../public/assets/placeables.json";
import { objectEcon } from "../src/objectCatalog";

describe("fruit-tree balance", () => {
  const tree = (key: string) => placeables.find((entry) => entry.key === key);

  it("keeps the authored harvest values used by client and server", () => {
    expect(tree("oliveTreeOlive")).toMatchObject({ level: 5, harvestValue: 15 });
    expect(tree("fruitTreeLemon")).toMatchObject({ harvestValue: 35 });
    expect(tree("fruitTreeOrange")).toMatchObject({ harvestValue: 18 });
  });

  it("awards the binary's gold-purchase XP for every fruit tree", () => {
    const expected = {
      fruitTreeApple: 5,
      oliveTreeOlive: 10,
      fruitTreeLemon: 20,
      fruitTreeOrange: 10,
    };
    for (const [key, xp] of Object.entries(expected)) {
      expect(tree(key), key).toMatchObject({ xp });
      expect(objectEcon(key), key).toMatchObject({ xp });
    }
  });

  it("keeps the authoritative Olive Tree purchase level in sync", () => {
    expect(objectEcon("oliveTreeOlive")?.level).toBe(5);
  });
});

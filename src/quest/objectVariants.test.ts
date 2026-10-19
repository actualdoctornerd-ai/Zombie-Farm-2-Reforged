import { describe, expect, it } from "vitest";
import placeables from "../../public/assets/placeables.json";
import type { PlaceableDef } from "../assets";
import { questSubjectMatches } from "./matching";
import { objectQuestAliases, type VariantRow } from "./objectVariants";

const catalog = placeables as PlaceableDef[];
const aliases = objectQuestAliases(catalog);

/** Would a quest requiring `requirement` be satisfied by buying `key`? */
const buying = (key: string, requirement: string) => {
  const def = catalog.find((entry) => entry.key === key);
  if (!def) throw new Error(`no such placeable: ${key}`);
  return questSubjectMatches(requirement, def.name, aliases.get(key) ?? []);
};

describe("objectQuestAliases", () => {
  it("leaves an item with no recolours alone", () => {
    const rows: VariantRow[] = [{ key: "windmill", name: "Windmill" }];
    expect(objectQuestAliases(rows).size).toBe(0);
  });

  it("points every member of a family at its siblings", () => {
    const rows: VariantRow[] = [
      { key: "pen", name: "Fence" },
      { key: "pen_blue", name: "Blue Fence", variantOf: "pen" },
      { key: "pen_red", name: "Red Fence", variantOf: "pen" },
    ];
    const map = objectQuestAliases(rows);
    expect(map.get("pen_blue")).toEqual(["Fence", "Red Fence"]);
    expect(map.get("pen")).toEqual(["Blue Fence", "Red Fence"]);
  });

  it("never aliases a row to the name it already posts", () => {
    // Both Fence Gate states are literally called "Fence Gate"; a self-alias would
    // be harmless but a duplicate entry is noise, and the base must not list itself.
    const rows: VariantRow[] = [
      { key: "gate", name: "Fence Gate" },
      { key: "gate_open", name: "Fence Gate", variantOf: "gate" },
      { key: "gate_red", name: "Red Fence Gate", variantOf: "gate" },
    ];
    const map = objectQuestAliases(rows);
    expect(map.get("gate")).toEqual(["Red Fence Gate"]);
    expect(map.get("gate_open")).toEqual(["Red Fence Gate"]);
  });
});

describe("the shipped catalog's recolour families", () => {
  it("gives every variant a base row that exists", () => {
    const keys = new Set(catalog.map((entry) => entry.key));
    const orphans = catalog
      .filter((entry) => entry.variantOf && !keys.has(entry.variantOf))
      .map((entry) => entry.key);
    expect(orphans).toEqual([]);
  });

  it("has every variant share its base's art and footprint", () => {
    // These variants deliberately carry their own art: the White Flower Bed needs
    // de-coloured petals, and the Obsidian Grave has a dark-purple sprite with glints.
    const OWN_ART = new Set(["flowerBed_white", "gravestoneObsidian"]);
    const byKey = new Map(catalog.map((entry) => [entry.key, entry]));
    const wrong: string[] = [];
    for (const entry of catalog) {
      if (!entry.variantOf) continue;
      const base = byKey.get(entry.variantOf)!;
      if (entry.sprite !== base.sprite && !OWN_ART.has(entry.key))
        wrong.push(`${entry.key}: sprite`);
      if (entry.tileW !== base.tileW || entry.tileH !== base.tileH)
        wrong.push(`${entry.key}: footprint`);
    }
    expect(wrong).toEqual([]);
  });

  it("gives the members of a family distinct appearances", () => {
    // The whole point: three Flower Beds that render identically were the bug.
    const family = catalog.filter((e) => e.key === "flowerBed" || e.variantOf === "flowerBed");
    expect(family).toHaveLength(4);
    const looks = family.map((e) => JSON.stringify(e.color ?? null));
    expect(new Set(looks).size).toBe(4);
  });
});

describe("quest objectives accept any recolour", () => {
  it("counts a recoloured buy toward the family's objective", () => {
    // The five live objectives that name a decor family (quests 9, 10 and 27).
    expect(buying("pen_01_blue", "Fence")).toBe(true);
    expect(buying("pen_01_black", "Fence")).toBe(true);
    expect(buying("fenceGate_01_open_red", "Fence Gate")).toBe(true);
    expect(buying("barrelNormal_pink", "Barrel")).toBe(true);
    expect(buying("hedge_01_white", "Hedge")).toBe(true);
    expect(buying("baloon_black", "Balloon")).toBe(true);
  });

  it("counts the base buy too, and in either direction", () => {
    expect(buying("pen_01", "Fence")).toBe(true);
    // Quest 9's text asks for White Fences while matching on "Fence"; a player who
    // reads the text and buys the coloured one must still be credited either way.
    expect(buying("pen_01", "Blue Fence")).toBe(true);
  });

  it("still refuses an unrelated item", () => {
    expect(buying("crate_red", "Fence")).toBe(false);
    expect(buying("windmill", "Hedge")).toBe(false);
  });

  it("keeps the deliberate barrel/hedge family rule working", () => {
    // Separate tiles, not recolours — the word-boundary rule in matching.ts is what
    // lets a Pirate Barrel count as a Barrel, and it predates this mechanism.
    expect(questSubjectMatches("Barrel", "Pirate Barrel")).toBe(true);
    expect(questSubjectMatches("Hedge", "Heart Hedge")).toBe(true);
  });
});

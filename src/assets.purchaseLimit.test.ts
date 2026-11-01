import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import { placeablePurchaseLimit, type PlaceableDef } from "./assets";
import { MAX_PET_PENS } from "./net/protocol";

const def = (key: string, category: PlaceableDef["category"]) => ({ key, category });

describe("placeablePurchaseLimit", () => {
  it("limits ordinary functional items to one owned copy", () => {
    expect(placeablePurchaseLimit(def("gravestoneBlue", "functional"))).toBe(1);
    expect(placeablePurchaseLimit(def("mausoleum3", "functional"))).toBe(1);
  });

  it("allows four Pet Pens, each a functional building", () => {
    // Each pen holds its own pets (src/petPens.ts). Being `functional` is what caps
    // it AND puts it in the Market's Functional Items tab — the server derives the
    // same limit (gen-catalogs PURCHASE_LIMITS), so it must not drift back to
    // `decor` (see FUNCTIONAL_OVERRIDE_TILES in tools/prep_placeables.py).
    const pen = (placeables as PlaceableDef[]).find((entry) => entry.key === "pettingZoo");
    expect(pen?.category).toBe("functional");
    expect(placeablePurchaseLimit(pen!)).toBe(MAX_PET_PENS);
    expect(MAX_PET_PENS).toBe(4);
  });

  it("allows three Zombie Pots and leaves non-functional items unlimited", () => {
    expect(placeablePurchaseLimit(def("zombieCombiner", "functional"))).toBe(3);
    expect(placeablePurchaseLimit(def("daisy", "decor"))).toBeUndefined();
  });

  it("puts no cap on Memorial Statues", () => {
    // One statue remembers one zombie, so the farm needs as many as the player has
    // lost — it is `functional` for the Market tab and the tap behaviour, not for
    // the one-per-farm rule that category otherwise implies.
    const statue = (placeables as PlaceableDef[]).find((e) => e.key === "memorialStatue");
    expect(statue?.category).toBe("functional");
    expect(statue?.memorial ?? statue?.key === "memorialStatue").toBeTruthy();
    expect(placeablePurchaseLimit(statue!)).toBeUndefined();
  });
});

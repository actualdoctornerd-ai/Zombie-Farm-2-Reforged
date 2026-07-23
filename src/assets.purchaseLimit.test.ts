import { describe, expect, it } from "vitest";
import { placeablePurchaseLimit, type PlaceableDef } from "./assets";

const def = (key: string, category: PlaceableDef["category"]) => ({ key, category });

describe("placeablePurchaseLimit", () => {
  it("limits ordinary functional items to one owned copy", () => {
    expect(placeablePurchaseLimit(def("gravestoneBlue", "functional"))).toBe(1);
    expect(placeablePurchaseLimit(def("mausoleum3", "functional"))).toBe(1);
  });

  it("allows three Zombie Pots and leaves non-functional items unlimited", () => {
    expect(placeablePurchaseLimit(def("zombieCombiner", "functional"))).toBe(3);
    expect(placeablePurchaseLimit(def("daisy", "decor"))).toBeUndefined();
  });
});

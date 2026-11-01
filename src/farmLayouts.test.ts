import { describe, expect, it } from "vitest";
import { captureLayout, planLayout, type PlacedNow } from "./farmLayouts";

const at = (id: string, key: string, oc: number, or: number, fixed = false, turn = 0): PlacedNow =>
  ({ id, key, oc, or, turn, fixed });
const noneFixed = () => false;

describe("planLayout", () => {
  it("keeps what is already in place and swaps the rest through the shed", () => {
    const plan = planLayout(
      [{ key: "bench", oc: 1, or: 1, turn: 0 }, { key: "pumpkin", oc: 5, or: 5, turn: 0 }],
      [at("a", "bench", 1, 1), at("b", "gnome", 3, 3)],
      { pumpkin: 1 }, 1, noneFixed,
    );
    expect(plan.keep).toEqual(["a"]);
    expect(plan.store).toEqual(["b"]);
    expect(plan.place.map((i) => i.key)).toEqual(["pumpkin"]);
    expect(plan.missing).toEqual([]);
    expect(plan.shedAfter).toBe(1); // +gnome, -pumpkin
  });

  it("skips entries for items no longer owned and still loads the rest", () => {
    const plan = planLayout(
      [{ key: "sold", oc: 0, or: 0, turn: 0 }, { key: "bench", oc: 2, or: 2, turn: 0 }],
      [at("a", "bench", 9, 9)], {}, 0, noneFixed,
    );
    expect(plan.missing.map((i) => i.key)).toEqual(["sold"]);
    expect(plan.place.map((i) => i.key)).toEqual(["bench"]); // the moved bench is reused
    expect(plan.store).toEqual(["a"]);
  });

  it("never places more copies than the farm owns", () => {
    const plan = planLayout(
      [1, 2, 3].map((n) => ({ key: "fence", oc: n, or: 0, turn: 0 })),
      [at("a", "fence", 7, 7)], { fence: 1 }, 1, noneFixed,
    );
    expect(plan.place).toHaveLength(2);
    expect(plan.missing).toHaveLength(1);
  });

  it("treats a turned copy as a different spot", () => {
    const plan = planLayout(
      [{ key: "bench", oc: 1, or: 1, turn: 1 }], [at("a", "bench", 1, 1)], {}, 0, noneFixed,
    );
    expect(plan.keep).toEqual([]);
    expect(plan.place).toHaveLength(1);
  });

  it("leaves fixed buildings alone", () => {
    const plan = planLayout(
      [{ key: "mausoleum3", oc: 20, or: 20, turn: 0 }],
      [at("m", "mausoleum3", 4, 4, true)], {}, 0, (k) => k.startsWith("mausoleum"),
    );
    expect(plan.store).toEqual([]);
    expect(plan.stuck).toHaveLength(1);
  });

  it("reports the shed count after a swap that empties a crowded farm", () => {
    const plan = planLayout([], [at("a", "x", 0, 0), at("b", "y", 2, 2)], {}, 5, noneFixed);
    expect(plan.shedAfter).toBe(7);
  });
});

describe("captureLayout", () => {
  it("keeps each object's own id so the same copy comes back", () => {
    expect(captureLayout([{ key: "pen", oc: 1, or: 2, turn: 0, id: "o7" }]))
      .toEqual([{ key: "pen", oc: 1, or: 2, turn: 0, id: "o7" }]);
  });
});

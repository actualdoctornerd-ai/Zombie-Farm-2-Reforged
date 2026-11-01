import { describe, expect, it } from "vitest";
import { normalizePenSlots, penOccupants, penOf, pennedPets, withPenPet, withoutPenPet } from "./petPens";
import { MAX_PEN_SLOTS } from "./net/protocol";

describe("pet pen slots", () => {
  it("reads a one-pen-era list as pen 0 unchanged", () => {
    expect(normalizePenSlots(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(penOccupants(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
    expect(penOccupants(["a", "b", "c"], 1)).toEqual([]);
  });

  it("blanks duplicates and refused keys, trims trailing blanks, and caps the length", () => {
    expect(normalizePenSlots(["a", "a", "x", "b", "", ""], (key) => key !== "x")).toEqual(["a", "", "", "b"]);
    expect(normalizePenSlots(Array.from({ length: 20 }, (_, i) => `p${i}`))).toHaveLength(MAX_PEN_SLOTS);
    expect(normalizePenSlots([3, null, "a"])).toEqual(["", "", "a"]);
  });

  it("adds to the chosen pen's first free slot and moves a pet out of its old pen", () => {
    let slots = withPenPet([], 1, "a")!;
    expect(slots).toEqual(["", "", "", "", "a"]);
    expect(penOf(slots, "a")).toBe(1);
    slots = withPenPet(slots, 0, "b")!;
    slots = withPenPet(slots, 0, "a")!; // moved from pen 1
    expect(slots).toEqual(["b", "a"]);
    expect(pennedPets(slots)).toEqual(["b", "a"]);
  });

  it("refuses a full pen and keeps the next pen in place when one is emptied", () => {
    const full = ["a", "b", "c", "d", "e"];
    expect(withPenPet(full, 0, "f")).toBeNull();
    expect(withoutPenPet(full, "b")).toEqual(["a", "", "c", "d", "e"]);
    expect(penOf(withoutPenPet(full, "b"), "e")).toBe(1);
    expect(penOf(full, "")).toBe(-1);
  });
});

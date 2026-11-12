import { describe, expect, it } from "vitest";
import {
  almanacZombieCount, applyGauges, GAUGE_NOTIFICATION, objectiveLines, requirementsMet,
  uniquePlacedItems, type ProgressDef,
} from "./questProgress";

const crop = (name: string) => ({
  notificationID: "kCropHarvestedNotification", notificationObject: name,
  countTotal: 100, text: `Harvest ${name}`, sweep: true,
});
const def = {
  requirements: [
    { notificationID: GAUGE_NOTIFICATION, countTotal: 40, text: "Items", gauge: "uniqueItemsPlaced" as const },
    crop("Carrots"), crop("Onions"), crop("Tomatoes"),
    { notificationID: GAUGE_NOTIFICATION, countTotal: 47, text: "Almanac", gauge: "almanacZombies" as const },
  ],
  sweep: { each: 5, best: 100 },
};

describe("requirementsMet", () => {
  it("judges a quest with no sweep exactly as before: every count at its target", () => {
    const plain: ProgressDef = { requirements: [{ notificationID: "a", countTotal: 2 }, { notificationID: "b", countTotal: 1 }] };
    expect(requirementsMet(plain, [2, 1])).toBe(true);
    expect(requirementsMet(plain, [2, 0])).toBe(false);
    expect(requirementsMet(plain, [])).toBe(false);
  });

  it("needs every sweep member at `each` AND one of them at `best`", () => {
    expect(requirementsMet(def, [40, 100, 5, 5, 47])).toBe(true);
    // 100 of one crop, but another is still short of 5.
    expect(requirementsMet(def, [40, 100, 5, 4, 47])).toBe(false);
    // Every crop at 5+, but none at 100.
    expect(requirementsMet(def, [40, 99, 99, 99, 47])).toBe(false);
  });

  it("still needs the non-sweep objectives beside the sweep", () => {
    expect(requirementsMet(def, [39, 100, 5, 5, 47])).toBe(false);
    expect(requirementsMet(def, [40, 100, 5, 5, 46])).toBe(false);
  });
});

describe("applyGauges", () => {
  it("overwrites gauge counts from the reading, clamped, and reports a change", () => {
    const counts = [0, 7, 0, 0, 0];
    expect(applyGauges(def, counts, { uniqueItemsPlaced: 55, almanacZombies: 12 })).toBe(true);
    expect(counts).toEqual([40, 7, 0, 0, 12]); // event tallies untouched
    expect(applyGauges(def, counts, { uniqueItemsPlaced: 55, almanacZombies: 12 })).toBe(false);
  });

  it("lets a gauge FALL — it is the farm right now, not a high-water mark", () => {
    const counts = [40, 0, 0, 0, 0];
    applyGauges(def, counts, { uniqueItemsPlaced: 31 });
    expect(counts[0]).toBe(31);
  });

  it("keeps the last known count for a reading the caller does not have", () => {
    const counts = [12, 0, 0, 0, 30];
    applyGauges(def, counts, { uniqueItemsPlaced: 15 });
    expect(counts).toEqual([15, 0, 0, 0, 30]);
  });
});

describe("gauge readings", () => {
  it("counts distinct placed keys, ignoring stored copies and the untracked starter shed", () => {
    expect(uniquePlacedItems([
      { key: "gravestoneRed", placed: true },
      { key: "gravestoneRed", placed: true },
      { key: "koiPond", placed: false },
      { key: "storage01", placed: true },
      { key: "fruitTreeLemon", placed: true },
    ])).toBe(2);
  });

  it("counts discovered basics and specials together, skipping unclassed and undiscovered keys", () => {
    const classOf = (key: string) =>
      ({ Regular: "basic", Zyborg: "basic", Pirate: "special" } as Record<string, "basic" | "special">)[key];
    expect(almanacZombieCount({ Regular: 3, Zyborg: 1, Pirate: 1, Tomatohead: 2, Zero: 0 }, classOf)).toBe(3);
    expect(almanacZombieCount(null, classOf)).toBe(0);
    expect(almanacZombieCount([1, 2], classOf)).toBe(0);
  });
});

describe("objectiveLines", () => {
  it("collapses the sweep into an 'every crop' line with a per-crop breakdown and a 'best crop' line", () => {
    const lines = objectiveLines(
      { ...def, sweep: { ...def.sweep, eachText: "Harvest 5 of every crop", bestText: "Harvest 100 of one crop" } },
      [12, 30, 5, 2, 20]
    );
    expect(lines.map((l) => l.text)).toEqual([
      "Items", "Harvest 5 of every crop", "Harvest 100 of one crop (best: Carrots)", "Almanac",
    ]);
    expect(lines[1]).toMatchObject({ count: 2, total: 3, done: false });
    expect(lines[1].detail).toEqual([
      { text: "Carrots", count: 5, total: 5, done: true },
      { text: "Onions", count: 5, total: 5, done: true },
      { text: "Tomatoes", count: 2, total: 5, done: false },
    ]);
    expect(lines[2]).toMatchObject({ count: 30, total: 100, done: false });
  });

  it("names no leader before anything is harvested", () => {
    expect(objectiveLines(def, [0, 0, 0, 0, 0])[2].text).toBe("Harvest 100 of one crop");
  });
});

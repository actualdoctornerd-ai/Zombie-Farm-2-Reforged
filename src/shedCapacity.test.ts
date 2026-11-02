import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import { BASE_SHED_SLOTS, shedCapacityOf } from "./shedCapacity";
import type { PlaceableDef } from "./assets";

const catalog = new Map((placeables as PlaceableDef[]).map((def) => [def.key, def]));
const slotsOf = (key: string) => catalog.get(key)?.storageSlots;

describe("shedCapacityOf", () => {
  it("is the base on a farm with no shed on it", () => {
    expect(shedCapacityOf(["daisy", "shamrocks"], slotsOf)).toBe(BASE_SHED_SLOTS);
  });

  it("reads the placed shed's own tier", () => {
    expect(shedCapacityOf(["daisy", "storage01"], slotsOf)).toBe(8);
    expect(shedCapacityOf(["daisy", "storage08"], slotsOf)).toBe(64);
    expect(shedCapacityOf(["storage09"], slotsOf)).toBe(72);
    expect(shedCapacityOf(["storage17"], slotsOf)).toBe(136);
  });

  // The bug this replaced: the capacity was a second record of something the farm
  // already states, raised in place at each purchase and otherwise read out of the
  // save. A file that understated it — every Online Farm export written before the
  // object reconcile had run — imported a McDonnell's Barn as eight slots, which hid
  // every item above the eighth. Derived, the file cannot be believed over the farm.
  it("ignores what a save claims: the shed standing on the farm is the answer", () => {
    const farm = ["storage08", "daisy"];
    expect(shedCapacityOf(farm, slotsOf)).toBe(64); // whatever storage.itemCap said
  });

  it("never reads below the base, and ignores keys the catalog does not know", () => {
    expect(shedCapacityOf([], slotsOf)).toBe(BASE_SHED_SLOTS);
    expect(shedCapacityOf(["nonesuch"], slotsOf)).toBe(BASE_SHED_SLOTS);
  });

  // An upgrade is an in-place def swap, so the farm holds exactly one shed before and
  // after. Derived, that is a plain re-read rather than a nudge that could double up.
  it("is a plain function of the placed shed across an upgrade", () => {
    expect(shedCapacityOf(["storage03"], slotsOf)).toBe(24);
    expect(shedCapacityOf(["storage04"], slotsOf)).toBe(32);
    expect(shedCapacityOf(["storage04"], slotsOf)).toBe(32);
  });

  it("ships the Shabby Shed's capacity as the base", () => {
    expect(BASE_SHED_SLOTS).toBe(catalog.get("storage01")?.storageSlots);
  });
});

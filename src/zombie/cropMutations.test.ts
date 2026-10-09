import { describe, expect, it } from "vitest";
import { cropMutationBits, resolveCropMutations, plotsTouch } from "./cropMutations";
import { cropMutationChance } from "../lifeForce";

/** The old flat 210% per adjacent crop. Most of these tests are about HOW rolls combine
 *  (stacking, slot conflicts, pooling), which a round per-crop chance keeps readable;
 *  the Life Force levels that set the real chance are covered at the bottom. */
const QUARTER = { chancePerCrop: 0.25 };

describe("crop-adjacency mutations", () => {
  it("touches all eight lattice neighbours and not the plot itself", () => {
    const touching = [
      [-4, -4], [0, -4], [4, -4],
      [-4, 0],           [4, 0],
      [-4, 4],  [0, 4],  [4, 4],
    ];
    for (const [dc, dr] of touching) expect(plotsTouch(0, 0, dc, dr, 4)).toBe(true);
    expect(plotsTouch(0, 0, 0, 0, 4)).toBe(false);
  });

  it("touches plots laid down flush but off the lattice", () => {
    // A plot two tiles east and a full plot north: its footprint runs along the top
    // edge without its origin being (0,-4). This is the reported bug — a farm plowed
    // in several strokes has plots that touch without sharing a lattice.
    expect(plotsTouch(0, 0, 2, -4, 4)).toBe(true);
    expect(plotsTouch(0, 0, -1, 4, 4)).toBe(true);
    expect(plotsTouch(0, 0, 4, 3, 4)).toBe(true);
  });

  it("does not touch a plot with a gap between the footprints", () => {
    expect(plotsTouch(0, 0, 5, 0, 4)).toBe(false); // one clear tile column between
    expect(plotsTouch(0, 0, 0, -5, 4)).toBe(false);
    expect(plotsTouch(0, 0, 8, 8, 4)).toBe(false);
  });

  it("gives one adjacent crop a 25% roll", () => {
    expect(resolveCropMutations(0, ["carrot"], { ...QUARTER, random: () => 0.249 })).toBe(4);
    expect(resolveCropMutations(0, ["carrot"], { ...QUARTER, random: () => 0.25 })).toBe(0);
  });

  it("stacks matching adjacent crops linearly to 100%", () => {
    expect(resolveCropMutations(0, ["carrot", "carrot", "carrot", "carrot"], {
      ...QUARTER,
      random: () => 1,
    })).toBe(4);
  });

  it("can grant every independently rolled non-conflicting mutation", () => {
    expect(resolveCropMutations(0, ["tomato", "carrot", "celery", "lima_beans"], {
      ...QUARTER,
      random: () => 0.1,
    })).toBe(1 | 4 | 64 | 1024);
  });

  it("never creates illegal same-slot or headless mutations", () => {
    // Onion wins the head conflict because its roll is lower than Tomato's.
    const rolls = [0.2, 0.1];
    expect(resolveCropMutations(0, ["tomato", "onion"], { ...QUARTER, random: () => rolls.shift()! })).toBe(2);
    expect(resolveCropMutations(0, ["tomato", "carrot", "celery"], {
      guaranteed: true,
      headless: true,
      random: () => 1,
    })).toBe(64);
  });

  it("grows Pumpking on a headless zombie and on nothing else", () => {
    expect(resolveCropMutations(0, ["pumpking"], { guaranteed: true, headless: true }))
      .toBe(8192);
    expect(resolveCropMutations(0, ["pumpking"], { guaranteed: true })).toBe(0);
    // A zombie with a head of its own grows none, however many are planted around it
    // or how sure the roll is — the Zombie Pot is its only route to one. The crops
    // beside it still mutate normally.
    expect(resolveCropMutations(0, Array(8).fill("pumpking"), { random: () => 0 })).toBe(0);
    expect(resolveCropMutations(0, ["pumpking", "celery"], {
      guaranteed: true, random: () => 1,
    })).toBe(64);
    // It fills the head slot a headless zombie has no other way to use, and leaves
    // the arm/body/neck rolls alone.
    expect(resolveCropMutations(0, ["pumpking", "celery", "onion"], {
      guaranteed: true, headless: true, random: () => 1,
    })).toBe(8192 | 64);
  });

  it("makes every eligible crop mutation guaranteed with the monolith", () => {
    expect(resolveCropMutations(0, ["dragon_fruit"], {
      guaranteed: true,
      random: () => 1,
    })).toBe(4096);
  });
});

describe("crop -> mutation wiring", () => {
  it("names mutations by key, resolving to the bit they persist as", () => {
    expect(cropMutationBits("tomato")).toEqual([1]);
    expect(cropMutationBits("pumpking")).toEqual([8192]);
    // The Tier-4 crops grow their OWN mutations — they used to grow carrot's (4) and
    // cauli's (512), which is what made planting one pointless.
    expect(cropMutationBits("eyebiscus")).toEqual([16384]);
    expect(cropMutationBits("heartichoke")).toEqual([32768]);
    expect(cropMutationBits("grass")).toEqual([]); // a crop that grows nothing
  });

  it("lets one crop grow SEVERAL mutations, each rolling on its own", () => {
    // The table takes a list as well as a single name. Turnip (8, arm) and potato
    // (16, head) sit in different slots, so a guaranteed roll grows both.
    const crops = { kitchen_sink: ["turnip", "potato"] };
    expect(cropMutationBits("kitchen_sink", crops)).toEqual([8, 16]);
    expect(resolveCropMutations(0, ["kitchen_sink"], { crops, guaranteed: true }))
      .toBe(8 | 16);
    // Same slot, though, still means one wins: the roll order decides, not the list.
    const heads = { two_heads: ["tomato", "garlic"] };
    const grown = resolveCropMutations(0, ["two_heads"], { crops: heads, guaranteed: true });
    expect([1, 256]).toContain(grown);
  });

  it("pools adjacency when two crops name the same mutation", () => {
    // Nothing SHIPPED shares a mutation any more (the Tier-4 pair stopped riding
    // carrot's and cauli's bits), but the table still allows it, and two crops that do
    // must clear the 25%-per-plot threshold together — one roll, not two.
    const crops = { carrot: "carrot", baby_carrot: "carrot" };
    const random = () => 0.4; // beats 2 x 25%, would fail a single plot's 25%
    expect(resolveCropMutations(0, ["carrot", "baby_carrot"], { ...QUARTER, crops, random })).toBe(4);
    expect(resolveCropMutations(0, ["carrot"], { ...QUARTER, crops, random })).toBe(0);
  });

  it("no longer makes a Tier-4 crop grow the Tier-1 mutation beside it", () => {
    // The reported balance hole: an eyebiscus plot cost several times a carrot plot
    // and granted the identical +1 speed, and two of them pooled into carrot's roll.
    const random = () => 0.4;
    expect(resolveCropMutations(0, ["carrot", "eyebiscus"], { ...QUARTER, random })).toBe(0);
    expect(resolveCropMutations(0, ["eyebiscus", "eyebiscus"], { ...QUARTER, random })).toBe(16384);
    expect(resolveCropMutations(0, ["cauliflower", "heartichoke"], { ...QUARTER, random })).toBe(0);
    expect(resolveCropMutations(0, ["heartichoke", "heartichoke"], { ...QUARTER, random })).toBe(32768);
  });

  it("ignores a mutation name the catalog does not have", () => {
    const crops = { corn: "cornhead" };
    expect(cropMutationBits("corn", crops)).toEqual([]);
    expect(resolveCropMutations(0, ["corn"], { crops, guaranteed: true })).toBe(0);
  });
});

describe("Life Force sets the mutation chance", () => {
  it("defaults to the level-0 chance, 10% per adjacent crop", () => {
    expect(resolveCropMutations(0, ["carrot"], { random: () => 0.099 })).toBe(4);
    expect(resolveCropMutations(0, ["carrot"], { random: () => 0.1 })).toBe(0);
  });

  it("follows cropMutationChance(level): 20% at level 1, 60% at level 5", () => {
    const at = (level: number, roll: number) =>
      resolveCropMutations(0, ["carrot"], { chancePerCrop: cropMutationChance(level), random: () => roll });
    expect(at(1, 0.199)).toBe(4);
    expect(at(1, 0.201)).toBe(0);
    expect(at(5, 0.599)).toBe(4);
    expect(at(5, 0.601)).toBe(0);
  });

  it("is certain at level 9, even for a single adjacent crop", () => {
    expect(resolveCropMutations(0, ["carrot"], {
      chancePerCrop: cropMutationChance(9), random: () => 0.999999,
    })).toBe(4);
  });

  it("still stacks adjacent crops on top of the per-crop chance", () => {
    const chancePerCrop = cropMutationChance(1); // 20% each
    const two = ["carrot", "carrot"]; // 40% together
    expect(resolveCropMutations(0, two, { chancePerCrop, random: () => 0.39 })).toBe(4);
    expect(resolveCropMutations(0, two, { chancePerCrop, random: () => 0.41 })).toBe(0);
  });
});

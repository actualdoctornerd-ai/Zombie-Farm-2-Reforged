import { describe, expect, it } from "vitest";
import plants from "../../public/assets/plants.json";
import zombies from "../../public/assets/zombies.json";
import { MUTATION_ICON } from "./mutationDisplay";
import { MUTATION_LIST, SLOTS, mutationsOf } from "./mutations";
import { CLASS_COLOR } from "./taxonomy";
import {
  SLOT_LABELS, TIER_PORTRAIT_ZOMBIE,
  backfillMutationDiscovered, mutationAlmanacEntries, repairMutationDiscovered,
  sanitizeMutationDiscovered, statEffectText,
} from "./mutationAlmanac";

// The icon files that actually ship, enumerated off the asset tree at build time: a
// path pointing at nothing is the same blank tile as no path at all.
const SHIPPED_ICONS = new Set(
  Object.keys(import.meta.glob("../../public/assets/ui/mutation/*.png"))
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
);

const CROP_NAMES = new Map((plants as { key: string; name: string }[]).map((p) => [p.key, p.name]));
const sources = { cropName: (key: string) => CROP_NAMES.get(key) };
const entries = (discovered: Record<string, number> = {}) =>
  mutationAlmanacEntries(discovered, sources);
const byKey = (key: string, discovered: Record<string, number> = {}) =>
  entries(discovered).find((entry) => entry.key === key)!;

describe("mutation almanac entries", () => {
  it("lists every catalog mutation once, in bit order", () => {
    const list = entries();
    expect(list.map((entry) => entry.key)).toEqual(MUTATION_LIST.map((def) => def.key));
    expect(list.map((entry) => entry.bit)).toEqual(MUTATION_LIST.map((def) => def.bit));
  });

  it("colours each entry by its tier, Green through Silver", () => {
    expect(byKey("tomato").className).toBe("Green");      // tier 1
    expect(byKey("celery").className).toBe("Blue");       // tier 2
    expect(byKey("dragon").className).toBe("Red");        // tier 3
    expect(byKey("heartichoke").className).toBe("Silver");// tier 4
    for (const entry of entries()) expect(entry.classColor).toBe(CLASS_COLOR[entry.className]);
  });

  // The four colours must all appear, or the ladder this is drawn on has a gap. This is
  // the reason the almanac reads the source's own tier and not zombies.json's rebalanced
  // one, which runs 1/3/4 and would leave Blue unused.
  it("uses all four colours across the catalog", () => {
    expect(new Set(entries().map((entry) => entry.className)))
      .toEqual(new Set(["Green", "Blue", "Red", "Silver"]));
  });

  // The tile draws the mutation on this zombie; if the key is not in the catalog the
  // portrait rig has nothing to build and the entry renders empty.
  it("names a real base zombie for every tier", () => {
    const keys = new Set((zombies as { key: string }[]).map((z) => z.key));
    for (const key of Object.values(TIER_PORTRAIT_ZOMBIE)) expect(keys.has(key)).toBe(true);
    for (const entry of entries()) {
      expect(entry.portraitZombieKey).toBe(TIER_PORTRAIT_ZOMBIE[entry.tier]);
    }
  });

  // The tile paints this icon before it asks the renderer for anything, and keeps it if
  // the extraction never arrives — so an entry without one is a frame that can end up
  // empty on a device whose renderer will not read pixels back.
  it("gives every entry an authored icon that ships", () => {
    for (const entry of entries()) {
      expect(entry.icon).toBe(MUTATION_ICON[entry.key]);
      expect(SHIPPED_ICONS.has(entry.icon.slice(entry.icon.lastIndexOf("/") + 1))).toBe(true);
    }
  });

  it("labels every slot the catalog uses", () => {
    for (const entry of entries()) {
      expect(SLOTS).toContain(entry.slot);
      expect(entry.slotLabel).toBe(SLOT_LABELS[entry.slot]);
      expect(entry.slotLabel).toBeTruthy();
    }
  });

  it("carries the stats the mutation actually moves and no others", () => {
    expect(byKey("tomato").statEffects).toEqual([{ stat: "str", amount: 1 }]);
    expect(byKey("eyebiscus").statEffects).toEqual([
      { stat: "str", amount: 1 }, { stat: "dex", amount: 2 },
    ]);
    // Every entry moves at least one stat — an entry with an empty line reads as broken.
    for (const entry of entries()) expect(entry.statEffects.length).toBeGreaterThan(0);
  });

  it("counts discovery per mutation key", () => {
    expect(byKey("tomato").obtained).toBe(0);
    expect(byKey("tomato", { tomato: 3 }).obtained).toBe(3);
    // Junk counts floor to something sane rather than reaching the DOM.
    expect(byKey("tomato", { tomato: -2 }).obtained).toBe(0);
    expect(byKey("tomato", { tomato: 2.7 }).obtained).toBe(2);
  });

  it("names the crop that grows each mutation in its hint", () => {
    expect(byKey("tomato").hint).toBe("Grow a zombie crop beside Tomatoes.");
    expect(byKey("pumpking").hint).toBe("Grow a zombie crop beside Pumpking.");
    // Every shipped mutation has a crop, so none should fall to the generic line.
    for (const entry of entries()) expect(entry.hint).toMatch(/^Grow a zombie crop beside /);
  });

  it("falls back to the other routes when a mutation has no crop", () => {
    const orphan = mutationAlmanacEntries({}, { cropName: () => undefined });
    for (const entry of orphan) expect(entry.hint).toBe("Found on a bought or combined zombie.");
  });
});

describe("stat effect text", () => {
  it("signs the number and spells the stat", () => {
    expect(statEffectText({ stat: "str", amount: 3 })).toBe("+3 Strength");
    expect(statEffectText({ stat: "dex", amount: -2 })).toBe("-2 Speed");
    expect(statEffectText({ stat: "con", amount: 5 })).toBe("+5 Life");
  });
});

describe("discovery persistence helpers", () => {
  it("seeds from the masks an existing roster is wearing", () => {
    const tomato = MUTATION_LIST.find((def) => def.key === "tomato")!.bit;
    const carrot = MUTATION_LIST.find((def) => def.key === "carrot")!.bit;
    const seeded = backfillMutationDiscovered([
      { mutation: tomato + carrot },
      { mutation: tomato },
      { mutation: 0 },
      {},
    ]);
    expect(seeded).toEqual({ tomato: 2, carrot: 1 });
  });

  it("agrees with the mask decoder about what a zombie is wearing", () => {
    const mask = MUTATION_LIST.slice(0, 3).reduce((sum, def) => sum + def.bit, 0);
    expect(Object.keys(backfillMutationDiscovered([{ mutation: mask }])).sort())
      .toEqual(mutationsOf(mask).map((def) => def.key).sort());
  });

  // The per-key repair. The empty-map seed above could never reach a save whose map
  // was non-empty but missing a mutation the roster wears — which is exactly what the
  // online harvest left behind. Floors, never increments: safe to run on every load.
  it("floors a mutation the roster wears but the map has never counted", () => {
    const tomato = MUTATION_LIST.find((def) => def.key === "tomato")!.bit;
    const carrot = MUTATION_LIST.find((def) => def.key === "carrot")!.bit;
    const repaired = repairMutationDiscovered({ carrot: 3 }, [
      { mutation: tomato + carrot },
      { mutation: tomato },
    ]);
    expect(repaired).toEqual({ carrot: 3, tomato: 1 });
  });

  it("repairs idempotently and never lowers a count", () => {
    const tomato = MUTATION_LIST.find((def) => def.key === "tomato")!.bit;
    const once = repairMutationDiscovered({ tomato: 4, celery: 2 }, [{ mutation: tomato }]);
    expect(once).toEqual({ tomato: 4, celery: 2 });
    expect(repairMutationDiscovered(once, [{ mutation: tomato }])).toEqual(once);
  });

  it("seeds the whole map when there is none, exactly like the backfill", () => {
    const tomato = MUTATION_LIST.find((def) => def.key === "tomato")!.bit;
    const roster = [{ mutation: tomato }, { mutation: tomato }];
    expect(repairMutationDiscovered({}, roster)).toEqual(backfillMutationDiscovered(roster));
  });

  it("keeps only finite counts of at least one", () => {
    expect(sanitizeMutationDiscovered({ a: 2, b: 0, c: -1, d: "x", e: Number.NaN, f: 1.9 }))
      .toEqual({ a: 2, f: 1 });
    expect(sanitizeMutationDiscovered(null)).toEqual({});
    expect(sanitizeMutationDiscovered([1, 2])).toEqual({});
    expect(sanitizeMutationDiscovered("nope")).toEqual({});
  });
});

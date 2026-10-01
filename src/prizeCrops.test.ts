// The six prize crops and their mutations (docs/PRIZE_CROPS.md): fully in the code, NOT in
// the game. This file pins both halves — the data is well-formed and follows the agreed
// rules, and while PRIZE_CROPS.live is false nothing about it is reachable.
// The app has no @types/node; the node test environment provides these at runtime.
// @ts-ignore
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import plants from "../public/assets/plants.json";
import prizeParts from "../public/assets/zombie/prize_mutations.json";
import baseParts from "../public/assets/zombie/mutations.json";
import { CROP_UNLOCKS, PRIZE_CROPS, cropUnlocked } from "./cropUnlocks";
import { cropAvailableInMarket } from "./marketOrder";
import { CROP_MUTATIONS, PRIZE_CROP_MUTATIONS, cropMutationBits } from "./zombie/cropMutations";
import { MUTATION_ICON } from "./zombie/mutationDisplay";
import {
  ALL_BITS, MUTATIONS_BY_KEY, MUTATION_LIST, PRIZE_MUTATIONS, statEffectsOf, type MutationSpec,
} from "./zombie/mutations";

const asset = (...parts: string[]) => new URL(`../public/assets/${parts.join("/")}`, import.meta.url);
type Row = (typeof plants)[number] & { prize?: boolean };
const rows = plants as Row[];
const byKey = new Map(rows.map((p) => [p.key, p]));
const prizeRows = rows.filter((p) => p.prize);

/** prize crop -> the regular crop it recolours (it takes twice that crop's grow time). */
const BASE_CROP: Record<string, string> = {
  golden_carrot: "carrot", golden_turnip: "turnip", obsidibeans: "lima_beans",
  cauliglower: "cauliflower", cosmic_potato: "potato", brainato: "tomato",
};
/** prize crop -> the mutation it grows. */
const CROP_MUTATION: Record<string, string> = {
  golden_carrot: "goldencarrot", golden_turnip: "goldenturnip", obsidibeans: "obsidibeans",
  cauliglower: "cauliglower", cosmic_potato: "cosmicpotato", brainato: "brainato",
};

describe("prize crop catalog", () => {
  it("is exactly the six agreed crops, each unlocked on a dual invasion tier", () => {
    expect(prizeRows.map((p) => p.key).sort()).toEqual(Object.keys(BASE_CROP).sort());
    expect(Object.keys(CROP_UNLOCKS).sort()).toEqual(Object.keys(BASE_CROP).sort());
    // t5 / t10 pairs on raids 12, 13, 15 (Circus + Video Games has no crop yet).
    expect(CROP_UNLOCKS).toEqual({
      golden_carrot: { raidId: 12, tier: 5 }, golden_turnip: { raidId: 12, tier: 10 },
      obsidibeans: { raidId: 13, tier: 5 }, cauliglower: { raidId: 13, tier: 10 },
      cosmic_potato: { raidId: 15, tier: 5 }, brainato: { raidId: 15, tier: 10 },
    });
  });

  it("is plantable at the level cap, never above it (crops past 45 would be unplantable)", () => {
    for (const p of prizeRows) expect(p.level).toBe(45);
  });

  it("ships every image the rows name", () => {
    for (const p of prizeRows) {
      for (const file of [`crops/${p.stage1}`, `crops/${p.stage2}`, `crop-icons/${p.icon}`]) {
        expect(existsSync(asset(file)), `${p.key}: missing ${file}`).toBe(true);
      }
    }
  });

  it("takes TWICE its base crop's grow time", () => {
    for (const p of prizeRows) {
      expect(p.growMs, p.key).toBe(byKey.get(BASE_CROP[p.key])!.growMs * 2);
    }
  });

  it("pays 50-75% over a regular crop of the same duration at level 40", () => {
    // The baseline is the fit over the 25 rebalanced regular crops
    // (tools/reforge_economy.py PRIZE_CROPS): net = e^(1.28+.019L) h^.725 and
    // xp+1 = e^(.88+.012L) h^.22, net = sell - cost - 10. The role multipliers (1.75 / 1.5)
    // land inside a 1.4-1.85 band once costs and XP are rounded to whole numbers.
    for (const p of prizeRows) {
      const h = p.growMs / 3_600_000;
      const net = p.sell - p.cost - 10;
      const baseNet = Math.exp(1.28 + 0.019 * 40) * h ** 0.725;
      const baseXp = Math.exp(0.88 + 0.012 * 40) * h ** 0.22;
      expect(net / baseNet, `${p.key} gold`).toBeGreaterThanOrEqual(1.4);
      expect(net / baseNet, `${p.key} gold`).toBeLessThanOrEqual(1.85);
      expect((p.xp + 1) / baseXp, `${p.key} xp`).toBeGreaterThanOrEqual(1.4);
      expect((p.xp + 1) / baseXp, `${p.key} xp`).toBeLessThanOrEqual(1.85);
    }
  });

  it("keeps Golden Carrot's seed price high enough that fertilizing cannot erode its lead", () => {
    // A Garden-fertilized harvest pays `sell` twice, so a fast crop needs the high
    // sell/net ratio of its peers (Skellyberry 13.5, Meat Flower 19). At 45/63 it lost
    // to Meat Flower once ~70% of plots were fertilized.
    const carrot = byKey.get("golden_carrot")!;
    expect(carrot.sell / (carrot.sell - carrot.cost - 10)).toBeGreaterThan(10);
  });
});

describe("while the prize crops are not live", () => {
  it("is switched off", () => {
    expect(PRIZE_CROPS.live).toBe(false);
  });

  it("has no market card and no quest-pool slot", () => {
    for (const p of prizeRows) expect(cropAvailableInMarket(p), p.key).toBe(false);
    expect(cropAvailableInMarket({ seasonal: false })).toBe(true); // ordinary crops are untouched
  });

  it("never unlocks, even with every dual invasion fully cleared", () => {
    const cleared = { "12": 10, "13": 10, "14": 10, "15": 10 };
    for (const key of Object.keys(CROP_UNLOCKS)) expect(cropUnlocked(key, cleared), key).toBe(false);
  });

  it("adds no mutation to the catalog, the bit space, or the crop adjacency table", () => {
    for (const spec of PRIZE_MUTATIONS) {
      expect(MUTATIONS_BY_KEY[spec.key], spec.key).toBeUndefined();
    }
    expect(MUTATION_LIST.map((m) => m.key)).not.toContain("brainato");
    expect(ALL_BITS).toHaveLength(16);
    for (const crop of Object.keys(PRIZE_CROP_MUTATIONS)) {
      expect(CROP_MUTATIONS[crop], crop).toBeUndefined();
      expect(cropMutationBits(crop), crop).toEqual([]);
    }
  });
});

describe("prize mutations", () => {
  const BASE_KEYS = new Set(MUTATION_LIST.map((m) => m.key));
  const total = (spec: MutationSpec) => statEffectsOf(spec).reduce((sum, e) => sum + e.amount, 0);
  const spec = (key: string) => PRIZE_MUTATIONS.find((m) => m.key === key)!;

  it("are the six agreed mutations, one per prize crop, on fresh keys", () => {
    expect(PRIZE_MUTATIONS.map((m) => m.key).sort()).toEqual(Object.values(CROP_MUTATION).sort());
    expect(PRIZE_CROP_MUTATIONS).toEqual(CROP_MUTATION);
    for (const m of PRIZE_MUTATIONS) expect(BASE_KEYS.has(m.key), m.key).toBe(false);
  });

  it("are ONE significant stat plus ONE minor one", () => {
    for (const m of PRIZE_MUTATIONS) {
      const amounts = statEffectsOf(m).map((e) => e.amount).sort((a, b) => b - a);
      expect(amounts.length, m.key).toBe(2);
      expect(amounts.every((a) => a > 0), m.key).toBe(true);
      expect(amounts[0], m.key).toBeGreaterThanOrEqual(amounts[1]);
    }
  });

  it("raise each slot's best total by at most 2 over the old best", () => {
    // Old bests: head Pumpking 4, hair/eye Cauli-hair 4, arm Dragon-arm 4, body Heartichoke 5.
    const oldBest = { head: 4, hair_eye: 4, arm: 4, body: 5, neck: 4 } as const;
    for (const m of PRIZE_MUTATIONS) {
      expect(total(m), m.key).toBeGreaterThan(oldBest[m.slot] - 1);
      expect(total(m), m.key).toBeLessThanOrEqual(oldBest[m.slot] + 2);
    }
  });

  it("keep dexterity rare: only Brainato and Golden Carrot-eyed add any, +2 each", () => {
    // Today's best dex is 4 (Coffeehead 2 + Eyebiscus 2); the prize head + eye also reach 4.
    const dex = PRIZE_MUTATIONS.filter((m) => m.stats.dex).map((m) => [m.key, m.stats.dex]);
    expect(dex.sort()).toEqual([["brainato", 2], ["goldencarrot", 2]]);
  });

  it("give the two crops that share a slot DIFFERENT roles", () => {
    const primary = (m: MutationSpec) =>
      statEffectsOf(m).reduce((a, b) => (b.amount > a.amount ? b : a)).stat;
    // Heads: Brainato attacks, Cosmic Potatohead tanks.
    expect(primary(spec("brainato"))).toBe("str");
    expect(primary(spec("cosmicpotato"))).toBe("con");
    // Hair/eyes: Cauliglower is the tough one; Golden Carrot-eyed is the quick, hard-hitting one.
    expect(primary(spec("cauliglower"))).toBe("con");
    expect(spec("goldencarrot").stats).toEqual({ str: 2, dex: 2 });
  });

  it("ship rig art, offsets and a flask icon for each", () => {
    for (const m of PRIZE_MUTATIONS) {
      const part = (prizeParts as Record<string, { file: string }>)[m.key];
      expect(part, `${m.key} offsets`).toBeDefined();
      expect(existsSync(asset("zombie", "mutations", `${part.file}.png`)), `${m.key} art`).toBe(true);
      expect(existsSync(asset("ui", "mutation", `icon_mutation_${m.key}.png`)), `${m.key} icon`).toBe(true);
      expect(MUTATION_ICON[m.key], `${m.key} icon url`).toContain(`icon_mutation_${m.key}.png`);
      // Never collides with a base mutation's key in the shared mutations.json.
      expect(Object.keys(baseParts), m.key).not.toContain(m.key);
    }
  });

  it("take their offsets from the base mutation they upgrade", () => {
    const BASE_MUTATION: Record<string, string> = {
      goldencarrot: "carrot", goldenturnip: "turnip", obsidibeans: "limabean",
      cauliglower: "cauli", cosmicpotato: "potato", brainato: "tomato",
    };
    const base = baseParts as Record<string, Record<string, unknown>>;
    const prize = prizeParts as Record<string, Record<string, unknown>>;
    for (const [key, baseKey] of Object.entries(BASE_MUTATION)) {
      const { file: _a, ...want } = base[baseKey];
      const { file: _b, ...got } = prize[key];
      expect(got, key).toEqual(want);
    }
  });

  it("form a valid catalog once the prize crops are live (a fresh load with the switch on)", async () => {
    vi.resetModules();
    const unlocks = await import("./cropUnlocks");
    unlocks.PRIZE_CROPS.live = true;
    try {
      const live = await import("./zombie/mutations");
      const adjacency = await import("./zombie/cropMutations");
      // Appended AFTER the 16 shipped mutations, so no existing bit moves.
      expect(live.MUTATION_LIST).toHaveLength(22);
      expect(live.MUTATION_LIST.slice(0, 16).map((m) => m.key)).toEqual(MUTATION_LIST.map((m) => m.key));
      expect(live.MUTATION_LIST.slice(16).map((m) => m.key)).toEqual(PRIZE_MUTATIONS.map((m) => m.key));
      for (const [i, m] of live.MUTATION_LIST.entries()) expect(m.bit, m.key).toBe(2 ** i);
      // Every prize crop now resolves to exactly its mutation's bit.
      for (const [crop, mutation] of Object.entries(CROP_MUTATION)) {
        expect(adjacency.cropMutationBits(crop), crop).toEqual([live.bitOf(mutation)]);
      }
      // The two same-slot pairs really occupy one slot each (one mutation per slot).
      const brainato = live.bitOf("brainato");
      expect(live.canReceive(brainato, live.bitOf("cosmicpotato"))).toBe(false);
      expect(live.mutationBonus(live.bitOf("obsidibeans"))).toEqual({ str: 1, con: 5, dex: 0 });
    } finally {
      unlocks.PRIZE_CROPS.live = false;
    }
  });
});

describe("prize crop plumbing", () => {
  it("is described by docs/PRIZE_CROPS.md, which says how to switch it on", () => {
    const doc: string = readFileSync(new URL("../docs/PRIZE_CROPS.md", import.meta.url), "utf-8");
    expect(doc).toContain("PRIZE_CROPS.live");
    for (const key of Object.keys(BASE_CROP)) expect(doc).toContain(key);
  });
});

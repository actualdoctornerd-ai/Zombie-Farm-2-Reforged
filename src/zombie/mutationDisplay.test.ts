import { describe, it, expect } from "vitest";
// The app has no @types/node (it only ever runs in a browser); the node test
// environment provides this at runtime. Same treatment as ui/tutorialLayering.test.ts.
// @ts-ignore
import { readdirSync } from "node:fs";
import models from "../../public/assets/zombie/models.json";
import {
  mutationEntries, mutationEffectText, mutationNames, mutationTipText,
  mutationEntriesFrom, mutationLabelFor, MUTATION_ICON, MUTATION_VARIANTS,
  type MutationCardEntry,
} from "./mutationDisplay";
import {
  ALL_BITS, bitOf, mutationOf, mutationBonus, type MutationDef,
} from "./mutations";
import { describeMutationGains, statBreakdown, statDisplayGains } from "./statDisplay";
import { displayStat } from "./traits";

// A plain Regular tier-1 (str/dex/con 2) unless a test says otherwise. Raw stats
// INCLUDE the mask's bonuses, exactly as makeOwned stores them.
const zombie = (mask: number, over: Partial<{ key: string; str: number; dex: number; con: number }> = {}) => {
  const bonus = mutationBonus(mask);
  return {
    key: "ZombieActorRegularTier1",
    str: 2 + bonus.str, dex: 2 + bonus.dex, con: 2 + bonus.con,
    mutation: mask,
    ...over,
  };
};

describe("mutationEntries", () => {
  it("reports nothing for an unmutated zombie", () => {
    expect(mutationEntries(zombie(0))).toEqual([]);
  });

  it("names each mutation the zombie carries, in tier order", () => {
    const rows = mutationEntries(zombie(bitOf("tomato") | bitOf("celery")));
    expect(rows.map((r) => r.name)).toEqual(["Tomatohead", "Celery-arms"]);
    expect(rows.map((r) => r.slotLabel)).toEqual(["Head", "Arm"]);
    expect(rows.map((r) => r.effects.map((e) => e.statLabel))).toEqual([["Damage"], ["Damage"]]);
  });

  it("reports the bonus in DISPLAYED units, not the raw 1-4 points", () => {
    // Carrot is +1 raw dex, but Speed's display reference is small, so it reads far
    // larger than Tomato's +1 raw str does on Damage. This is the whole reason the
    // row quotes a normalized number.
    const [carrot] = mutationEntries(zombie(bitOf("carrot")));
    const [tomato] = mutationEntries(zombie(bitOf("tomato")));
    expect(carrot.effects[0].delta).toBeGreaterThan(tomato.effects[0].delta);
    expect(tomato.effects[0].delta).toBe(4);
    expect(carrot.effects[0].delta).toBe(23);
  });

  it("splits a stat's total across the mutations that share it, without drift", () => {
    // Tomato (+1 str) and Celery (+3 str) both raise Damage: the two rows must add up
    // to exactly the "Mutation" line the stat breakdown shows, not a point either way.
    const z = { ...zombie(bitOf("tomato") | bitOf("celery")), focus: 50, invasions: 9, group: "Regular", className: "Green" };
    const rows = mutationEntries(z);
    const line = statBreakdown(z, "str", () => false).lines.find((l) => l.label === "Mutation");
    const damage = rows.flatMap((r) => r.effects).filter((e) => e.stat === "str");
    expect(damage.reduce((sum, e) => sum + e.delta, 0)).toBe(Number(line!.amount));
  });

  it("names a Tier-4 variant after ITS OWN mutation, not the bit it shares", () => {
    // Heartichoke rides Cauliflower's bit 512; calling it "Cauli-hair" was the bug.
    const [heartichoke] = mutationEntries(zombie(bitOf("cauli"), { key: "ZombieActorRegularTier4Heartichoke" }));
    expect(heartichoke.name).toBe("Heartichoke");
    expect(heartichoke.icon).toContain("heartichoke");
    const [eyebiscus] = mutationEntries(zombie(bitOf("carrot"), { key: "ZombieActorRegularTier4Eyebiscus" }));
    expect(eyebiscus.name).toBe("Eyebiscus");
    expect(eyebiscus.icon).toContain("eyebiscus");
    // The shared bit still means Cauli-hair on anybody else.
    expect(mutationEntries(zombie(bitOf("cauli")))[0].name).toBe("Cauli-hair");
  });

  it("names a Heartichoke's slot after the silhouette it wears, not Cauli-hair's", () => {
    // heartichokeBody `replaces: "body"` — it is Lima Bean's slot on the rig, so
    // calling it a hair mutation (the reported bug) contradicted the art.
    const [heartichoke] = mutationEntries(zombie(bitOf("cauli"), { key: "ZombieActorRegularTier4Heartichoke" }));
    expect(heartichoke.slotLabel).toBe(mutationEntries(zombie(bitOf("limabean")))[0].slotLabel);
    expect(heartichoke.slotLabel).toBe("Body");
    // Eyebiscus really is an eye attachment, so it keeps Carrot-eyed's slot.
    const [eyebiscus] = mutationEntries(zombie(bitOf("carrot"), { key: "ZombieActorRegularTier4Eyebiscus" }));
    expect(eyebiscus.slotLabel).toBe("Hair & Eyes");
    // Anybody else's Cauli-hair is unmoved.
    expect(mutationEntries(zombie(bitOf("cauli")))[0].slotLabel).toBe("Hair & Eyes");
  });

  it("gives every mutation an icon", () => {
    for (const bit of ALL_BITS) {
      const [row] = mutationEntries(zombie(bit));
      expect(row.icon, `${mutationOf(bit)!.name} has no icon`).toBeTruthy();
    }
  });
});

describe("mutation art", () => {
  it("points every icon at a file the prep tool actually shipped", () => {
    // Guards the three names that differ from our mutation keys — the game calls
    // them cauliflower and dragonfruit, and pumpking is the composed one — plus a
    // stale MUTATION_ICON entry after any re-run of tools/prep_mutation_icons.py.
    const shipped = new Set(
      readdirSync(new URL("../../public/assets/ui/mutation", import.meta.url))
    );
    // MUTATION_ICON also carries the prize mutations' icons (not in the catalog until the
    // prize crops are live); only the catalogued ones count toward "every bit".
    const catalogued = new Set(ALL_BITS.map((bit) => mutationOf(bit)!.key));
    const icons = [
      ...Object.entries(MUTATION_ICON).filter(([key]) => catalogued.has(key)).map(([, icon]) => icon),
      ...Object.values(MUTATION_VARIANTS).flatMap((v) => Object.values(v).map((m) => m.icon)),
    ];
    expect(icons.length).toBe(ALL_BITS.length + 2); // every bit + the two variants
    for (const icon of icons) {
      expect(shipped, `missing art for ${icon}`).toContain(icon.split("/").pop());
    }
  });

  it("keeps the variant table in step with the rig's mutationOverrides", () => {
    // models.json is the rig's source of truth for which part a species swaps in;
    // the card must show art for the SAME override, or the icon and the zombie on
    // the farm would disagree.
    const rig = Object.entries(models as Record<string, { mutationOverrides?: Record<string, string> }>)
      .filter(([, model]) => model.mutationOverrides)
      .map(([key, model]) => [key, model.mutationOverrides!] as const);
    expect(rig.length).toBe(Object.keys(MUTATION_VARIANTS).length);
    for (const [key, overrides] of rig) {
      const variants = MUTATION_VARIANTS[key];
      expect(variants, `${key} has no card variant`).toBeTruthy();
      for (const [mutationKey, part] of Object.entries(overrides)) {
        expect(variants[mutationKey]?.part, `${key} -> ${mutationKey}`).toBe(part);
      }
    }
  });
});

describe("mutationNames", () => {
  it("lists the names a mask stands for on that species", () => {
    expect(mutationNames("ZombieActorRegularTier1", 2 | 1024)).toEqual(["Onionhead", "Lima Bean"]);
    expect(mutationNames("ZombieActorRegularTier4Eyebiscus", 4)).toEqual(["Eyebiscus"]);
    expect(mutationNames("ZombieActorRegularTier1", 0)).toEqual([]);
  });
});

describe("mutationLabelFor", () => {
  it("writes the mask out for that species", () => {
    expect(mutationLabelFor("ZombieActorRegularTier1", bitOf("onion") | bitOf("celery")))
      .toBe("Onionhead, Celery-arms");
    expect(mutationLabelFor("ZombieActorRegularTier1", 0)).toBe("");
  });

  it("never calls a Tier-4 variant by the mutation it shares", () => {
    // The whole point: the Pot, the Black Market and the roster all name a unit's
    // mutations through here, and an Eyebiscus is not a Carrot.
    expect(mutationLabelFor("ZombieActorRegularTier4Eyebiscus", bitOf("carrot")))
      .toBe("Eyebiscus");
    expect(mutationLabelFor("ZombieActorRegularTier4Heartichoke", bitOf("cauli")))
      .toBe("Heartichoke");
    expect(mutationLabelFor("ZombieActorRegularTier1", bitOf("carrot"))).toBe("Carrot-eyed");
  });
});

describe("mutationTipText", () => {
  it("is just the effect and the slot it occupies", () => {
    // The tile carries no label, so the effect must be here — and nothing else, the
    // name is the tooltip's own title.
    const [flytrap] = mutationEntries(zombie(bitOf("flytrap")));
    expect(mutationTipText(flytrap)).toBe(
      `<span class="zeff">+${flytrap.effects[0].delta} Life</span><br>Neck slot`
    );
  });

  it("writes a penalty signed, on its own line, and marks it as a loss", () => {
    // A mutation that trades stats writes both halves in the same tooltip, so the
    // penalty has to be distinguishable from a smaller gain — by the sign AND by a
    // class the card can colour (see hud.css .zeff-down).
    const entry: MutationCardEntry = {
      bit: 1, partKey: "1", icon: "", name: "Cornhead", slotLabel: "Head",
      effects: [
        { stat: "con", statLabel: "Life", delta: 27 },
        { stat: "dex", statLabel: "Speed", delta: -45 },
      ],
    };
    expect(mutationTipText(entry)).toBe(
      '<span class="zeff">+27 Life</span><br>'
      + '<span class="zeff zeff-down">-45 Speed</span><br>Head slot'
    );
    expect(mutationEffectText({ stat: "dex", statLabel: "Speed", delta: 0 })).toBe("+0 Speed");
  });
});

describe("a mutation that trades one stat for another", () => {
  // Cornhead: big Life, real Speed cost. Nothing in the shipped catalog does this yet,
  // so it is supplied as an explicit def — mutationEntriesFrom is the same code path
  // mutationEntries uses once the defs are resolved.
  const CORNHEAD: MutationDef = {
    bit: 1 << 20, key: "cornhead", name: "Cornhead", slot: "head",
    stats: { con: 8, dex: -2 }, tier: 2,
  };
  // A plain Regular tier-1's unmutated stats.
  const base = { str: 2, dex: 2, con: 3 };

  it("reports a row per stat, gains and penalties together", () => {
    const [row] = mutationEntriesFrom([CORNHEAD], base);
    expect(row.name).toBe("Cornhead");
    expect(row.slotLabel).toBe("Head");
    expect(row.effects.map((e) => e.statLabel)).toEqual(["Speed", "Life"]);
    const speed = row.effects.find((e) => e.stat === "dex")!;
    const life = row.effects.find((e) => e.stat === "con")!;
    expect(speed.delta).toBeLessThan(0); // the penalty survives normalization
    expect(life.delta).toBeGreaterThan(0);
    // ...in displayed units, measured through the same rounding as any other row.
    expect(life.delta).toBe(displayStat("con", base.con + 8) - displayStat("con", base.con));
    expect(speed.delta).toBe(displayStat("dex", base.dex - 2) - displayStat("dex", base.dex));
  });

  it("chains with another mutation on the same stat without drift", () => {
    // Carrot (+1 dex) and Cornhead (-2 dex) share the Speed stat: the two rows must
    // still add up to the net change, which is what the stat breakdown will show.
    const carrot = mutationOf("carrot")!;
    const rows = mutationEntriesFrom([carrot, CORNHEAD], base);
    const speed = rows.flatMap((r) => r.effects).filter((e) => e.stat === "dex");
    expect(speed).toHaveLength(2);
    const net = displayStat("dex", base.dex + 1 - 2) - displayStat("dex", base.dex);
    expect(speed.reduce((sum, e) => sum + e.delta, 0)).toBe(net);
  });

  it("sells itself honestly on the Market card", () => {
    const gains = statDisplayGains(base, { str: 0, dex: -2, con: 8 });
    expect(describeMutationGains(gains)).toContain("-45 Speed");
    expect(describeMutationGains(gains)).toContain("+27 Life");
    // The penalty is not silently dropped, and not written as though it were a gain.
    expect(describeMutationGains(gains)).not.toContain("+-");
    expect(describeMutationGains(gains)).not.toContain("+45 Speed");
  });
});

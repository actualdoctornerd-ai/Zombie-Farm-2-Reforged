import { describe, it, expect } from "vitest";
import { statBreakdown, displayTotals, selfStatAbilities } from "./statDisplay";
import type { StatSource } from "./statDisplay";

// The displayed stat = (base + mutation) × veterancy × Π(self passive stat abilities),
// normalized to the 0–100 reference bar. These tests pin the fold-in order and the
// hover breakdown (base, every applied modifier incl. +0 ones, total).

const NONE = () => false;
const ALL = () => true;

function z(over: Partial<StatSource>): StatSource {
  return {
    str: 10, dex: 2, con: 10, focus: 70,
    mutation: 0, invasions: 0,
    key: "ZombieActorRegularTier1", group: "Regular", className: "Green",
    ...over,
  };
}

describe("displayed stat — bonus fold-in", () => {
  it("a plain Newbie with no mutation/abilities shows the raw normalization", () => {
    const bd = statBreakdown(z({ str: 21.2 }), "str", NONE);
    expect(bd.base).toBe(91);
    expect(bd.total).toBe(91);
  });

  it("folds the mutation into the total and reports its display delta (Flytrap +13 Life)", () => {
    // Flytrap = con base 10 + mutation bit 2048 (Flytrap, +4 con) → info.con 14.
    // NONE abilities so this isolates the mutation contribution.
    const bd = statBreakdown(z({ con: 14, mutation: 2048 }), "con", NONE);
    expect(bd.base).toBe(34); // con 10
    expect(bd.total).toBe(47); // con 14
    const mut = bd.lines.find((l) => l.label === "Mutation")!;
    expect(mut.amount).toBe("+13");
    expect(mut.zero).toBe(false);
  });

  it("scales every stat (incl. focus) by veterancy — Master = +25%", () => {
    const master = z({ str: 23.32, con: 16.5, dex: 1.3, focus: 100, invasions: 5, group: "Large" });
    // className Green → only tier-1 ability; NONE unlocked so this isolates veterancy.
    expect(statBreakdown(master, "str", NONE).total).toBe(125); // 23.32×1.25
    expect(statBreakdown(master, "con", NONE).total).toBe(69);
    expect(statBreakdown(master, "dex", NONE).total).toBe(37);
    expect(statBreakdown(master, "focus", NONE).total).toBe(125);
    const vet = statBreakdown(master, "focus", NONE).lines.find((l) => l.label.startsWith("Veterancy"))!;
    expect(vet.label).toBe("Veterancy (Master)");
    expect(vet.amount).toBe("+25%");
  });
});

describe("self stat abilities", () => {
  const largeGreen = z({ str: 23.32, con: 16.5, dex: 1.3, focus: 100, group: "Large" }); // t1 = powerBuff

  it("applies an unlocked self buff to the stat it targets, not the others", () => {
    expect(statBreakdown(largeGreen, "str", ALL).total).toBe(110); // 23.32×1.10 (+10% Power)
    expect(statBreakdown(largeGreen, "con", ALL).total).toBe(56); // unaffected
    expect(statBreakdown(largeGreen, "dex", ALL).total).toBe(30); // unaffected
  });

  it("does NOT apply a locked ability", () => {
    expect(statBreakdown(largeGreen, "str", NONE).total).toBe(100); // powerBuff locked → base
  });

  it("lists the ability on every stat, +0% where it does not contribute", () => {
    const dmg = statBreakdown(largeGreen, "str", ALL).lines.find((l) => l.label === "+10% Power")!;
    expect(dmg.amount).toBe("+10%");
    expect(dmg.zero).toBe(false);
    const life = statBreakdown(largeGreen, "con", ALL).lines.find((l) => l.label === "+10% Power")!;
    expect(life.amount).toBe("+0%");
    expect(life.zero).toBe(true);
  });

  it("applies '+5% All Stats' to all four stats including focus", () => {
    const reg = z({ str: 12.6, dex: 2.1, con: 19.8, focus: 100, group: "Regular" }); // t1 = buffAllStats
    expect(statBreakdown(reg, "str", ALL).total).toBe(57);
    expect(statBreakdown(reg, "dex", ALL).total).toBe(50);
    expect(statBreakdown(reg, "con", ALL).total).toBe(70);
    expect(statBreakdown(reg, "focus", ALL).total).toBe(105);
  });

  it("excludes team buffs (Chivalry) and army-only self abilities — only real self stat buffs count", () => {
    // A Blue Regular sees t1 (buffAllStats, self) + t2 (chivalry, TEAM). Only buffAllStats
    // is a self stat ability; chivalry must not appear.
    const blue = z({ group: "Regular", className: "Blue" });
    const keys = selfStatAbilities(blue, ALL);
    expect(keys).toContain("buffAllStats");
    expect(keys).not.toContain("chivalry");
  });
});

describe("breakdown completeness", () => {
  it("always shows Mutation (str/con/dex) and Veterancy at +0, but no Mutation line for focus", () => {
    const plain = statBreakdown(z({}), "str", NONE);
    const mut = plain.lines.find((l) => l.label === "Mutation")!;
    expect(mut.amount).toBe("+0");
    expect(mut.zero).toBe(true);
    const vet = plain.lines.find((l) => l.label.startsWith("Veterancy"))!;
    expect(vet.amount).toBe("+0%");
    expect(vet.zero).toBe(true);

    const focus = statBreakdown(z({}), "focus", NONE);
    expect(focus.lines.some((l) => l.label === "Mutation")).toBe(false);
  });
});

describe("displayTotals", () => {
  it("returns the four tile values with every bonus folded in", () => {
    const t = displayTotals(z({ str: 23.32, con: 16.5, dex: 1.3, focus: 100, group: "Large" }), ALL);
    expect(t).toEqual({ str: 110, dex: 30, con: 56, focus: 100 });
  });
});

import { describe, expect, it } from "vitest";
import { BattleSim, LAST_LAUGH_HEAL_FRAC, UNWRAP_HP_FRAC } from "./BattleSim";
import { unitAbilityAt } from "../zombie/traits";
import type { CombatUnit } from "./types";

// Halloween's prize abilities (owner, 2026-10-24): the Mummy's Unwrapped and JackoZombie's
// Last Laugh, both death-time effects at BattleSim.dealDamage's single death choke point.

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
    ...over,
  };
}

const kill = (sim: BattleSim, u: { maxHp: number }) => (sim as any).dealDamage(u, u.maxHp * 2, false);

describe("Halloween prize kits", () => {
  const ladder = (key: string, group: string) => [1, 2, 3, 4].map((t) => unitAbilityAt(key, group, t));
  it("JackoZombie: Explode Ver.2 and Last Laugh on a Regular", () => {
    expect(ladder("ZombieActorRegular2Tier5", "Regular")).toEqual(["buffAllStats", "chivalry", "explodeV2", "lastLaugh"]);
  });
  it("Zcarecrow: Block in place of Bash on a brute, keeping Mini Buddy and Smash", () => {
    expect(ladder("ZombieActorLarge2Tier5", "Large")).toEqual(["powerBuff", "attachMini", "block", "bashV2"]);
  });
  it("Mummy: Unwrapped and Random Stun in place of the two lasers", () => {
    expect(ladder("ZombieActorMummy", "Regular")).toEqual(["buffAllStats", "chivalry", "unwrapped", "stun"]);
  });
});

describe("Unwrapped (Mummy Zombie)", () => {
  const party = () => {
    const mummy = unit({ id: "mummy", sourceKey: "ZombieActorMummy", team: "player", abilities: ["unwrapped"] });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([mummy, healer], [enemy], null, true);
    return { sim, m: sim.units.find((u) => u.id === "mummy")!, h: sim.units.find((u) => u.id === "healer")! };
  };

  it("gets back up at half Life from the first killing blow, once", () => {
    const { sim, m } = party();
    kill(sim, m);
    expect(m.alive).toBe(true);
    expect(m.hp).toBe(Math.round(m.maxHp * UNWRAP_HP_FRAC));
    expect(m.unwrapUsed).toBe(true);
    expect(m.unwrapFxSeq).toBe(1);
    kill(sim, m);
    expect(m.alive).toBe(false); // the second one is final
  });

  it("is not handed back by a Resurrect: revived, the next death is final", () => {
    const { sim, m, h } = party();
    h.state = "advance";
    kill(sim, m); // unwraps
    kill(sim, m); // falls
    sim.step(50); // the Garden revives it
    expect(m.alive).toBe(true);
    expect(h.resurrectUsed).toBe(true);
    kill(sim, m);
    sim.step(50);
    expect(m.alive).toBe(false);
    expect(m.unwrapFxSeq).toBe(1);
  });

  it("belongs to the carrier alone", () => {
    const { sim, h } = party();
    kill(sim, h);
    expect(h.alive).toBe(false);
  });
});

describe("Last Laugh (JackoZombie)", () => {
  const party = () => {
    const jacko = unit({ id: "jacko", sourceKey: "ZombieActorRegular2Tier5", team: "player", abilities: ["explodeV2", "lastLaugh"] });
    const a = unit({ id: "a", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const b = unit({ id: "b", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const gone = unit({ id: "gone", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([jacko, a, b, gone], [enemy], null, true);
    const get = (id: string) => sim.units.find((u) => u.id === id)!;
    return { sim, j: get("jacko"), a: get("a"), b: get("b"), gone: get("gone"), e: get("enemy") };
  };

  it("heals every living zombie a fifth of its Life when it falls", () => {
    const { sim, j, a, b, gone } = party();
    a.hp = Math.round(a.maxHp * 0.3);
    b.hp = b.maxHp - 100; // nearly full: capped, not overhealed
    kill(sim, gone);
    const before = { a: a.hp, aFx: a.healFxSeq };
    kill(sim, j);
    expect(j.alive).toBe(false);
    expect(j.lastLaughFxSeq).toBe(1);
    expect(a.hp).toBe(before.a + Math.round(a.maxHp * LAST_LAUGH_HEAL_FRAC));
    expect(a.healFxSeq).toBe(before.aFx + 1);
    expect(b.hp).toBe(b.maxHp);
    expect(gone.alive).toBe(false); // the dead are not raised by it
    expect(gone.hp).toBe(0);
  });

  it("goes off when JackoZombie blows itself up with Explode Ver.2", () => {
    const { sim, j, a, e } = party();
    a.hp = Math.round(a.maxHp * 0.5);
    j.state = "fight";
    j.windupKey = "explodeV2";
    j.windupMs = 0;
    (sim as any).stepWindup(j, e, 50);
    expect(j.alive).toBe(false);
    expect(j.lastLaughFxSeq).toBe(1);
    expect(a.hp).toBe(Math.round(a.maxHp * 0.5) + Math.round(a.maxHp * LAST_LAUGH_HEAL_FRAC));
  });
});

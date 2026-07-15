import { describe, it, expect } from "vitest";
import { resolveRaid, buildPlayerUnits } from "./CombatEngine";
import type { CombatUnit } from "./types";
import type { OwnedZombie } from "../zombie/types";

// resolveRaid is the deterministic instant-resolver. These tests pin the outcome
// direction and, crucially, that the recovered damage formula
// (max(0, dmg − armor) × (1 − DR)) is wired into the hit step.

function mk(over: Partial<CombatUnit> & { id: string; team: "player" | "enemy" }): CombatUnit {
  return {
    sourceKey: over.id,
    name: over.id,
    str: 10,
    dex: 5,
    con: 10,
    focus: 0,
    hp: 100,
    maxHp: 100,
    attackCooldownMs: 1000,
    attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false,
    alive: true,
    isGarden: false,
    isHeadless: false,
    abilities: [],
    ...over,
  };
}

describe("resolveRaid outcome direction", () => {
  it("a strong army beats a weak wave", () => {
    const player = [mk({ id: "p", team: "player", str: 50, con: 50 })];
    const enemy = [mk({ id: "e", team: "enemy", str: 2, con: 5 })];
    expect(resolveRaid(player, enemy).win).toBe(true);
  });

  it("a weak army loses to a strong wave", () => {
    const player = [mk({ id: "p", team: "player", str: 2, con: 5 })];
    const enemy = [mk({ id: "e", team: "enemy", str: 50, con: 50 })];
    expect(resolveRaid(player, enemy).win).toBe(false);
  });
});

describe("damage formula is wired into the resolver", () => {
  const player = () => [mk({ id: "p", team: "player", str: 20, con: 30, dex: 10 })];

  it("near-total damage reduction on the enemy flips a win into a loss", () => {
    const winnable = resolveRaid(player(), [mk({ id: "e", team: "enemy", str: 3, con: 20 })]);
    expect(winnable.win).toBe(true);

    const armored = resolveRaid(player(), [
      mk({ id: "e", team: "enemy", str: 3, con: 20, damageReduction: 0.99 }),
    ]);
    expect(armored.win).toBe(false); // player's damage is reduced to ~0 → can't kill
  });

  it("flat armor ≥ the attacker's per-hit damage blocks all of it", () => {
    // player hitDamage = finalPower(str20×10) × mult(1) × K(0.7) = 140; armor 200 absorbs it.
    const blocked = resolveRaid(player(), [
      mk({ id: "e", team: "enemy", str: 3, con: 20, armor: 200 }),
    ]);
    expect(blocked.win).toBe(false);
    expect(blocked.playerDamage).toBe(0);
  });
});

describe("enemies engage one at a time (army concentration matters)", () => {
  const army = (team: "player" | "enemy", n: number) =>
    Array.from({ length: n }, (_, i) => mk({ id: `${team}${i}`, team, str: 10, con: 10 }));

  it("an even-stat army beats a same-size wave by focusing it down one at a time", () => {
    // Under an all-at-once wave this is a loss; one-at-a-time, the army's concentrated
    // fire wins with survivors.
    const r = resolveRaid(army("player", 5), army("enemy", 5));
    expect(r.win).toBe(true);
    expect(r.enemiesBeaten).toBe(5);
    expect(r.survivors.length).toBeGreaterThan(0);
  });

  it("still loses when badly outnumbered by equal units", () => {
    const r = resolveRaid(army("player", 1), army("enemy", 4));
    expect(r.win).toBe(false);
  });

  it("faces the wave sequentially — a lone zombie can chip several before falling", () => {
    // Weak-but-many player vs one tanky enemy: the whole army piles the single enemy.
    const tank = mk({ id: "boss", team: "enemy", str: 8, con: 40 });
    const r = resolveRaid(army("player", 6), [tank]);
    expect(r.win).toBe(true);
  });
});

describe("buildPlayerUnits — level-scaling is applied", () => {
  const headless = (): OwnedZombie[] => [
    {
      id: "z1",
      key: "ZombieActorHeadless",
      name: "Bob",
      typeName: "Skull Head",
      group: "Headless",
      className: "Green",
      classColor: "#000",
      mutation: 0,
      str: 11,
      dex: 1,
      con: 29.7, // base con; Headless con floor is 11
      focus: 100,
      invasions: 0,
      col: 0,
      row: 0,
    },
  ];

  it("a low-level army fights weaker than a maxed one (con ramps HP)", () => {
    const lo = buildPlayerUnits(headless(), { playerLevel: 8 })[0]; // con -> floor 11
    const hi = buildPlayerUnits(headless(), { playerLevel: 25 })[0]; // con -> base 29.7
    expect(lo.maxHp).toBeLessThan(hi.maxHp);
    expect(lo.maxHp).toBe(1100); // con 11 × 100 (ground-truth hitPointsTotal)
    expect(hi.maxHp).toBe(2970); // con 29.7 × 100
  });

  it("omitting playerLevel fights at full base stats (no scaling)", () => {
    const full = buildPlayerUnits(headless(), {})[0];
    expect(full.maxHp).toBe(2970);
  });

  it("does not scale focus (only str/con/dex)", () => {
    const lo = buildPlayerUnits(headless(), { playerLevel: 8 })[0];
    expect(lo.focus).toBe(100); // unchanged despite low level
  });

  it("carries the owned mutation mask into the raid combat unit", () => {
    const mutated = headless()[0];
    mutated.group = "Regular";
    mutated.mutation = 4 | 64;
    expect(buildPlayerUnits([mutated])[0].mutation).toBe(4 | 64);
  });
});

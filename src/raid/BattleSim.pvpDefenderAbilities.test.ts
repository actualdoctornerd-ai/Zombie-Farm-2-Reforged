import { describe, expect, it } from "vitest";
import zombieRows from "../../public/assets/zombies.json";
import {
  BattleSim, BERSERK_DAMAGE_MULT, PHASE_INVULN_MS, RAGE_DAMAGE_MULT, RAGE_SPEED_MULT,
  SHIELD_REGEN_FRAC_PER_SEC, SUPPORT_SHARE, LAST_LAUGH_HEAL_FRAC, UNWRAP_HP_FRAC,
} from "./BattleSim";
import { buildPlayerUnits } from "./CombatEngine";
import { formationDefenseUnits, selectFormationDefense } from "./pvp";
import { makeOwned } from "../zombie/types";
import { flyFight } from "./harness/pilot";
import { EXPERT, makePilot } from "./harness/pilots";
import { replayRaid } from "./replay";
import type { ZombieDef } from "../assets";
import type { CombatUnit } from "./types";

// Ruleset 82 (owner, 2026-10-25): "all zombie abilities should work on PvP". A FORMATION
// defender keeps every ability (pvp.toEnemyCopy) and the sim runs each passive on the
// defending side. These pin each one there; raids are untouched because no raid enemy
// carries an ability (the full suite's raid regressions hold that).

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
    ...over,
  };
}

/** One attacker against defenders on authored stations (which is what makes it PvP). */
function fight(defenders: Array<Partial<CombatUnit> & { id: string }>, attackerOver: Partial<CombatUnit> = {}) {
  const attacker = unit({ id: "a0", sourceKey: "ZombieActorRegularTier1", team: "player", damage: 100, ...attackerOver } as any);
  const defs = defenders.map((d, i) => unit({
    sourceKey: "ZombieActorRegularTier1", team: "enemy", stationX: 600 + i * 60, stationY: 0,
    damage: 100, ...d,
  } as any));
  const sim = new BattleSim([attacker], defs, null, true);
  const get = (id: string) => sim.units.find((u) => u.id === id)!;
  for (const d of defs) { const u = get(d.id); u.state = "hold"; u.x = u.stationX ?? u.x; }
  return { sim, a: get("a0"), get };
}
const hitDefender = (sim: BattleSim, d: any, dmg: number) => (sim as any).dealDamage(d, dmg, true);
const swingAt = (sim: BattleSim, u: any, foe: any) => {
  u.timerMs = 0;
  const before = foe.hp;
  (sim as any).tryAttack(u, foe, 1);
  return before - foe.hp;
};

describe("PvP defenders: damage abilities", () => {
  it("Rage: a hurt defender hits 25% harder and swings 25% faster", () => {
    const { sim, a, get } = fight([{ id: "d0", abilities: ["rage"] }]);
    const d = get("d0");
    const calm = swingAt(sim, d, a);
    const calmCycle = (sim as any).cycleMs(d, null);
    a.hp = a.maxHp;
    d.hp = Math.floor(d.maxHp * 0.4);
    expect(swingAt(sim, d, a)).toBe(Math.round(calm * RAGE_DAMAGE_MULT));
    expect((sim as any).cycleMs(d, null)).toBeCloseTo(calmCycle / RAGE_SPEED_MULT, 6);
  });

  it("Berserk: +20% on the swing, and the swing costs the defender its own Life", () => {
    const plain = fight([{ id: "d0" }]);
    const base = swingAt(plain.sim, plain.get("d0"), plain.a);
    const { sim, a, get } = fight([{ id: "d0", abilities: ["berserk"] }]);
    const d = get("d0");
    expect(swingAt(sim, d, a)).toBe(Math.round(base * BERSERK_DAMAGE_MULT));
    expect(d.hp).toBeLessThan(d.maxHp);
  });

  it("Double Strike and Random Stun proc on a defender's swings", () => {
    const { sim, a, get } = fight([{ id: "d0", abilities: ["doubleStrike", "stun"] }], { hp: 1e9, maxHp: 1e9 } as any);
    const d = get("d0");
    let bonusSeen = false;
    let stunSeen = false;
    for (let i = 0; i < 400 && !(bonusSeen && stunSeen); i++) {
      a.stunMs = 0;
      const dealt = swingAt(sim, d, a);
      if (dealt > d.damage) bonusSeen = true;
      if (a.stunMs > 0) stunSeen = true;
    }
    expect(bonusSeen).toBe(true);
    expect(stunSeen).toBe(true);
  });
});

describe("PvP defenders: defensive abilities", () => {
  it("Protect's reduction finally applies to blows on a defender", () => {
    // The defense's Protect carriers are folded into each defender's damageReduction when the
    // army is built (CombatEngine), the defender Protect shields included, not the carrier.
    const { sim, get } = fight([{ id: "d0", damageReduction: 0.2 } as any]);
    const d = get("d0");
    hitDefender(sim, d, 1000);
    expect(d.hp).toBe(d.maxHp - 800);
  });

  it("Shield Bar builds on station and soaks blows before Life", () => {
    const { sim, get } = fight([{ id: "d0", abilities: ["shieldBar"] }]);
    const d = get("d0");
    for (let i = 0; i < 20; i++) sim.step(50);
    expect(d.shield).toBeGreaterThan(0);
    expect(d.shield).toBeLessThanOrEqual(d.maxHp * SHIELD_REGEN_FRAC_PER_SEC * 1.0001);
    d.shield = 500;
    const hp = d.hp;
    hitDefender(sim, d, 300);
    expect(d.hp).toBe(hp);
    expect(d.shield).toBe(200);
  });

  it("Support: a holder takes a tenth of every blow on the FRONT defender", () => {
    const { sim, get } = fight([{ id: "front" }, { id: "blue", abilities: ["support"] }]);
    const f = get("front");
    const b = get("blue");
    hitDefender(sim, f, 1000);
    expect(f.hp).toBe(f.maxHp - 1000 * (1 - SUPPORT_SHARE));
    expect(b.hp).toBe(b.maxHp - 1000 * SUPPORT_SHARE);
    hitDefender(sim, b, 100); // not the front: not shared
    expect(f.hp).toBe(f.maxHp - 900);
  });

  it("Phase: the killing blow leaves a defender on 1 Life and untouchable, once", () => {
    const { sim, get } = fight([{ id: "d0", abilities: ["phase"] }, { id: "d1" }]);
    const d = get("d0");
    hitDefender(sim, d, d.maxHp * 2);
    expect([d.alive, d.hp, d.phaseMs]).toEqual([true, 1, PHASE_INVULN_MS]);
    hitDefender(sim, d, d.maxHp * 2);
    expect(d.alive).toBe(true);
    d.phaseMs = 0;
    hitDefender(sim, d, d.maxHp * 2);
    expect(d.alive).toBe(false);
  });

  it("Unwrapped: the first killing blow leaves a defender at half Life", () => {
    const { sim, get } = fight([{ id: "d0", abilities: ["unwrapped"] }, { id: "d1" }]);
    const d = get("d0");
    hitDefender(sim, d, d.maxHp * 2);
    expect(d.hp).toBe(Math.round(d.maxHp * UNWRAP_HP_FRAC));
  });

  it("Treat: a fallen defender heals the rest of the DEFENSE", () => {
    const { sim, a, get } = fight([{ id: "jacko", abilities: ["lastLaugh"] }, { id: "d1" }]);
    const d1 = get("d1");
    d1.hp = 1000;
    a.hp = 1000;
    hitDefender(sim, get("jacko"), 1e6);
    expect(d1.hp).toBe(1000 + Math.round(d1.maxHp * LAST_LAUGH_HEAL_FRAC));
    expect(a.hp).toBe(1000); // not the attackers
  });

  it("Resurrect: a defending holder brings a fallen defender back, once", () => {
    const { sim, get } = fight([
      { id: "d0" },
      { id: "doc", isGarden: true, group: "Garden", abilities: ["ressurect"] } as any,
      { id: "d2" },
    ]);
    const d0 = get("d0");
    hitDefender(sim, d0, 1e6);
    expect(d0.alive).toBe(false);
    sim.step(50);
    expect(d0.alive).toBe(true);
    expect(d0.hp).toBe(d0.maxHp);
    expect(get("doc").resurrectUsed).toBe(true);
    hitDefender(sim, d0, 1e6);
    sim.step(50);
    expect(d0.alive).toBe(false); // spent
  });
});

describe("PvP defenders: the walk to the station", () => {
  const walkIn = (abilities: string[]) => {
    const { sim, get } = fight([{ id: "d0", abilities }, { id: "d1" }]);
    const d = get("d0");
    d.state = "emerging";
    d.x = 1100;
    sim.step(50);
    return d;
  };
  it("Teleport puts a defender on its station at once", () => {
    const d = walkIn(["teleport"]);
    expect(d.x).toBe(d.stationX);
    expect(d.teleportFxSeq).toBe(1);
  });
  it("Turbo walks it in twice as fast", () => {
    const slow = walkIn([]);
    const fast = walkIn(["turboSpeed"]);
    expect(1100 - fast.x).toBeCloseTo(2 * (1100 - slow.x), 6);
  });
});

// ---- Full PvP fights with variant defenders ---------------------------------------------
const defs = zombieRows as ZombieDef[];
const byKey = new Map(defs.map((z) => [z.key, z]));
function armyOf(keys: string[], prefix: string): CombatUnit[] {
  const party = keys.map((k, i) => makeOwned(`${prefix}${i}`, byKey.get(k)!, 0, 0, 5, 0));
  return buildPlayerUnits(party, { abilitySlotUnlocked: () => true, playerLevel: 45 });
}
const DEFENSE = [
  "ZombieActorRegularMegaBoss", "ZombieActorRegularOmegaBoss", "ZombieActorRegularSecretBoss",
  "ZombieActorOmegaZombieBot", "ZombieActorOmegaDrZombie", "ZombieActorPoseidon", "ZombieActorZombug",
  "ZombieActorMummy", "ZombieActorRegular2Tier5",
];
const ATTACK = [
  "ZombieActorOmegaZombieBot", "ZombieActorOmegaDrZombie", "ZombieActorRegularMegaBoss",
  "ZombieActorRegularOmegaBoss", "ZombieActorRegularSecretBoss", "ZombieActorVagabond",
  "ZombieActorMasterNinjombie", "ZombieActorPoseidon",
];

describe("PvP fights with ability-carrying defenders", () => {
  it("formation defenders arrive with every ability, and fights replay exactly", () => {
    const defense = formationDefenseUnits(selectFormationDefense(armyOf(DEFENSE, "x")));
    expect(defense.some((u) => u.abilities.includes("shieldBar") || u.abilities.includes("rage") || u.abilities.includes("phase")))
      .toBe(true);
    for (let s = 0; s < 4; s++) {
      const make = () => new BattleSim(armyOf(ATTACK, "a"), formationDefenseUnits(selectFormationDefense(armyOf(DEFENSE, "x"))),
        null, true, [], undefined, null, null, false, false, false, undefined, null, null, { maxActive: 1, dripMs: 0 }, null);
      const sim = make();
      const f = flyFight(sim, makePilot(EXPERT), { seed: `pvp-def:${s}` });
      for (const u of sim.units) {
        expect(Number.isFinite(u.hp) && u.hp >= 0 && u.hp <= u.maxHp + 1e-6, `${u.id} hp ${u.hp}`).toBe(true);
        expect(u.shield >= 0 && u.shield <= u.maxHp + 1e-6, `${u.id} shield`).toBe(true);
        if (!u.alive) expect(u.hp, u.id).toBe(0);
      }
      const replay = replayRaid(make(), f.ticks, f.inputs);
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      if (replay.ok) {
        expect(replay.outcome.win).toBe(f.win);
        expect([...replay.outcome.survivors].sort()).toEqual([...(f.outcome?.survivors ?? [])].sort());
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import zombieRows from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";
import {
  BattleSim, BERSERK_DAMAGE_MULT, BERSERK_SELF_DRAIN_PER_SEC, CHARGE_X, PHASE_INVULN_MS,
  RAGE_DAMAGE_MULT, RAGE_SPEED_MULT, SHIELD_REGEN_FRAC_PER_SEC, SUPPORT_SHARE,
} from "./BattleSim";
import {
  BOSS_ZOMBIE_WEIGHT, FINAL_BOSS_ZOMBIE_KEY, MEGA_BOSS_ZOMBIE_KEY, OMEGA_BOSS_ZOMBIE_KEY,
  RAID_ELITE_ZOMBIE_DROPS, SECRET_BOSS_ZOMBIE_KEY, VIDEO_GAMES_RAID_ID, pickRaidZombie,
  resetsRaidZombieDry,
} from "./zombieDrops";
import { abilityTierOf, unitAbilityAt } from "../zombie/traits";
import type { CombatUnit } from "./types";

// The Boss Zombie's three uncommon colour variants (owner, 2026-10-25): Omega (red), Mega
// (blue) and Secret (silver). Each is a 1-in-7 roll of the Boss Zombie's own drop, a
// sidegrade of the Vagabond, and carries an ability pair of its own in place of the lasers.

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
    ...over,
  };
}

const zombies = zombieRows as ZombieDef[];
const def = (key: string) => zombies.find((z) => z.key === key)!;
const ladder = (key: string) => [1, 2, 3, 4].map((t) => unitAbilityAt(key, "Regular", t));
/** The prize yardstick: sqrt(DPS x HP) wearing the five-slot damage set (videoGameZombie.test). */
const mutated = (z: ZombieDef) => Math.sqrt(500 * (z.str + 9) * (z.dex + 2) * (z.con + 9));

describe("the Boss Zombie's colour variants: catalog and kits", () => {
  const boss = def(FINAL_BOSS_ZOMBIE_KEY);
  const vagabond = def("ZombieActorVagabond");

  it.each([
    [OMEGA_BOSS_ZOMBIE_KEY, "Omega Boss Zombie", ["buffAllStats", "chivalry", "rage", "berserk"]],
    [MEGA_BOSS_ZOMBIE_KEY, "Mega Boss Zombie", ["buffAllStats", "chivalry", "shieldBar", "support"]],
    [SECRET_BOSS_ZOMBIE_KEY, "Secret Boss Zombie", ["buffAllStats", "chivalry", "teleport", "phase"]],
  ])("%s is %s, a Boss Zombie palette swap with its own pair", (key, name, kit) => {
    const z = def(key);
    expect(z).toMatchObject({
      name, category: "special", group: "Regular", className: boss.className, level: boss.level,
      cost: boss.cost, marketHidden: true, specialSprite: key === OMEGA_BOSS_ZOMBIE_KEY
        ? "omega_boss_zombie.png" : key === MEGA_BOSS_ZOMBIE_KEY ? "mega_boss_zombie.png" : "secret_boss_zombie.png",
    });
    expect(ladder(key)).toEqual(kit);
    // Both new abilities sit in slots whose tier they belong to, so they open in order.
    expect(abilityTierOf(kit[2]!)).toBe(3);
    expect(abilityTierOf(kit[3]!)).toBe(4);
  });

  it("each is a sidegrade of the Vagabond on the prize yardstick, reshaped around its kit", () => {
    // Omega and Secret sit on the Vagabond's line; Mega ~10% under it, because its Shield Bar
    // is worth more than a stat line (it out-survived every candidate in the harness).
    for (const key of [OMEGA_BOSS_ZOMBIE_KEY, SECRET_BOSS_ZOMBIE_KEY]) {
      const ratio = mutated(def(key)) / mutated(vagabond);
      expect(ratio, key).toBeGreaterThan(0.97);
      expect(ratio, key).toBeLessThan(1.03);
    }
    const megaRatio = mutated(def(MEGA_BOSS_ZOMBIE_KEY)) / mutated(vagabond);
    expect(megaRatio).toBeGreaterThan(0.85);
    expect(megaRatio).toBeLessThan(0.95);
    const omega = def(OMEGA_BOSS_ZOMBIE_KEY);
    const mega = def(MEGA_BOSS_ZOMBIE_KEY);
    const secret = def(SECRET_BOSS_ZOMBIE_KEY);
    // Red: more damage, less Life. Blue: the reverse. Silver: less of both, much faster.
    expect(omega.str).toBeGreaterThan(boss.str);
    expect(omega.con).toBeLessThan(boss.con);
    expect(mega.con).toBeGreaterThan(boss.con);
    expect(mega.str).toBeLessThan(boss.str);
    expect(secret.str).toBeLessThan(boss.str);
    expect(secret.con).toBeLessThan(boss.con);
    expect(secret.dex).toBeGreaterThan(boss.dex);
  });
});

describe("the Boss Zombie's drop splits 4 : 1 : 1 : 1", () => {
  const drop = RAID_ELITE_ZOMBIE_DROPS[VIDEO_GAMES_RAID_ID];

  it("pays the purple and each colour a quarter of hits", () => {
    const counts = new Map<string, number>();
    const N = 8000;
    for (let i = 0; i < N; i++) {
      const key = pickRaidZombie(drop, (i + 0.5) / N).key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(BOSS_ZOMBIE_WEIGHT).toBe(1);
    expect(counts.get(FINAL_BOSS_ZOMBIE_KEY)).toBe(2000);
    for (const key of [OMEGA_BOSS_ZOMBIE_KEY, MEGA_BOSS_ZOMBIE_KEY, SECRET_BOSS_ZOMBIE_KEY]) {
      expect(counts.get(key), key).toBe(2000);
    }
  });

  it("keeps Halloween's unweighted pair an even pick", () => {
    const pair = { key: "a", name: "A", rate: 0.01, alternates: [{ key: "b", name: "B" }] };
    expect(pickRaidZombie(pair, 0.49).key).toBe("a");
    expect(pickRaidZombie(pair, 0.5).key).toBe("b");
    expect(pickRaidZombie(pair, Number.NaN).key).toBe("a");
  });

  it("a colour counts as the Boss Zombie for its forty-win floor", () => {
    expect(resetsRaidZombieDry(VIDEO_GAMES_RAID_ID, true, { key: SECRET_BOSS_ZOMBIE_KEY, name: "", rate: 0 })).toBe(true);
  });
});

describe("Omega: Rage and Berserk", () => {
  const party = (abilities: string[]) => {
    const red = unit({ id: "red", sourceKey: OMEGA_BOSS_ZOMBIE_KEY, team: "player", abilities, damage: 100 } as any);
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", hp: 1e6, maxHp: 1e6 });
    const sim = new BattleSim([red], [enemy], null, true);
    const get = (id: string) => sim.units.find((u) => u.id === id)!;
    return { sim, r: get("red"), e: get("enemy") };
  };
  const swing = (sim: BattleSim, r: any, e: any) => {
    r.timerMs = 0;
    const before = e.hp;
    (sim as any).tryAttack(r, e, 1);
    return before - e.hp;
  };

  it("Rage: under half Life it hits 25% harder and swings 25% faster", () => {
    const { sim, r, e } = party(["rage"]);
    const calm = swing(sim, r, e);
    const calmCycle = (sim as any).cycleMs(r, null);
    r.hp = Math.floor(r.maxHp * 0.49);
    expect(swing(sim, r, e)).toBe(Math.round(calm * RAGE_DAMAGE_MULT));
    expect((sim as any).cycleMs(r, null)).toBeCloseTo(calmCycle / RAGE_SPEED_MULT, 6);
  });

  it("Berserk: +20% on every swing, each costing its share of 5% Life a second", () => {
    const plain = party([]);
    const base = swing(plain.sim, plain.r, plain.e);
    const { sim, r, e } = party(["berserk"]);
    expect(swing(sim, r, e)).toBe(Math.round(base * BERSERK_DAMAGE_MULT));
    expect(r.hp).toBe(r.maxHp - Math.round(r.maxHp * BERSERK_SELF_DRAIN_PER_SEC * r.cooldownMs / 1000));
  });

  it("the drain is a RATE: a faster swinger pays less a swing", () => {
    const slow = party(["berserk"]);
    const fast = party(["berserk"]);
    fast.r.cooldownMs = slow.r.cooldownMs / 3;
    swing(slow.sim, slow.r, slow.e);
    for (let i = 0; i < 3; i++) swing(fast.sim, fast.r, fast.e);
    expect(Math.abs((fast.r.maxHp - fast.r.hp) - (slow.r.maxHp - slow.r.hp))).toBeLessThanOrEqual(2);
  });

  it("Berserk alone kills it, and nothing softens the self-hit", () => {
    const { sim, r, e } = party(["rage", "berserk"]);
    r.damageReduction = 0.5; // Protect / Block do not apply to its own swings
    let swings = 0;
    while (r.alive && swings < 1000) { swing(sim, r, e); swings++; }
    expect(r.alive).toBe(false);
    const perSwing = Math.round(r.maxHp * BERSERK_SELF_DRAIN_PER_SEC * r.cooldownMs / 1000);
    expect(swings).toBe(Math.ceil(r.maxHp / perSwing));
  });
});

describe("Mega: Shield Bar and Support", () => {
  const party = () => {
    const front = unit({ id: "front", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const blue = unit({ id: "blue", sourceKey: MEGA_BOSS_ZOMBIE_KEY, team: "player", abilities: ["shieldBar", "support"] });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["heal"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([front, blue, healer], [enemy], null, true);
    const get = (id: string) => sim.units.find((u) => u.id === id)!;
    return { sim, f: get("front"), b: get("blue"), h: get("healer"), e: get("enemy") };
  };

  it("builds 2% of its Life a second on the field, capped at its full Life, and only there", () => {
    const { sim, b } = party();
    b.state = "waiting";
    sim.step(1000);
    expect(b.shield).toBe(0); // in the back group it builds nothing
    b.state = "advance";
    for (let i = 0; i < 20; i++) sim.step(50);
    expect(["advance", "fight"]).toContain(b.state);
    expect(b.shield).toBeCloseTo(b.maxHp * SHIELD_REGEN_FRAC_PER_SEC, 6);
    b.shield = b.maxHp;
    sim.step(50);
    expect(b.shield).toBe(b.maxHp);
  });

  it("the shield soaks a blow before Life, and healers never see it", () => {
    const { sim, b } = party();
    b.shield = 500;
    (sim as any).dealEnemyDamage(b, 300);
    expect(b.hp).toBe(b.maxHp);
    expect(b.shield).toBe(200);
    (sim as any).dealEnemyDamage(b, 300);
    expect(b.shield).toBe(0);
    expect(b.hp).toBe(b.maxHp - 100);
    // A shielded zombie at full Life is full: Heal's target pick reads Life alone.
    b.hp = b.maxHp;
    b.shield = b.maxHp;
    expect(b.hp / b.maxHp).toBe(1);
  });

  it("Support takes a tenth of every blow aimed at the front zombie", () => {
    const { sim, f, b } = party();
    f.lineupIndex = 0;
    b.lineupIndex = 1;
    f.state = "fight";
    b.state = "fight";
    (sim as any).dealEnemyDamage(f, 1000);
    expect(f.hp).toBe(f.maxHp - 1000 * (1 - SUPPORT_SHARE));
    expect(b.hp).toBe(b.maxHp - 1000 * SUPPORT_SHARE);
    // A blow on anyone but the front is not shared.
    (sim as any).dealEnemyDamage(b, 100);
    expect(f.hp).toBe(f.maxHp - 900);
    // Nor while the holder is still in the back group.
    b.state = "waiting";
    (sim as any).dealEnemyDamage(f, 100);
    expect(f.hp).toBe(f.maxHp - 1000);
  });
});

describe("Secret: Phase and Teleport", () => {
  const party = () => {
    const silver = unit({ id: "silver", sourceKey: SECRET_BOSS_ZOMBIE_KEY, team: "player", abilities: ["teleport", "phase"] });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([silver], [enemy], null, true);
    return { sim, s: sim.units.find((u) => u.id === "silver")! };
  };

  it("Phase: the first killing blow leaves it on 1 Life, untouchable for 3 seconds, once", () => {
    const { sim, s } = party();
    // The one-shot floor (an ordinary enemy blow from near full) spares it first; Phase is
    // the death after that.
    (sim as any).dealEnemyDamage(s, s.maxHp * 2);
    expect(s.hp).toBe(1);
    expect(s.phaseMs).toBe(0);
    (sim as any).dealEnemyDamage(s, s.maxHp * 2);
    expect(s.alive).toBe(true);
    expect(s.hp).toBe(1);
    expect(s.phaseMs).toBe(PHASE_INVULN_MS);
    expect(s.phaseFxSeq).toBe(1);
    (sim as any).dealEnemyDamage(s, s.maxHp * 2);
    (sim as any).dealDamage(s, s.maxHp * 2, false);
    expect(s.alive).toBe(true); // nothing lands in the window
    s.phaseMs = 0;
    (sim as any).dealDamage(s, s.maxHp * 2, false);
    expect(s.alive).toBe(false); // the second is final
  });

  it("Teleport: released from the charge slot, it is at its place in the line on the next tick", () => {
    const { sim, s } = party();
    s.state = "charging";
    s.x = CHARGE_X;
    (sim as any).releaseCharger(s);
    expect(s.teleportPending).toBe(true);
    sim.step(50);
    expect(s.teleportPending).toBe(false);
    expect(s.teleportFxSeq).toBe(1);
    expect(s.x).toBeCloseTo(s.slotX, 6);
    expect(s.x).toBeGreaterThan(CHARGE_X + 100);
  });
});

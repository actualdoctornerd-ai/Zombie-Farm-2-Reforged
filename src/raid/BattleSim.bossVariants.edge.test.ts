import { describe, expect, it } from "vitest";
import {
  BattleSim, BERSERK_DAMAGE_MULT, CHARGE_X, PHASE_INVULN_MS, RAGE_DAMAGE_MULT,
} from "./BattleSim";
import { MEGA_BOSS_ZOMBIE_KEY, OMEGA_BOSS_ZOMBIE_KEY, SECRET_BOSS_ZOMBIE_KEY } from "./zombieDrops";
import { buildExplicit } from "./harness/roster";
import type { CombatUnit } from "./types";

// Edge cases and interactions of the Boss Zombie colour variants' six abilities (see
// BattleSim.bossVariants.test.ts for each ability's headline behaviour).

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
    ...over,
  };
}
const kill = (sim: BattleSim, u: { maxHp: number }) => (sim as any).dealDamage(u, u.maxHp * 2, false);

describe("Support: several holders, Gardens, and itself", () => {
  const party = (holders: number) => {
    const front = unit({ id: "front", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const blues = Array.from({ length: holders }, (_, i) =>
      unit({ id: `blue${i}`, sourceKey: MEGA_BOSS_ZOMBIE_KEY, team: "player", abilities: ["support"] }));
    const garden = unit({
      id: "garden", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player", isGarden: true,
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([front, ...blues, garden], [enemy], null, true);
    const get = (id: string) => sim.units.find((u) => u.id === id)!;
    const all = [get("front"), ...blues.map((b) => get(b.id)), get("garden")];
    all.forEach((u, i) => { u.state = "fight"; u.lineupIndex = u.isGarden ? 0 : i; });
    return { sim, f: get("front"), blues: blues.map((b) => get(b.id)), g: get("garden") };
  };

  it("two holders take a tenth of the ORIGINAL blow each", () => {
    const { sim, f, blues } = party(2);
    (sim as any).dealEnemyDamage(f, 1000);
    expect(f.hp).toBe(f.maxHp - 800);
    for (const b of blues) expect(b.hp).toBe(b.maxHp - 100);
  });

  it("ten or more holders share out the whole blow and never more", () => {
    const { sim, f, blues } = party(12);
    (sim as any).dealEnemyDamage(f, 1000);
    expect(f.hp).toBe(f.maxHp);
    const taken = blues.reduce((a, b) => a + (b.maxHp - b.hp), 0);
    expect(taken).toBeCloseTo(1000, 6);
  });

  it("a blow on a Garden (the front of the support station) is not shared", () => {
    const { sim, g, blues } = party(1);
    (sim as any).dealEnemyDamage(g, 500);
    expect(g.hp).toBe(g.maxHp - 500);
    expect(blues[0].hp).toBe(blues[0].maxHp);
  });

  it("a holder at the front keeps its own share, and a shared blow is not shared again", () => {
    const { sim, blues } = party(2);
    const [a, b] = blues;
    a.lineupIndex = 0;
    b.lineupIndex = 1;
    (sim as any).dealEnemyDamage(a, 1000);
    expect(a.hp).toBe(a.maxHp - 900);
    expect(b.hp).toBe(b.maxHp - 100);
  });

  it("the share goes through the holder's own reduction and shield", () => {
    const { sim, f, blues } = party(1);
    blues[0].shield = 60;
    blues[0].damageReduction = 0.5;
    (sim as any).dealEnemyDamage(f, 1000);
    // 100 shared -> 50 after its own 50% reduction -> soaked by the 60 shield.
    expect(blues[0].hp).toBe(blues[0].maxHp);
    expect(blues[0].shield).toBe(10);
  });

  it("a holder still in the back group, carried off, or dead shares nothing", () => {
    for (const setup of [
      (b: any) => { b.state = "waiting"; },
      (b: any) => { b.taken = true; },
      (b: any) => { b.alive = false; },
    ]) {
      const { sim, f, blues } = party(1);
      setup(blues[0]);
      (sim as any).dealEnemyDamage(f, 1000);
      expect(f.hp).toBe(f.maxHp - 1000);
    }
  });
});

describe("Shield Bar interactions", () => {
  const solo = () => {
    const blue = unit({ id: "blue", sourceKey: MEGA_BOSS_ZOMBIE_KEY, team: "player", abilities: ["shieldBar"] });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([blue], [enemy], null, true);
    return { sim, b: sim.units.find((u) => u.id === "blue")! };
  };

  it("Protect's reduction applies first, then the shield soaks what is left", () => {
    const { sim, b } = solo();
    b.damageReduction = 0.2;
    b.shield = 1000;
    (sim as any).dealEnemyDamage(b, 1000);
    expect(b.shield).toBe(200);
    expect(b.hp).toBe(b.maxHp);
  });

  it("a hit the shield fully soaks never trips the one-shot floor", () => {
    const { sim, b } = solo();
    b.shield = b.maxHp;
    (sim as any).dealEnemyDamage(b, b.maxHp);
    expect(b.hp).toBe(b.maxHp);
    expect(b.oneShotProtectionUsed).toBe(false);
  });

  it("the soaked part still shows as damage taken", () => {
    const { sim, b } = solo();
    b.shield = 300;
    (sim as any).dealEnemyDamage(b, 500);
    expect(b.damageFxTaken).toBe(500);
  });

  it("a shield on a zombie WITHOUT the ability still soaks (restored checkpoints) but never grows", () => {
    const plain = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([plain], [enemy], null, true);
    const p = sim.units.find((u) => u.id === "p")!;
    p.state = "advance";
    for (let i = 0; i < 40; i++) sim.step(50);
    expect(p.shield).toBe(0);
  });

  it("healers pick by Life alone: a fully shielded zombie at lower Life is healed first", () => {
    const blue = unit({ id: "blue", sourceKey: MEGA_BOSS_ZOMBIE_KEY, team: "player", abilities: ["shieldBar"] });
    const other = unit({ id: "other", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["heal"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([blue, other, healer], [enemy], null, true);
    const get = (id: string) => sim.units.find((u) => u.id === id)!;
    const [b, o, h] = [get("blue"), get("other"), get("healer")];
    for (const u of [b, o, h]) u.state = "advance";
    b.hp = Math.round(b.maxHp * 0.6);
    b.shield = b.maxHp;
    o.hp = Math.round(o.maxHp * 0.7);
    h.healTimerMs = 0;
    for (let i = 0; i < 40 && b.healFxSeq === 0 && o.healFxSeq === 0; i++) sim.step(50);
    expect(b.healFxSeq).toBeGreaterThan(0);
    expect(o.healFxSeq).toBe(0);
  });
});

describe("Phase interactions", () => {
  const party = () => {
    const silver = unit({ id: "silver", sourceKey: SECRET_BOSS_ZOMBIE_KEY, team: "player", abilities: ["teleport", "phase"] });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([silver, healer], [enemy], null, true);
    const get = (id: string) => sim.units.find((u) => u.id === id)!;
    return { sim, s: get("silver"), h: get("healer") };
  };

  it("heals still land inside the window", () => {
    const { sim, s } = party();
    kill(sim, s);
    expect(s.phaseMs).toBe(PHASE_INVULN_MS);
    s.hp += 500; // what a Heal does
    kill(sim, s);
    expect(s.hp).toBe(501);
  });

  it("the window runs out on the fight clock, and then it can fall", () => {
    const { sim, s } = party();
    s.state = "fight";
    kill(sim, s);
    for (let t = 0; t < PHASE_INVULN_MS; t += 50) sim.step(50);
    expect(s.phaseMs).toBe(0);
    kill(sim, s);
    expect(s.alive).toBe(false);
  });

  it("is not handed back by a Resurrect: revived, the next death is final", () => {
    const { sim, s, h } = party();
    h.state = "advance";
    kill(sim, s); // phases
    s.phaseMs = 0;
    kill(sim, s); // falls
    sim.step(50); // the Garden revives it
    expect(s.alive).toBe(true);
    expect(h.resurrectUsed).toBe(true);
    kill(sim, s);
    expect(s.alive).toBe(false);
    expect(s.phaseFxSeq).toBe(1);
  });

  it("a revived Secret teleports back into the line", () => {
    const { sim, s, h } = party();
    h.state = "advance";
    s.phaseUsed = true;
    kill(sim, s);
    for (let i = 0; i < 4 && s.teleportFxSeq === 0; i++) sim.step(50);
    expect(s.alive).toBe(true);
    expect(s.teleportFxSeq).toBe(1);
    expect(s.x).toBeGreaterThan(CHARGE_X + 100);
  });
});

describe("Teleport past a wall", () => {
  const withWall = (abilities: string[]) => {
    const z = unit({ id: "z", sourceKey: SECRET_BOSS_ZOMBIE_KEY, team: "player", abilities });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const wall = unit({ id: "wall", sourceKey: "FarmStageActorFarmhand", team: "enemy", hp: 1e6, maxHp: 1e6 });
    const sim = new BattleSim([z], [enemy, wall], null, true);
    const get = (id: string) => sim.units.find((u) => u.id === id)!;
    const w = get("wall");
    w.isWall = true;
    w.isBlocker = true;
    w.state = "hold";
    w.x = CHARGE_X + 120;
    const zz = get("z");
    w.y = zz.y;
    zz.state = "charging";
    zz.x = CHARGE_X;
    (sim as any).releaseCharger(zz);
    return { sim, z: zz, w };
  };

  it("a walker stops at the wall; a teleporter lands past it and stays past it", () => {
    const walker = withWall([]);
    for (let i = 0; i < 200; i++) walker.sim.step(50);
    expect(walker.z.x).toBeLessThan(walker.w.x + 0.5);

    const jumper = withWall(["teleport"]);
    jumper.sim.step(50);
    expect(jumper.z.teleportFxSeq).toBe(1);
    expect(jumper.z.x).toBeGreaterThan(jumper.w.x + 0.5);
    for (let i = 0; i < 40; i++) jumper.sim.step(50);
    expect(jumper.z.x).toBeGreaterThan(jumper.w.x + 0.5);
  });

  it("only fires once per deploy: a knockback walk-back is walked", () => {
    const { sim, z } = withWall(["teleport"]);
    sim.step(50);
    (sim as any).knockBackZombie(z);
    expect(z.teleportPending).toBe(false);
    for (let i = 0; i < 20; i++) sim.step(50);
    expect(z.teleportFxSeq).toBe(1);
  });
});

describe("Omega edge cases", () => {
  const solo = (abilities: string[]) => {
    const red = unit({ id: "red", sourceKey: OMEGA_BOSS_ZOMBIE_KEY, team: "player", abilities, damage: 100 } as any);
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", hp: 1e9, maxHp: 1e9 });
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

  it("Rage starts strictly under half Life", () => {
    const { sim, r } = solo(["rage"]);
    const calm = (sim as any).cycleMs(r, null);
    r.hp = r.maxHp * 0.5;
    expect((sim as any).cycleMs(r, null)).toBe(calm);
    r.hp = r.maxHp * 0.5 - 1;
    expect((sim as any).cycleMs(r, null)).toBeLessThan(calm);
  });

  it("a Berserk death is an ordinary death: it joins the corpse backlog a Resurrect draws on", () => {
    const { sim, r, e } = solo(["berserk"]);
    r.hp = 1;
    swing(sim, r, e);
    expect(r.alive).toBe(false);
    expect((sim as any).fallen).toContain(r.id);
  });

  it("Rage and Berserk stack multiplicatively on the swing", () => {
    const plain = solo([]);
    const base = swing(plain.sim, plain.r, plain.e);
    const { sim, r, e } = solo(["rage", "berserk"]);
    r.hp = Math.floor(r.maxHp * 0.3);
    expect(swing(sim, r, e)).toBe(Math.round(base * BERSERK_DAMAGE_MULT * RAGE_DAMAGE_MULT));
  });
});

describe("aura refresh never revives Life on the dead (found by the stress suite)", () => {
  it("a fallen Headless stays at 0 when a Fortitude carrier changes the line's Life", () => {
    // Real catalog units, so the Headless carries the aura stat block refreshTeamAuras rescales.
    const { units } = buildExplicit(["ZombieActorOmegaZombieBot", "ZombieActorOmegaDrZombie"], { playerLevel: 45 });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim(units, [enemy], null, true);
    const [t, d] = sim.units.filter((u) => u.team === "player");
    expect(t.teamAuraStats).not.toBeNull();
    kill(sim, t);
    expect(t.alive).toBe(false);
    d.state = "advance"; // the carrier deploys: Fortitude goes from 0 to 1
    (sim as any).refreshTeamAuras();
    expect(t.maxHp).toBeGreaterThan(0);
    expect(t.hp).toBe(0);
    expect(sim.teamTotals().playerHp).toBe(d.hp);
  });

  it("a living Headless keeps at least 1 Life when its Fortitude carrier falls", () => {
    const { units } = buildExplicit(["ZombieActorOmegaZombieBot", "ZombieActorOmegaDrZombie"], { playerLevel: 45 });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim(units, [enemy], null, true);
    const [t, d] = sim.units.filter((u) => u.team === "player");
    t.state = "advance";
    d.state = "advance";
    (sim as any).refreshTeamAuras(); // the bonus is on
    const boosted = t.maxHp;
    t.hp = 1; // hanging on by the bonus alone
    kill(sim, d);
    (sim as any).refreshTeamAuras(); // ...which the carrier's death takes back
    expect(t.maxHp).toBeLessThan(boosted);
    expect(t.alive).toBe(true);
    expect(t.hp).toBe(1);
  });
});

describe("checkpoints carry every new field", () => {
  it("snapshot -> JSON -> restore keeps shield, Phase and Teleport state exactly", () => {
    const blue = unit({ id: "blue", sourceKey: MEGA_BOSS_ZOMBIE_KEY, team: "player", abilities: ["shieldBar", "support"] });
    const silver = unit({ id: "silver", sourceKey: SECRET_BOSS_ZOMBIE_KEY, team: "player", abilities: ["teleport", "phase"] });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const make = () => new BattleSim([blue, silver], [enemy], null, true);
    const sim = make();
    const b = sim.units.find((u) => u.id === "blue")!;
    const s = sim.units.find((u) => u.id === "silver")!;
    b.shield = 123.456;
    s.phaseUsed = true;
    s.phaseMs = 1750;
    s.phaseFxSeq = 1;
    s.teleportPending = true;
    s.teleportFxSeq = 2;
    const resumed = make();
    resumed.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    const rb = resumed.units.find((u) => u.id === "blue")!;
    const rs = resumed.units.find((u) => u.id === "silver")!;
    expect(rb.shield).toBe(123.456);
    expect([rs.phaseUsed, rs.phaseMs, rs.phaseFxSeq, rs.teleportPending, rs.teleportFxSeq])
      .toEqual([true, 1750, 1, true, 2]);
  });

  it("a pre-v82 checkpoint (no new fields) restores to the neutral defaults", () => {
    const silver = unit({ id: "silver", sourceKey: SECRET_BOSS_ZOMBIE_KEY, team: "player", abilities: ["phase"] });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([silver], [enemy], null, true);
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    for (const u of snap.units) {
      for (const k of ["shield", "phaseUsed", "phaseMs", "phaseFxSeq", "teleportPending", "teleportFxSeq"]) delete u[k];
    }
    const resumed = new BattleSim([silver], [enemy], null, true);
    resumed.restore(snap);
    const rs = resumed.units.find((u) => u.id === "silver")!;
    expect([rs.shield, rs.phaseUsed, rs.phaseMs, rs.teleportPending]).toEqual([0, false, 0, false]);
  });
});

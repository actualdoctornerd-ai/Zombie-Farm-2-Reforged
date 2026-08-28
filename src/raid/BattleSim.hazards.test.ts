import { describe, expect, it } from "vitest";
import { BattleSim, CHARGE_X, ENEMY_HOLD_X } from "./BattleSim";
import type { CombatUnit, CrabConfig, GrabberConfig } from "./types";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

/** Build a sim with a trapeze grabber; the player starts already deployed on the lane. */
function grabSim(grabber: GrabberConfig, players: CombatUnit[], enemies: CombatUnit[]) {
  const sim = new BattleSim(
    players, enemies, null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, grabber
  );
  for (const p of players) {
    const su = sim.units.find((u) => u.id === p.id)!;
    su.state = "advance";
  }
  return sim;
}

/** Step the sim in fixed ticks until `pred` holds or `maxMs` elapses; returns elapsed ms. */
function stepUntil(sim: BattleSim, pred: () => boolean, maxMs = 12000): number {
  let t = 0;
  while (t < maxMs && !pred()) {
    sim.step(16);
    t += 16;
  }
  return t;
}

const GRAB: GrabberConfig = { sprite: "t.png", hp: 200, tapDamage: 100, spawnDelayMs: 100 };

describe("Trapeze Artist grab hazard", () => {
  it("first swings right-to-left and stops when it reaches its target", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim(GRAB, [player], [enemy]);

    stepUntil(sim, () => sim.grabbers.length > 0);
    const g = sim.grabbers[0];
    expect(g.state).toBe("swoop");
    expect(g.rot).toBeLessThan(10);
    sim.step(400);
    expect(g.state).toBe("swoop");
    expect(g.rot).toBeGreaterThan(0);
    expect(g.rot).toBeLessThan(g.contactDeg);

    stepUntil(sim, () => g.state === "carry");
    expect(g.rot).toBe(90);
  });

  it("reanchors the pivot directly above the zombie at contact", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim(GRAB, [player], [enemy]);

    stepUntil(sim, () => sim.grabbers.length > 0);
    const g = sim.grabbers[0];
    expect(g.swingTotalMs).toBeLessThan(1700);
    stepUntil(sim, () => sim.activeGrabber() !== null);
    const z = sim.units.find((u) => u.id === "p")!;
    expect(g.x).toBe(z.x);
    expect(g.rot).toBe(90);
  });

  it("alternates the next appearance to a left-to-right swing", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim(GRAB, [player], [enemy]);

    stepUntil(sim, () => sim.activeGrabber() !== null);
    const first = sim.activeGrabber()!;
    expect(first.swingStartDeg).toBe(0);
    expect(sim.tapGrabber(first.id)).toBe(true);
    sim.step(300);
    expect(sim.tapGrabber(first.id)).toBe(true);

    stepUntil(sim, () => sim.grabbers.some((g) => g.id === "grab1"), 9000);
    const second = sim.grabbers.find((g) => g.id === "grab1")!;
    expect(second.state).toBe("swoop");
    expect(second.swingStartDeg).toBe(180);
    expect(second.rot).toBeLessThan(180);
    expect(second.rot).toBeGreaterThan(second.contactDeg);
  });

  it("sweeps in and seizes a deployed zombie (it goes inactive)", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim(GRAB, [player], [enemy]);
    stepUntil(sim, () => sim.units.find((u) => u.id === "p")!.state === "grabbed");
    const z = sim.units.find((u) => u.id === "p")!;
    expect(z.state).toBe("grabbed");
    expect(z.alive).toBe(true); // held, not dead
    expect(sim.activeGrabber()).not.toBeNull();
  });

  it("tapping it to death DROPS the zombie back into the fight (alive, resumes)", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim(GRAB, [player], [enemy]);
    stepUntil(sim, () => sim.activeGrabber() !== null);
    const g = sim.activeGrabber()!;
    // 200 HP / 100 per tap = 2 taps; tapDelay gates them, so step between taps.
    expect(sim.tapGrabber(g.id)).toBe(true);
    sim.step(300); // clear the tap cooldown
    expect(sim.tapGrabber(g.id)).toBe(true);
    const z = sim.units.find((u) => u.id === "p")!;
    expect(z.alive).toBe(true);
    expect(z.state).not.toBe("grabbed");
    expect(sim.grabbers.some((x) => x.state !== "gone")).toBe(false);
  });

  it("destroys remaining hazards and drops a held zombie for the end march", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim(GRAB, [player], [enemy]);
    stepUntil(sim, () => sim.activeGrabber() !== null);
    const zombie = sim.units.find((unit) => unit.id === "p")!;
    zombie.distracted = true;
    zombie.awaitRelease = true;
    sim.projectiles.push({
      id: "late-shot", x: 0, y: 0, vx: 0, vy: 0, rot: 0, rotSpeed: 0,
      damage: 1, sprite: "", spriteSize: 1, done: false, gravity: 0,
    });
    sim.crabs.push({
      id: "late-crab", x: zombie.x, y: zombie.y, state: "hold", dir: -1,
      wanderMs: 0, hp: 100, maxHp: 100, tapDamage: 10, grabbedId: zombie.id,
      holdMs: 1000, tapCdMs: 0, sprite: "crab.png", struckThisTick: false,
    });

    sim.prepareArmyExit();

    expect(sim.grabbers).toHaveLength(0);
    expect(sim.crabs).toHaveLength(0);
    expect(sim.projectiles).toHaveLength(0);
    expect(zombie).toMatchObject({
      alive: true, state: "advance", distracted: false, awaitRelease: false, charge: 0,
    });
  });

  it("honors the tap cooldown (a second tap in the same beat is ignored)", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim({ ...GRAB, hp: 1000 }, [player], [enemy]);
    stepUntil(sim, () => sim.activeGrabber() !== null);
    const g = sim.activeGrabber()!;
    expect(sim.tapGrabber(g.id)).toBe(true); // lands
    expect(sim.tapGrabber(g.id)).toBe(false); // too soon — ignored
  });

  it("if it escapes with the zombie, that zombie DIES", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim({ ...GRAB, hp: 100000 }, [player], [enemy]); // effectively un-tappable in time
    stepUntil(sim, () => !sim.units.find((u) => u.id === "p")!.alive, 20000);
    expect(sim.units.find((u) => u.id === "p")!.alive).toBe(false);
  });

  it("keeps the zombie alive through the early lift and only kills it off-screen", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 3000 });
    const sim = grabSim({ ...GRAB, hp: 100000 }, [player], [enemy]);
    stepUntil(sim, () => sim.activeGrabber() !== null);
    const z = sim.units.find((u) => u.id === "p")!;

    // Well into the lift, the zombie is still alive; death waits for full clearance.
    stepUntil(sim, () => z.y <= -50);
    expect(z.alive).toBe(true);
    expect(z.state).toBe("grabbed");

    stepUntil(sim, () => !z.alive);
    expect(z.alive).toBe(false);
    expect(z.y).toBeLessThan(-300);
  });
});

describe("boss wall (carrotWall / junkWall)", () => {
  it("spawns a tappable wall that chips 75 per tap", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const boss = unit({ id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy", isBoss: true, con: 3000 });
    // A minion keeps the boss on its perch — only a perched boss walls.
    const minion = unit({ id: "minion", sourceKey: "NinjaStageActorBoy", team: "enemy", con: 3000 });
    const wallTemplate = unit({
      id: "wall", sourceKey: "carrotWall", team: "enemy", str: 0, con: 150,
      hp: 1500, maxHp: 1500, attacks: [{ name: "", frequency: 1, mult: 0 }],
    });
    const sim = new BattleSim(
      [player], [minion, boss], null, true,
      [{ name: "wall", weight: 100, castMs: 0, cooldownMs: 999999, damage: 0 }],
      10 * 60 * 1000, null, wallTemplate
    );
    stepUntil(sim, () => sim.units.some((u) => u.isWall && u.alive));
    const wall = sim.units.find((u) => u.isWall)!;
    expect(wall.hp).toBe(1500);
    expect(sim.tapWall(wall.id)).toBe(true);
    expect(wall.hp).toBe(1425); // 1500 − 75
  });

  it("casts for three seconds without throwing, then resumes tossing after the fixed wall appears", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const boss = unit({ id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy", isBoss: true, con: 3000 });
    const minion = unit({ id: "minion", sourceKey: "NinjaStageActorBoy", team: "enemy", con: 3000 });
    const wallTemplate = unit({
      id: "wall", sourceKey: "carrotWall", team: "enemy", str: 0, con: 150,
      hp: 1500, maxHp: 1500, attacks: [{ name: "", frequency: 1, mult: 0 }],
    });
    const sim = new BattleSim(
      [player], [minion, boss],
      { intervalMs: 100, options: [{ damage: 1, weight: 1, sprite: "carrot.png", spriteSize: 20 }] },
      true,
      // cooldownMs mirrors what the real `wall` action derives (it carries castTime 3
      // and no cooldownTime). Throws share this action budget, so the wall's cast AND
      // its recovery both hold the toss — see BattleSim.stepBossActions.
      [{ name: "wall", weight: 100, castMs: 3000, cooldownMs: 3000, damage: 0 }],
      10 * 60 * 1000, null, wallTemplate
    );
    sim.units.find((u) => u.id === "p")!.state = "advance";
    sim.step(16);
    expect(sim.bossWallSummonProgress()).toBe(0);
    for (let t = 0; t < 2900; t += 16) sim.step(16);
    expect(sim.units.some((u) => u.isWall)).toBe(false);
    expect(sim.projectiles).toHaveLength(0);

    stepUntil(sim, () => sim.units.some((u) => u.isWall && u.alive));
    const wall = sim.units.find((u) => u.isWall)!;
    const spawnX = wall.x;
    // A second wall is refused while this one stands, so the budget falls through to
    // throws once the cast's recovery elapses.
    stepUntil(sim, () => sim.projectiles.length > 0);
    expect(wall.x).toBe(spawnX);
    expect(sim.projectiles.length).toBeGreaterThan(0);
  });

  it("stops walling once the boss climbs down off its structure", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    // No minions, so promote() sends the boss down the moment the fight opens.
    const boss = unit({ id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy", isBoss: true, con: 3000 });
    const wallTemplate = unit({
      id: "wall", sourceKey: "carrotWall", team: "enemy", str: 0, con: 150,
      hp: 1500, maxHp: 1500, attacks: [{ name: "", frequency: 1, mult: 0 }],
    });
    const sim = new BattleSim(
      [player], [boss], null, true,
      [{ name: "wall", weight: 100, castMs: 0, cooldownMs: 0, damage: 0 }],
      10 * 60 * 1000, null, wallTemplate
    );
    const b = sim.units.find((u) => u.id === "boss")!;
    stepUntil(sim, () => b.state !== "structure");
    expect(b.state).not.toBe("structure");
    // The wall is over half the Ninja boss's action budget, so a permissive gate would
    // have it re-summoning carrots behind itself for the rest of the fight.
    for (let t = 0; t < 8000; t += 16) sim.step(16);
    expect(sim.units.some((u) => u.isWall)).toBe(false);
  });

  it("does not keep the boss perched: the boss descends once the minions die, wall standing", () => {
    // Ruleset 47. The zombie starts PAST the wall's spawn point, so it latches
    // `passedWall` and kills the minion straight through the fight — leaving the field
    // in the state that used to soft-lock it: minions dead, wall untouched, boss up top
    // untargetable and still throwing, and this zombie with no target at all until the
    // player hand-tapped 1500 hp of wall away.
    const past = unit({
      id: "past", sourceKey: "ZombieActorRegularTier1", team: "player",
      str: 60, attackCooldownMs: 200,
    });
    const minion = unit({
      id: "minion", sourceKey: "NinjaStageActorBoy", team: "enemy",
      hp: 40, maxHp: 40, con: 100, attackCooldownMs: 10_000,
    });
    const boss = unit({
      id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy",
      isBoss: true, con: 3000,
    });
    const wallTemplate = unit({
      id: "wall", sourceKey: "carrotWall", team: "enemy", str: 0, con: 150,
      hp: 1500, maxHp: 1500, attacks: [{ name: "", frequency: 1, mult: 0 }],
    });
    const sim = new BattleSim(
      [past], [minion, boss], null, true,
      [{ name: "wall", weight: 100, castMs: 1, cooldownMs: 999999, damage: 0 }],
      10 * 60 * 1000, null, wallTemplate
    );
    const z = sim.units.find((u) => u.id === "past")!;
    const m = sim.units.find((u) => u.id === "minion")!;
    const b = sim.units.find((u) => u.id === "boss")!;
    z.state = "advance";
    z.x = 700;
    m.state = "hold";
    m.x = 915;

    stepUntil(sim, () => sim.units.some((u) => u.isWall && u.alive));
    expect(z.passedWall).toBe(true);
    expect(b.state).toBe("structure");

    stepUntil(sim, () => !m.alive);
    expect(m.alive).toBe(false);

    stepUntil(sim, () => b.state !== "structure");
    const wall = sim.units.find((u) => u.isWall)!;
    expect(wall.alive).toBe(true); // nothing ever hit it — it is NOT what let the boss down
    expect(b.state).toBe("descending");
  });

  it("blocks zombies marching past it, but not those already past it or holding behind it", () => {
    const blocked = unit({
      id: "blocked", sourceKey: "ZombieActorRegularTier1", team: "player",
      str: 1, attackCooldownMs: 200,
    });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier1", team: "player",
      str: 1, isGarden: true, abilities: ["heal"], attackCooldownMs: 200,
    });
    const past = unit({
      id: "past", sourceKey: "ZombieActorRegularTier1", team: "player",
      str: 1, attackCooldownMs: 200,
    });
    const minion = unit({
      id: "minion", sourceKey: "NinjaStageActorBoy", team: "enemy",
      hp: 10_000, maxHp: 10_000, con: 100, attackCooldownMs: 10_000,
    });
    const boss = unit({
      id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy",
      isBoss: true, con: 3000,
    });
    const wallTemplate = unit({
      id: "wall", sourceKey: "carrotWall", team: "enemy", str: 0, con: 150,
      hp: 1500, maxHp: 1500, attacks: [{ name: "", frequency: 1, mult: 0 }],
    });
    const sim = new BattleSim(
      [blocked, healer, past], [minion, boss], null, true,
      [{ name: "wall", weight: 100, castMs: 1, cooldownMs: 999999, damage: 0 }],
      10 * 60 * 1000, null, wallTemplate
    );
    const b = sim.units.find((u) => u.id === "blocked")!;
    const h = sim.units.find((u) => u.id === "healer")!;
    const through = sim.units.find((u) => u.id === "past")!;
    const enemy = sim.units.find((u) => u.id === "minion")!;
    for (const p of [b, h, through]) p.state = "advance";
    b.x = 400;
    h.x = 450;
    through.x = 700;
    enemy.state = "hold";
    enemy.x = 915;

    stepUntil(sim, () => sim.units.some((u) => u.isWall));
    const wall = sim.units.find((u) => u.isWall)!;
    b.hp -= 100;
    expect(through.passedWall).toBe(true);
    const wallHp = wall.hp;
    const enemyHp = enemy.hp;
    for (let t = 0; t < 1800; t += 16) sim.step(16);

    expect(wall.hp).toBeLessThan(wallHp);
    // The healer's station is far behind the wall, so the wall was never in its way: it
    // keeps healing right through the block instead of standing idle for the whole fight.
    expect(h.healCastSeq).toBeGreaterThan(0);
    expect(h.x).toBeLessThan(wall.x);
    expect(enemy.hp).toBeLessThan(enemyHp);
    // The wall materialises at the support line: halfway from the staging slot to the
    // front, so it moves with ENEMY_HOLD_X rather than sitting on a fixed number.
    expect(wall.x).toBeCloseTo(CHARGE_X + (ENEMY_HOLD_X - 60 - CHARGE_X) / 2, 1);
  });
});

/** Build a sim with a Beach crab; the player starts already deployed on the lane. */
function crabSim(crab: CrabConfig, players: CombatUnit[], enemies: CombatUnit[]) {
  const sim = new BattleSim(
    players, enemies, null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, crab
  );
  for (const p of players) {
    sim.units.find((u) => u.id === p.id)!.state = "advance";
  }
  return sim;
}

// Ground truth: HP 1000 / 100 per tap = exactly 10 taps; 2.0s hold before the haul.
const CRAB: CrabConfig = { sprite: "c.png", hp: 1000, tapDamage: 100, spawnMs: 100, limit: 2, holdMs: 2000 };

describe("Beach crab hazard", () => {
  it("grabs a deployed zombie on contact — held, alive, and invincible to the fight", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "BeachStageActorMinion2", team: "enemy", con: 3000 });
    const sim = crabSim(CRAB, [player], [enemy]);
    stepUntil(sim, () => sim.units.find((u) => u.id === "p")!.state === "grabbed");
    const z = sim.units.find((u) => u.id === "p")!;
    expect(z.state).toBe("grabbed");
    expect(z.alive).toBe(true);
    expect(z.taken).toBe(false); // still in the fight until it's hauled off
    expect(sim.activeCrabs().length).toBeGreaterThan(0);
  });

  it("takes exactly 10 taps to kill (100 damage vs 1000 HP)", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "BeachStageActorMinion2", team: "enemy", con: 3000 });
    const sim = crabSim(CRAB, [player], [enemy]);
    stepUntil(sim, () => sim.activeCrabs().length > 0);
    const id = sim.activeCrabs()[0].id;
    for (let i = 0; i < 9; i++) {
      expect(sim.tapCrab(id)).toBe(true);
      sim.step(300); // clear the tap cooldown
    }
    expect(sim.crabs.find((c) => c.id === id)!.hp).toBe(100);
    expect(sim.tapCrab(id)).toBe(true); // the 10th kills it
    expect(sim.activeCrabs().some((c) => c.id === id)).toBe(false);
  });

  it("tapping it to death FREES the held zombie back onto the lane", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "BeachStageActorMinion2", team: "enemy", con: 3000 });
    const sim = crabSim(CRAB, [player], [enemy]);
    stepUntil(sim, () => sim.units.find((u) => u.id === "p")!.state === "grabbed");
    const id = sim.crabs.find((c) => c.grabbedId === "p")!.id;
    for (let i = 0; i < 10; i++) {
      sim.tapCrab(id);
      sim.step(300);
    }
    const z = sim.units.find((u) => u.id === "p")!;
    expect(z.alive).toBe(true);
    expect(z.taken).toBe(false);
    expect(z.state).not.toBe("grabbed"); // back on the lane
  });

  it("if NOT tapped it carries the zombie off: taken, still alive, out of the fight", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "BeachStageActorMinion2", team: "enemy", con: 3000 });
    const sim = crabSim(CRAB, [player], [enemy]);
    stepUntil(sim, () => sim.units.find((u) => u.id === "p")!.taken, 60000);
    const z = sim.units.find((u) => u.id === "p")!;
    expect(z.taken).toBe(true);
    expect(z.alive).toBe(true); // NOT the death path (source state 38, not 100)
    // A carried-off zombie still counts as a SURVIVOR — it comes home after the raid.
    expect(sim.outcome().survivors).toContain("p");
    expect(sim.outcome().losses).not.toContain("p");
  });

  it("losing every zombie to crabs ends the fight (taken zombies can't keep it alive)", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "BeachStageActorMinion2", team: "enemy", con: 3000 });
    const sim = crabSim(CRAB, [player], [enemy]);
    stepUntil(sim, () => sim.finished, 90000);
    expect(sim.units.find((u) => u.id === "p")!.taken).toBe(true);
    expect(sim.finished).toBe(true);
    expect(sim.outcome().win).toBe(false);
  });

  it("respects the concurrent cap", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "e", sourceKey: "BeachStageActorMinion2", team: "enemy", con: 3000 });
    const sim = crabSim({ ...CRAB, limit: 2 }, [player], [enemy]);
    stepUntil(sim, () => false, 8000); // let the spawn timer run well past 2 intervals
    expect(sim.activeCrabs().length).toBeLessThanOrEqual(2);
  });
});

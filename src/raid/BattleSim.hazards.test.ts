import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import type { CombatUnit, GrabberConfig } from "./types";

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
    players, enemies, null, true, [], null, 10 * 60 * 1000, null, null, false, false, false, 60, grabber
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
    stepUntil(sim, () => !sim.units.find((u) => u.id === "p")!.alive);
    expect(sim.units.find((u) => u.id === "p")!.alive).toBe(false);
  });
});

describe("boss wall (carrotWall / junkWall)", () => {
  it("spawns a tappable wall that chips 75 per tap", () => {
    const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const boss = unit({ id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy", isBoss: true, con: 3000 });
    const wallTemplate = unit({
      id: "wall", sourceKey: "carrotWall", team: "enemy", str: 0, con: 150,
      hp: 1500, maxHp: 1500, attacks: [{ name: "", frequency: 1, mult: 0 }],
    });
    const sim = new BattleSim(
      [player], [boss], null, true,
      [{ name: "wall", weight: 100, castMs: 0, cooldownMs: 999999, damage: 0 }],
      null, 10 * 60 * 1000, null, wallTemplate
    );
    stepUntil(sim, () => sim.units.some((u) => u.isWall && u.alive));
    const wall = sim.units.find((u) => u.isWall)!;
    expect(wall.hp).toBe(1500);
    expect(sim.tapWall(wall.id)).toBe(true);
    expect(wall.hp).toBe(1425); // 1500 − 75
  });
});

import { describe, expect, it } from "vitest";
import { buildFight } from "./buildFight";
import type { BattleSim } from "./BattleSim";
import { megaBotFor, MEGA_BOT_RAID_ID } from "./fightConfig";
import type { CombatUnit, MegaBotConfig, RaidDef } from "./types";

// The Mega-Robot (RobotStageActorGiantBot) — see types.MegaBotConfig and
// ZF2R_extracted/docs/mechanics/GIANT_BOT_HAZARD.md for the ground truth pinned here.

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 0, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

const EYES: MegaBotConfig = { eyeHp: 2400, tapDamage: 200 };

/** A harmless standoff (nobody deals damage) with a boss, so the round clock runs and
 *  the only thing that can hurt a zombie is the robot. Every zombie starts deployed. */
function fight(megaBot: MegaBotConfig | null, zombies = 6): BattleSim {
  const players = Array.from({ length: zombies }, (_, i) =>
    unit({ id: `z${i}`, sourceKey: "ZombieActorRegularTier1", team: "player" }));
  const enemies = [
    unit({ id: "boss", sourceKey: "RobotStageActorBrainBot", team: "enemy", isBoss: true, hp: 1e9, maxHp: 1e9 }),
    unit({ id: "wall", sourceKey: "RobotStageActorJunkBot", team: "enemy", hp: 1e9, maxHp: 1e9 }),
  ];
  const sim = buildFight({ playerUnits: players, enemyUnits: enemies, concentration: true, megaBot });
  for (const u of sim.units) if (u.team === "player") u.state = "advance";
  return sim;
}

function run(sim: BattleSim, ms: number, each?: (t: number) => void) {
  for (let t = 0; t < ms; t += 50) {
    each?.(t);
    sim.step(50);
  }
}

const dead = (sim: BattleSim) => sim.units.filter((u) => u.team === "player" && !u.alive).length;

describe("Mega-Robot hazard", () => {
  it("stays hidden for 15 s, climbs until 20 s, then lights an 8 s fuse", () => {
    const sim = fight(EYES);
    run(sim, 14_900);
    expect(sim.megaBot!.phase).toBe("hidden");
    run(sim, 200);
    expect(sim.megaBot!.phase).toBe("rising");
    run(sim, 5_000);
    expect(sim.megaBot!.phase).toBe("charge");
    expect(sim.megaBot!.chargeMs).toBe(8_000);
  });

  it("ignored, it kills one zombie per shot — first blast at 0:29, then every 10 s", () => {
    const sim = fight(EYES);
    run(sim, 28_900);
    expect(dead(sim)).toBe(0);
    run(sim, 300);
    expect(sim.megaBot!.blastSeq).toBe(1);
    expect(dead(sim)).toBe(1);
    run(sim, 10_000);
    expect(sim.megaBot!.blastSeq).toBe(2);
    expect(dead(sim)).toBe(2);
    // Casualties are ordinary losses, so they reach the server as clientLosses.
    expect(sim.outcome().losses.length).toBe(2);
  });

  it("twelve taps on the lit eyes cancel the shot, and it re-arms 5 s later", () => {
    const sim = fight(EYES);
    run(sim, 20_100);
    let taps = 0;
    while (sim.megaBot!.phase === "charge") {
      if (sim.tapMegaBotEyes()) taps++;
      sim.step(50);
    }
    expect(taps).toBe(12);
    expect(sim.megaBot!.phase).toBe("disabled");
    run(sim, 4_900);
    expect(sim.megaBot!.phase).toBe("disabled");
    run(sim, 200);
    expect(sim.megaBot!.phase).toBe("charge");
    expect(sim.megaBot!.eyeHp).toBe(2400);
    expect(sim.megaBot!.blastSeq).toBe(0);
    expect(dead(sim)).toBe(0);
  });

  it("the eyes can only be tapped while they are charging, and every tap counts", () => {
    const sim = fight(EYES);
    expect(sim.tapMegaBotEyes()).toBe(false); // still hidden
    run(sim, 20_100);
    expect(sim.tapMegaBotEyes()).toBe(true);
    // No rescue-hazard tap gate: the source's eye box takes every touch.
    expect(sim.tapMegaBotEyes()).toBe(true);
    expect(sim.megaBot!.eyeHp).toBe(2400 - 2 * 200);
    run(sim, 8_000); // fuse ran out → in flight
    expect(sim.megaBot!.phase).toBe("fire");
    expect(sim.tapMegaBotEyes()).toBe(false);
  });

  it("the splash reaches neighbours but only the zombie at ground zero dies", () => {
    const sim = fight(EYES, 2);
    const [a, b] = sim.units.filter((u) => u.team === "player");
    run(sim, 29_000, () => {
      // Pin the two side by side, 15 points apart, well clear of the enemies.
      a.state = "advance"; b.state = "advance";
      a.x = 300; b.x = 300 + 15 * (1000 / 384);
      a.y = b.y = 280;
    });
    expect(dead(sim)).toBe(1);
    const survivor = a.alive ? a : b;
    // 800 / (1 + 15/10) = 320 splash.
    expect(survivor.maxHp - survivor.hp).toBeCloseTo(320, 0);
  });

  it("enrage halves the fuse to 4 s", () => {
    const sim = buildFight({
      playerUnits: [unit({ id: "z0", sourceKey: "ZombieActorRegularTier1", team: "player" })],
      enemyUnits: [unit({ id: "boss", sourceKey: "RobotStageActorBrainBot", team: "enemy", isBoss: true, hp: 1e9, maxHp: 1e9 })],
      concentration: true,
      roundMs: 10_000, // enrages before the 20 s arm point
      megaBot: EYES,
    });
    sim.units[0].state = "advance";
    run(sim, 15_100);
    expect(sim.enraged).toBe(true);
    // The round clock froze at enrage with 10 s gone, so it arms on the enrage path.
    expect(sim.megaBot!.chargeMs).toBe(4_000);
  });

  it("without the config (the server's sim) nothing happens", () => {
    const sim = fight(null);
    run(sim, 60_000);
    expect(sim.megaBot).toBeNull();
    expect(dead(sim)).toBe(0);
  });
});

describe("megaBotFor", () => {
  const raid = (id: number) => ({ id } as RaidDef);
  it("fields the robot on Zombies vs Robots only", () => {
    expect(MEGA_BOT_RAID_ID).toBe(5);
    expect(megaBotFor(raid(5))?.tapDamage).toBe(200);
    for (const id of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect(megaBotFor(raid(id))).toBeNull();
    }
  });
});

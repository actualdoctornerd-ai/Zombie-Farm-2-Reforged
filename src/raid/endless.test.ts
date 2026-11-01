import { describe, expect, it } from "vitest";
import enemyStats from "../../public/assets/raids/enemy_stats.json";
import attacks from "../../public/assets/raids/attacks.json";
import { buildUnitsForKeys } from "./CombatEngine";
import {
  ENDLESS_DAMAGE_STEP, ENDLESS_ENTRY_COST, ENDLESS_ENTRY_THREAT_RATING, ENDLESS_HEALTH_STEP,
  ENDLESS_LOCATION_MECHANICS, ENDLESS_UNLOCK_LEVEL, endlessBossAsRegularAllowed, endlessBossMultiplier,
  applyEndlessBoon, applyEndlessCurse, beginEndlessRun, endlessBossDraft, endlessEnemyArchetype, endlessWavePlan, scaleEndlessEnemy,
} from "./endless";

describe("Endless Mode plan", () => {
  it("uses the intended entry gates and brain costs", () => {
    expect(ENDLESS_UNLOCK_LEVEL).toEqual({ endless: 30, nightmare: 45 });
    expect(ENDLESS_ENTRY_COST).toEqual({ endless: 1, nightmare: 3 });
  });

  it("keeps mechanics constant within a location while tightening cadence locally", () => {
    const start = endlessWavePlan("endless", 5);
    const middle = endlessWavePlan("endless", 6);
    const gate = endlessWavePlan("endless", 8);
    expect(start.location).toBe("ninja");
    expect(middle.location).toBe("ninja");
    expect(gate.location).toBe("ninja");
    expect(ENDLESS_LOCATION_MECHANICS.ninja.mechanics)
      .toEqual(["carrot-wall", "smoke-bomb-teleport"]);
    expect(start.mechanicCooldownScale).toBe(1);
    expect(start.mechanicCooldownsMs["smoke-bomb-teleport"]).toBe(30_000);
    expect(gate.mechanicCooldownsMs["smoke-bomb-teleport"]).toBe(19_800);
    expect(middle.mechanicCooldownScale).toBeLessThan(start.mechanicCooldownScale);
    expect(gate.mechanicCooldownScale).toBeLessThan(middle.mechanicCooldownScale);
    expect(endlessWavePlan("endless", 9).mechanicCooldownScale).toBe(1);
    expect(endlessWavePlan("endless", 9).mechanicCooldownsMs.laser).toBe(26_000);
  });

  it("scales enemy stats and enemy roster by global depth", () => {
    const early = endlessWavePlan("endless", 3);
    const deep = endlessWavePlan("endless", 15);
    expect(deep.damageScale).toBeCloseTo((1 + ENDLESS_DAMAGE_STEP) ** 14);
    expect(deep.healthScale).toBeCloseTo((1 + ENDLESS_HEALTH_STEP) ** 14);
    expect(deep.enemyTier).toBeGreaterThan(early.enemyTier);
    expect(deep.enemyKeys.some((key) => key.includes("VideoGame"))).toBe(true);
    expect(early.enemyKeys.every((key) => !key.includes("Boss"))).toBe(true);
    expect(endlessBossAsRegularAllowed(3)).toBe(false);
    expect(endlessBossAsRegularAllowed(14)).toBe(true);
  });

  it("keeps the steeper normal-mode retune separate from Nightmare scaling", () => {
    const nightmare = endlessWavePlan("nightmare", 15);
    expect(nightmare.damageScale).toBeCloseTo(1.4 * 1.075 ** 14);
    expect(nightmare.healthScale).toBeCloseTo(1.25 * 1.045 ** 14);
  });

  it("adds Endless pairings at depth and preserves the normal Alien swarm cadence", () => {
    const pair = endlessWavePlan("endless", 14);
    const alien = endlessWavePlan("endless", 10);
    expect(pair.pairDeploy).toBe(true);
    expect(pair.enemyKeys.slice(0, 2)).toEqual(["VideoGameStageKnightActor", "VideoGameStageGhostActor"]);
    expect(alien.pairDeploy).toBe(false);
    expect(alien.enemyKeys).toHaveLength(20);
    expect(new Set(alien.enemyKeys)).toEqual(new Set(["AlienStageActorMinion"]));
  });

  it("uses a flatter stat curve after the early tier ramp", () => {
    const before = endlessWavePlan("endless", 16);
    const later = endlessWavePlan("endless", 17);
    expect(later.damageScale / before.damageScale).toBeCloseTo(1.04);
    expect(later.healthScale / before.healthScale).toBeCloseTo(1.03);
    const next = endlessWavePlan("endless", 18);
    expect(next.damageScale / later.damageScale).toBeCloseTo(1.04);
    expect(next.healthScale / later.healthScale).toBeCloseTo(1.03);
  });

  it("offers three repeatable unique boons and curses after every boss", () => {
    const first = endlessBossDraft("endless", 4);
    expect(first).toEqual(endlessBossDraft("endless", 4));
    expect(first.boons).toHaveLength(3);
    expect(first.curses).toHaveLength(3);
    expect(new Set(first.boons.map((b) => b.kind)).size).toBe(3);
    expect(new Set(first.curses.map((c) => c.kind)).size).toBe(3);
    expect(endlessBossDraft("nightmare", 4)).not.toEqual(first);
    const run = applyEndlessCurse(beginEndlessRun("endless", []), first.curses[0]);
    expect(run.curses).toEqual([first.curses[0]]);
  });

  it("makes every fourth fight an Epic Boss gate", () => {
    for (const wave of [4, 8, 12, 16, 20, 24]) {
      const plan = endlessWavePlan("endless", wave);
      expect(plan.bossGate).toBe(true);
      expect(plan.bossId).toBe("dr-groundhog");
      expect(plan.enemyKeys).toEqual([]);
    }
    expect(endlessWavePlan("nightmare", 4).bossId).toBe("galactic-groundhog");
    expect(endlessWavePlan("nightmare", 3).bossId).toBeNull();
  });

  it("ramps normal Endless bosses from the T7 gate without changing Nightmare", () => {
    expect(endlessBossMultiplier("endless", 27)).toBe(1);
    expect(endlessBossMultiplier("endless", 28)).toBe(7);
    expect(endlessBossMultiplier("endless", 32)).toBe(7);
    expect(endlessBossMultiplier("nightmare", 28)).toBe(1);
  });

  it("keeps ordinary fights short", () => {
    for (const wave of [1, 2, 3, 5, 6, 7, 15, 19]) {
      const plan = endlessWavePlan("endless", wave);
      expect(plan.enemyKeys.length).toBeGreaterThanOrEqual(4);
      expect(plan.enemyKeys.length).toBeLessThanOrEqual(6);
    }
  });

  it("raises weak source enemies to the entry floor while retaining role gaps", () => {
    const build = (key: string) => buildUnitsForKeys(
      [key], null, enemyStats as unknown as Record<string, import("./types").EnemyStat>, attacks,
    )[0];
    const plan = endlessWavePlan("endless", 1);
    const farmhand = scaleEndlessEnemy(build("FarmStageActorFarmhand"), plan);
    const lumberjack = scaleEndlessEnemy(build("FarmStageActorLumberjack"), plan);
    const rating = (u: typeof farmhand) => Math.sqrt(u.str * u.dex * (u.attacks[0]?.mult ?? 1) * u.con);
    expect(rating(farmhand)).toBeCloseTo(ENDLESS_ENTRY_THREAT_RATING, 1);
    expect(rating(lumberjack)).toBeGreaterThan(rating(farmhand));
    expect(lumberjack.maxHp).toBeGreaterThan(farmhand.maxHp);
  });

  it("assigns specialized stat profiles and a telegraphed Lumberjack strike only in Endless", () => {
    const build = (key: string) => buildUnitsForKeys(
      [key], null, enemyStats as unknown as Record<string, import("./types").EnemyStat>, attacks,
    )[0];
    const plan = endlessWavePlan("endless", 1);
    const hand = scaleEndlessEnemy(build("FarmStageActorFarmhand"), plan);
    const lumberjack = scaleEndlessEnemy(build("FarmStageActorLumberjack"), plan);
    const ghost = scaleEndlessEnemy(build("VideoGameStageGhostActor"), plan);
    expect(endlessEnemyArchetype(hand.sourceKey)).toBe("swarm");
    expect(lumberjack.charge).toMatchObject({ windupMs: 2400, recoveryMs: 5200, target: "front-deployed" });
    expect(ghost.maxHp).toBeLessThan(scaleEndlessEnemy(build("VideoGameStageKnightActor"), plan).maxHp);
    expect(build("FarmStageActorLumberjack").charge).toBeFalsy();
  });

  it("makes deployment and opening-deploy boons run-local and capped", () => {
    const base = beginEndlessRun("endless", []);
    const deployed = applyEndlessBoon(base, { kind: "deployment", percent: 60 });
    expect(deployed.deploymentSpeedBonus).toBe(0.6);
    expect(applyEndlessBoon(deployed, { kind: "deployment", percent: 60 }).deploymentSpeedBonus).toBe(0.8);
    expect(applyEndlessBoon(base, { kind: "opening-deploy", count: 3 }).openingDeploy).toBe(3);
    expect(applyEndlessBoon(base, { kind: "revive-headless" }).reviveHeadless).toBe(true);
  });

  it("applies persistent enemy stat and combat-effect curses", () => {
    const build = () => buildUnitsForKeys(
      ["FarmStageActorFarmhand"], null, enemyStats as unknown as Record<string, import("./types").EnemyStat>, attacks,
    )[0];
    const base = scaleEndlessEnemy(build(), endlessWavePlan("endless", 1));
    const cursed = scaleEndlessEnemy(build(), endlessWavePlan("endless", 1), [
      { kind: "enemy-health", percent: 20 },
      { kind: "enemy-damage", percent: 20 },
      { kind: "enemy-attack-speed", percent: 20 },
      { kind: "enemy-stun", chance: 0.15, durationMs: 900 },
      { kind: "enemy-explosion", chance: 0.2, damagePercent: 20 },
    ]);
    expect(cursed.maxHp).toBeGreaterThan(base.maxHp);
    expect(cursed.str).toBeGreaterThan(base.str);
    expect(cursed.attackCooldownMs).toBeLessThan(base.attackCooldownMs);
    expect(cursed.stunChance).toBe(0.15);
    expect(cursed.deathExplosion).toEqual({ chance: 0.2, damagePercent: 20 });
  });
});

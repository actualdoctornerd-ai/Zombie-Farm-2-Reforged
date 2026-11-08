import { describe, expect, it } from "vitest";
import enemyStats from "../../public/assets/raids/enemy_stats.json";
import attacks from "../../public/assets/raids/attacks.json";
import { buildUnitsForKeys } from "./CombatEngine";
import {
  ENDLESS_ADVANCED_CLOCK_MS, ENDLESS_ALIEN_NORMAL_CLOCK_MS, ENDLESS_BOSS_CLOCK_MS, ENDLESS_DAMAGE_STEP, ENDLESS_ENTRY_COST,
  ENDLESS_KILLER, ENDLESS_ENTRY_THREAT_RATING, ENDLESS_SHAPE_LIMIT, ENDLESS_FLOOR_ENEMIES, ENDLESS_LINE, ENDLESS_HEALTH_STEP, ENDLESS_LATE_DO_OR_DIE_MS, ENDLESS_LOCATION_MECHANICS,
  ENDLESS_MODIFIERS, ENDLESS_NORMAL_CLOCK_MS, ENDLESS_NORMAL_DO_OR_DIE_MS, ENDLESS_SLAM_SECONDS, ENDLESS_UNLOCK_LEVEL,
  applyEndlessBoon, applyEndlessCurse, applyEndlessStop, beginEndlessRun, carryEndlessArmy, finishEndlessFight, endlessBossDraft,
  endlessBossMultiplier, endlessInvasionOf, endlessSourceDps, isEndlessKiller, endlessKillerCount, endlessLocationOptions, endlessWavePlan, endlessWeekSeed,
  scaleEndlessEnemy, type EndlessLocation, type EndlessModifierId, type EndlessStop,
} from "./endless";
import { countHitDamage } from "./countSlam";
import { mirrorIntervalSec } from "./combatStats";
import { buildFight } from "./buildFight";
import { ENDLESS_SHAPES, endlessFightConfig, endlessSimFor, endlessSourceUnit } from "./endlessFight";
import { rollEndlessBossLoot, rollEndlessFloorLoot } from "./endlessLoot";

describe("Endless Mode plan", () => {
  it("uses the intended entry gates and brain costs", () => {
    expect(ENDLESS_UNLOCK_LEVEL).toEqual({ endless: 30, nightmare: 45 });
    expect(ENDLESS_ENTRY_COST).toEqual({ endless: 1, nightmare: 3 });
  });

  const at = (location: EndlessLocation, modifier: EndlessModifierId | null = null): EndlessStop => ({ location, modifier });

  it("keeps mechanics constant within a location while tightening cadence locally", () => {
    const ninja = at("ninja");
    const start = endlessWavePlan("endless", 4, ninja);
    const middle = endlessWavePlan("endless", 5, ninja);
    const gate = endlessWavePlan("endless", 6, ninja);
    expect(ENDLESS_LOCATION_MECHANICS.ninja.mechanics)
      .toEqual(["carrot-wall", "smoke-bomb-teleport"]);
    expect(start.mechanicCooldownScale).toBe(1);
    expect(start.mechanicCooldownsMs["smoke-bomb-teleport"]).toBe(30_000);
    expect(gate.mechanicCooldownsMs["smoke-bomb-teleport"]).toBe(19_800);
    expect(middle.mechanicCooldownScale).toBeLessThan(start.mechanicCooldownScale);
    expect(gate.mechanicCooldownScale).toBeLessThan(middle.mechanicCooldownScale);
    const nextTier = endlessWavePlan("endless", 7, at("alien"));
    expect(nextTier.mechanicCooldownScale).toBe(1);
    expect(nextTier.mechanicCooldownsMs.laser).toBe(26_000);
  });

  it("takes its location and modifier from the stop the player chose, not the wave", () => {
    const plan = endlessWavePlan("endless", 7, at("pirate", "chunky"));
    expect(plan).toMatchObject({ tier: 3, locationFight: 1, location: "pirate", modifier: "chunky" });
    expect(endlessWavePlan("endless", 7, at("ninja")).location).toBe("ninja");
  });

  it("scales enemy stats and enemy roster by global depth", () => {
    const early = endlessWavePlan("endless", 2);
    const deep = endlessWavePlan("endless", 11, at("video-game"));
    const depth = 10 * (4 / 3);
    expect(deep.damageScale).toBeCloseTo((1 + ENDLESS_DAMAGE_STEP) ** depth);
    expect(deep.healthScale).toBeCloseTo((1 + ENDLESS_HEALTH_STEP) ** depth);
    expect(deep.enemyTier).toBeGreaterThan(early.enemyTier);
    expect(deep.enemyKeys.some((key) => key.includes("VideoGame"))).toBe(true);
    expect(early.enemyKeys.every((key) => !key.includes("Boss"))).toBe(true);
  });

  it("keeps the steeper normal-mode retune separate from Nightmare scaling", () => {
    const nightmare = endlessWavePlan("nightmare", 4);
    expect(nightmare.damageScale).toBeCloseTo(1.4 * 1.075 ** 4);
    expect(nightmare.healthScale).toBeCloseTo(1.25 * 1.045 ** 4);
  });

  it("opens later advanced floors with a pair and preserves the normal Alien swarm", () => {
    const pair = endlessWavePlan("endless", 11, at("video-game"));
    expect(pair.enemyKeys.slice(0, 2)).toEqual(["VideoGameStageKnightActor", "VideoGameStageGhostActor"]);
    for (const modifier of [null, "crowded"] as const) {
      const alien = endlessWavePlan("endless", 11, at("alien", modifier));
      expect(alien.enemyKeys).toHaveLength(20);
      expect(new Set(alien.enemyKeys)).toEqual(new Set(["AlienStageActorMinion"]));
    }
  });

  it("uses a flatter stat curve after the early tier ramp", () => {
    const before = endlessWavePlan("endless", 14);
    const later = endlessWavePlan("endless", 15);
    expect(later.damageScale / before.damageScale).toBeCloseTo(1.05 ** (4 / 3));
    expect(later.healthScale / before.healthScale).toBeCloseTo(1.07 ** (4 / 3));
  });

  it("offers the same repeatable draft to everyone in a week, and a new one the next", () => {
    const first = endlessBossDraft("endless", 3, "100", "farm");
    expect(first).toEqual(endlessBossDraft("endless", 3, "100", "farm"));
    expect(first.boons).toHaveLength(3);
    expect(first.curses).toHaveLength(3);
    expect(new Set(first.boons.map((b) => b.kind)).size).toBe(3);
    expect(new Set(first.curses.map((c) => c.kind)).size).toBe(3);
    expect(endlessBossDraft("nightmare", 3, "100", "farm")).not.toEqual(first);
    const weeks = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(endlessBossDraft("endless", 3, String(i), "farm"))));
    expect(weeks.size).toBeGreaterThan(1);
    const run = applyEndlessCurse(beginEndlessRun("endless", []), first.curses[0]);
    expect(run.curses).toEqual([first.curses[0]]);
  });

  it("turns the week over at Monday 00:00 UTC", () => {
    const sunday = Date.UTC(2026, 10, 8, 23, 59);
    const monday = Date.UTC(2026, 10, 9, 0, 0);
    expect(endlessWeekSeed(monday)).not.toBe(endlessWeekSeed(sunday));
    expect(endlessWeekSeed(monday + 6 * 24 * 60 * 60 * 1000)).toBe(endlessWeekSeed(monday));
  });

  it("offers two other locations with different modifiers, and keeps Alien's drip authored", () => {
    for (let week = 0; week < 40; week++) {
      for (const current of ["farm", "alien", "pirate"] as const) {
        const options = endlessLocationOptions("endless", 3, String(week), current);
        expect(options).toHaveLength(2);
        expect(options.map((o) => o.location)).not.toContain(current);
        expect(options[0].location).not.toBe(options[1].location);
        expect(options[0].modifier).not.toBe(options[1].modifier);
        for (const option of options) {
          if (option.location === "alien") expect(["crowded", "short-clock"]).not.toContain(option.modifier);
        }
      }
    }
  });

  it("carries the chosen stop into the next fight", () => {
    const run = applyEndlessStop({ ...beginEndlessRun("endless", []), nextWave: 4 }, at("video-game", "short-clock"));
    const config = endlessFightConfig(run, 45);
    expect(config).toMatchObject({ location: "video-game", modifier: "short-clock" });
    expect(config.timeLimitMs).toBe(ENDLESS_NORMAL_CLOCK_MS * (ENDLESS_MODIFIERS["short-clock"].clock ?? 1));
  });

  it("makes every third fight an Epic Boss gate", () => {
    for (const wave of [3, 6, 9, 12, 15, 18]) {
      const plan = endlessWavePlan("endless", wave);
      expect(plan.bossGate).toBe(true);
      expect(plan.bossId).toBe("dr-groundhog");
      expect(plan.enemyKeys).toEqual([]);
    }
    expect(endlessWavePlan("nightmare", 3).bossId).toBe("galactic-groundhog");
    expect(endlessWavePlan("nightmare", 2).bossId).toBeNull();
  });

  it("ramps normal Endless bosses from the T7 gate without changing Nightmare", () => {
    expect(endlessBossMultiplier("endless", 18)).toBe(1);
    expect(endlessBossMultiplier("endless", 21)).toBe(7);
    expect(endlessBossMultiplier("endless", 24)).toBe(7);
    expect(endlessBossMultiplier("nightmare", 21)).toBe(1);
  });

  it("fields more bodies on an advanced floor, and Crowded only adds bodies", () => {
    expect(endlessWavePlan("endless", 1).enemyKeys).toHaveLength(ENDLESS_FLOOR_ENEMIES[0]);
    expect(endlessWavePlan("endless", 2).enemyKeys).toHaveLength(ENDLESS_FLOOR_ENEMIES[1]);
    const plain = endlessWavePlan("endless", 4, at("pirate"));
    const crowded = endlessWavePlan("endless", 4, at("pirate", "crowded"));
    expect(crowded.enemyKeys.length).toBe(plain.enemyKeys.length + (ENDLESS_MODIFIERS.crowded.extraEnemies ?? 0));
    expect(crowded.damageScale).toBe(plain.damageScale);
    expect(crowded.healthScale).toBe(plain.healthScale);
  });

  it("starts every invasion at the same baseline and keeps its enemies' source shape", () => {
    const plan = endlessWavePlan("endless", 1);
    const scaled = (key: string) => scaleEndlessEnemy(endlessSourceUnit(key)!, plan, [], ENDLESS_SHAPES);
    const dps = (u: ReturnType<typeof scaled>) => countHitDamage(u) / (u.attackCooldownMs / 1000);
    // An average member of any invasion sits exactly on the entry floor.
    const minion = scaled("AlienStageActorMinion");
    expect(minion.maxHp).toBe(Math.round(ENDLESS_ENTRY_THREAT_RATING * ENDLESS_LINE.hp * plan.healthScale * 100));
    // Within an invasion the source order holds: the Ninja Boy outlasts and out-hits the Girl,
    // the BroBot out-hits the BrainBot, the Lumberjack outlasts the Farmhand.
    expect(scaled("NinjaStageActorBoy").maxHp).toBeGreaterThan(scaled("NinjaStageActorGirl").maxHp);
    expect(dps(scaled("NinjaStageActorBoy"))).toBeGreaterThan(dps(scaled("NinjaStageActorGirl")));
    expect(dps(scaled("RobotStageActorBroBot"))).toBeGreaterThan(dps(scaled("RobotStageActorBrainBot")));
    expect(scaled("FarmStageActorLumberjack").maxHp).toBeGreaterThan(scaled("FarmStageActorFarmhand").maxHp);
    // Across invasions the raw scale is gone: a Robot (31,000 source hit points) and a
    // Farmhand (300) start within the shape limit of each other.
    expect(scaled("RobotStageActorJunkBot").maxHp / scaled("FarmStageActorFarmhand").maxHp).toBeLessThan(ENDLESS_SHAPE_LIMIT);
    // Every shape is relative to its own invasion, and capped either way.
    for (const [key, s] of Object.entries(ENDLESS_SHAPES)) {
      expect(endlessInvasionOf(key).length).toBeGreaterThan(0);
      for (const v of [s.damage, s.hp]) {
        expect(v).toBeLessThanOrEqual(ENDLESS_SHAPE_LIMIT);
        expect(v).toBeGreaterThanOrEqual(1 / ENDLESS_SHAPE_LIMIT);
      }
    }
  });

  it("keeps every enemy's source attack speed and scales only damage and health", () => {
    const plan = endlessWavePlan("endless", 8);
    for (const key of Object.keys(ENDLESS_SHAPES)) {
      const source = endlessSourceUnit(key)!;
      const scaled = scaleEndlessEnemy(source, plan, [], ENDLESS_SHAPES);
      expect(scaled.attackCooldownMs).toBe(source.attackCooldownMs);
      expect(scaled.dex).toBe(source.dex);
    }
    // Deeper floors raise damage and health, never speed.
    const early = scaleEndlessEnemy(endlessSourceUnit("NinjaStageActorGirl")!, endlessWavePlan("endless", 1), [], ENDLESS_SHAPES);
    const late = scaleEndlessEnemy(endlessSourceUnit("NinjaStageActorGirl")!, endlessWavePlan("endless", 20), [], ENDLESS_SHAPES);
    expect(late.attackCooldownMs).toBe(early.attackCooldownMs);
    expect(countHitDamage(late)).toBeGreaterThan(countHitDamage(early));
    expect(late.maxHp).toBeGreaterThan(early.maxHp);
  });

  it("gives the Lumberjack a telegraphed strike only in Endless", () => {
    const plan = endlessWavePlan("endless", 1);
    const lumberjack = scaleEndlessEnemy(endlessSourceUnit("FarmStageActorLumberjack")!, plan, [], ENDLESS_SHAPES);
    expect(lumberjack.charge).toMatchObject({ windupMs: 2400, recoveryMs: 5200, target: "front-deployed" });
    expect(endlessSourceUnit("FarmStageActorLumberjack")!.charge).toBeFalsy();
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

  it("arms every fight with its clock and overtime, and no boss timer gets in first", () => {
    const fightAt = (nextWave: number, stop: EndlessStop = at("farm")) =>
      endlessSimFor(endlessFightConfig({ ...beginEndlessRun("endless", []), nextWave, stop }, 45));
    expect(fightAt(1).timeLimitMs).toBe(ENDLESS_NORMAL_CLOCK_MS);
    expect(fightAt(1).doOrDieMs).toBe(ENDLESS_NORMAL_DO_OR_DIE_MS);
    expect(fightAt(2).timeLimitMs).toBe(ENDLESS_ADVANCED_CLOCK_MS);
    expect(fightAt(2).doOrDieMs).toBe(ENDLESS_LATE_DO_OR_DIE_MS);
    expect(fightAt(4, at("alien")).timeLimitMs).toBe(ENDLESS_ALIEN_NORMAL_CLOCK_MS);
    const boss = fightAt(3);
    expect(boss.timeLimitMs).toBe(ENDLESS_BOSS_CLOCK_MS);
    expect(boss.doOrDieMs).toBe(ENDLESS_LATE_DO_OR_DIE_MS);
    expect(boss.roundRemainingMs()).toBeGreaterThan(ENDLESS_BOSS_CLOCK_MS + ENDLESS_LATE_DO_OR_DIE_MS);
  });

  const enemy = (key: string) => buildUnitsForKeys(
    [key], null, enemyStats as unknown as Record<string, import("./types").EnemyStat>, attacks,
  )[0];

  it("makes the former bosses killers: less health than the line, more damage, and a slam", () => {
    const plan = endlessWavePlan("endless", 8, at("farm"));
    const scaled = (key: string) => scaleEndlessEnemy(endlessSourceUnit(key)!, plan, [], ENDLESS_SHAPES);
    const dps = (u: ReturnType<typeof scaled>) => countHitDamage(u) / (u.attackCooldownMs / 1000);
    const line = scaled("AlienStageActorMinion");
    for (const key of ["FarmStageActorBoss", "NinjaStageActorBoss", "VideoGameStageBossActor"]) {
      const killer = scaled(key);
      expect(isEndlessKiller(key)).toBe(true);
      expect(killer.maxHp).toBeLessThan(line.maxHp);
      expect(dps(killer)).toBeGreaterThan(dps(line) * ENDLESS_KILLER.damage / 2);
      expect(killer.charge).toMatchObject({ target: "front-deployed" });
      expect(killer.charge?.damage).toBeCloseTo(ENDLESS_SLAM_SECONDS * dps(killer), -1);
    }
    // The captain's mirrored blow is his killing move: no second clock on top of it.
    expect(isEndlessKiller("PirateStageActorBoss")).toBe(true);
    expect(scaled("PirateStageActorBoss").charge).toBeFalsy();
    expect(scaleEndlessEnemy(enemy("FarmStageActorFarmhand"), plan).charge).toBeFalsy();
    expect(endlessKillerCount(1, 2)).toBe(0);
    expect(endlessKillerCount(3, 2)).toBeGreaterThan(0);
    expect(endlessWavePlan("endless", 8, at("farm")).enemyKeys).toContain("FarmStageActorBoss");
    expect(endlessWavePlan("endless", 8, at("alien")).enemyKeys).not.toContain("FarmStageActorBoss");
  });

  it("applies each modifier's stats", () => {
    const plain = scaleEndlessEnemy(enemy("FarmStageActorFarmhand"), endlessWavePlan("endless", 4, at("farm")));
    const under = (modifier: EndlessModifierId) =>
      scaleEndlessEnemy(enemy("FarmStageActorFarmhand"), endlessWavePlan("endless", 4, at("farm", modifier)));
    const heavy = under("heavy-hitters");
    expect(heavy.str).toBeCloseTo(plain.str * 2.5);
    expect(heavy.dex).toBeCloseTo(plain.dex * 0.5);
    expect(under("chunky").maxHp).toBeGreaterThan(plain.maxHp);
    expect(under("chunky").str).toBeLessThan(plain.str);
    expect(under("glass-cannon").maxHp).toBeLessThan(plain.maxHp);
    expect(under("glass-cannon").str).toBeGreaterThan(plain.str);
    expect(under("stun-immune").stunResist).toBe(1);
    expect(plain.stunResist).toBeUndefined();
  });

  it("makes a slam's damage follow Heavy Hitters", () => {
    const killer = (modifier: EndlessModifierId | null) =>
      scaleEndlessEnemy(enemy("FarmStageActorBoss"), endlessWavePlan("endless", 8, at("farm", modifier)), [], ENDLESS_SHAPES);
    expect(killer("heavy-hitters").charge!.damage).toBeCloseTo(killer(null).charge!.damage * 2.5, -1);
  });

  it("shortens stuns and slows the slam's poise bar under stun resistance", () => {
    const stunned = (stunResist: number | undefined, winding: boolean) => {
      const unit = { ...enemy("FarmStageActorBoss"), stunResist, charge: {
        windupMs: 3_000, recoveryMs: 7_000, damage: 10, poiseThreshold: 1, poiseDrainPerSec: 0, staggerMs: 0, target: "front-deployed" as const,
      } };
      const sim = buildFight({ playerUnits: [], enemyUnits: [unit] });
      const foe = sim.units.find((u) => u.team === "enemy")! as unknown as { chargeMs: number; poise: number; stunMs: number };
      if (winding) foe.chargeMs = 1_000;
      (sim as unknown as { stunEnemy(foe: unknown, ms: number, source: string): void }).stunEnemy(foe, 1_000, "bashV2");
      return foe;
    };
    expect(stunned(undefined, false).stunMs).toBe(1_000);
    expect(stunned(0.3, false).stunMs).toBeCloseTo(700);
    expect(stunned(1, false).stunMs).toBe(0);
    expect(stunned(undefined, true).poise).toBeCloseTo(0.5);
    expect(stunned(0.3, true).poise).toBeCloseTo(0.35);
    expect(stunned(1, true).poise).toBe(0);
  });

  it("pays a small floor roll on every tier, keeping Zwamp Thing and cosmetics for bosses", () => {
    for (let tier = 1; tier <= 12; tier++) {
      for (let roll = 0; roll < 1; roll += 0.01) {
        const loot = rollEndlessFloorLoot(tier, roll);
        expect(loot.kind).toBe("boost");
        if (loot.kind === "boost" && loot.key === "insta_grow") {
          expect(loot.quantity).toBeGreaterThanOrEqual(5);
          expect(loot.quantity % 5).toBe(0);
        }
      }
    }
  });

  it("makes a boss worth more than the floors before it", () => {
    const value: Record<string, number> = {
      insta_grow: 1 / 20, insta_harvest: 1 / 4, insta_plow: 1 / 4, concentration: 1 / 2,
      golden_dice: 1, invasion_voucher: 1, brain_ticket: 1,
    };
    const mean = (rolled: (roll: number) => { kind: string; key?: string; quantity: number }) => {
      let total = 0;
      for (let i = 0; i < 1000; i++) {
        const loot = rolled(i / 1000);
        total += (value[loot.key ?? ""] ?? 0) * loot.quantity;
      }
      return total / 1000;
    };
    for (const tier of [1, 3, 5, 7, 10]) {
      expect(mean((r) => rollEndlessBossLoot(tier, "farm", r, 0, 1)[0])).toBeGreaterThan(mean((r) => rollEndlessFloorLoot(tier, r)));
    }
  });

  it("brings the whole army back after a boss, and only after a boss", () => {
    const units = buildUnitsForKeys(["FarmStageActorFarmhand", "FarmStageActorFarmhand"], null, enemyStats as never, attacks as never, { raidId: 1 });
    const fallen = (run: ReturnType<typeof beginEndlessRun>) => [
      { ...run.units[0], team: "player" as const, alive: false, hp: 0 },
      { ...run.units[1], team: "player" as const, hp: Math.ceil(run.units[1].maxHp / 2) },
    ];
    const floor = { ...beginEndlessRun("endless", units), nextWave: 1 };
    const afterFloor = finishEndlessFight(floor, fallen(floor)).units;
    expect(afterFloor[0].alive).toBe(false);
    expect(afterFloor[1].hp).toBeLessThan(afterFloor[1].maxHp);
    const gate = { ...beginEndlessRun("endless", units), nextWave: 3 };
    const afterBoss = finishEndlessFight(gate, fallen(gate)).units;
    expect(afterBoss.every((u) => u.alive && u.hp === u.maxHp)).toBe(true);
    expect(carryEndlessArmy(gate, fallen(gate)).units[0].alive).toBe(false);
  });

  it("no longer offers a revive boon", () => {
    for (let wave = 3; wave <= 60; wave += 3) {
      expect(endlessBossDraft("endless", wave).boons.map((b) => b.kind)).not.toContain("revive");
    }
  });
});

describe("Endless enemy shapes", () => {
  const plan = endlessWavePlan("endless", 8);

  it("keeps both pirate heavy hitters mirroring the zombie they face", () => {
    const scaled = (key: string) => scaleEndlessEnemy(endlessSourceUnit(key)!, plan, [], ENDLESS_SHAPES);
    const captain = scaled("PirateStageActorBoss");
    const scallywag = scaled("PirateStageActorScallywag");
    expect(captain.mirrorsOpponentSpeed).toBe(true);
    expect(scallywag.mirrorsOpponentSpeed).toBe(true);
    expect(scaled("PirateStageActorSwashbuckler").mirrorsOpponentSpeed).toBe(false);
    // Each pirate's damage per second, against the reference zombie, is what its shape says.
    expect(endlessSourceDps(captain)).toBeGreaterThan(endlessSourceDps(scaled("FarmStageActorBoss")));
    expect(countHitDamage(scallywag)).toBeGreaterThan(countHitDamage(scaled("PirateStageActorSwashbuckler")));
    // The captain's tempo is his invasion's: a Headless (2 s) in front holds him to a blow
    // every 6.5 s, a Small (0.45 s) speeds him to the 1.25 s floor.
    const vs = (sec: number) => mirrorIntervalSec(captain.sourceKey, sec, sec);
    expect(vs(2)).toBeCloseTo(6.5, 5);
    expect(vs(0.45)).toBe(1.25);
    const sw = (sec: number) => mirrorIntervalSec(scallywag.sourceKey, sec, sec);
    expect(sw(0.6)).toBe(0.5);
    expect(sw(2)).toBeGreaterThan(sw(1));
  });

  it("lets Heavy Hitters slow the pirates through their mirror", () => {
    const heavy = endlessWavePlan("endless", 8, { location: "pirate", modifier: "heavy-hitters" });
    const plain = endlessWavePlan("endless", 8, { location: "pirate", modifier: null });
    const cap = (p: typeof plain) => scaleEndlessEnemy(endlessSourceUnit("PirateStageActorBoss")!, p, [], ENDLESS_SHAPES);
    expect(cap(plain).mirrorPace ?? 1).toBe(1);
    expect(cap(heavy).mirrorPace).toBe(2);
  });


});

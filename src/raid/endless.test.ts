import { describe, expect, it } from "vitest";
import enemyStats from "../../public/assets/raids/enemy_stats.json";
import attacks from "../../public/assets/raids/attacks.json";
import zombiesJson from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";
import { makeOwned } from "../zombie/types";
import { buildPlayerUnits, buildUnitsForKeys } from "./CombatEngine";
import {
  ENDLESS_ADVANCED_CLOCK_MS, ENDLESS_ALIEN_NORMAL_CLOCK_MS, ENDLESS_BOSS_CLOCK_MS, ENDLESS_BOSS_DAMAGE,
  ENDLESS_BEAM_WALK_IN_MS, ENDLESS_LOCATION_STRENGTH, ENDLESS_ALIEN_SWARM, ENDLESS_ALIEN_MAX_ACTIVE, ENDLESS_BOSS_HP_AT_T1, ENDLESS_BOSS_HP_AT_T7, ENDLESS_BOSS_MOVES, ENDLESS_PERCHED_BOSS, ENDLESS_WALK_IN, ENDLESS_WALK_IN_POOL, ENDLESS_DAMAGE_STEP, ENDLESS_ENTRY_COST,
  ENDLESS_KILLER, ENDLESS_ENTRY_THREAT_RATING, ENDLESS_SHAPE_LIMIT, ENDLESS_FLOOR_ENEMIES, ENDLESS_LINE, ENDLESS_HEALTH_STEP, ENDLESS_LATE_DO_OR_DIE_MS, ENDLESS_LOCATION_MECHANICS,
  ENDLESS_MODIFIERS, ENDLESS_NORMAL_CLOCK_MS, ENDLESS_NORMAL_DO_OR_DIE_MS, ENDLESS_SLAM_SECONDS, ENDLESS_UNLOCK_LEVEL,
  applyEndlessBoon, applyEndlessCurse, applyEndlessStop, beginEndlessRun, carryEndlessArmy, finishEndlessFight, endlessBossDraft,
  endlessBossMultiplier, endlessInvasionOf, endlessSourceDps, isEndlessKiller, endlessKillerCount, endlessLocationOptions, endlessWavePlan, endlessWeekSeed,
  scaleEndlessEnemy, type EndlessLocation, type EndlessModifierId, type EndlessStop,
  applyEndlessEnemyCurses, applyEndlessDepthStunResist, endlessDraftPickWasted, ENDLESS_MAX_DEPLOY_REDUCTION, ENDLESS_MAX_OPENING_DEPLOY,
  type EndlessBoon, type EndlessCurse,
} from "./endless";
import { countHitDamage } from "./countSlam";
import type { CombatUnit } from "./types";
import { mirrorIntervalSec } from "./combatStats";
import { buildFight } from "./buildFight";
import { ENDLESS_SHAPES, endlessFightConfig, endlessSimFor, endlessSourceUnit } from "./endlessFight";
import { rollEndlessBossLoot, rollEndlessFloorLoot } from "./endlessLoot";
import { buildEndlessStageMechanics } from "./endlessMechanics";

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
    expect(middle.mechanicCooldownsMs["smoke-bomb-teleport"]).toBe(Math.round(30_000 * 0.82));
    expect(gate.mechanicCooldownsMs).toEqual({}); // Dr. Groundhog fights alone
    expect(middle.mechanicCooldownScale).toBeLessThan(start.mechanicCooldownScale);
    expect(gate.mechanicCooldownScale).toBeLessThan(middle.mechanicCooldownScale);
    const nextTier = endlessWavePlan("endless", 7, at("alien"));
    expect(nextTier.mechanicCooldownScale).toBe(1);
    // The saucer's laser is a boss move: floor 2 only, at that floor's cadence.
    expect(nextTier.mechanicCooldownsMs.laser).toBeUndefined();
    expect(endlessWavePlan("endless", 8, at("alien")).mechanicCooldownsMs.laser).toBe(Math.round(26_000 * 0.82));
  });

  it("runs each tier as enemies, then the location's boss, then Dr. Groundhog", () => {
    for (const location of ["farm", "ninja", "pirate", "video-game"] as const) {
      const [one, two, three] = [1, 2, 3].map((wave) => endlessWavePlan("endless", wave, at(location)));
      expect(one.bossKey, location).toBeNull();
      expect(two.bossKey, location).toBe(ENDLESS_PERCHED_BOSS[location]);
      expect(three.bossGate, location).toBe(true);
      expect(three.bossKey, location).toBeNull();
      for (const move of ENDLESS_BOSS_MOVES) expect(one.mechanicCooldownsMs[move], `${location} ${move}`).toBeUndefined();
      expect(three.mechanicCooldownsMs, `${location} Groundhog floor`).toEqual({});
    }
    const run = (wave: number, location: EndlessLocation) =>
      endlessFightConfig({ ...beginEndlessRun("endless", []), nextWave: wave, stop: at(location) }, 45);
    // Floor 2's boss perches at the back and throws his own projectiles.
    const floor2 = run(2, "pirate");
    expect(floor2.enemyUnits[floor2.enemyUnits.length - 1]).toMatchObject({ sourceKey: "PirateStageActorBoss", isBoss: true });
    expect(floor2.bossThrow?.options.map((o) => o.sprite)).toEqual(["parrot.png", "chest.png", "anchor.png"]);
    expect(run(1, "pirate").bossThrow ?? null).toBeNull();
    expect(run(1, "pirate").enemyUnits.some((u) => u.isBoss)).toBe(false);
    // The saucer has no body or throws: its floor 2 is its laser and beam-ins.
    expect(run(2, "alien").enemyUnits.some((u) => u.isBoss)).toBe(false);
    expect(endlessWavePlan("endless", 2, at("alien")).mechanicCooldownsMs).toMatchObject({ laser: expect.any(Number), summons: expect.any(Number) });
  });

  it("sends walk-in bosses from associated invasions: floor 1 from the sixth location, floor 2 from the fifth", () => {
    const walkIns = (wave: number, location: EndlessLocation) =>
      endlessWavePlan("endless", wave, at(location)).enemyKeys.filter(isEndlessKiller);
    expect(walkIns(13, "ninja")).toEqual([]);
    expect(walkIns(16, "ninja")).toEqual(["PirateStageActorBoss"]);
    expect(walkIns(14, "pirate")).toEqual(["NinjaStageActorBoss"]);
    expect(walkIns(17, "video-game")).toEqual(["CircusStageActorBoss"]);
    for (const key of walkIns(25, "farm")) expect(["CityStageActorBoss", "AlienStageActorBoss"]).toContain(key);
    expect(walkIns(25, "farm")).toHaveLength(2);
    // A walk-in is a strong ordinary enemy: no slam, and smaller than the perched boss.
    const plan = endlessWavePlan("endless", 17, at("ninja"));
    const config = endlessFightConfig({ ...beginEndlessRun("endless", []), nextWave: 17, stop: at("ninja") }, 45);
    const walkIn = config.enemyUnits.find((u) => u.sourceKey === "PirateStageActorBoss")!;
    const perched = config.enemyUnits.find((u) => u.isBoss)!;
    expect(walkIn.charge).toBeFalsy();
    expect(walkIn.maxHp).toBeLessThan(perched.maxHp);
    expect(plan.beamedWalkIns).toEqual([]);
    // Alien Landing's are beamed down by the saucer, from T7, never its own boss or Zedzox.
    expect(endlessWavePlan("endless", 17, at("alien")).beamedWalkIns).toEqual([]);
    const alien = endlessWavePlan("endless", 19, at("alien"));
    expect(alien.enemyKeys.filter(isEndlessKiller)).toEqual([]);
    expect(alien.beamedWalkIns).toHaveLength(1);
    expect(alien.mechanicCooldownsMs["beam-walk-in"]).toBeGreaterThan(0);
    for (const key of ENDLESS_WALK_IN_POOL.alien) expect(["AlienStageActorBoss", "VideoGameStageBossActor"]).not.toContain(key);
  });

  it("throws the smoke bomb only at a deployed Garden, which fights back and holds its heals", () => {
    // Unkillable on both sides, so only the bomb and who answers it decide anything.
    const tough = (u: CombatUnit) => ({ ...u, maxHp: 1e9, hp: 1e9, con: 1e7, teamAuraStats: undefined });
    const army = (keys: string[]) => buildPlayerUnits(
      keys.map((key, i) => makeOwned(`z${i}`, (zombiesJson as ZombieDef[]).find((z) => z.key === key)!, 0, 0, 0, 0)),
      // Unlocked: a Garden is a stationed healer only when it carries its heal.
      { abilitySlotUnlocked: () => true, playerLevel: 45 },
    ).map(tough);
    const fly = (units: CombatUnit[]) => {
      const config = endlessFightConfig({ ...beginEndlessRun("endless", units), nextWave: 4, stop: at("ninja") }, 45);
      config.enemyUnits = config.enemyUnits.filter((u) => u.sourceKey === "NinjaStageActorGirl").slice(0, 1).map(tough);
      expect(config.enemyUnits).toHaveLength(1);
      const sim = endlessSimFor(config);
      const internals = sim as unknown as { smokeSeq: number; chargingBubble(): { id: string } | null; popBubble(id: string): boolean };
      let gardenFought = false;
      for (let t = 0; t < 60_000 && !sim.finished; t += 50) {
        const bubble = internals.chargingBubble();
        if (bubble) internals.popBubble(bubble.id);
        sim.step(50);
        const flanker = sim.units.some((u) => u.team === "enemy" && u.isFlanker && u.alive);
        if (flanker && sim.units.some((u) => u.team === "player" && u.isGarden && u.state === "fight")) gardenFought = true;
      }
      return { smokes: internals.smokeSeq, gardenFought };
    };
    // No Garden out: no bomb. (The ninja simply fights the line.)
    expect(fly(army(["ZombieActorHeadlessTier4", "ZombieActorRegularTier4"])).smokes).toBe(0);
    // A tank in front, Gardens behind: the ninja lands on a Garden, which swings back.
    const withGardens = fly(army(["ZombieActorHeadlessTier4", "ZombieActorGardenTier4", "ZombieActorGardenTier4"]));
    expect(withGardens.smokes).toBeGreaterThan(0);
    expect(withGardens.gardenFought).toBe(true);
  });

  it("beams the walk-in down mid-field, where it must be beaten to clear the floor", () => {
    // One unkillable zombie that never deploys far: the saucer only acts while the army stands.
    const zombie = buildPlayerUnits(Array.from({ length: 6 }, (_, i) => makeOwned(`z${i}`, (zombiesJson as ZombieDef[]).find((z) => z.key.includes("Headless"))!, 0, 0, 0, 0)), { abilitySlotUnlocked: () => false, playerLevel: 45 })
      .map((u) => ({ ...u, maxHp: 1e9, hp: 1e9, con: 1e7 }));
    const config = endlessFightConfig({ ...beginEndlessRun("endless", zombie), nextWave: 19, stop: at("alien") }, 45);
    expect(config.endlessMechanics.walkInTemplates).toHaveLength(1);
    const sim = endlessSimFor(config);
    for (let t = 0; t < ENDLESS_BEAM_WALK_IN_MS + 100; t += 50) sim.step(50);
    const beamed = sim.units.find((u) => u.team === "enemy" && u.isSummon);
    expect(beamed?.sourceKey).toBe(config.endlessMechanics.walkInTemplates![0].sourceKey);
    expect(["hold", "fight"]).toContain(beamed?.state); // standing its ground, or already fighting
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

  it("sizes Alien Landing's swarm below a solo enemy's base stats, four at a time, never its boss", () => {
    const minion = endlessSourceUnit("AlienStageActorMinion")!;
    const at = (location: "alien" | "farm") => scaleEndlessEnemy(minion, endlessWavePlan("endless", 4, { location, modifier: null }), [], ENDLESS_SHAPES);
    expect(at("alien").maxHp / at("farm").maxHp).toBeCloseTo(ENDLESS_ALIEN_SWARM.hp, 2);
    expect(at("alien").str / at("farm").str).toBeCloseTo(ENDLESS_ALIEN_SWARM.damage, 6);
    expect(endlessFightConfig({ ...beginEndlessRun("endless", []), nextWave: 4, stop: { location: "alien", modifier: null } }, 45)
      .waveCadence?.maxActive).toBe(ENDLESS_ALIEN_MAX_ACTIVE);
    // Dr. Groundhog fights alone there: the same boss as anywhere else.
    const boss = (location: "alien" | "farm") => endlessFightConfig(
      { ...beginEndlessRun("endless", []), nextWave: 12, stop: { location, modifier: null } }, 45,
    ).enemyUnits.find((u) => u.isBoss)!;
    expect(boss("alien").maxHp).toBe(boss("farm").maxHp);
    expect(boss("alien").str).toBe(boss("farm").str);
  });

  it("flattens the ramp after the T7 boss to 1.11x damage and 1.13x health a tier", () => {
    for (const fight of [1, 2, 3]) {
      const t8 = endlessWavePlan("endless", 21 + fight), t9 = endlessWavePlan("endless", 24 + fight);
      expect(t9.damageScale / t8.damageScale).toBeCloseTo(1.11, 6);
      expect(t9.healthScale / t8.healthScale).toBeCloseTo(1.13, 6);
    }
    // The ramp up to the T7 boss is unchanged.
    expect(endlessWavePlan("endless", 21).damageScale).toBeCloseTo(6.893, 2);
  });

  it("gives Dr. Groundhog the same extra on his hit at every tier, without changing Nightmare", () => {
    for (const wave of [3, 12, 21, 30]) expect(endlessBossMultiplier("endless", wave)).toBe(ENDLESS_BOSS_DAMAGE);
    expect(endlessBossMultiplier("nightmare", 21)).toBe(1);
  });

  it("makes Dr. Groundhog out-damage the tier's ordinary enemies", () => {
    // Damage per second of one hit, the way the floors line up: one enemy at a time. Measured
    // against floor 1's line, the tier's plain enemies (floor 2 adds the bosses).
    const dps = (u: CombatUnit) => countHitDamage(u) / (u.attackCooldownMs / 1000);
    for (let tier = 1; tier <= 12; tier++) {
      const at = (wave: number) => endlessFightConfig({ ...beginEndlessRun("endless", []), nextWave: wave }, 45).enemyUnits;
      const floor = at(tier * 3 - 2).filter((u) => !isEndlessKiller(u.sourceKey));
      const floorDps = floor.reduce((sum, u) => sum + dps(u), 0) / floor.length;
      const boss = at(tier * 3).find((u) => u.isBoss)!;
      const ratio = dps(boss) / floorDps;
      expect(ratio, `T${tier}`).toBeGreaterThan(1.1);
      expect(ratio, `T${tier}`).toBeLessThan(1.8);
    }
  });

  it("climbs Dr. Groundhog's health smoothly to ENDLESS_BOSS_HP_AT_T7, no tier more than 1.75x the last", () => {
    const hp = (wave: number) => endlessFightConfig({ ...beginEndlessRun("endless", []), nextWave: wave }, 45)
      .enemyUnits.find((u) => u.isBoss)!.maxHp;
    expect(hp(3)).toBe(ENDLESS_BOSS_HP_AT_T1);
    expect(hp(21)).toBe(ENDLESS_BOSS_HP_AT_T7);
    for (let wave = 6; wave <= 36; wave += 3) {
      const step = hp(wave) / hp(wave - 3);
      expect(step, `T${wave / 3}`).toBeGreaterThan(1.1);
      expect(step, `T${wave / 3}`).toBeLessThan(1.75);
    }
  });

  it("hits harder on Video Game floors, but not on its Groundhog floor", () => {
    const at2 = (location: EndlessLocation, wave: number) =>
      scaleEndlessEnemy(endlessSourceUnit("NinjaStageActorBoy")!, endlessWavePlan("endless", wave, at(location)), [], ENDLESS_SHAPES);
    expect(at2("video-game", 4).str / at2("pirate", 4).str).toBeCloseTo(ENDLESS_LOCATION_STRENGTH["video-game"]!.damage, 6);
    expect(at2("video-game", 4).maxHp).toBe(at2("pirate", 4).maxHp);
    const boss = (location: EndlessLocation) =>
      endlessFightConfig({ ...beginEndlessRun("endless", []), nextWave: 6, stop: at(location) }, 45).enemyUnits[0];
    expect(boss("video-game").str).toBe(boss("pirate").str);
  });

  it("fields more bodies on an advanced floor, and Crowded only adds bodies", () => {
    expect(endlessWavePlan("endless", 1, at("pirate")).enemyKeys).toHaveLength(ENDLESS_FLOOR_ENEMIES[0]);
    expect(endlessWavePlan("endless", 2, at("pirate")).enemyKeys).toHaveLength(ENDLESS_FLOOR_ENEMIES[1]);
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
    expect(cursed.curseStun).toEqual({ chance: 0.15, durationMs: 900 });
    expect(cursed.stunChance).toBe(base.stunChance); // the enemy's own stun is untouched
    expect(cursed.deathExplosion).toEqual({ chance: 0.2, damagePercent: 20 });
  });

  it("only ever adds with Dazing Blows and Shoving Match, never rewriting an enemy's own effects", () => {
    // The Farm boss knocks back on every hit, at everyone.
    const boss = buildUnitsForKeys(
      [], "FarmStageActorBoss", enemyStats as unknown as Record<string, import("./types").EnemyStat>, attacks,
    ).find((u) => u.isBoss)!;
    expect(boss.knockBack).toBe(true);
    const cursed = applyEndlessEnemyCurses(boss, [
      { kind: "enemy-knockback-headless", chance: 0.25 },
      { kind: "enemy-stun", chance: 0.15, durationMs: 900 },
    ]);
    expect(cursed.knockBack).toBe(true);
    expect(cursed.knockBackChance).toBe(boss.knockBackChance);
    expect(cursed.knockBackHeadlessOnly).toBeFalsy();
    expect(cursed.stunMs ?? 0).toBe(boss.stunMs ?? 0);
    expect(cursed.curseShoveHeadless).toBe(0.25);
    expect(cursed.curseStun).toEqual({ chance: 0.15, durationMs: 900 });
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

  it("makes a perched boss hit harder than the line and slam, and a walk-in hit harder without one", () => {
    const plan = endlessWavePlan("endless", 8, at("farm"));
    const scaled = (key: string, isBoss: boolean) => scaleEndlessEnemy({ ...endlessSourceUnit(key)!, isBoss }, plan, [], ENDLESS_SHAPES);
    const dps = (u: ReturnType<typeof scaled>) => countHitDamage(u) / (u.attackCooldownMs / 1000);
    const line = scaled("AlienStageActorMinion", false);
    for (const key of ["FarmStageActorBoss", "NinjaStageActorBoss", "VideoGameStageBossActor"]) {
      const perched = scaled(key, true);
      const walkIn = scaled(key, false);
      expect(isEndlessKiller(key)).toBe(true);
      expect(dps(perched)).toBeGreaterThan(dps(line) * ENDLESS_KILLER.damage / 2);
      expect(dps(walkIn)).toBeGreaterThan(dps(line) * ENDLESS_WALK_IN.damage / 2);
      expect(walkIn.maxHp).toBeLessThan(perched.maxHp);
      expect(perched.charge).toMatchObject({ target: "front-deployed" });
      expect(perched.charge?.damage).toBeCloseTo(ENDLESS_SLAM_SECONDS * dps(perched), -1);
      expect(walkIn.charge).toBeFalsy();
    }
    // The captain's mirrored blow is his killing move: no second clock on top of it.
    expect(isEndlessKiller("PirateStageActorBoss")).toBe(true);
    expect(scaled("PirateStageActorBoss", true).charge).toBeFalsy();
    expect(scaleEndlessEnemy(enemy("FarmStageActorFarmhand"), plan).charge).toBeFalsy();
    expect(endlessKillerCount(5, 1)).toBe(0);
    expect(endlessKillerCount(6, 1)).toBe(1);
    expect(endlessKillerCount(4, 2)).toBe(0);
    expect(endlessKillerCount(5, 2)).toBe(1);
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
    expect(plain.stunResist).toBeCloseTo(0.02); // wave 4 is tier 2: 1% shorter stuns a tier
  });

  it("makes a slam's damage follow Heavy Hitters", () => {
    const killer = (modifier: EndlessModifierId | null) =>
      scaleEndlessEnemy({ ...enemy("FarmStageActorBoss"), isBoss: true }, endlessWavePlan("endless", 8, at("farm", modifier)), [], ENDLESS_SHAPES);
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

  it("shortens stuns 1% a tier with no cap, stacking with the curse (owner, ruleset 85)", () => {
    const base = enemy("FarmStageActorFarmhand");
    expect(applyEndlessDepthStunResist(base, 0).stunResist).toBeUndefined();
    expect(applyEndlessDepthStunResist(base, 10).stunResist).toBeCloseTo(0.10);
    expect(applyEndlessDepthStunResist(base, 27).stunResist).toBeCloseTo(0.27);
    // One stun-resist curse (30%) at T20: 1 - 0.7 x 0.8.
    expect(applyEndlessDepthStunResist({ ...base, stunResist: 0.3 }, 20).stunResist).toBeCloseTo(0.44);
    expect(applyEndlessDepthStunResist({ ...base, stunResist: 1 }, 5).stunResist).toBe(1);
    // The Epic Boss takes it too: his gate is built apart from the floor enemies.
    const run = { ...beginEndlessRun("endless", [], "2026-W46"), nextWave: 9 };
    const boss = endlessFightConfig(run, 45).enemyUnits[0];
    expect(boss.stunResist).toBeCloseTo(0.03);
  });

  it("pauses a stunned Endless enemy's swing clock instead of restarting it (ruleset 85)", () => {
    const timerAfterStun = (endless: boolean) => {
      const plan = endlessWavePlan("endless", 4, at("farm"));
      const zombie = buildPlayerUnits([makeOwned("z", zombiesJson.find((z) => z.key === "ZombieActorRegularTier1") as unknown as ZombieDef, 0, 0, 0, 0)])[0];
      const sim = buildFight({
        playerUnits: [{ ...zombie, con: 1e6, maxHp: 1e8, hp: 1e8 }], enemyUnits: [{ ...enemy("FarmStageActorFarmhand"), maxHp: 1e8, hp: 1e8 }],
        ...(endless ? { endlessMechanics: buildEndlessStageMechanics(plan, 45) } : {}),
      });
      const foe = sim.units.find((u) => u.team === "enemy")! as unknown as { state: string; timerMs: number; stunMs: number };
      for (let i = 0; i < 2_000 && foe.state !== "fight"; i++) sim.step(50);
      expect(foe.state).toBe("fight");
      foe.timerMs = 400;
      foe.stunMs = 500;
      for (let i = 0; i < 10; i++) sim.step(50);
      return foe.timerMs;
    };
    expect(timerAfterStun(true)).toBeCloseTo(400, -1); // paused: the swing is still 0.4 s away
    expect(timerAfterStun(false)).toBeGreaterThan(400); // invasions: the swing starts over
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

  it("heals the survivors after a boss, and never brings the fallen back", () => {
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
    expect(afterBoss[0].alive).toBe(false);
    expect(afterBoss[1].alive && afterBoss[1].hp === afterBoss[1].maxHp).toBe(true);
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

describe("Endless drafts never offer a pick that would do nothing (owner, 2026-11-11)", () => {
  // Only what the draft reads: who is alive, who is Headless, and who can stun.
  const body = (id: string, isHeadless: boolean, abilities: string[], alive = true) =>
    ({ id, isHeadless, abilities, alive }) as unknown as CombatUnit;
  const army = [
    body("h1", true, ["hitPointsBuff"]), body("h2", true, ["protect"]), body("h3", true, ["block"]),
    body("s1", false, ["stun", "bashV2"]), body("r1", false, ["grace"]),
  ];
  const base = { ...beginEndlessRun("endless", [], "9"), units: army };
  const maxed = {
    ...base,
    reviveHeadless: true,
    buildBoons: ["rearguard" as const],
    deploymentSpeedBonus: ENDLESS_MAX_DEPLOY_REDUCTION,
    openingDeploy: ENDLESS_MAX_OPENING_DEPLOY,
    curses: [
      { kind: "enemy-stun", chance: 0.15, durationMs: 900 },
      { kind: "enemy-explosion", chance: 0.2, damagePercent: 20 },
      { kind: "enemy-knockback-headless", chance: 0.25 },
    ] as EndlessCurse[],
  };

  it("knows which picks are wasted on a run", () => {
    const boons: EndlessBoon[] = [{ kind: "revive-headless" }, { kind: "rearguard" }, { kind: "deployment", percent: 20 }, { kind: "opening-deploy", count: 3 }];
    for (const boon of boons) {
      expect(endlessDraftPickWasted(base, boon), boon.kind).toBe(false);
      expect(endlessDraftPickWasted(maxed, boon), boon.kind).toBe(true);
    }
    for (const curse of maxed.curses) {
      expect(endlessDraftPickWasted(base, curse), curse.kind).toBe(false);
      expect(endlessDraftPickWasted(maxed, curse), curse.kind).toBe(true);
    }
    // Everything that stacks stays on offer however often it was taken.
    expect(endlessDraftPickWasted(maxed, { kind: "sharp-teeth" })).toBe(false);
    expect(endlessDraftPickWasted(maxed, { kind: "enemy-health", percent: 20 })).toBe(false);
    expect(endlessDraftPickWasted(maxed, { kind: "enemy-stun-resist", percent: 30 })).toBe(false);
  });

  it("wastes curses aimed at what the army does not field", () => {
    const headlessCurse: EndlessCurse = { kind: "headless-stat", stat: "con", percent: 20 };
    const shove: EndlessCurse = { kind: "enemy-knockback-headless", chance: 0.25 };
    const resist: EndlessCurse = { kind: "enemy-stun-resist", percent: 30 };
    for (const curse of [headlessCurse, shove, resist]) expect(endlessDraftPickWasted(base, curse), curse.kind).toBe(false);
    // Two living Headless (the third fell this run) are not enough to make a Headless curse cost anything.
    const twoHeadless = { ...base, units: [...army.slice(0, 2), body("h3", true, ["block"], false), ...army.slice(3)] };
    expect(endlessDraftPickWasted(twoHeadless, headlessCurse)).toBe(true);
    expect(endlessDraftPickWasted(twoHeadless, shove)).toBe(true);
    // No stun source anywhere: stun resistance is free.
    const noStuns = { ...base, units: army.filter((u) => u.id !== "s1") };
    expect(endlessDraftPickWasted(noStuns, resist)).toBe(true);
    for (const source of ["stun", "bashV2", "explode", "explodeV2", "attachMini", "stoneGaze"]) {
      expect(endlessDraftPickWasted({ ...noStuns, units: [...noStuns.units, body("x", false, [source])] }, resist), source).toBe(false);
    }
  });

  it("offers the Headless curse against con, the stat a tank lives on", () => {
    const offered = new Set<string>();
    for (let week = 0; week < 60; week++) for (const wave of [3, 6, 9]) {
      for (const curse of endlessBossDraft("endless", wave, String(week)).curses) {
        if (curse.kind === "headless-stat") offered.add(curse.stat);
      }
    }
    expect([...offered]).toEqual(["con"]);
  });

  it("re-rolls wasted picks across many weeks and bosses, deterministically, with no repeats", () => {
    for (let week = 0; week < 40; week++) {
      for (const wave of [3, 6, 9, 12]) {
        const draft = endlessBossDraft("endless", wave, String(week), "farm", true, { ...maxed, weekSeed: String(week) });
        expect(draft).toEqual(endlessBossDraft("endless", wave, String(week), "farm", true, { ...maxed, weekSeed: String(week) }));
        for (const pick of [...draft.boons, ...draft.curses]) expect(endlessDraftPickWasted(maxed, pick), pick.kind).toBe(false);
        expect(draft.boons).toHaveLength(3);
        expect(draft.curses).toHaveLength(3);
        expect(new Set(draft.boons.map((b) => JSON.stringify(b))).size).toBe(3);
        expect(new Set(draft.curses.map((b) => JSON.stringify(b))).size).toBe(3);
      }
    }
  });

  it("leaves a fresh run's draft exactly the weekly one", () => {
    for (let week = 0; week < 20; week++) {
      const run = { ...base, weekSeed: String(week) };
      expect(endlessBossDraft("endless", 3, String(week), "farm", true, run))
        .toEqual(endlessBossDraft("endless", 3, String(week), "farm", true));
    }
  });
});

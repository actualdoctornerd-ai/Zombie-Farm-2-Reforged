/** One Endless fight's pinned config, shared by the Worker (which pins and replays it) and
 *  the balance report (which flies it). A tool can only measure the fight players get if it
 *  builds that fight here, so nothing else should assemble one. */
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import zombiesJson from "../../public/assets/zombies.json";
import { epicBossDamage, epicBossHp, DR_GROUNDHOG, GALACTIC_GROUNDHOG } from "../epicBoss/catalog";
import type { ZombieDef } from "../assets";
import { abilitySlotUnlocked } from "../lifeForce";
import { MAX_VET_RANK } from "../zombie/traits";
import { makeOwned } from "../zombie/types";
import { waveCadenceFor } from "./alienStage";
import { buildFight } from "./buildFight";
import { buildPlayerUnits, buildUnitsForKeys } from "./CombatEngine";
import { countHitDamage } from "./countSlam";
import { POISE_THRESHOLD, STAGGER_MS } from "./dualInvasion";
import {
  applyEndlessBoon, applyEndlessEnemyCurses, ENDLESS_ALIEN_MAX_ACTIVE, ENDLESS_BOSS_LAUNCH_COOLDOWN_MS, ENDLESS_BOSS_LAUNCH_HIT, ENDLESS_BOSS_LAUNCH_TARGETS, ENDLESS_BOSS_LAUNCH_TIER, ENDLESS_BOSS_SLAM_MULT, ENDLESS_BOSS_SLAM_TIER, ENDLESS_CHARGE_TAP_REDUCE, ENDLESS_BOSS_HP_SCALE, ENDLESS_FIGHTS_PER_LOCATION, endlessBossHp,
  endlessBossMultiplier, endlessClockMs, endlessDoOrDieMs, endlessPeerShapes, endlessPlayerUnits, endlessWavePlan,
  finishEndlessFight, type EndlessCurse, type EndlessLocation, type EndlessModifierId, type EndlessWavePlan, scaleEndlessEnemy, scaleEndlessThrow, type EndlessBoon, type EndlessRunState,
} from "./endless";
import { buildEndlessStageMechanics } from "./endlessMechanics";
import { ENDLESS_LOCATION_RAID } from "./endlessLoot";
import type { AttackDef, BossSpecial, BossThrowConfig, CombatUnit, EnemyStat, EndlessStageMechanics, WaveCadence } from "./types";

const enemyStats = enemyStatsJson as Record<string, EnemyStat>;
const attacks = attacksJson as Record<string, AttackDef>;

/** Every Endless enemy as its own invasion authored it: no level pace, no elite profile. */
export function endlessSourceUnit(key: string): CombatUnit | undefined {
  return enemyStats[key] ? buildUnitsForKeys([key], null, enemyStats, attacks)[0] : undefined;
}
/** Each enemy's shape against its own invasion, built once from the source tables. */
export const ENDLESS_SHAPES = endlessPeerShapes(endlessSourceUnit);

const NO_ENRAGE_MS = 10 * 60 * 1000;

export interface EndlessFightConfig {
  wave: number;
  /** The terrain to draw and its modifier: the player chose them, the wave cannot tell. */
  location: EndlessLocation;
  modifier: EndlessModifierId | null;
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  bossSpecials: BossSpecial[];
  bossFallsFromSky: boolean;
  noDistractions: boolean;
  escapeOnRoundEnd: boolean;
  roundMs?: number;
  /** Omitted on a run pinned before Endless had its own clock: the ordinary four minutes. */
  timeLimitMs?: number;
  doOrDieMs?: number;
  endlessMechanics: EndlessStageMechanics;
  waveCadence?: WaveCadence;
  /** The perched location boss's projectiles (ordinary floors); omitted on a run pinned
   *  before floors had their bosses, and on boss gates and Alien Landing. */
  bossThrow?: BossThrowConfig | null;
  /** The run's Concentration (bought once at the start, good for every floor). Also read by
   *  RaidScene, which hides the focus minigame. */
  concentration?: boolean;
}

/** Seconds between a perched boss's throws: each invasion's own pace (raids.json throwSpeed;
 *  the Worker does not bundle raids.json, so the four are written out here). */
export const ENDLESS_THROW_INTERVAL_S: Readonly<Record<string, number>> = {
  FarmStageActorBoss: 2, NinjaStageActorBoss: 2, VideoGameStageBossActor: 2, PirateStageActorBoss: 8,
};

/** A perched boss's throws on this floor: the projectiles from his own boss actions, paced as
 *  in his invasion, sized by scaleEndlessThrow. */
export function endlessBossThrow(plan: EndlessWavePlan, curses: readonly EndlessCurse[]): BossThrowConfig | null {
  if (!plan.bossKey) return null;
  const options = (enemyStats[plan.bossKey]?.bossActions ?? [])
    .filter((action) => action.name === "throw" && action.sprite)
    .map((action) => ({ damage: action.damage ?? 1, weight: action.frequency, sprite: action.sprite!, spriteSize: action.spriteSize ?? 32 }));
  if (!options.length) return null;
  return scaleEndlessThrow({ intervalMs: (ENDLESS_THROW_INTERVAL_S[plan.bossKey] ?? 2) * 1000, options }, plan, curses);
}

function epicBossUnit(plan: EndlessWavePlan): { unit: CombatUnit; specials: BossSpecial[] } {
  const def = plan.mode === "nightmare" ? GALACTIC_GROUNDHOG : DR_GROUNDHOG;
  const bossMultiplier = endlessBossMultiplier(plan.mode, plan.wave);
  // Normal Endless: a smooth climb to 1,000,000 at T7 (endlessBossHp). Nightmare: the ramp.
  const baseHp = epicBossHp(def, 1) * ENDLESS_BOSS_HP_SCALE;
  const hp = Math.max(1, Math.round(plan.mode === "endless"
    ? endlessBossHp(plan.mode, plan.wave, baseHp * endlessWavePlan(plan.mode, ENDLESS_FIGHTS_PER_LOCATION).healthScale,
      plan.healthScale, endlessWavePlan(plan.mode, 7 * ENDLESS_FIGHTS_PER_LOCATION).healthScale)
    : baseHp * plan.healthScale));
  const unit: CombatUnit = {
    id: `endless-boss-${plan.wave}`, sourceKey: `EpicBoss:${def.id}`, team: "enemy", name: def.name,
    str: epicBossDamage(def, 1) * plan.damageScale * bossMultiplier, dex: def.unitStats.dex, con: def.unitStats.con,
    focus: 0, hp, maxHp: hp, attackCooldownMs: Math.max(1, Math.round(1000 / Math.max(0.1, def.unitStats.dex))),
    attacks: def.unitStats.attacks.map((a) => ({ name: a.name, frequency: a.frequency, mult: a.mult ?? 1 })),
    isBoss: true, alive: true, isGarden: false, isHeadless: false, abilities: [],
  };
  const specials: BossSpecial[] = (def.specials ?? []).map((s) => ({
    name: s.name, weight: s.weight, castMs: s.castMs, cooldownMs: s.cooldownMs, damage: s.damage * bossMultiplier,
  }));
  // He comes with only a bite, so Endless gives him moves: from the first meeting a launch that
  // throws the front four to the back, and from T2 a slam that a stun, a timed Block or tapping
  // him can answer.
  const hit = countHitDamage(unit);
  if (plan.tier >= ENDLESS_BOSS_SLAM_TIER) {
    unit.charge = {
      windupMs: 3_000, recoveryMs: 9_000, damage: Math.round(ENDLESS_BOSS_SLAM_MULT * hit),
      poiseThreshold: POISE_THRESHOLD, poiseDrainPerSec: 0, staggerMs: STAGGER_MS, target: "front-deployed",
      tapReduce: ENDLESS_CHARGE_TAP_REDUCE,
    };
  }
  if (plan.tier >= ENDLESS_BOSS_LAUNCH_TIER) {
    specials.push({
      name: "launch", weight: 1, castMs: 1_500, cooldownMs: ENDLESS_BOSS_LAUNCH_COOLDOWN_MS,
      damage: Math.round(ENDLESS_BOSS_LAUNCH_HIT * hit), targets: ENDLESS_BOSS_LAUNCH_TARGETS,
    });
  }
  return { unit, specials };
}

export function endlessFightConfig(run: EndlessRunState, playerLevel: number): EndlessFightConfig {
  const plan = endlessWavePlan(run.mode, run.nextWave, run.stop, run.weekSeed);
  const mechanics = buildEndlessStageMechanics(plan, playerLevel, undefined, run.curses);
  mechanics.deploymentSpeedBonus = run.deploymentSpeedBonus;
  mechanics.openingDeploy = run.openingDeploy;
  mechanics.rearguard = run.buildBoons.includes("rearguard");
  const waveCadence: WaveCadence = plan.location === "alien"
    ? { ...waveCadenceFor(6), maxActive: ENDLESS_ALIEN_MAX_ACTIVE }
    : { maxActive: 1, dripMs: 0, openingActive: 1 };
  const timeLimitMs = endlessClockMs(plan);
  const doOrDieMs = endlessDoOrDieMs(plan);
  const where = { location: plan.location, modifier: plan.modifier, ...(run.concentration ? { concentration: true } : {}) };
  if (plan.bossGate) {
    const boss = epicBossUnit(plan);
    return {
      wave: plan.wave, ...where,
      playerUnits: endlessPlayerUnits(run),
      enemyUnits: [applyEndlessEnemyCurses(boss.unit, run.curses)],
      bossSpecials: boss.specials,
      bossFallsFromSky: true,
      noDistractions: true,
      // The Epic Boss's own round timer would end the fight (or enrage him) before the
      // overtime, so it is pushed well past the clock: Do or Die is the only pressure.
      escapeOnRoundEnd: false,
      roundMs: NO_ENRAGE_MS,
      timeLimitMs, doOrDieMs,
      endlessMechanics: mechanics,
      waveCadence,
    };
  }
  // Built without the player's level: the Farm invasion's level pace speeds its enemies up as
  // a starter raid is out-levelled, which is not Endless's ramp.
  // The location's boss is the last unit, perched and throwing until the line falls.
  const enemyUnits = buildUnitsForKeys([...plan.enemyKeys], plan.bossKey, enemyStats, attacks, {
    raidId: ENDLESS_LOCATION_RAID[plan.location],
  }).map((unit) => scaleEndlessEnemy(unit, plan, run.curses, ENDLESS_SHAPES));
  return {
    wave: plan.wave, ...where,
    playerUnits: endlessPlayerUnits(run), enemyUnits, bossSpecials: [],
    bossThrow: endlessBossThrow(plan, run.curses),
    bossFallsFromSky: false, noDistractions: false, escapeOnRoundEnd: false,
    timeLimitMs, doOrDieMs,
    endlessMechanics: mechanics,
    waveCadence,
  };
}

export function endlessSimFor(config: EndlessFightConfig) {
  return buildFight({
    playerUnits: config.playerUnits,
    enemyUnits: config.enemyUnits,
    bossSpecials: config.bossSpecials,
    bossFallsFromSky: config.bossFallsFromSky,
    noDistractions: config.noDistractions,
    escapeOnRoundEnd: config.escapeOnRoundEnd,
    roundMs: config.roundMs,
    timeLimitMs: config.timeLimitMs,
    doOrDieMs: config.doOrDieMs,
    endlessMechanics: config.endlessMechanics,
    waveCadence: config.waveCadence,
    bossThrow: config.bossThrow ?? null,
    concentration: config.concentration ?? false,
  });
}

const ZOMBIES = new Map((zombiesJson as ZombieDef[]).map((z) => [z.key, z]));

/** Apply a chosen boon. A temporary zombie joins the army at Master veterancy for this run
 *  only (never on the account's roster), and deploys with the army's third zombie. Its ability
 *  slots open with the farm's Life Force, as the army's do; a run from before that rule passes
 *  none and keeps the player level it was started under. */
export function endlessApplyBoon(
  run: EndlessRunState, boon: EndlessBoon, playerLevel: number, lifeForceLevel: number = playerLevel,
): EndlessRunState {
  if (boon.kind !== "temporary-zombie") return applyEndlessBoon(run, boon);
  const def = ZOMBIES.get(boon.key);
  if (!def) return run;
  const owned = makeOwned(`temp-${run.units.length}`, def as Parameters<typeof makeOwned>[1], 0, 0, MAX_VET_RANK, 0);
  const [unit] = buildPlayerUnits([owned], { playerLevel, abilitySlotUnlocked: (slot) => abilitySlotUnlocked(slot, lifeForceLevel) });
  // Loaned: it skips the deploy queue and walks on with the army's third deploy (BattleSim).
  return unit ? { ...run, units: [...run.units, { ...unit, hp: unit.maxHp, alive: true, loaned: true }] } : run;
}

export function endlessCarryFromSim(run: EndlessRunState, sim: ReturnType<typeof endlessSimFor>) {
  const states = new Map(sim.units.filter((unit) => unit.team === "player").map((unit) => [unit.id, unit]));
  // The fight's bodies can be scaled by boons, so what carries over is the share of health left.
  const battleUnits = run.units.map((unit) => {
    const state = states.get(unit.id);
    return state
      ? { ...unit, alive: state.alive, hp: state.alive ? Math.max(1, Math.round(unit.maxHp * (state.hp / Math.max(1, state.maxHp)))) : 0 }
      : unit;
  });
  return finishEndlessFight(run, battleUnits);
}

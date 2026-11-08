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
  applyEndlessBoon, applyEndlessEnemyCurses, ENDLESS_BOSS_LAUNCH_TIER, ENDLESS_BOSS_SLAM_MULT, ENDLESS_BOSS_SLAM_TIER, ENDLESS_CHARGE_TAP_REDUCE, ENDLESS_BOSS_HP_SCALE, ENDLESS_LATE_BOSS_HP_MULTIPLIER,
  endlessBossMultiplier, endlessClockMs, endlessDoOrDieMs, endlessPeerShapes, endlessPlayerUnits, endlessWavePlan,
  finishEndlessFight, type EndlessLocation, type EndlessModifierId, type EndlessWavePlan, scaleEndlessEnemy, type EndlessBoon, type EndlessRunState,
} from "./endless";
import { buildEndlessStageMechanics } from "./endlessMechanics";
import type { AttackDef, BossSpecial, CombatUnit, EnemyStat, EndlessStageMechanics, WaveCadence } from "./types";

const enemyStats = enemyStatsJson as Record<string, EnemyStat>;
const attacks = attacksJson as Record<string, AttackDef>;
const raidId: Record<string, number> = { farm: 1, ninja: 3, alien: 6, "video-game": 9, pirate: 4 };

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
}

function epicBossUnit(plan: EndlessWavePlan): { unit: CombatUnit; specials: BossSpecial[] } {
  const def = plan.mode === "nightmare" ? GALACTIC_GROUNDHOG : DR_GROUNDHOG;
  const bossMultiplier = endlessBossMultiplier(plan.mode, plan.wave);
  const hpMultiplier = bossMultiplier > 1 ? ENDLESS_LATE_BOSS_HP_MULTIPLIER : 1;
  const hp = Math.max(1, Math.round(epicBossHp(def, 1) * plan.healthScale * hpMultiplier * ENDLESS_BOSS_HP_SCALE));
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
  // He comes with only a bite, so Endless gives him a new move a tier: a slam that stuns, a
  // timed Block or tapping him can answer, then a launch that sends a zombie to the back.
  const hit = countHitDamage(unit);
  if (plan.tier >= ENDLESS_BOSS_SLAM_TIER) {
    unit.charge = {
      windupMs: 3_000, recoveryMs: 9_000, damage: Math.round(ENDLESS_BOSS_SLAM_MULT * hit),
      poiseThreshold: POISE_THRESHOLD, poiseDrainPerSec: 0, staggerMs: STAGGER_MS, target: "front-deployed",
      tapReduce: ENDLESS_CHARGE_TAP_REDUCE,
    };
  }
  if (plan.tier >= ENDLESS_BOSS_LAUNCH_TIER) {
    specials.push({ name: "launch", weight: 1, castMs: 1_500, cooldownMs: 12_000, damage: Math.round(hit) });
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
    ? waveCadenceFor(6)
    : { maxActive: 1, dripMs: 0, openingActive: 1 };
  const timeLimitMs = endlessClockMs(plan);
  const doOrDieMs = endlessDoOrDieMs(plan);
  const where = { location: plan.location, modifier: plan.modifier };
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
  const enemyUnits = buildUnitsForKeys([...plan.enemyKeys], null, enemyStats, attacks, {
    raidId: raidId[plan.location],
  }).map((unit) => scaleEndlessEnemy(unit, plan, run.curses, ENDLESS_SHAPES));
  return {
    wave: plan.wave, ...where,
    playerUnits: endlessPlayerUnits(run), enemyUnits, bossSpecials: [],
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
  });
}

const ZOMBIES = new Map((zombiesJson as ZombieDef[]).map((z) => [z.key, z]));

/** Apply a chosen boon. A temporary zombie joins the army at Master veterancy for this run
 *  only (never on the account's roster), and deploys with the army's third zombie. */
export function endlessApplyBoon(run: EndlessRunState, boon: EndlessBoon, playerLevel: number): EndlessRunState {
  if (boon.kind !== "temporary-zombie") return applyEndlessBoon(run, boon);
  const def = ZOMBIES.get(boon.key);
  if (!def) return run;
  const owned = makeOwned(`temp-${run.units.length}`, def as Parameters<typeof makeOwned>[1], 0, 0, MAX_VET_RANK, 0);
  const [unit] = buildPlayerUnits([owned], { playerLevel, abilitySlotUnlocked: (slot) => abilitySlotUnlocked(slot, playerLevel) });
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

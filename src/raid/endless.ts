/** Endless Mode's deterministic encounter planner.
 *
 * The global wave controls the enemy roster and stat ramp. The position inside a
 * four-wave location section controls that location's timed-mechanic cadence. Those
 * axes are deliberately separate: entering a new location resets its cadence, while
 * enemies keep scaling with the run.
 */
import { seededRandom } from "./RaidCatalog";
import type { CombatUnit } from "./types";

export type EndlessMode = "endless" | "nightmare";
export type EndlessLocation = "farm" | "ninja" | "alien" | "video-game" | "pirate";

export const ENDLESS_ENTRY_COST: Readonly<Record<EndlessMode, number>> = {
  endless: 1,
  nightmare: 3,
};
export const ENDLESS_UNLOCK_LEVEL: Readonly<Record<EndlessMode, number>> = {
  endless: 30,
  nightmare: 45,
};
export const ENDLESS_FIGHTS_PER_LOCATION = 4;
export const ENDLESS_LOCATION_ORDER: readonly EndlessLocation[] = [
  "farm", "ninja", "alien", "video-game", "pirate",
];

/** A regular enemy's initial threat band, before the endless stat multiplier.
 *
 * These are deliberately close together. Normal raid rosters have very wide raw stat
 * gaps, and Endless should not inherit those gaps as free waves. The entry floor is
 * meant to be calibrated against an elite-level L30 roster; the factors preserve a
 * visible role gradient after weak species have been brought up to that floor.
 */
export const ENDLESS_ROLE_THREAT = {
  baseline: 1,
  specialist: 1.16,
  heavy: 1.32,
} as const;
/** Shared minimum threat rating before role differentiation. This brings weak source
 *  enemies (notably Farmhands and Lumberjacks) up to the mode's elite-like entry floor;
 *  role factors keep the original identity gradient without the huge cross-raid gaps. */
export const ENDLESS_ENTRY_THREAT_RATING = 22;
export type EndlessEnemyArchetype = "swarm" | "balanced" | "tank" | "high-dps" | "burst" | "control";
interface EndlessArchetypeProfile { hp: number; damage: number; cadence: number }
/** Endless-only identities, applied after shared entry-floor normalization. */
export const ENDLESS_ARCHETYPE_PROFILES: Readonly<Record<EndlessEnemyArchetype, EndlessArchetypeProfile>> = {
  swarm: { hp: 0.76, damage: 0.9, cadence: 1.46 },
  balanced: { hp: 1, damage: 1, cadence: 1 },
  tank: { hp: 1.62, damage: 0.7, cadence: 0.88 },
  "high-dps": { hp: 0.78, damage: 1.4, cadence: 1.16 },
  burst: { hp: 1, damage: 0.92, cadence: 0.92 },
  control: { hp: 0.94, damage: 0.82, cadence: 0.96 },
};
const ENDLESS_ARCHETYPE_BY_KEY: Readonly<Record<string, EndlessEnemyArchetype>> = {
  FarmStageActorFarmhand: "swarm", FarmStageActorLumberjack: "burst", FarmStageActorBoss: "tank",
  AlienStageActorMinion: "balanced", RobotStageActorBrainBot: "tank", RobotStageActorJunkBot: "tank",
  RobotStageActorBroBot: "high-dps", NinjaStageActorGirl: "control", NinjaStageActorBoy: "burst",
  NinjaStageActorBoss: "control", VideoGameStageKnightActor: "tank", VideoGameStageGhostActor: "high-dps",
  VideoGameStageMonsterActor: "burst", VideoGameStageBossActor: "control", PirateStageActorScallywag: "swarm",
  PirateStageActorSwashbuckler: "balanced", PirateStageActorBoss: "burst",
  BeachStageActorMinion1: "balanced", BeachStageActorMinion2: "high-dps",
  CircusStageActorMinion1: "control", CircusStageActorMinion2: "tank",
};
export function endlessEnemyArchetype(sourceKey: string): EndlessEnemyArchetype {
  return ENDLESS_ARCHETYPE_BY_KEY[sourceKey] ?? "balanced";
}

/** Starting points for tuning, not a hard cap: difficulty continues to grow at every
 * wave. `damage` and `health` are applied after the entry threat floor and role band. */
// Calibrated against 53 saved level-45 armies for a seven-tier reward ladder: each
// four-fight section raises enemy damage by about 46% and health by about 29%.
export const ENDLESS_DAMAGE_STEP = 0.10;
export const ENDLESS_HEALTH_STEP = 0.065;
/** Preserve Nightmare's existing steeper entry multiplier and per-wave rates. */
export const NIGHTMARE_DAMAGE_STEP = 0.075;
export const NIGHTMARE_HEALTH_STEP = 0.045;
/** T7 and later boss gates are 7x stronger after the regular wave stat ramp. */
export const ENDLESS_LATE_BOSS_MULTIPLIER = 7;
export const ENDLESS_LATE_BOSS_START_WAVE = 28;
/** Keep the curve at each post-T7 section one four-fight tier behind the raw wave.
 * This makes T8's encounter/stat envelope comparable to today's T7, then lets later
 * tiers continue the same gradual rise. Location mechanics still follow their actual
 * section and cooldown progression. */
export const ENDLESS_LATE_SCALING_DELAY_WAVES = ENDLESS_FIGHTS_PER_LOCATION;

export function endlessBossMultiplier(mode: EndlessMode, wave: number): number {
  return mode === "endless" && wave >= ENDLESS_LATE_BOSS_START_WAVE
    ? ENDLESS_LATE_BOSS_MULTIPLIER
    : 1;
}
export const NIGHTMARE_ENTRY_DAMAGE = 1.4;
export const NIGHTMARE_ENTRY_HEALTH = 1.25;

export interface EndlessWavePlan {
  mode: EndlessMode;
  wave: number;
  section: number;
  location: EndlessLocation;
  /** 1–4, resets when terrain changes. */
  locationFight: number;
  bossGate: boolean;
  /** Later regular encounters sometimes field two enemies at once. */
  pairDeploy: boolean;
  /** 1–5 enemy roster tier, increases across the full run (and keeps rising on revisits). */
  enemyTier: number;
  /** Raw source enemy keys, with no boss actors. Boss gates use Epic Boss combat. */
  enemyKeys: readonly string[];
  damageScale: number;
  healthScale: number;
  /** Multiplier on each location mechanic's authored cooldown. Passive mechanics ignore it. */
  mechanicCooldownScale: number;
  /** Absolute environmental mechanic cooldowns after local frequency scaling. */
  mechanicCooldownsMs: Readonly<Record<string, number>>;
  bossId: "dr-groundhog" | "galactic-groundhog" | null;
}

interface LocationMechanics {
  /** This describes the area's always-on mechanic set. Frequency changes; membership does not. */
  mechanics: readonly string[];
  /** Per-fight cooldown factor, ending at the boss gate. */
  cadence: readonly [number, number, number, number];
}

export const ENDLESS_LOCATION_MECHANICS: Readonly<Record<EndlessLocation, LocationMechanics>> = {
  farm: { mechanics: [], cadence: [1, 1, 1, 1] },
  ninja: { mechanics: ["carrot-wall", "smoke-bomb-teleport"], cadence: [1, 0.88, 0.76, 0.66] },
  alien: { mechanics: ["laser", "summons"], cadence: [1, 0.88, 0.76, 0.66] },
  "video-game": { mechanics: ["pixel-fire", "turn-zombie"], cadence: [1, 0.88, 0.76, 0.66] },
  pirate: { mechanics: ["mirrored-attack-speed"], cadence: [1, 0.92, 0.82, 0.72] },
};

/** Starting cooldowns for location mechanics. Each location's cadence multiplier
 *  tightens these over its four fights, then resets when the terrain changes. */
export const ENDLESS_MECHANIC_BASE_COOLDOWNS_MS: Readonly<Partial<Record<EndlessLocation, Readonly<Record<string, number>>>>> = {
  ninja: { "smoke-bomb-teleport": 30_000, "carrot-wall": 48_000 },
  alien: { laser: 26_000, summons: 42_000 },
  "video-game": { "pixel-fire": 30_000, "turn-zombie": 45_000 },
};

/** Pools progress by role, not by faction. An area can mix any of these invasions'
 * regular enemies; its terrain and local mechanic set supply its identity. */
const ENEMY_BANDS: readonly (readonly string[])[] = [
  [
    "FarmStageActorFarmhand", "AlienStageActorMinion", "PirateStageActorScallywag",
    "BeachStageActorMinion1",
  ],
  [
    "FarmStageActorLumberjack", "PirateStageActorSwashbuckler", "NinjaStageActorGirl",
    "BeachStageActorMinion2", "RobotStageActorBrainBot",
  ],
  [
    "NinjaStageActorBoy", "CircusStageActorMinion1", "VideoGameStageKnightActor",
    "VideoGameStageGhostActor", "RobotStageActorJunkBot",
  ],
  [
    "VideoGameStageMonsterActor", "CircusStageActorMinion2", "RobotStageActorBroBot",
    "AlienStageActorMinion",
  ],
  [
    // Former invasion bosses can enter the late regular roster. They must be built as
    // ordinary units: no perch, boss throws, or boss-only action scheduler.
    "FarmStageActorBoss", "NinjaStageActorBoss", "PirateStageActorBoss",
  ],
];

const LOCATION_POOLS: Readonly<Record<EndlessLocation, readonly string[]>> = {
  farm: ["FarmStageActorFarmhand", "FarmStageActorLumberjack", "BeachStageActorMinion1", "AlienStageActorMinion", "FarmStageActorBoss"],
  ninja: ["NinjaStageActorGirl", "NinjaStageActorBoy", "FarmStageActorLumberjack", "PirateStageActorSwashbuckler", "NinjaStageActorBoss"],
  alien: ["AlienStageActorMinion", "RobotStageActorBrainBot", "NinjaStageActorGirl", "VideoGameStageGhostActor"],
  "video-game": ["VideoGameStageKnightActor", "VideoGameStageGhostActor", "VideoGameStageMonsterActor", "NinjaStageActorBoy", "VideoGameStageBossActor"],
  pirate: ["PirateStageActorScallywag", "PirateStageActorSwashbuckler", "BeachStageActorMinion1", "BeachStageActorMinion2", "PirateStageActorBoss"],
};

const SPECIALIST_KEYS = new Set([
  "FarmStageActorLumberjack", "PirateStageActorSwashbuckler", "NinjaStageActorGirl",
  "NinjaStageActorBoy", "RobotStageActorBrainBot", "VideoGameStageGhostActor",
  "BeachStageActorMinion2", "CircusStageActorMinion1",
]);
const HEAVY_KEYS = new Set([
  "VideoGameStageKnightActor", "VideoGameStageMonsterActor", "RobotStageActorJunkBot",
  "RobotStageActorBroBot", "CircusStageActorMinion2", "FarmStageActorBoss",
  "NinjaStageActorBoss", "PirateStageActorBoss", "VideoGameStageBossActor",
]);

export function endlessEnemyRole(sourceKey: string): "baseline" | "specialist" | "heavy" {
  if (HEAVY_KEYS.has(sourceKey)) return "heavy";
  if (SPECIALIST_KEYS.has(sourceKey)) return "specialist";
  return "baseline";
}

/** Normalize a source enemy to the Endless entry floor, retain its role gradient, then
 *  apply global depth scaling. The enemy's attack cadence and special attack traits are
 *  intentionally preserved; the source abilities remain the tactical distinction. */
export function scaleEndlessEnemy(unit: CombatUnit, plan: EndlessWavePlan, curses: readonly EndlessCurse[] = []): CombatUnit {
  const role = endlessEnemyRole(unit.sourceKey);
  const target = ENDLESS_ENTRY_THREAT_RATING * ENDLESS_ROLE_THREAT[role];
  const attackFactor = Math.max(0.1, unit.dex) * Math.max(0.1, unit.attacks[0]?.mult ?? 1);
  const threat = Math.sqrt(Math.max(0.01, unit.str * attackFactor) * Math.max(0.01, unit.con));
  const normalize = target / Math.max(0.01, threat);
  const result = { ...unit, attacks: unit.attacks.map((attack) => ({ ...attack })) };
  result.str *= normalize * plan.damageScale;
  result.con *= normalize * plan.healthScale;
  result.maxHp = Math.max(1, Math.round(result.maxHp * normalize * plan.healthScale));
  result.hp = result.maxHp;
  const profile = ENDLESS_ARCHETYPE_PROFILES[endlessEnemyArchetype(unit.sourceKey)];
  result.str *= profile.damage;
  result.con *= profile.hp;
  result.maxHp = Math.max(1, Math.round(result.maxHp * profile.hp));
  result.hp = result.maxHp;
  result.dex *= profile.cadence;
  result.attackCooldownMs = Math.max(1, Math.round(result.attackCooldownMs / profile.cadence));
  if (unit.sourceKey === "FarmStageActorLumberjack") {
    result.charge = {
      windupMs: 2_400, recoveryMs: 5_200, damage: Math.max(18, Math.round(result.str * 2.1)),
      poiseThreshold: 1, poiseDrainPerSec: 0, staggerMs: 800, target: "front-deployed",
    };
  }
  return applyEndlessEnemyCurses(result, curses);
}

/** Apply run curses to regular enemies or the boss actor after its baseline scaling. */
export function applyEndlessEnemyCurses(unit: CombatUnit, curses: readonly EndlessCurse[]): CombatUnit {
  const result = { ...unit, attacks: unit.attacks.map((attack) => ({ ...attack })) };
  for (const curse of curses) {
    if (curse.kind === "enemy-health") {
      result.maxHp = Math.round(result.maxHp * (1 + curse.percent / 100));
      result.hp = result.maxHp;
      result.con *= 1 + curse.percent / 100;
    } else if (curse.kind === "enemy-damage") {
      result.str *= 1 + curse.percent / 100;
    } else if (curse.kind === "enemy-attack-speed") {
      result.attackCooldownMs = Math.max(1, Math.round(result.attackCooldownMs / (1 + curse.percent / 100)));
    } else if (curse.kind === "enemy-stun") {
      result.stunMs = Math.max(result.stunMs ?? 0, curse.durationMs);
      result.stunChance = Math.max(result.stunChance ?? 0, curse.chance);
    } else if (curse.kind === "enemy-explosion") {
      result.deathExplosion = { chance: curse.chance, damagePercent: curse.damagePercent };
    } else if (curse.kind === "enemy-knockback-headless") {
      result.knockBack = true;
      result.knockBackChance = Math.max(result.knockBackChance ?? 0, curse.chance);
      result.knockBackHeadlessOnly = true;
    }
  }
  return result;
}

function powStep(step: number, count: number): number {
  let value = 1;
  for (let i = 0; i < count; i++) value *= 1 + step;
  return value;
}

function waveEnemies(wave: number, location: EndlessLocation, locationFight: number): string[] {
  // Four to six bodies keeps ordinary encounters shorter than a normal invasion.
  if (location === "alien") return Array.from({ length: 20 }, () => "AlienStageActorMinion");
  const count = locationFight === 1 ? 4 : locationFight === 2 ? 5 : 6;
  const globalTier = Math.min(ENEMY_BANDS.length, Math.ceil(wave / 4));
  // Local progression keeps each section moving from common foes to its strongest
  // regular mix. Global progression raises the starting tier on later sections.
  const enemyTier = Math.min(ENEMY_BANDS.length, globalTier + locationFight - 1);
  const allowed = new Set(ENEMY_BANDS.slice(0, enemyTier).flat());
  const local = LOCATION_POOLS[location].filter((key) => allowed.has(key));
  const candidates = local.length ? local : [...allowed];
  const formerBosses = candidates.filter((key) =>
    key.endsWith("StageActorBoss") || key.endsWith("StageBossActor"));
  const pool = candidates.filter((key) => !formerBosses.includes(key));
  const random = seededRandom(`endless-roster:${wave}:${location}`);
  // Scallywags mirror zombie attack speed. Their trait is always present in Pirate
  // sections; local escalation raises how often the army must manage it.
  const weightedPool = location === "pirate"
    ? pool.flatMap((key) => key === "PirateStageActorScallywag"
      ? Array.from({ length: locationFight }, () => key)
      : [key])
    : pool;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const key = weightedPool[Math.floor(random() * weightedPool.length)];
    out.push(key);
  }
  // Boss characters are an occasional regular enemy only once the run is deep enough.
  // `buildUnitsForKeys` receives them in enemyKeys, not bossKey, so they lose their
  // perched role and boss action scheduler for these appearances.
  if (wave >= 14 && formerBosses.length && random() < 0.25) {
    out[out.length - 1] = formerBosses[Math.floor(random() * formerBosses.length)];
  }
  if (wave >= 13 && locationFight === 2) {
    const pair: Partial<Record<EndlessLocation, readonly [string, string]>> = {
      farm: ["FarmStageActorBoss", "BeachStageActorMinion2"],
      ninja: ["NinjaStageActorBoss", "NinjaStageActorBoy"],
      "video-game": ["VideoGameStageKnightActor", "VideoGameStageGhostActor"],
      pirate: ["PirateStageActorSwashbuckler", "BeachStageActorMinion2"],
    };
    const [tank, striker] = pair[location] ?? [];
    if (tank && striker && out.length > 1) [out[0], out[1]] = [tank, striker];
  }
  return out;
}

/** Build the pure, reproducible plan for one fight in an Endless run. */
export function endlessWavePlan(mode: EndlessMode, waveInput: number): EndlessWavePlan {
  const wave = Math.max(1, Math.floor(Number.isFinite(waveInput) ? waveInput : 1));
  const scalingWave = mode === "endless" && wave > ENDLESS_LATE_BOSS_START_WAVE
    ? wave - ENDLESS_LATE_SCALING_DELAY_WAVES
    : wave;
  const section = Math.floor((wave - 1) / ENDLESS_FIGHTS_PER_LOCATION);
  const locationFight = ((wave - 1) % ENDLESS_FIGHTS_PER_LOCATION) + 1;
  const location = ENDLESS_LOCATION_ORDER[section % ENDLESS_LOCATION_ORDER.length];
  const bossGate = locationFight === ENDLESS_FIGHTS_PER_LOCATION;
  const baseDamage = mode === "nightmare" ? NIGHTMARE_ENTRY_DAMAGE : 1;
  const baseHealth = mode === "nightmare" ? NIGHTMARE_ENTRY_HEALTH : 1;
  const damageStep = mode === "nightmare" ? NIGHTMARE_DAMAGE_STEP : ENDLESS_DAMAGE_STEP;
  const healthStep = mode === "nightmare" ? NIGHTMARE_HEALTH_STEP : ENDLESS_HEALTH_STEP;
  const mechanics = ENDLESS_LOCATION_MECHANICS[location];
  // After tier four, compress raw stat growth so adding paired enemies and role
  // contrast supplies the challenge instead of an increasingly steep stat wall.
  const fastSteps = Math.min(scalingWave - 1, 15);
  const slowSteps = Math.max(0, scalingWave - 16);
  const damageScale = baseDamage * powStep(damageStep, fastSteps)
    * powStep(mode === "nightmare" ? 0.035 : 0.04, slowSteps);
  const healthScale = baseHealth * powStep(healthStep, fastSteps)
    * powStep(mode === "nightmare" ? 0.025 : 0.03, slowSteps);
  const mechanicCooldownScale = mechanics.cadence[locationFight - 1];
  const mechanicCooldownsMs = Object.fromEntries(
    Object.entries(ENDLESS_MECHANIC_BASE_COOLDOWNS_MS[location] ?? {})
      .map(([key, cooldown]) => [key, Math.max(1_000, Math.round(cooldown * mechanicCooldownScale))]),
  );
  return {
    mode, wave, section, location, locationFight, bossGate,
    pairDeploy: !bossGate && location !== "alien" && wave >= 13 && locationFight === 2,
    enemyTier: Math.min(ENEMY_BANDS.length, Math.ceil(wave / 4) + locationFight - 1),
    enemyKeys: bossGate ? [] : waveEnemies(wave, location, locationFight),
    damageScale, healthScale, mechanicCooldownScale, mechanicCooldownsMs,
    bossId: bossGate ? (mode === "nightmare" ? "galactic-groundhog" : "dr-groundhog") : null,
  };
}

/** Whether a former raid boss is eligible to be a regular line enemy at this depth. */
export function endlessBossAsRegularAllowed(wave: number): boolean {
  return Math.max(1, Math.floor(wave)) >= 14;
}

/** A run-local army. Endless damage never touches the account's owned zombies: this
 *  snapshot is created after entry is paid and discarded when the run ends. */
export interface EndlessRunState {
  mode: EndlessMode;
  nextWave: number;
  units: CombatUnit[];
  /** Additive combat boon, carried for this run only. */
  damageBonus: number;
  /** Faster zombie release, represented as a run-local percent for the scene layer. */
  deploymentSpeedBonus: number;
  /** Number of extra units released at the start of each fight (cap 3). */
  openingDeploy: number;
  /** Revive all fallen headless zombies after each fight once this boon is chosen. */
  reviveHeadless: boolean;
  /** Permanent run curses selected at boss gates. */
  curses: EndlessCurse[];
}

export type EndlessBoon =
  | { kind: "revive"; count: number }
  | { kind: "revive-headless" }
  | { kind: "damage"; percent: number }
  | { kind: "deployment"; percent: number }
  | { kind: "opening-deploy"; count: number };

export type EndlessCurse =
  | { kind: "enemy-health"; percent: number }
  | { kind: "enemy-damage"; percent: number }
  | { kind: "enemy-attack-speed"; percent: number }
  | { kind: "enemy-stun"; chance: number; durationMs: number }
  | { kind: "headless-stat"; stat: "str" | "dex" | "con"; percent: number }
  | { kind: "enemy-explosion"; chance: number; damagePercent: number }
  | { kind: "enemy-knockback-headless"; chance: number };

const BOON_POOL: readonly EndlessBoon[] = [
  { kind: "revive", count: 3 }, { kind: "damage", percent: 20 },
  { kind: "deployment", percent: 20 }, { kind: "opening-deploy", count: 3 },
  { kind: "revive-headless" },
];
const CURSE_POOL: readonly EndlessCurse[] = [
  { kind: "enemy-health", percent: 20 }, { kind: "enemy-damage", percent: 20 },
  { kind: "enemy-attack-speed", percent: 20 },
  { kind: "enemy-stun", chance: 0.15, durationMs: 900 },
  { kind: "headless-stat", stat: "str", percent: 20 },
  { kind: "enemy-explosion", chance: 0.2, damagePercent: 20 },
  { kind: "enemy-knockback-headless", chance: 0.25 },
];

/** Boss reward draft. Three unique boon choices and three unique curses are offered. */
export function endlessBossDraft(mode: EndlessMode, bossWave: number): { boons: EndlessBoon[]; curses: EndlessCurse[] } {
  const select = <T>(pool: readonly T[], label: string): T[] => {
    const random = seededRandom(`endless-draft:${mode}:${bossWave}:${label}`);
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, 3).map((item) => ({ ...item }));
  };
  return { boons: select(BOON_POOL, "boons"), curses: select(CURSE_POOL, "curses") };
}

/** Begin with a fresh battle copy; account-owned army records remain untouched. */
export function beginEndlessRun(mode: EndlessMode, party: readonly CombatUnit[]): EndlessRunState {
  return {
    mode, nextWave: 1,
    units: party.map((u) => ({ ...u, attacks: u.attacks.map((a) => ({ ...a })), hp: u.maxHp, alive: true })),
    damageBonus: 0, deploymentSpeedBonus: 0, openingDeploy: 0, reviveHeadless: false, curses: [],
  };
}

export function applyEndlessCurse(run: EndlessRunState, curse: EndlessCurse): EndlessRunState {
  return { ...run, curses: [...run.curses, { ...curse }] };
}

/** Carry only surviving units and their actual HP into the next fight. The scene
 *  builder starts them in the garden line again; no source/account state is mutated. */
export function carryEndlessArmy(run: EndlessRunState, battleUnits: readonly CombatUnit[]): EndlessRunState {
  const current = new Map(battleUnits.filter((u) => u.team === "player").map((u) => [u.id, u]));
  return {
    ...run,
    units: run.units.map((original) => {
      const fought = current.get(original.id);
      if (!fought || !fought.alive || fought.hp <= 0) {
        return { ...original, attacks: original.attacks.map((a) => ({ ...a })), hp: 0, alive: false };
      }
      return { ...original, attacks: original.attacks.map((a) => ({ ...a })), hp: Math.min(original.maxHp, fought.hp), alive: true };
    }),
  };
}

/** The section gate is the recovery checkpoint: revive everyone at full health, then
 *  advance the run. Between ordinary fights, surviving HP and casualties persist. */
export function finishEndlessFight(
  run: EndlessRunState,
  battleUnits: readonly CombatUnit[],
): EndlessRunState {
  const carried = carryEndlessArmy(run, battleUnits);
  const completedWave = run.nextWave;
  const bossGate = endlessWavePlan(run.mode, completedWave).bossGate;
  return {
    ...carried,
    nextWave: completedWave + 1,
    units: bossGate
      ? carried.units.map((u) => u.alive || (run.reviveHeadless && u.isHeadless)
        ? { ...u, alive: true, hp: u.maxHp }
        : u)
      : carried.units.map((u) => run.reviveHeadless && u.isHeadless && !u.alive
        ? { ...u, alive: true, hp: u.maxHp }
        : u),
  };
}

/** Boons appear after each cleared Epic Boss gate. Invalid revive picks are a no-op. */
export function applyEndlessBoon(run: EndlessRunState, boon: EndlessBoon): EndlessRunState {
  switch (boon.kind) {
    case "revive": {
      let left = Math.max(0, Math.floor(boon.count));
      const dead = run.units.filter((u) => !u.alive || u.hp <= 0);
      const revived = new Set(dead.slice(0, left).map((u) => u.id));
      return { ...run, units: run.units.map((u) => revived.has(u.id) ? { ...u, alive: true, hp: u.maxHp } : u) };
    }
    case "revive-headless":
      return { ...run, reviveHeadless: true };
    case "damage":
      return { ...run, damageBonus: run.damageBonus + Math.max(0, boon.percent) / 100 };
    case "deployment":
      return { ...run, deploymentSpeedBonus: Math.min(0.8, run.deploymentSpeedBonus + Math.max(0, boon.percent) / 100) };
    case "opening-deploy":
      return { ...run, openingDeploy: Math.min(3, run.openingDeploy + Math.max(0, Math.floor(boon.count))) };
  }
}

/** Apply run damage boons to a battle copy of the living party. */
export function endlessPlayerUnits(run: EndlessRunState): CombatUnit[] {
  return run.units.filter((u) => u.alive && u.hp > 0).map((u) => {
    const unit = { ...u, attacks: u.attacks.map((a) => ({ ...a, mult: (a.mult ?? 1) * (1 + run.damageBonus) })) };
    for (const curse of run.curses) {
      if (curse.kind === "headless-stat" && unit.isHeadless) {
        const ratio = Math.max(0, 1 - curse.percent / 100);
        unit[curse.stat] *= ratio;
        if (curse.stat === "con") {
          const hpRatio = unit.maxHp > 0 ? unit.hp / unit.maxHp : 1;
          unit.maxHp = Math.max(1, Math.round(unit.maxHp * ratio));
          unit.hp = Math.min(unit.maxHp, Math.round(unit.maxHp * hpRatio));
        }
        if (curse.stat === "dex") unit.attackCooldownMs = Math.max(1, Math.round(unit.attackCooldownMs / ratio));
      }
    }
    return unit;
  });
}


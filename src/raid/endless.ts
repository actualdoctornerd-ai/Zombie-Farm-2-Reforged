/** Endless Mode's deterministic encounter planner.
 *
 * The global wave controls the enemy roster and stat ramp. The position inside a
 * three-fight tier (normal, advanced, boss) controls that location's timed-mechanic
 * cadence. Those axes are deliberately separate: entering a new location resets its
 * cadence, while enemies keep scaling with the run.
 *
 * The player chooses each tier's location and modifier after a boss. Everything an option
 * or a draft contains comes from the week's seed, so in one week everybody faces the same
 * choices and nobody can out-roll anybody (owner, 2026-11-05).
 */
import { countHitDamage, COUNT_SLAM_RECOVERY_MS, COUNT_SLAM_WINDUP_MS } from "./countSlam";
import { POISE_THRESHOLD, STAGGER_MS } from "./dualInvasion";
import { mirrorIntervalSec } from "./combatStats";
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
export const ENDLESS_FIGHTS_PER_LOCATION = 3;
/** Where every run starts. The first choice comes after the first boss. */
export const ENDLESS_FIRST_LOCATION: EndlessLocation = "farm";
export const ENDLESS_LOCATIONS: readonly EndlessLocation[] = [
  "farm", "ninja", "alien", "video-game", "pirate",
];
export const ENDLESS_LOCATION_NAMES: Readonly<Record<EndlessLocation, string>> = {
  farm: "The Farm", ninja: "Ninja Dojo", alien: "Alien Landing", "video-game": "Video Game", pirate: "Pirate Ship",
};

/** What a location option carries, so choosing one is about your build and not about scenery. */
export type EndlessModifierId = "glass-cannon" | "chunky" | "crowded" | "stun-immune" | "short-clock" | "heavy-hitters";
interface EndlessModifier {
  name: string;
  description: string;
  hp?: number;
  damage?: number;
  dex?: number;
  extraEnemies?: number;
  clock?: number;
  stunResist?: number;
}
export const ENDLESS_MODIFIERS: Readonly<Record<EndlessModifierId, EndlessModifier>> = {
  "glass-cannon": { name: "Glass Cannon", description: "Enemies have 40% less health and deal 60% more damage", hp: 0.6, damage: 1.6 },
  chunky: { name: "Chunky", description: "Enemies have 35% more health and deal 25% less damage", hp: 1.35, damage: 0.75 },
  crowded: { name: "Crowded", description: "Extra enemies", extraEnemies: 4 },
  "stun-immune": { name: "Unstunnable", description: "Enemies cannot be stunned", stunResist: 1 },
  "short-clock": { name: "Short Clock", description: "20% less time on the clock", clock: 0.8 },
  "heavy-hitters": { name: "Heavy Hitters", description: "Enemies attack half as fast and hit 2.5x as hard", dex: 0.5, damage: 2.5 },
};
const ENDLESS_MODIFIER_IDS = Object.keys(ENDLESS_MODIFIERS) as EndlessModifierId[];

/** One tier's terrain and what it does to the fights there. */
export interface EndlessStop {
  location: EndlessLocation;
  modifier: EndlessModifierId | null;
}
export const ENDLESS_FIRST_STOP: EndlessStop = { location: ENDLESS_FIRST_LOCATION, modifier: null };
export function endlessStopLabel(stop: EndlessStop): string {
  const name = ENDLESS_LOCATION_NAMES[stop.location];
  return stop.modifier ? `${name} · ${ENDLESS_MODIFIERS[stop.modifier].name}` : name;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** A Monday, so the week turns over at Monday 00:00 UTC. */
const WEEK_EPOCH_MS = Date.UTC(2024, 0, 1);
/** The seed behind everything a week offers. A run pins it at its start and keeps it. */
export function endlessWeekSeed(now: number): string {
  return String(Math.floor((now - WEEK_EPOCH_MS) / WEEK_MS));
}

/** Every enemy's stats start from one shared threat rating, the Endless entry floor. What
 *  sets one enemy apart from another is its SOURCE shape: how its damage per second and
 *  health compare with the other enemies of its own invasion (endlessPeerShapes). The ramp
 *  then scales everyone from there. Attack speed stays the source's own. */
export const ENDLESS_ENTRY_THREAT_RATING = 23;
/** How far an enemy's source shape may sit from its invasion's baseline, either way. The
 *  pirate captain hits twelve times as hard as his crew; Endless keeps him the hardest
 *  hitter on the field without letting one source outlier set the whole fight. */
export const ENDLESS_SHAPE_LIMIT = 2;
/** An enemy's damage and health against its invasion's baseline (1 = average). */
export interface EndlessShape { damage: number; hp: number }

/** The former invasion bosses, on a floor: they are there to kill zombies, while the ordinary
 *  line whittles them down and only occasionally finishes one (owner, 2026-11-05). */
const ENDLESS_KILLER_KEYS: ReadonlySet<string> = new Set([
  "FarmStageActorBoss", "NinjaStageActorBoss", "VideoGameStageBossActor", "PirateStageActorBoss",
]);
export function isEndlessKiller(sourceKey: string): boolean {
  return ENDLESS_KILLER_KEYS.has(sourceKey);
}
/** A killer's damage and health on top of its shape: less health than the line, double the
 *  damage. */
export const ENDLESS_KILLER = { hp: 0.8, damage: 2 } as const;

/** Starting points for tuning, not a hard cap: difficulty continues to grow at every
 * wave. `damage` and `health` are applied after the entry threat floor and role band. */
// Per four-fight-equivalent section, enemy damage rises about 46% and health about 29%. The
// steps below are per "depth", which runs 4/3 of a depth per fight on the three-fight tier.
export const ENDLESS_DAMAGE_STEP = 0.095;
export const ENDLESS_HEALTH_STEP = 0.085;
const DEPTH_PER_FIGHT = 4 / 3;
/** Preserve Nightmare's existing steeper entry multiplier and per-wave rates. */
export const NIGHTMARE_DAMAGE_STEP = 0.075;
export const NIGHTMARE_HEALTH_STEP = 0.045;
/** T7 and later boss gates are 7x stronger after the regular wave stat ramp. */
export const ENDLESS_LATE_BOSS_MULTIPLIER = 7;
/** The late gate's health rises less than its hit: a 7x sponge just runs out the clock. */
export const ENDLESS_LATE_BOSS_HP_MULTIPLIER = 3;
export const ENDLESS_LATE_BOSS_START_WAVE = 7 * ENDLESS_FIGHTS_PER_LOCATION;
/** Keep the curve at each post-T7 section one tier behind the raw wave, so T8's stats are
 *  comparable to T7's. Location mechanics still follow their actual section. */
const ENDLESS_LATE_DEPTH_DELAY = 4;

/** Every Epic Boss's hit points on top of the ramp: he should last about as long as a floor. */
export const ENDLESS_BOSS_HP_SCALE = 14;
/** Dr. Groundhog's Endless moves, added a tier at a time so a boss gate keeps changing. */
export const ENDLESS_BOSS_SLAM_TIER = 2;
export const ENDLESS_BOSS_LAUNCH_TIER = 3;
export const ENDLESS_BOSS_SLAM_MULT = 4;
/** Each tap on a winding-up slam takes this much off it, down to half. */
export const ENDLESS_CHARGE_TAP_REDUCE = 0.1;

/** Level 30 starts at T1, then one tier later per 5 levels, up to T4 at level 45. */
export function endlessMaxStartTier(mode: EndlessMode, level: number): number {
  if (mode !== "endless") return 1;
  return Math.max(1, Math.min(4, 1 + Math.floor((level - ENDLESS_UNLOCK_LEVEL.endless) / 5)));
}
export function endlessStartWave(startTier: number): number {
  return (Math.max(1, Math.floor(startTier)) - 1) * ENDLESS_FIGHTS_PER_LOCATION + 1;
}

/** The Special a temporary-zombie boon lends for the run: one per week, from the bodies real
 *  endgame armies are built on, so it is worth having to everyone. */
export const ENDLESS_TEMPORARY_ZOMBIES: readonly { key: string; name: string }[] = [
  { key: "ZombieActorPoseidon", name: "Poseidon Zombie" },
  { key: "ZombieActorOmegaZombieBot", name: "Omega Zombie Bot" },
  { key: "ZombieActorMasterNinjombie", name: "Master Ninjombie" },
  { key: "ZombieActorZombug", name: "Zombug" },
  { key: "ZombieActorMadame", name: "Madame Zombie" },
  { key: "ZombieActorOmegaDrZombie", name: "Omega Dr. Zombie" },
];

/** The Count's slam, on the former bosses: this many seconds of the killer's damage, on the
 *  front zombie. Priced on damage per second rather than per hit, because killers keep their
 *  source attack speed (the Video Game boss pecks ten times a second). */
export const ENDLESS_SLAM_SECONDS = 6;
/** The Lumberjack's telegraphed chop, in hits. */
export const ENDLESS_CHOP_MULT = 2.5;

/** The zombie a mirroring pirate is measured against. Both pirates throw their own clock away
 *  and mirror the zombie they face (combatStats.mirrorIntervalSec), so their damage per
 *  second is defined against a 1 s cycle, an ordinary front-liner's: the Scallywag swings
 *  every 1.25 s there and the captain every 1.6 s. A slower zombie in front slows them and a
 *  faster one speeds them up, by the invasion's own curves (a Headless holds the captain to
 *  one blow every 6.5 s). */
export const ENDLESS_MIRROR_REFERENCE_SEC = 1;

/** Every enemy but the killers, on top of its shape. */
export const ENDLESS_LINE = { hp: 1.5, damage: 0.95 } as const;

/** Bodies on a normal and an advanced floor. They come out one at a time (owner, 2026-11-07):
 *  only Alien, built around a swarm, fields several at once. */
export const ENDLESS_FLOOR_ENEMIES: readonly [number, number] = [8, 12];

/** Former bosses on a floor: the place to tune how often a fight kills something. */
export function endlessKillerCount(tier: number, locationFight: number): number {
  if (locationFight === 1) return tier >= 9 ? 2 : tier >= 5 ? 1 : 0;
  return tier >= 9 ? 4 : tier >= 7 ? 3 : tier >= 5 ? 2 : tier >= 3 ? 1 : 0;
}

export function endlessBossMultiplier(mode: EndlessMode, wave: number): number {
  return mode === "endless" && wave >= ENDLESS_LATE_BOSS_START_WAVE
    ? ENDLESS_LATE_BOSS_MULTIPLIER
    : 1;
}
/** The Halloween clock model (owner, 2026-11-05): when the clock runs out the fight is not
 *  lost yet, it goes into Do or Die (BattleSim.armDoOrDie). An Alien section drips its twenty
 *  bodies in, so it gets more time. Measured through harness/report/endless.report.ts. */
export const ENDLESS_NORMAL_CLOCK_MS = 90_000;
export const ENDLESS_ADVANCED_CLOCK_MS = 120_000;
export const ENDLESS_BOSS_CLOCK_MS = 120_000;
export const ENDLESS_ALIEN_NORMAL_CLOCK_MS = 120_000;
export const ENDLESS_ALIEN_ADVANCED_CLOCK_MS = 150_000;
export const ENDLESS_NORMAL_DO_OR_DIE_MS = 30_000;
export const ENDLESS_LATE_DO_OR_DIE_MS = 60_000;

export function endlessClockMs(plan: Pick<EndlessWavePlan, "bossGate" | "location" | "locationFight" | "modifier">): number {
  const base = plan.bossGate ? ENDLESS_BOSS_CLOCK_MS
    : plan.location === "alien"
      ? plan.locationFight === 1 ? ENDLESS_ALIEN_NORMAL_CLOCK_MS : ENDLESS_ALIEN_ADVANCED_CLOCK_MS
      : plan.locationFight === 1 ? ENDLESS_NORMAL_CLOCK_MS : ENDLESS_ADVANCED_CLOCK_MS;
  const clock = plan.modifier ? ENDLESS_MODIFIERS[plan.modifier].clock ?? 1 : 1;
  return Math.round(base * clock);
}
export function endlessDoOrDieMs(plan: Pick<EndlessWavePlan, "locationFight">): number {
  return plan.locationFight === 1 ? ENDLESS_NORMAL_DO_OR_DIE_MS : ENDLESS_LATE_DO_OR_DIE_MS;
}
export const NIGHTMARE_ENTRY_DAMAGE = 1.4;
export const NIGHTMARE_ENTRY_HEALTH = 1.25;

export interface EndlessWavePlan {
  mode: EndlessMode;
  wave: number;
  section: number;
  /** 1-based tier: `section + 1`. */
  tier: number;
  location: EndlessLocation;
  modifier: EndlessModifierId | null;
  /** 1 normal, 2 advanced, 3 boss. Resets when terrain changes. */
  locationFight: number;
  bossGate: boolean;
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
  cadence: readonly [number, number, number];
}

export const ENDLESS_LOCATION_MECHANICS: Readonly<Record<EndlessLocation, LocationMechanics>> = {
  farm: { mechanics: [], cadence: [1, 1, 1] },
  ninja: { mechanics: ["carrot-wall", "smoke-bomb-teleport"], cadence: [1, 0.82, 0.66] },
  alien: { mechanics: ["laser", "summons"], cadence: [1, 0.82, 0.66] },
  "video-game": { mechanics: ["pixel-fire", "turn-zombie"], cadence: [1, 0.82, 0.66] },
  pirate: { mechanics: ["mirrored-attack-speed"], cadence: [1, 0.86, 0.72] },
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

/** The invasion a source enemy belongs to: the part of its key before "Stage". */
export function endlessInvasionOf(sourceKey: string): string {
  return /^(.+?)Stage/.exec(sourceKey)?.[1] ?? sourceKey;
}

/** Every enemy an Endless floor can field. */
export const ENDLESS_ENEMY_KEYS: readonly string[] = [...new Set([...ENEMY_BANDS.flat(), ...Object.values(LOCATION_POOLS).flat()])];

/** A source enemy's damage per second, in hit points. A mirroring pirate's is measured
 *  against the reference zombie, since its own clock never paces it. */
export function endlessSourceDps(unit: CombatUnit): number {
  const sec = unit.mirrorsOpponentSpeed
    ? mirrorIntervalSec(unit.sourceKey, ENDLESS_MIRROR_REFERENCE_SEC, ENDLESS_MIRROR_REFERENCE_SEC)
    : unit.attackCooldownMs / 1000;
  return countHitDamage(unit) / Math.max(0.05, sec);
}

const geomean = (xs: readonly number[]) => Math.exp(xs.reduce((t, x) => t + Math.log(x), 0) / xs.length);
const limitShape = (x: number) => Math.min(ENDLESS_SHAPE_LIMIT, Math.max(1 / ENDLESS_SHAPE_LIMIT, x));

/** Each enemy's shape against the baseline of its own invasion (owner, 2026-11-07).
 *
 *  An invasion's baseline is the geometric mean of its ordinary enemies' source damage per
 *  second and health, so a Ninja Boy is measured against the Ninja Girl and not against a
 *  Farmhand: invasions differ wildly in raw scale, and Endless brings each to the same entry
 *  floor while keeping who hits harder and who lasts longer within it. A killer is measured
 *  against its own invasion's crew too, and the four killers are then brought to a shared
 *  level, so ENDLESS_KILLER sets how dangerous killers are and the source sets how they differ. */
export function endlessPeerShapes(source: (key: string) => CombatUnit | undefined): Record<string, EndlessShape> {
  const stats = new Map<string, { dps: number; hp: number }>();
  for (const key of ENDLESS_ENEMY_KEYS) {
    const unit = source(key);
    if (unit) stats.set(key, { dps: endlessSourceDps(unit), hp: Math.max(1, unit.maxHp) });
  }
  const baseline = new Map<string, { dps: number; hp: number }>();
  for (const invasion of new Set([...stats.keys()].map(endlessInvasionOf))) {
    const crew = [...stats].filter(([key]) => endlessInvasionOf(key) === invasion && !isEndlessKiller(key)).map(([, s]) => s);
    if (crew.length) baseline.set(invasion, { dps: geomean(crew.map((s) => s.dps)), hp: geomean(crew.map((s) => s.hp)) });
  }
  const raw = new Map<string, EndlessShape>();
  for (const [key, s] of stats) {
    const base = baseline.get(endlessInvasionOf(key)) ?? s;
    raw.set(key, { damage: s.dps / base.dps, hp: s.hp / base.hp });
  }
  const killers = [...raw].filter(([key]) => isEndlessKiller(key)).map(([, s]) => s);
  const killerLevel = killers.length
    ? { damage: geomean(killers.map((s) => s.damage)), hp: geomean(killers.map((s) => s.hp)) }
    : { damage: 1, hp: 1 };
  const out: Record<string, EndlessShape> = {};
  for (const [key, s] of raw) {
    const level = isEndlessKiller(key) ? killerLevel : { damage: 1, hp: 1 };
    out[key] = { damage: limitShape(s.damage / level.damage), hp: limitShape(s.hp / level.hp) };
  }
  return out;
}

/** Scale a source enemy for an Endless floor: the entry rating times its shape against its
 *  own invasion, the line or killer profile, and the depth ramp. Damage and health are what
 *  scale; attack speed is the source's own, so a hit is sized from the damage per second and
 *  the swing it lands on. `shapes` comes from endlessPeerShapes (endlessFight builds it). */
export function scaleEndlessEnemy(
  unit: CombatUnit, plan: EndlessWavePlan, curses: readonly EndlessCurse[] = [],
  shapes: Readonly<Record<string, EndlessShape>> = {},
): CombatUnit {
  const killer = isEndlessKiller(unit.sourceKey);
  const shape = shapes[unit.sourceKey] ?? { damage: 1, hp: 1 };
  const profile = killer ? ENDLESS_KILLER : ENDLESS_LINE;
  const result = { ...unit, attacks: unit.attacks.map((attack) => ({ ...attack })) };
  const damage = ENDLESS_ENTRY_THREAT_RATING * shape.damage * profile.damage * plan.damageScale;
  const health = ENDLESS_ENTRY_THREAT_RATING * shape.hp * profile.hp * plan.healthScale;
  // The swing the damage lands on: the source clock, or for a mirroring pirate the
  // reference zombie's mirrored interval.
  const hitSec = unit.mirrorsOpponentSpeed
    ? mirrorIntervalSec(unit.sourceKey, ENDLESS_MIRROR_REFERENCE_SEC, ENDLESS_MIRROR_REFERENCE_SEC)
    : unit.attackCooldownMs / 1000;
  const mult = Math.max(0.1, unit.attacks[0]?.mult ?? 1);
  result.str = damage * hitSec / mult;
  result.con = health;
  result.maxHp = Math.max(1, Math.round(health * 100));
  result.hp = result.maxHp;
  const final = applyEndlessEnemyCurses(applyEndlessModifier(result, plan.modifier), curses);
  // Priced last: seconds of the killer's base damage, then grown with its HIT as modifiers and
  // curses left it (Heavy Hitters' slower, 2.5x hits make a 2.5x slam). The pirate captain
  // carries none: his mirrored blow IS his killing move, and a second clock breaks its tempo.
  if (killer && !unit.mirrorsOpponentSpeed) {
    const baseHit = countHitDamage(result);
    const dps = baseHit / (result.attackCooldownMs / 1000);
    final.charge = {
      windupMs: COUNT_SLAM_WINDUP_MS, recoveryMs: COUNT_SLAM_RECOVERY_MS,
      damage: Math.round(ENDLESS_SLAM_SECONDS * dps * countHitDamage(final) / Math.max(1e-9, baseHit)),
      poiseThreshold: POISE_THRESHOLD, poiseDrainPerSec: 0, staggerMs: STAGGER_MS, target: "front-deployed",
    };
  } else if (unit.sourceKey === "FarmStageActorLumberjack") {
    final.charge = {
      windupMs: 2_400, recoveryMs: 5_200, damage: Math.round(ENDLESS_CHOP_MULT * countHitDamage(final)),
      poiseThreshold: POISE_THRESHOLD, poiseDrainPerSec: 0, staggerMs: 800, target: "front-deployed",
    };
  }
  return final;
}

/** What a tier's modifier does to one enemy, Epic Boss included. */
export function applyEndlessModifier(unit: CombatUnit, modifier: EndlessModifierId | null): CombatUnit {
  if (!modifier) return unit;
  const m = ENDLESS_MODIFIERS[modifier];
  const result = { ...unit, attacks: unit.attacks.map((attack) => ({ ...attack })) };
  if (m.hp) {
    result.maxHp = Math.max(1, Math.round(result.maxHp * m.hp));
    result.hp = result.maxHp;
    result.con *= m.hp;
  }
  if (m.damage) result.str *= m.damage;
  if (m.dex) {
    result.dex *= m.dex;
    result.attackCooldownMs = Math.max(1, Math.round(result.attackCooldownMs / m.dex));
    if (result.mirrorsOpponentSpeed) result.mirrorPace = (result.mirrorPace ?? 1) / m.dex;
  }
  if (m.stunResist) result.stunResist = Math.max(result.stunResist ?? 0, m.stunResist);
  return result;
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
      if (result.mirrorsOpponentSpeed) result.mirrorPace = (result.mirrorPace ?? 1) / (1 + curse.percent / 100);
    } else if (curse.kind === "enemy-stun-resist") {
      result.stunResist = 1 - (1 - (result.stunResist ?? 0)) * (1 - curse.percent / 100);
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

function waveEnemies(plan: Pick<EndlessWavePlan, "wave" | "tier" | "location" | "locationFight" | "modifier">, weekSeed: string): string[] {
  const { wave, tier, location, locationFight, modifier } = plan;
  // Alien keeps the normal invasion's deployment count and timing, whatever the modifier.
  if (location === "alien") return Array.from({ length: 20 }, () => "AlienStageActorMinion");
  const count = ENDLESS_FLOOR_ENEMIES[locationFight - 1] + (modifier ? ENDLESS_MODIFIERS[modifier].extraEnemies ?? 0 : 0);
  // Local progression keeps each section moving from common foes to its strongest
  // regular mix. Global progression raises the starting tier on later sections.
  const enemyTier = Math.min(ENEMY_BANDS.length, tier + locationFight - 1);
  const allowed = new Set(ENEMY_BANDS.slice(0, enemyTier).flat());
  const isKiller = isEndlessKiller;
  const local = LOCATION_POOLS[location].filter((key) => allowed.has(key) && !isKiller(key));
  const pool = local.length ? local : [...allowed].filter((key) => !isKiller(key));
  const random = seededRandom(`endless-roster:${weekSeed}:${wave}:${location}:${modifier ?? ""}`);
  // Scallywags mirror zombie attack speed. Their trait is always present in Pirate
  // sections; local escalation raises how often the army must manage it.
  const weightedPool = location === "pirate"
    ? pool.flatMap((key) => key === "PirateStageActorScallywag"
      ? Array.from({ length: locationFight }, () => key)
      : [key])
    : pool;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(weightedPool[Math.floor(random() * weightedPool.length)]);
  }
  // A durable frontliner with a fragile striker behind it opens the later advanced floors.
  if (tier >= 4 && locationFight === 2) {
    const pair: Partial<Record<EndlessLocation, readonly [string, string]>> = {
      farm: ["RobotStageActorJunkBot", "BeachStageActorMinion2"],
      ninja: ["RobotStageActorJunkBot", "NinjaStageActorBoy"],
      "video-game": ["VideoGameStageKnightActor", "VideoGameStageGhostActor"],
      pirate: ["PirateStageActorSwashbuckler", "BeachStageActorMinion2"],
    };
    const [tank, striker] = pair[location] ?? [];
    if (tank && striker) [out[0], out[1]] = [tank, striker];
  }
  // Former bosses stand late in the queue, so the line has whittled the army down first.
  // `buildUnitsForKeys` receives them in enemyKeys, not bossKey, so they lose their perched
  // role and boss action scheduler for these appearances.
  const killers = endlessKillerCount(tier, locationFight);
  const killer = LOCATION_POOLS[location].find(isKiller);
  if (killer) {
    for (let i = 0; i < killers; i++) out[out.length - 1 - i * 3] = killer;
  }
  return out;
}

/** Build the pure, reproducible plan for one fight in an Endless run. */
export function endlessWavePlan(
  mode: EndlessMode,
  waveInput: number,
  stop: EndlessStop = ENDLESS_FIRST_STOP,
  weekSeed = "0",
): EndlessWavePlan {
  const wave = Math.max(1, Math.floor(Number.isFinite(waveInput) ? waveInput : 1));
  const depth = (wave - 1) * DEPTH_PER_FIGHT
    - (mode === "endless" && wave > ENDLESS_LATE_BOSS_START_WAVE ? ENDLESS_LATE_DEPTH_DELAY : 0);
  const section = Math.floor((wave - 1) / ENDLESS_FIGHTS_PER_LOCATION);
  const tier = section + 1;
  const locationFight = ((wave - 1) % ENDLESS_FIGHTS_PER_LOCATION) + 1;
  const { location } = stop;
  const bossGate = locationFight === ENDLESS_FIGHTS_PER_LOCATION;
  // A location's modifier shapes its floors. The Epic Boss is the same fight wherever he is.
  const modifier = bossGate ? null : stop.modifier;
  const baseDamage = mode === "nightmare" ? NIGHTMARE_ENTRY_DAMAGE : 1;
  const baseHealth = mode === "nightmare" ? NIGHTMARE_ENTRY_HEALTH : 1;
  const damageStep = mode === "nightmare" ? NIGHTMARE_DAMAGE_STEP : ENDLESS_DAMAGE_STEP;
  const healthStep = mode === "nightmare" ? NIGHTMARE_HEALTH_STEP : ENDLESS_HEALTH_STEP;
  const mechanics = ENDLESS_LOCATION_MECHANICS[location];
  // After tier four, compress raw stat growth so paired enemies and role contrast supply
  // the challenge instead of an increasingly steep stat wall.
  const fastDepth = Math.min(depth, 15);
  const slowDepth = Math.max(0, depth - 15);
  const damageScale = baseDamage * (1 + damageStep) ** fastDepth
    * (mode === "nightmare" ? 1.035 : 1.05) ** slowDepth;
  const healthScale = baseHealth * (1 + healthStep) ** fastDepth
    * (mode === "nightmare" ? 1.025 : 1.07) ** slowDepth;
  const mechanicCooldownScale = mechanics.cadence[locationFight - 1];
  const mechanicCooldownsMs = Object.fromEntries(
    Object.entries(ENDLESS_MECHANIC_BASE_COOLDOWNS_MS[location] ?? {})
      .map(([key, cooldown]) => [key, Math.max(1_000, Math.round(cooldown * mechanicCooldownScale))]),
  );
  return {
    mode, wave, section, tier, location, modifier, locationFight, bossGate,
    enemyTier: Math.min(ENEMY_BANDS.length, tier + locationFight - 1),
    enemyKeys: bossGate ? [] : waveEnemies({ wave, tier, location, locationFight, modifier }, weekSeed),
    damageScale, healthScale, mechanicCooldownScale, mechanicCooldownsMs,
    bossId: bossGate ? (mode === "nightmare" ? "galactic-groundhog" : "dr-groundhog") : null,
  };
}

/** A run-local army. Endless damage never touches the account's owned zombies: this
 *  snapshot is created after entry is paid and discarded when the run ends. */
export interface EndlessRunState {
  mode: EndlessMode;
  nextWave: number;
  units: CombatUnit[];
  /** The week the run started in. It keeps that week's rosters and options to its end. */
  weekSeed: string;
  /** The tier being fought: chosen after each boss. */
  stop: EndlessStop;
  /** First wave actually fought. Above 1, the early tiers were skipped at the start. */
  startWave: number;
  /** Build-changing boons taken. They can stack, and read the army's current order. */
  buildBoons: EndlessBuildBoon[];
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

export type EndlessBuildBoon = "vanguard" | "rearguard" | "headless-wall" | "garden-focus";
export type EndlessBoon =
  | { kind: EndlessBuildBoon }
  | { kind: "temporary-zombie"; key: string; name: string }
  | { kind: "revive-headless" }
  | { kind: "damage"; percent: number }
  | { kind: "deployment"; percent: number }
  | { kind: "opening-deploy"; count: number };

export type EndlessCurse =
  | { kind: "enemy-health"; percent: number }
  | { kind: "enemy-damage"; percent: number }
  | { kind: "enemy-attack-speed"; percent: number }
  | { kind: "enemy-stun"; chance: number; durationMs: number }
  | { kind: "enemy-stun-resist"; percent: number }
  | { kind: "headless-stat"; stat: "str" | "dex" | "con"; percent: number }
  | { kind: "enemy-explosion"; chance: number; damagePercent: number }
  | { kind: "enemy-knockback-headless"; chance: number };

const BOON_POOL: readonly EndlessBoon[] = [
  { kind: "damage", percent: 20 },
  { kind: "deployment", percent: 20 }, { kind: "opening-deploy", count: 3 },
  { kind: "revive-headless" }, { kind: "vanguard" }, { kind: "rearguard" },
  { kind: "headless-wall" }, { kind: "garden-focus" },
];
const CURSE_POOL: readonly EndlessCurse[] = [
  { kind: "enemy-health", percent: 20 }, { kind: "enemy-damage", percent: 20 },
  { kind: "enemy-attack-speed", percent: 20 },
  { kind: "enemy-stun", chance: 0.15, durationMs: 900 },
  { kind: "enemy-stun-resist", percent: 30 },
  { kind: "headless-stat", stat: "str", percent: 20 },
  { kind: "enemy-explosion", chance: 0.2, damagePercent: 20 },
  { kind: "enemy-knockback-headless", chance: 0.25 },
];

function seededShuffle<T>(pool: readonly T[], label: string): T[] {
  const random = seededRandom(label);
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/** Where the run can go next: two other locations, each with its own modifier. Alien's
 *  deployment count and timing stay as authored, so its slow drip of twenty bodies never gets
 *  Crowded or Short Clock. */
export function endlessLocationOptions(mode: EndlessMode, bossWave: number, weekSeed: string, current: EndlessLocation): EndlessStop[] {
  const label = `endless-route:${weekSeed}:${mode}:${bossWave}`;
  const locations = seededShuffle(ENDLESS_LOCATIONS.filter((location) => location !== current), `${label}:locations`).slice(0, 2);
  const modifiers = seededShuffle(ENDLESS_MODIFIER_IDS, `${label}:modifiers`);
  return locations.map((location) => {
    const index = modifiers.findIndex((id) => location !== "alien" || (id !== "crowded" && id !== "short-clock"));
    const [modifier] = modifiers.splice(index, 1);
    return { location, modifier };
  });
}

export interface EndlessBossDraft {
  boons: EndlessBoon[];
  curses: EndlessCurse[];
  locations: EndlessStop[];
}

/** Boss reward draft: three unique boons, three unique curses and the routes onward. The same
 *  for everyone in a week, given the same location. */
export function endlessBossDraft(
  mode: EndlessMode,
  bossWave: number,
  weekSeed = "0",
  current: EndlessLocation = ENDLESS_FIRST_LOCATION,
  withLocations = true,
): EndlessBossDraft {
  const label = `endless-draft:${weekSeed}:${mode}:${bossWave}`;
  const select = <T>(pool: readonly T[], name: string): T[] =>
    seededShuffle(pool, `${label}:${name}`).slice(0, 3).map((item) => ({ ...item }));
  const lent = ENDLESS_TEMPORARY_ZOMBIES[Math.floor(seededRandom(`${label}:temporary`)() * ENDLESS_TEMPORARY_ZOMBIES.length)];
  const boons: EndlessBoon[] = [...BOON_POOL, { kind: "temporary-zombie", key: lent.key, name: lent.name }];
  return {
    boons: select(boons, "boons"), curses: select(CURSE_POOL, "curses"),
    locations: withLocations ? endlessLocationOptions(mode, bossWave, weekSeed, current) : [],
  };
}

/** Begin with a fresh battle copy; account-owned army records remain untouched. */
export function beginEndlessRun(mode: EndlessMode, party: readonly CombatUnit[], weekSeed = "0", startTier = 1): EndlessRunState {
  const startWave = endlessStartWave(startTier);
  return {
    mode, nextWave: startWave, startWave, buildBoons: [], weekSeed, stop: { ...ENDLESS_FIRST_STOP },
    units: party.map((u) => ({ ...u, attacks: u.attacks.map((a) => ({ ...a })), hp: u.maxHp, alive: true })),
    damageBonus: 0, deploymentSpeedBonus: 0, openingDeploy: 0, reviveHeadless: false, curses: [],
  };
}

export function applyEndlessCurse(run: EndlessRunState, curse: EndlessCurse): EndlessRunState {
  return { ...run, curses: [...run.curses, { ...curse }] };
}

/** Reorder the run's army. Null unless `ids` is exactly the zombies brought on this run. */
export function applyEndlessOrder(run: EndlessRunState, ids: unknown): EndlessRunState | null {
  if (!Array.isArray(ids) || ids.length !== run.units.length || new Set(ids).size !== ids.length) return null;
  const byId = new Map(run.units.map((u) => [u.id, u]));
  if (ids.some((id) => !byId.has(id as string))) return null;
  return { ...run, units: ids.map((id) => byId.get(id as string)!) };
}

export function applyEndlessStop(run: EndlessRunState, stop: EndlessStop): EndlessRunState {
  return { ...run, stop: { ...stop } };
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

/** The section gate is the recovery checkpoint: everyone comes back at full health (owner,
 *  2026-11-05), so casualties only weigh on the rest of their own section. Between ordinary
 *  fights, surviving HP and casualties persist. */
export function finishEndlessFight(
  run: EndlessRunState,
  battleUnits: readonly CombatUnit[],
): EndlessRunState {
  const carried = carryEndlessArmy(run, battleUnits);
  const completedWave = run.nextWave;
  const bossGate = completedWave % ENDLESS_FIGHTS_PER_LOCATION === 0;
  return {
    ...carried,
    nextWave: completedWave + 1,
    units: bossGate
      ? carried.units.map((u) => ({ ...u, alive: true, hp: u.maxHp }))
      : carried.units.map((u) => run.reviveHeadless && u.isHeadless && !u.alive
        ? { ...u, alive: true, hp: u.maxHp }
        : u),
  };
}

/** Boons appear after each cleared Epic Boss gate. */
export function applyEndlessBoon(run: EndlessRunState, boon: EndlessBoon): EndlessRunState {
  switch (boon.kind) {
    case "revive-headless":
      return { ...run, reviveHeadless: true };
    case "vanguard": case "rearguard": case "headless-wall": case "garden-focus":
      return { ...run, buildBoons: [...run.buildBoons, boon.kind] };
    case "temporary-zombie":
      return run; // The unit needs the catalog: see endlessFight's endlessApplyBoon.
    case "damage":
      return { ...run, damageBonus: run.damageBonus + Math.max(0, boon.percent) / 100 };
    case "deployment":
      return { ...run, deploymentSpeedBonus: Math.min(0.8, run.deploymentSpeedBonus + Math.max(0, boon.percent) / 100) };
    case "opening-deploy":
      return { ...run, openingDeploy: Math.min(3, run.openingDeploy + Math.max(0, Math.floor(boon.count))) };
  }
}

/** What the build boons do to one body, given its place in the army's order. */
function buildBoonScale(run: EndlessRunState, unit: CombatUnit, index: number): { hp: number; damage: number } {
  let hp = 1;
  let damage = 1;
  for (const boon of run.buildBoons) {
    if (boon === "vanguard") hp *= index < 3 ? 1.5 : 0.9;
    else if (boon === "rearguard") damage *= index >= run.units.length - 5 ? 1.4 : 0.9;
    else if (boon === "headless-wall") { if (unit.isHeadless) hp *= 1.4; else damage *= 0.9; }
    else if (boon === "garden-focus") { if (unit.isGarden) hp *= 1.6; else damage *= 0.95; }
  }
  return { hp, damage };
}

/** Apply run damage and build boons to a battle copy of the living party. */
export function endlessPlayerUnits(run: EndlessRunState): CombatUnit[] {
  return run.units.flatMap((u, index) => {
    if (!u.alive || u.hp <= 0) return [];
    const scale = buildBoonScale(run, u, index);
    const unit = { ...u, attacks: u.attacks.map((a) => ({ ...a, mult: (a.mult ?? 1) * (1 + run.damageBonus) * scale.damage })) };
    if (scale.hp !== 1) {
      const fraction = unit.maxHp > 0 ? unit.hp / unit.maxHp : 1;
      unit.maxHp = Math.max(1, Math.round(unit.maxHp * scale.hp));
      unit.hp = Math.max(1, Math.round(unit.maxHp * fraction));
      unit.con *= scale.hp;
    }
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
    return [unit];
  });
}

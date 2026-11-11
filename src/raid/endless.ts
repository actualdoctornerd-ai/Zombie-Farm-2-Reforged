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
import type { BossThrowConfig, CombatUnit } from "./types";

export type EndlessMode = "endless" | "nightmare";
export type EndlessLocation = "farm" | "ninja" | "alien" | "video-game" | "pirate";

export const ENDLESS_ENTRY_COST: Readonly<Record<EndlessMode, number>> = {
  endless: 1,
  nightmare: 3,
};
/** One free normal Endless run a day (owner, 2026-11-08): the first run an account starts
 *  after midnight UTC costs nothing. Started is what counts, so a run ended early or lost
 *  on its first floor still uses the day's free one. */
const DAY_MS = 86_400_000;
export function endlessFreeDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/** Nightmare is held for a later release (owner, 2026-11-08): its loot tables are not
 *  written. Off, no new Nightmare run can start and the client shows no Nightmare button or
 *  board; a run already under way still finishes. The fights, milestones and Medusa stay in
 *  the code, so turning it on is this flag plus the loot. */
export const ENDLESS_NIGHTMARE_LIVE = false;

/** The modes a player can start a run in today. */
export function endlessModeOpen(mode: EndlessMode): boolean {
  return mode === "endless" || ENDLESS_NIGHTMARE_LIVE;
}

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

/** Invasion bosses. On a floor they are either the location's own boss, perched on floor 2
 *  (ENDLESS_PERCHED_BOSS), or a WALK-IN: a boss from an associated invasion fighting in the
 *  line as a strong ordinary enemy (owner, 2026-11-10). Their shapes are measured against
 *  each other, not against a crew. */
const ENDLESS_KILLER_KEYS: ReadonlySet<string> = new Set([
  "FarmStageActorBoss", "CityStageActorBoss", "PirateStageActorBoss", "NinjaStageActorBoss",
  "AlienStageActorBoss", "BeachStageActorBoss", "CircusStageActorBoss", "VideoGameStageBossActor",
  "TreeWorldStageBossActor", "ValentinesDayStageActorBoss", "HalloweenStageActorBoss",
]);
export function isEndlessKiller(sourceKey: string): boolean {
  return ENDLESS_KILLER_KEYS.has(sourceKey);
}
/** The perched floor-2 boss on top of his shape: double a line enemy's damage, more health,
 *  and a slam (scaleEndlessEnemy). */
export const ENDLESS_KILLER = { hp: 2.3, damage: 2 } as const;
/** A walk-in boss: weaker than a perched boss, stronger than the line, and no slam. */
export const ENDLESS_WALK_IN = { hp: 1.4, damage: 1.4 } as const;

/** Bosses from each location's associated invasions (the dual invasions' pairs; the Farm also
 *  gets the alien boss). They walk in late in the line. Alien Landing's are beamed down by
 *  the saucer instead: any boss but its own and Zedzox. */
export const ENDLESS_WALK_IN_POOL: Readonly<Record<EndlessLocation, readonly string[]>> = {
  farm: ["CityStageActorBoss", "AlienStageActorBoss"],
  ninja: ["PirateStageActorBoss"],
  pirate: ["NinjaStageActorBoss"],
  "video-game": ["CircusStageActorBoss"],
  alien: [
    "FarmStageActorBoss", "CityStageActorBoss", "PirateStageActorBoss", "NinjaStageActorBoss",
    "BeachStageActorBoss", "CircusStageActorBoss", "TreeWorldStageBossActor",
    "ValentinesDayStageActorBoss", "HalloweenStageActorBoss",
  ],
};
/** Seconds into an Alien Landing floor before the saucer beams down its first walk-in boss,
 *  then between beams. */
export const ENDLESS_BEAM_WALK_IN_MS = 30_000;
/** Alien Landing's walk-ins begin at T7 on both of its floors. */
export const ENDLESS_ALIEN_WALK_IN_TIER = 7;

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
/** Dr. Groundhog climbs smoothly (owner, 2026-11-08: no cliff). This replaced a 7x hit and 3x
 *  health jump at the T7 boss, which also held every later tier's stats one tier back.
 *
 *  Health: ENDLESS_BOSS_HP_AT_T1 to ENDLESS_BOSS_HP_AT_T7 in equal steps (x1.71 a tier), then
 *  the ordinary health ramp from there.
 *  Damage: the ordinary damage ramp, times ENDLESS_BOSS_DAMAGE at every tier.
 *
 *  Harder hits, less health (owner, 2026-11-10): his fights run 20-55 s instead of 33-80 s and
 *  cost about one zombie through the middle tiers, at the same overall depth (real prod
 *  armies, expert pilot, 3 weeks: L45 clears T7 57%, T8 54%; before, 54% and 53%). Measured
 *  through harness/report/endless.report.ts. */
export const ENDLESS_BOSS_HP_AT_T1 = 15_000;
export const ENDLESS_BOSS_HP_AT_T7 = 375_000;
/** Past the T7 boss the ramp flattens (owner, 2026-11-08): a tier asks for about a 25% stronger
 *  army (1.11x damage and 1.13x health a tier) instead of about 60%, so a clearly better army
 *  goes clearly deeper. Rates are per depth; a tier is 4 depth. */
export const ENDLESS_LATE_RAMP_FROM_WAVE = 7 * ENDLESS_FIGHTS_PER_LOCATION;
export const ENDLESS_LATE_DAMAGE_PER_TIER = 1.11;
export const ENDLESS_LATE_HEALTH_PER_TIER = 1.13;
/** Dr. Groundhog's hit over the ordinary damage ramp (owner, 2026-11-10: he was hitting
 *  softer than the floors before him). At x5 his damage per second is about 1.2-1.7x a line
 *  enemy's at every tier. It used to climb from x1 at T1 to x3 at T7, which left him at a
 *  quarter of a floor enemy's damage at T1 and two thirds of it from T7. x6.7 cost a tier of
 *  depth even with his health cut. */
export const ENDLESS_BOSS_DAMAGE = 5;
export const ENDLESS_BOSS_CURVE_TIER = 7;

/** Every Epic Boss's hit points on top of the ramp: he should last about as long as a floor. */
export const ENDLESS_BOSS_HP_SCALE = 14;
/** Dr. Groundhog's Endless moves, added a tier at a time so a boss gate keeps changing. */
export const ENDLESS_BOSS_SLAM_TIER = 2;
/** The launch is his from the first meeting (owner, 2026-11-10: "he is supposed to launch
 *  zombies"); it used to wait for T3, so a player who wiped before then never saw a move. It
 *  throws the front ENDLESS_BOSS_LAUNCH_TARGETS zombies through the air to the back, each
 *  taking ENDLESS_BOSS_LAUNCH_HIT of his hits. */
export const ENDLESS_BOSS_LAUNCH_TIER = 1;
export const ENDLESS_BOSS_LAUNCH_TARGETS = 4;
export const ENDLESS_BOSS_LAUNCH_HIT = 0.5;
export const ENDLESS_BOSS_LAUNCH_COOLDOWN_MS = 15_000;
export const ENDLESS_BOSS_SLAM_MULT = 1.5;
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
export const ENDLESS_LINE = { hp: 1.75, damage: 0.95 } as const;
/** Alien Landing's swarm (owner, 2026-11-08): twenty minions, up to six on the field at once,
 *  each sized like a solo enemy made it the run-ender everywhere. Its FLOORS' enemies carry
 *  half base stats (measured through harness/report/endless.report.ts). Its boss is Dr.
 *  Groundhog alone, built by epicBossUnit, and is never scaled down. */
export const ENDLESS_ALIEN_SWARM = { hp: 0.5, damage: 0.4 } as const;
/** How many of the swarm are out at once (its own invasion fields six). Owner, 2026-11-10:
 *  Alien Landing ended about 20% of visits at L45, double the other locations. Its laser
 *  (a flat 200) and beam-ins barely mattered when switched off; the swarm's combined damage
 *  did. Four at a time and 0.4 damage brought it to about 13% at L45, 20% at L35. */
export const ENDLESS_ALIEN_MAX_ACTIVE = 4;
/** Per-location strength on its floors (not Dr. Groundhog), for evening the locations out.
 *  Video Game's floors ended almost no runs (owner, 2026-11-10). */
export const ENDLESS_LOCATION_STRENGTH: Readonly<Partial<Record<EndlessLocation, { hp: number; damage: number }>>> = {
  "video-game": { hp: 1, damage: 1.25 },
};

/** Bodies on a normal and an advanced floor. They come out one at a time (owner, 2026-11-07):
 *  only Alien, built around a swarm, fields several at once. */
export const ENDLESS_FLOOR_ENEMIES: readonly [number, number] = [8, 12];
/** Extra bodies by location, on floors 1 and 2. None today: the Farm was tried with 4 / 6
 *  more (2026-11-10) and taken out, since from T2 on it is already among the hardest. */
export const ENDLESS_LOCATION_EXTRA_ENEMIES: Readonly<Partial<Record<EndlessLocation, readonly [number, number]>>> = {};

/** Walk-in bosses on a floor (owner, 2026-11-10): floor 1 is just enemies until the sixth
 *  location, floor 2 has its perched boss plus walk-ins from T5. */
export function endlessKillerCount(tier: number, locationFight: number): number {
  if (locationFight === 1) return tier >= 9 ? 2 : tier >= 6 ? 1 : 0;
  return tier >= 9 ? 3 : tier >= 7 ? 2 : tier >= 5 ? 1 : 0;
}

/** The extra on Dr. Groundhog's hit over the ordinary damage ramp: ENDLESS_BOSS_DAMAGE at
 *  every boss gate, so the ramp alone carries him tier to tier. Nightmare keeps its own. */
export function endlessBossMultiplier(mode: EndlessMode, wave: number): number {
  void wave;
  return mode === "endless" ? ENDLESS_BOSS_DAMAGE : 1;
}

/** Dr. Groundhog's health at a boss gate. `t1Hp` is his T1 health (base x scale x T1's ramp);
 *  `healthScale` this gate's ordinary ramp, `t7Scale` the T7 gate's. */
export function endlessBossHp(mode: EndlessMode, wave: number, t1Hp: number, healthScale: number, t7Scale: number): number {
  const tier = Math.ceil(Math.max(1, wave) / ENDLESS_FIGHTS_PER_LOCATION);
  if (mode !== "endless") return t1Hp;
  const steps = (ENDLESS_BOSS_CURVE_TIER - 1);
  const start = ENDLESS_BOSS_HP_AT_T1;
  if (tier <= ENDLESS_BOSS_CURVE_TIER) return start * (ENDLESS_BOSS_HP_AT_T7 / start) ** ((tier - 1) / steps);
  return ENDLESS_BOSS_HP_AT_T7 * healthScale / t7Scale;
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
  /** The location's own invasion boss, perched at the back of an ordinary floor and throwing
   *  as in his invasion, then coming down to fight last: floor 2 only. Null at Alien Landing,
   *  whose saucer acts through its laser and beam-ins (ENDLESS_LOCATION_MECHANICS). */
  bossKey: string | null;
  /** Alien Landing's walk-in bosses, beamed down by the saucer one at a time. */
  beamedWalkIns: readonly string[];
}

/** The location mechanics that are a boss's own moves: floor 2 only. */
/** Pixel fire is Video Game's location trait (owner, 2026-11-10: the location needed teeth on
 *  floor 1 too), the way the smoke bomb is the Dojo's; turning zombies stays Zedzox's own. */
export const ENDLESS_BOSS_MOVES: ReadonlySet<string> = new Set(["carrot-wall", "laser", "summons", "turn-zombie"]);

/** Each location's own invasion boss (owner, 2026-11-10: ordinary floors keep their bosses as
 *  in the invasions, projectiles and all). */
export const ENDLESS_PERCHED_BOSS: Readonly<Partial<Record<EndlessLocation, string>>> = {
  farm: "FarmStageActorBoss",
  ninja: "NinjaStageActorBoss",
  "video-game": "VideoGameStageBossActor",
  pirate: "PirateStageActorBoss",
};

/** A perched boss's throws, as a share of a line enemy's damage per second: they chip at the
 *  army all floor long, but the line is still what kills. */
export const ENDLESS_THROW_SHARE = 0.5;

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
export const ENDLESS_ENEMY_KEYS: readonly string[] = [...new Set([...ENEMY_BANDS.flat(), ...Object.values(LOCATION_POOLS).flat(), ...Object.values(ENDLESS_WALK_IN_POOL).flat()])];

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
  const perched = killer && unit.isBoss;
  const shape = shapes[unit.sourceKey] ?? { damage: 1, hp: 1 };
  const profile = perched ? ENDLESS_KILLER : killer ? ENDLESS_WALK_IN : ENDLESS_LINE;
  const swarm = plan.location === "alien" && !plan.bossGate ? ENDLESS_ALIEN_SWARM
    : !plan.bossGate ? ENDLESS_LOCATION_STRENGTH[plan.location] ?? { hp: 1, damage: 1 } : { hp: 1, damage: 1 };
  const result = { ...unit, attacks: unit.attacks.map((attack) => ({ ...attack })) };
  const damage = ENDLESS_ENTRY_THREAT_RATING * shape.damage * profile.damage * swarm.damage * plan.damageScale;
  const health = ENDLESS_ENTRY_THREAT_RATING * shape.hp * profile.hp * swarm.hp * plan.healthScale;
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
  const final = applyEndlessDepthStunResist(
    applyEndlessEnemyCurses(applyEndlessModifier(result, plan.modifier), curses), plan.tier);
  // The perched boss's slam, priced last: seconds of his base damage, then grown with his HIT
  // as modifiers and curses left it (Heavy Hitters' slower, 2.5x hits make a 2.5x slam). The
  // pirate captain carries none: his mirrored blow IS his killing move, and a second clock
  // breaks its tempo. Walk-ins carry none: they are strong ordinary enemies.
  if (perched && !unit.mirrorsOpponentSpeed) {
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

/** A perched boss's throws on this floor: the invasion's own projectiles and their relative
 *  sizes, resized so that on average they deal ENDLESS_THROW_SHARE of a line enemy's damage
 *  per second, then the modifier's and curses' damage on top. */
export function scaleEndlessThrow(
  thrown: BossThrowConfig, plan: EndlessWavePlan, curses: readonly EndlessCurse[] = [],
): BossThrowConfig {
  const weight = thrown.options.reduce((sum, o) => sum + o.weight, 0);
  const average = thrown.options.reduce((sum, o) => sum + o.weight * o.damage, 0) / Math.max(1e-9, weight);
  const swarm = plan.location === "alien" ? ENDLESS_ALIEN_SWARM.damage : 1;
  const lineDps = ENDLESS_ENTRY_THREAT_RATING * ENDLESS_LINE.damage * swarm * plan.damageScale;
  // A modifier's damage per second (Heavy Hitters' 2.5x hits come half as often).
  const mod = plan.modifier ? ENDLESS_MODIFIERS[plan.modifier] : null;
  let extra = (mod?.damage ?? 1) * (mod?.dex ?? 1);
  for (const curse of curses) if (curse.kind === "enemy-damage") extra *= 1 + curse.percent / 100;
  const scale = ENDLESS_THROW_SHARE * lineDps * (thrown.intervalMs / 1000) * extra / Math.max(1e-9, average);
  return { ...thrown, options: thrown.options.map((o) => ({ ...o, damage: Math.max(1, Math.round(o.damage * scale)) })) };
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

/** Endless enemies shrug off more of every stun the deeper the run goes (owner, 2026-11-11,
 *  ruleset 85): 1% shorter per tier, no cap ("if people are making it to 25, they deserve that
 *  debuff"). It stacks multiplicatively with the stun-resist curse and the modifiers. Paired
 *  with the paused swing clock (BattleSim, `endlessMechanics`), a stun army stays strong deep
 *  but can no longer lock an enemy out of attacking for a whole fight. */
export const ENDLESS_STUN_RESIST_PER_TIER = 0.01;
export function applyEndlessDepthStunResist(unit: CombatUnit, tier: number): CombatUnit {
  const depth = Math.min(1, Math.max(0, ENDLESS_STUN_RESIST_PER_TIER * tier));
  if (depth <= 0) return unit;
  return { ...unit, stunResist: 1 - (1 - (unit.stunResist ?? 0)) * (1 - depth) };
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
      // Its own roll (BattleSim), never folded into the enemy's attack effects.
      result.curseStun = {
        chance: Math.max(result.curseStun?.chance ?? 0, curse.chance),
        durationMs: Math.max(result.curseStun?.durationMs ?? 0, curse.durationMs),
      };
    } else if (curse.kind === "enemy-explosion") {
      result.deathExplosion = { chance: curse.chance, damagePercent: curse.damagePercent };
    } else if (curse.kind === "enemy-knockback-headless") {
      // Its own roll; the enemy's own knockback is left exactly as it was.
      result.curseShoveHeadless = Math.max(result.curseShoveHeadless ?? 0, curse.chance);
    }
  }
  return result;
}

function waveEnemies(plan: Pick<EndlessWavePlan, "wave" | "tier" | "location" | "locationFight" | "modifier">, weekSeed: string): string[] {
  const { wave, tier, location, locationFight, modifier } = plan;
  // Alien keeps the normal invasion's deployment count and timing, whatever the modifier.
  if (location === "alien") return Array.from({ length: 20 }, () => "AlienStageActorMinion");
  const count = ENDLESS_FLOOR_ENEMIES[locationFight - 1] + (ENDLESS_LOCATION_EXTRA_ENEMIES[location]?.[locationFight - 1] ?? 0)
    + (modifier ? ENDLESS_MODIFIERS[modifier].extraEnemies ?? 0 : 0);
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
  // Walk-in bosses stand late in the queue, so the line has whittled the army down first.
  // `buildUnitsForKeys` receives them in enemyKeys, not bossKey: no perch, no boss actions.
  const walkIns = endlessWalkIns({ wave, tier, location, locationFight, modifier }, weekSeed);
  walkIns.forEach((key, i) => { out[out.length - 1 - i * 3] = key; });
  return out;
}

/** This floor's walk-in bosses, drawn from the location's pool. Alien Landing's are not in
 *  the line: the saucer beams them down (EndlessWavePlan.beamedWalkIns). */
function endlessWalkIns(plan: Pick<EndlessWavePlan, "wave" | "tier" | "location" | "locationFight" | "modifier">, weekSeed: string): string[] {
  const pool = ENDLESS_WALK_IN_POOL[plan.location];
  // The saucer's beamed walk-ins start later than the others (owner, 2026-11-10).
  if (plan.location === "alien" && plan.tier < ENDLESS_ALIEN_WALK_IN_TIER) return [];
  const random = seededRandom(`endless-walk-in:${weekSeed}:${plan.wave}:${plan.location}:${plan.modifier ?? ""}`);
  return Array.from({ length: endlessKillerCount(plan.tier, plan.locationFight) }, () => pool[Math.floor(random() * pool.length)]);
}

/** Build the pure, reproducible plan for one fight in an Endless run. */
export function endlessWavePlan(
  mode: EndlessMode,
  waveInput: number,
  stop: EndlessStop = ENDLESS_FIRST_STOP,
  weekSeed = "0",
): EndlessWavePlan {
  const wave = Math.max(1, Math.floor(Number.isFinite(waveInput) ? waveInput : 1));
  const depth = (wave - 1) * DEPTH_PER_FIGHT;
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
  // Normal Endless flattens once more after the T7 boss (ENDLESS_LATE_*).
  const lateFrom = mode === "endless" ? (ENDLESS_LATE_RAMP_FROM_WAVE - 1) * DEPTH_PER_FIGHT : Infinity;
  const fastDepth = Math.min(depth, 15);
  const slowDepth = Math.max(0, Math.min(depth, lateFrom) - 15);
  const lateTiers = Math.max(0, depth - lateFrom) / (ENDLESS_FIGHTS_PER_LOCATION * DEPTH_PER_FIGHT);
  const damageScale = baseDamage * (1 + damageStep) ** fastDepth
    * (mode === "nightmare" ? 1.035 : 1.05) ** slowDepth * ENDLESS_LATE_DAMAGE_PER_TIER ** lateTiers;
  const healthScale = baseHealth * (1 + healthStep) ** fastDepth
    * (mode === "nightmare" ? 1.025 : 1.07) ** slowDepth * ENDLESS_LATE_HEALTH_PER_TIER ** lateTiers;
  const mechanicCooldownScale = mechanics.cadence[locationFight - 1];
  // A boss's own moves (the carrot wall, pixel fire, turning zombies, the saucer's laser and
  // beam-ins) belong to floor 2, where he is; floor 1 keeps only the location's trait (the
  // Ninja smoke bomb); floor 3 is Dr. Groundhog alone.
  const beamed = location === "alien" && !bossGate ? endlessWalkIns({ wave, tier, location, locationFight, modifier }, weekSeed) : [];
  const mechanicCooldownsMs = Object.fromEntries([
    ...Object.entries(ENDLESS_MECHANIC_BASE_COOLDOWNS_MS[location] ?? {})
      // Dr. Groundhog fights alone: no location mechanics on his floor at all.
      .filter(([key]) => !bossGate && (locationFight === 2 || !ENDLESS_BOSS_MOVES.has(key)))
      .map(([key, cooldown]) => [key, Math.max(1_000, Math.round(cooldown * mechanicCooldownScale))]),
    ...(beamed.length ? [["beam-walk-in", ENDLESS_BEAM_WALK_IN_MS]] : []),
  ]);
  return {
    mode, wave, section, tier, location, modifier, locationFight, bossGate,
    enemyTier: Math.min(ENEMY_BANDS.length, tier + locationFight - 1),
    enemyKeys: bossGate ? [] : waveEnemies({ wave, tier, location, locationFight, modifier }, weekSeed),
    damageScale, healthScale, mechanicCooldownScale, mechanicCooldownsMs,
    bossId: bossGate ? (mode === "nightmare" ? "galactic-groundhog" : "dr-groundhog") : null,
    bossKey: locationFight === 2 ? ENDLESS_PERCHED_BOSS[location] ?? null : null,
    beamedWalkIns: beamed,
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
  /** Head Start: extra zombies that walk on with each fight's first deploy. Stacks, three a
   *  pick, to ENDLESS_MAX_OPENING_DEPLOY. */
  openingDeploy: number;
  /** A Concentration was spent at the start (owner, 2026-11-11): every floor of the run is
   *  fought concentrated, no focus minigame and no distraction penalty. */
  concentration?: boolean;
  /** Revive all fallen headless zombies after each fight once this boon is chosen. */
  reviveHeadless: boolean;
  /** Permanent run curses selected at boss gates. */
  curses: EndlessCurse[];
}

/** A boon that reshapes the army's stats for the rest of the run (owner, 2026-11-08). General
 *  ones lift one stat for everyone or every stat for one class. Class ones trade within what
 *  that class is for, or are plain useful. See ENDLESS_BUILD_BOONS. */
export type EndlessBuildBoon =
  | "sharp-teeth" | "thick-skin" | "quick-hands"
  | "drill-regular" | "drill-girl" | "drill-headless" | "drill-large" | "drill-garden"
  | "battering-ram" | "bulwark" | "green-thumb" | "brute-force" | "frenzy" | "grit"
  | "vanguard" | "rearguard";

/** What a build boon does to one zombie's STATS (owner, 2026-11-08): multipliers on str, con
 *  and dex, flat additions after them, and a heal multiplier. Changing the stats themselves means
 *  everything that reads them follows: str is each hit and a healer's heal, con is health, dex is
 *  the attack interval and the walk. */
type BoonScale = { str?: number; con?: number; dex?: number; dexPlus?: number; heal?: number };
const classOf = (u: CombatUnit): string => u.group ?? (u.isHeadless ? "Headless" : u.isGarden ? "Garden" : "Regular");
const forClass = (group: string, scale: BoonScale) => (u: CombatUnit): BoonScale => classOf(u) === group ? scale : {};
const allStats = (by: number): BoonScale => ({ str: by, con: by, dex: by });

export const ENDLESS_BUILD_BOONS: Readonly<Record<EndlessBuildBoon, {
  name: string; text: string; scale: (u: CombatUnit, index: number) => BoonScale;
}>> = {
  // ---- General: one stat for everyone, or every stat for one class ----
  "sharp-teeth": { name: "Sharp Teeth", text: "All zombies +10% str", scale: () => ({ str: 1.1 }) },
  "thick-skin": { name: "Thick Skin", text: "All zombies +10% con", scale: () => ({ con: 1.1 }) },
  "quick-hands": { name: "Quick Hands", text: "All zombies +10% dex", scale: () => ({ dex: 1.1 }) },
  "drill-regular": { name: "Regular Drills", text: "Regular zombies +10% str, con and dex", scale: forClass("Regular", allStats(1.1)) },
  "drill-girl": { name: "Girl Drills", text: "Girl zombies +10% str, con and dex", scale: forClass("Female", allStats(1.1)) },
  "drill-headless": { name: "Headless Drills", text: "Headless zombies +10% str, con and dex", scale: forClass("Headless", allStats(1.1)) },
  "drill-large": { name: "Brute Drills", text: "Brute zombies +10% str, con and dex", scale: forClass("Large", allStats(1.1)) },
  "drill-garden": { name: "Garden Drills", text: "Garden zombies +10% str, con and dex", scale: forClass("Garden", allStats(1.1)) },
  // ---- Class: a trade inside what the class is for, or a plain useful lift ----
  "battering-ram": { name: "Battering Ram", text: "Headless zombies +2 dex, -15% con", scale: forClass("Headless", { dexPlus: 2, con: 0.85 }) },
  bulwark: { name: "Bulwark", text: "Headless zombies +25% con", scale: forClass("Headless", { con: 1.25 }) },
  "green-thumb": { name: "Green Thumb", text: "Garden zombies heal 20% more", scale: forClass("Garden", { heal: 1.2 }) },
  "brute-force": { name: "Brute Force", text: "Brute zombies +30% str, -15% dex", scale: forClass("Large", { str: 1.3, dex: 0.85 }) },
  frenzy: { name: "Frenzy", text: "Girl zombies +30% dex, -15% con", scale: forClass("Female", { dex: 1.3, con: 0.85 }) },
  grit: { name: "Grit", text: "Regular zombies +20% con, -10% str", scale: forClass("Regular", { con: 1.2, str: 0.9 }) },
  // ---- Formation ----
  // Owner, 2026-11-11: +30%, no penalty behind. `index` counts the LIVING army only, so it
  // passes to whoever is now at the front (it used to stay with the dead, leaving only -10%).
  vanguard: { name: "Vanguard", text: "Your first 3 living zombies +30% con",
    scale: (_u, index) => (index < 3 ? { con: 1.3 } : {}) },
  // Not a stat change: the zombies behind the front five already swing slower and hit softer
  // (lineupSpeedBand / lineupDamageBand). Rearguard halves that falloff (BattleSim.speedBand).
  rearguard: { name: "Rearguard", text: "Zombies behind your front five lose only half as much speed and damage", scale: () => ({}) },
};
const BUILD_BOON_IDS = Object.keys(ENDLESS_BUILD_BOONS) as EndlessBuildBoon[];
export const isEndlessBuildBoon = (kind: unknown): kind is EndlessBuildBoon =>
  typeof kind === "string" && Object.prototype.hasOwnProperty.call(ENDLESS_BUILD_BOONS, kind);
/** The most a run's deployment boons may cut the deploy charge by (owner, 2026-11-08). */
export const ENDLESS_MAX_DEPLOY_REDUCTION = 0.8;
/** Head Start's stack: three picks (BattleSim holds the same ceiling). */
export const ENDLESS_MAX_OPENING_DEPLOY = 9;
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

/** The draft's pool (plus the week's loaned Special). `damage` stays a valid boon for runs
 *  that drafted it before 2026-11-08, but Sharp Teeth replaced it in the pool. */
const BOON_POOL: readonly EndlessBoon[] = [
  ...BUILD_BOON_IDS.map((kind) => ({ kind })),
  { kind: "deployment", percent: 20 }, { kind: "opening-deploy", count: 3 },
  { kind: "revive-headless" },
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
/** Draft picks that would do nothing for this run, being already owned or at their cap
 *  (owner, 2026-11-11): Second Wind, Rearguard, Quick Release at 80%, Head Start at its cap;
 *  and the three curses that only ever take their strongest copy. Every other boon and curse
 *  stacks. */
export function endlessDraftPickWasted(run: EndlessRunState, pick: EndlessBoon | EndlessCurse): boolean {
  switch (pick.kind) {
    case "revive-headless": return run.reviveHeadless;
    case "rearguard": return run.buildBoons.includes("rearguard");
    case "deployment": return run.deploymentSpeedBonus >= ENDLESS_MAX_DEPLOY_REDUCTION - 1e-9;
    case "opening-deploy": return run.openingDeploy >= ENDLESS_MAX_OPENING_DEPLOY;
    case "enemy-stun": case "enemy-explosion": case "enemy-knockback-headless":
      return run.curses.some((curse) => curse.kind === pick.kind);
    default: return false;
  }
}
/** Re-rolls a wasted draft slot gets before it falls back. */
export const ENDLESS_DRAFT_REROLLS = 3;
/** Where a slot lands after three wasted re-rolls: the general stat boons, and the three plain
 *  stacking curses. */
const FALLBACK_BOONS: readonly EndlessBoon[] = (["sharp-teeth", "thick-skin", "quick-hands",
  "drill-regular", "drill-girl", "drill-headless", "drill-large", "drill-garden"] as const).map((kind) => ({ kind }));
const FALLBACK_CURSES: readonly EndlessCurse[] = CURSE_POOL.filter((curse) =>
  curse.kind === "enemy-health" || curse.kind === "enemy-damage" || curse.kind === "enemy-attack-speed");

export function endlessBossDraft(
  mode: EndlessMode,
  bossWave: number,
  weekSeed = "0",
  current: EndlessLocation = ENDLESS_FIRST_LOCATION,
  withLocations = true,
  /** The run the draft is for. Given, a pick that would do nothing for it is re-rolled (up to
   *  ENDLESS_DRAFT_REROLLS times, seeded like the draft), then falls back to a stacking option.
   *  Omitted, the bare weekly draft. */
  run?: EndlessRunState,
): EndlessBossDraft {
  const label = `endless-draft:${weekSeed}:${mode}:${bossWave}`;
  const select = <T extends EndlessBoon | EndlessCurse>(pool: readonly T[], name: string, fallback: readonly T[]): T[] => {
    const picks = seededShuffle(pool, `${label}:${name}`).slice(0, 3);
    if (!run) return picks.map((item) => ({ ...item }));
    const key = (item: T) => JSON.stringify(item);
    const offered = new Set<string>();
    const usable = (item: T) => !endlessDraftPickWasted(run, item) && !offered.has(key(item));
    return picks.map((first, slot) => {
      let pick = first;
      for (let attempt = 1; attempt <= ENDLESS_DRAFT_REROLLS && !usable(pick); attempt++) {
        pick = pool[Math.floor(seededRandom(`${label}:${name}:reroll:${slot}:${attempt}`)() * pool.length)];
      }
      if (!usable(pick)) {
        pick = seededShuffle(fallback, `${label}:${name}:fallback:${slot}`).find(usable) ?? pick;
      }
      offered.add(key(pick));
      return { ...pick };
    });
  };
  const lent = ENDLESS_TEMPORARY_ZOMBIES[Math.floor(seededRandom(`${label}:temporary`)() * ENDLESS_TEMPORARY_ZOMBIES.length)];
  const boons: EndlessBoon[] = [...BOON_POOL, { kind: "temporary-zombie", key: lent.key, name: lent.name }];
  return {
    boons: select(boons, "boons", FALLBACK_BOONS), curses: select(CURSE_POOL, "curses", FALLBACK_CURSES),
    locations: withLocations ? endlessLocationOptions(mode, bossWave, weekSeed, current) : [],
  };
}

/** Begin with a fresh battle copy; account-owned army records remain untouched. */
export function beginEndlessRun(
  mode: EndlessMode, party: readonly CombatUnit[], weekSeed = "0", startTier = 1, concentration = false,
): EndlessRunState {
  const startWave = endlessStartWave(startTier);
  return {
    mode, nextWave: startWave, startWave, buildBoons: [], weekSeed, stop: { ...ENDLESS_FIRST_STOP },
    units: party.map((u) => ({ ...u, attacks: u.attacks.map((a) => ({ ...a })), hp: u.maxHp, alive: true })),
    damageBonus: 0, deploymentSpeedBonus: 0, openingDeploy: 0, reviveHeadless: false, curses: [],
    ...(concentration ? { concentration: true } : {}),
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

/** The section gate heals the SURVIVORS to full, and nothing more: a zombie lost in Endless
 *  stays lost for the rest of the run (owner, 2026-11-10, replacing the 2026-11-05 full
 *  revive). With the difficulty cliff, a revive only ever bought one more location, so
 *  casualties now carry the whole run. Between ordinary fights, surviving HP persists too.
 *  The Second Wind boon (`reviveHeadless`) still stands fallen Headless up after each fight. */
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
    units: carried.units.map((u) => {
      if (run.reviveHeadless && u.isHeadless && !u.alive) return { ...u, alive: true, hp: u.maxHp };
      return bossGate && u.alive ? { ...u, hp: u.maxHp } : u;
    }),
  };
}

/** Boons appear after each cleared Epic Boss gate. */
export function applyEndlessBoon(run: EndlessRunState, boon: EndlessBoon): EndlessRunState {
  switch (boon.kind) {
    case "revive-headless":
      return { ...run, reviveHeadless: true };
    case "sharp-teeth": case "thick-skin": case "quick-hands":
    case "drill-regular": case "drill-girl": case "drill-headless": case "drill-large": case "drill-garden":
    case "battering-ram": case "bulwark": case "green-thumb": case "brute-force": case "frenzy": case "grit":
    case "vanguard": case "rearguard":
      return { ...run, buildBoons: [...run.buildBoons, boon.kind] };
    case "temporary-zombie":
      return run; // The unit needs the catalog: see endlessFight's endlessApplyBoon.
    case "damage":
      return { ...run, damageBonus: run.damageBonus + Math.max(0, boon.percent) / 100 };
    case "deployment":
      // A cut to the charge time, stacking to ENDLESS_MAX_DEPLOY_REDUCTION and no further.
      return { ...run, deploymentSpeedBonus: Math.min(ENDLESS_MAX_DEPLOY_REDUCTION, run.deploymentSpeedBonus + Math.max(0, boon.percent) / 100) };
    case "opening-deploy":
      // Stacks (2026-11-11: a second pick used to do nothing past 3).
      return { ...run, openingDeploy: Math.min(ENDLESS_MAX_OPENING_DEPLOY, run.openingDeploy + Math.max(0, Math.floor(boon.count))) };
  }
}

/** What the build boons do to one body, given its place in the army's order. Boons retired
 *  from the pool (an old run's "headless-wall", "garden-focus") simply do nothing. */
function buildBoonScale(run: EndlessRunState, unit: CombatUnit, index: number): { str: number; con: number; dex: number; dexPlus: number; heal: number } {
  const out = { str: 1, con: 1, dex: 1, dexPlus: 0, heal: 1 };
  for (const boon of run.buildBoons) {
    if (!isEndlessBuildBoon(boon)) continue;
    const s = ENDLESS_BUILD_BOONS[boon].scale(unit, index);
    out.str *= s.str ?? 1;
    out.con *= s.con ?? 1;
    out.dex *= s.dex ?? 1;
    out.dexPlus += s.dexPlus ?? 0;
    out.heal *= s.heal ?? 1;
  }
  return out;
}

/** Apply run damage and build boons to a battle copy of the living party. */
export function endlessPlayerUnits(run: EndlessRunState): CombatUnit[] {
  // Positions in the army as it now stands: the fallen hold no place (Vanguard reads it).
  return run.units.filter((u) => u.alive && u.hp > 0).flatMap((u, index) => {
    const scale = buildBoonScale(run, u, index);
    // `damageBonus` is the retired +20% damage boon, still honoured for runs that drafted it.
    const unit = { ...u, attacks: u.attacks.map((a) => ({ ...a, mult: (a.mult ?? 1) * (1 + run.damageBonus) })) };
    // Boons move the stats themselves (str: hits and heals; con: health; dex: attack
    // interval and walk), and the derived numbers follow in proportion.
    unit.str *= scale.str;
    const dex = Math.max(0.1, unit.dex * scale.dex + scale.dexPlus);
    if (dex !== unit.dex) {
      unit.attackCooldownMs = Math.max(1, Math.round(unit.attackCooldownMs * Math.max(0.1, unit.dex) / dex));
      unit.dex = dex;
    }
    if (scale.heal !== 1) unit.healMult = (unit.healMult ?? 1) * scale.heal;
    scaleAuraBase(unit, scale);
    if (scale.con !== 1) {
      const fraction = unit.maxHp > 0 ? unit.hp / unit.maxHp : 1;
      unit.maxHp = Math.max(1, Math.round(unit.maxHp * scale.con));
      unit.hp = Math.max(1, Math.round(unit.maxHp * fraction));
      unit.con *= scale.con;
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
        scaleAuraBase(unit, { [curse.stat]: ratio });
      }
    }
    return [unit];
  });
}

/** The sim rebuilds a zombie's str/con/dex from `teamAuraStats` whenever a team-aura carrier
 *  deploys or falls (BattleSim.refreshTeamAuras), so a stat change has to land there too or
 *  the first aura refresh would undo it. */
function scaleAuraBase(unit: CombatUnit, s: { str?: number; con?: number; dex?: number; dexPlus?: number }): void {
  if (!unit.teamAuraStats) return;
  const a = { ...unit.teamAuraStats };
  const str = s.str ?? 1, con = s.con ?? 1, dex = s.dex ?? 1;
  a.baseStr *= str; a.strPerCarrier *= str;
  a.baseCon *= con; a.conPerCarrier *= con;
  a.baseDex = Math.max(0.1, a.baseDex * dex + (s.dexPlus ?? 0)); a.dexPerCarrier *= dex;
  unit.teamAuraStats = a;
}

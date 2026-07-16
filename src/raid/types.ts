// Raid/invasion data shapes, normalized by tools/prep_raids.py from the source
// Enemies.json / UnitStats.json / Attacks.json.
//
// The MVP resolves a raid instantly from stats (no animated scene), so most of
// the timing/sfx fields below are carried through only for the future live
// battle scene — the resolver reads str/dex/con and the attack damage multiplier.

/** One enemy wave within a raid (from the source stageSettings). */
export interface RaidStage {
  enemyKeys: string[];
  /** The boss unit for this wave, if any. */
  bossKey?: string;
  /** Source wave ordinal (NOT a player-level gate). */
  wave?: number;
  /** Weighted-spawn population cap (used by the late endless waves). */
  population?: number;
  throwSpeed?: number;
  throwingDisabled?: boolean;
  /** Weighted spawn table for population-capped waves. */
  weighted?: { enemy: string; frequency: number }[];
}

/** A background/scenery layer for the (future) battle scene. */
export interface RaidLevelAsset {
  sprite: string;
  position: string; // "{x,y}" in source-space
  anchor: string; // "{ax,ay}"
  z: number;
}

/** A normalized invasion definition. */
export interface RaidDef {
  id: number;
  name: string;
  bossName: string;
  bossPortrait: string; // filename under /assets/raids/images/
  enemyIcon: string;
  /** Player level required to unlock (0 = always). */
  unlockLevel: number;
  recommendedLevel: number;
  introText: string;
  successText: string;
  failureText: string;
  /** XP awarded on a win. */
  xp: number;
  /** Guaranteed win gold ("gold without casualties"). Wiki-sourced (see
   *  prep_raids.py WIKI_GOLD) — approximate, not in the source data. */
  goldReward: number;
  /** Additional possible bonus gold on a win. Wiki-sourced, approximate. */
  bonusGold: number;
  throwSpeed: number;
  /** Looping battle BGM filename under /assets/audio/ (themed track for the 5
   *  stages that ship one, generic fightBGM.mp3 for the rest). */
  music: string;
  /** Event/seasonal invasion — shown apart from the level ladder. */
  seasonal: boolean;
  /** Has playable stages (enemy data). Others show as a locked/coming-soon card. */
  playable: boolean;
  levelAssets: RaidLevelAsset[];
  stages: RaidStage[];
  /** Reward tiers: each tier is a list of possible drops (names/keys). */
  loot: string[][];
  // ---- Environmental hazards (ZFFightMan spawnObstacle: loop) ----
  /** Max obstacle hazards on screen at once (0 = this raid has none). */
  obstacleLimit: number;
  /** Seconds between obstacle spawns. */
  obstacleSpawnSecs: number;
  /** Source obstacle-actor class names (for reference / future art). */
  obstacleActors: string[];
  /** A one-shot obstacle spawned at the start (e.g. the beach Crab). */
  initialSpawnClass: string;
  /** This raid has a `grabZombie` stage actor (Lawyers cars / Circus trapeze) that
   *  seizes zombies and drops them at the back of the line. */
  hasGrab: boolean;
}

/** One entry in a boss's `bossActions` (UnitStats.json). `name==="throw"` is a
 *  ballistic projectile; other names are special hazards (alienLaser, pixelFire,
 *  turnZombie, telekinesis, summonBoss, wall) recovered from the binary's
 *  ZFFightMan action scheduler. `frequency` is a selection weight; `castTime` /
 *  `cooldownTime` are the wind-up / recovery in seconds. */
export interface BossAction {
  name: string;
  frequency: number;
  damage?: number;
  sprite?: string;
  spriteSize?: number;
  castTime?: number; // wind-up seconds before the effect lands (special actions)
  cooldownTime?: number; // recovery seconds after the effect (special actions)
  hp?: number; // wall action: the spawned wall's hit points
  collisionSize?: number; // wall action: collision box size
}

/** A unit stat template (enemy or boss) from UnitStats.json. */
export interface EnemyStat {
  str: number;
  dex: number;
  con: number;
  focus?: number;
  tier?: number;
  attacks?: { frequency: number; name: string }[];
  bossActions?: BossAction[];
  standardGoldLoot?: boolean;
  standardBossLoot?: boolean;
}

/** An attack definition from Attacks.json (only damageMultiplier matters to MVP). */
export interface AttackDef {
  animID?: number;
  damageMultiplier?: number;
  damageTiming?: number;
  speedMultiplier?: number;
  sfxID?: string;
  sfxTiming?: number;
  knockBack?: boolean;
  stun?: boolean;
  stunTimer?: number;
  zombieAOE?: number;
  cantInterrupt?: boolean;
}

/** The whole raid bundle loaded at startup. */
export interface RaidData {
  raids: RaidDef[];
  enemyStats: Record<string, EnemyStat>;
  attacks: Record<string, AttackDef>;
}

/** A resolved attack option on a combat unit. */
export interface CombatAttack {
  name: string;
  frequency: number;
  mult: number; // damageMultiplier (defaults to 1)
}

/** A transient combatant used only inside the resolver (never persisted). */
export interface CombatUnit {
  id: string;
  sourceKey: string;
  /** Owned mutation mask. Player actors use it for raid rendering; enemies omit it. */
  mutation?: number;
  team: "player" | "enemy";
  name: string;
  str: number;
  dex: number;
  con: number;
  focus: number;
  hp: number;
  maxHp: number;
  attackCooldownMs: number;
  attacks: CombatAttack[];
  isBoss: boolean;
  alive: boolean;
  /** Garden-group zombie — the boss prefers to throw projectiles at these. */
  isGarden: boolean;
  /** Headless-group zombie — pushes to the front row of the formation. */
  isHeadless: boolean;
  /** The unit's unlocked, active ability keys (players only; [] for enemies). Used
   *  by the live scene to drive the top-left ability strip + activated moves. */
  abilities: string[];
  /** Enemy attack carries knockback (Attacks.json `knockBack`) — on hit it shoves the
   *  struck zombie back down the lane and interrupts it (see BattleSim). Players: false. */
  knockBack?: boolean;
  /** Enemy attack stun on hit, in ms (Attacks.json `stun`/`stunTimer`). 0 = none. */
  stunMs?: number;
  /** Fraction (0..1) of the attack animation at which the strike connects — Attacks.json
   *  `damageTiming` of the enemy's primary attack (Farmhand poke 0.33, Lumberjack slice
   *  0.75, boss punch 0.4). Purely cosmetic: shapes the enemy's lunge/thrust in the raid
   *  scene so the forward peak lands with the hit. Players: unused. */
  attackDamageTiming?: number;
  /** Flat armor: subtracted from incoming damage before the % reduction (binary
   *  `Actor damage:`). 0/absent = none. */
  armor?: number;
  /** Fractional damage reduction 0..1, applied after armor (binary
   *  `finalDamageReduction`). 0/absent = none. */
  damageReduction?: number;
}

/** One item the boss can throw, derived from UnitStats bossActions. */
export interface BossThrowOption {
  damage: number;
  weight: number; // source `frequency`
  sprite: string; // projectile image under raids/images/
  spriteSize: number;
}

/** Boss projectile config for the live scene (built by RaidManager.beginRaid). */
export interface BossThrowConfig {
  intervalMs: number; // time between throws (from raid.throwSpeed)
  options: BossThrowOption[];
}

/** One boss SPECIAL action (non-throw) the live sim schedules on a cast/cooldown
 *  cadence. Recovered from ZFFightMan's boss-action loop; see BattleSim.stepBossSpecials. */
export interface BossSpecial {
  name: string; // alienLaser | pixelFire | turnZombie | telekinesis | summonBoss | wall
  weight: number; // source `frequency` (selection weight)
  castMs: number; // wind-up before the effect lands
  cooldownMs: number; // recovery before the next special can fire
  damage: number; // effect damage (data value, or a sensible default)
}

/** Environmental-hazard config for the live sim (obstacle actors crossing the lane). */
export interface HazardConfig {
  limit: number; // max obstacles on the lane at once
  spawnMs: number; // interval between obstacle spawns
  damage: number; // damage an obstacle deals to a zombie it hits
  sprite: string; // projectile sprite name (falls back to a tinted dot if unloaded)
  initial: boolean; // spawn one obstacle immediately at the start
  grab: boolean; // grab hazard (Lawyers car / Circus trapeze) — seizes instead of damages
}

/** The outcome of a resolved raid (fed to the Result panel + reward pipeline). */
export interface RaidOutcome {
  win: boolean;
  rounds: number;
  /** Ids of player units still alive at the end. */
  survivors: string[];
  /** Player units that died. */
  losses: string[];
  /** Enemy units defeated (all of them on a win). */
  enemiesBeaten: number;
  /** Total damage dealt by the player army (for the summary line). */
  playerDamage: number;
  /** Epic Boss only: the hard attempt clock elapsed while the boss still lived. */
  escaped?: boolean;
}

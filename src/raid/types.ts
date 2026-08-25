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
  /** Robots only. The wave has no authored boss: one entry of `weighted` is drawn at
   *  random to lead it and the REST make up the minions, so every bot type appears
   *  exactly once and any of them can be the boss. resolveStageWave() turns such a
   *  stage into a concrete one before anything reads `bossKey`. */
  randomBoss?: boolean;
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
  /** Player zombie taxonomy, carried for presentation sizing. Enemies omit it. */
  group?: string;
  className?: string;
  /** Owned body tint (Zombie Pot children inherit a mixed parent colour). Purely
   *  presentational — carried so the battlefield rig matches the farm and the
   *  Army screen instead of falling back to the catalog colour. Never read by the
   *  sim, so it cannot affect deterministic replay. */
  color?: [number, number, number];
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
  /** How often that shove actually lands: the frequency SHARE of the entries in the
   *  unit's `attacks` list that carry `knockBack`, since one attack is rolled per swing.
   *  1 for a unit whose only attack has it, 0.1 for the Lumberjack. Absent = 1 (every
   *  hit), which is what a caller that predates the split would have meant. */
  knockBackChance?: number;
  /** Enemy attack stun on hit, in ms (Attacks.json `stun`/`stunTimer`). 0 = none. */
  stunMs?: number;
  /** Frequency share of the stunning entries, exactly as `knockBackChance`. */
  stunChance?: number;
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
  // ---- PvP defense formation (friend invasions, "formation" defense mode) ----
  // All three are OPTIONAL and authored server-side into the pinned config. When they
  // are ABSENT every unit behaves exactly as it always has, which is what keeps raid
  // transcripts byte-identical: only a formation-mode PvP defense ever carries them.
  // See docs/PVP_DEFENSE_FORMATION.md and src/raid/pvp.ts.
  /** Which authored job this defender holds in the farm's defense. */
  defenseRole?: "tank" | "support" | "brute" | "mini" | "line";
  /** Authored hold position. An enemy carrying this walks to it and stands there
   *  instead of holding at the shared ENEMY_HOLD_X doorway. */
  stationX?: number;
  stationY?: number;
  /** Fight-clock ms at which this defender walks on. 0 = already there when the
   *  fight opens. Present = this unit ignores the wave's drip cadence entirely. */
  deployAtMs?: number;
  /** Held off-field until the perched boss climbs down, then released with it. The
   *  formation defense's MINI is the brute's ammunition: it waits in the barn between
   *  throws rather than standing in the line, so it neither holds the boss on its
   *  perch nor counts as a defender the attackers must clear. */
  deployWithBoss?: boolean;
  /** Pre-team-aura stats plus the additive contribution from one matching deployed
   *  carrier. BattleSim uses this to turn Chivalry/Grace/Protect/Fortitude on only
   *  while their holder is actually deployed; headless/instant resolvers can keep
   *  using the already-combined public stats above. */
  teamAuraStats?: {
    baseStr: number;
    baseDex: number;
    baseCon: number;
    strPerCarrier: number;
    dexPerCarrier: number;
    conPerCarrier: number;
  };
  /** Walking-only multiplier. Turbo Walking Speed changes this without changing
   *  DEX or the attack interval. */
  walkingSpeedMult?: number;
  /** This enemy ignores its own dex clock and MIRRORS its opponent's attack interval
   *  (`combatStats.mirrorIntervalSec`) — the Pirate Scallywag's override, and Arrrnold's
   *  divergent one. Recomputed against the current foe every time it re-arms.
   *  Players: false. */
  mirrorsOpponentSpeed?: boolean;
  /** This zombie's SPECIES BASE attack cycle in ms: 2 s ÷ its catalog dex, with no
   *  veterancy, mutation, level ramp, ability buff or lineup band on it. `attackCooldownMs`
   *  is what the zombie actually swings at; this is what its BODY would swing at.
   *  Read by exactly one thing — Arrrnold's slam clock, which is keyed to the body in
   *  front of him and deliberately not to how upgraded it is. Set by buildPlayerUnits;
   *  absent on enemies and on hand-built units, where the effective cycle stands in. */
  speciesCycleMs?: number;
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

/** How a stage feeds its wave onto the field.
 *
 *  GROUND TRUTH (`-[ZFFightMan spawnEnemyIn:]` 0x58100): the fight holds ONE "current"
 *  enemy plus a five-slot `enemySlots` array — six enemies at once. Two schedulers arm
 *  `spawnEnemyIn:` at a 1 s delay, both gated on `enemyPopulation - alive >= 1`:
 *  `update:` when the current enemy has died, and `updateTimer:` when `spawnTimer`
 *  expires. `spawnTimer` is seeded in `initialSpawn` (0x575fe) to **10 s for stage 6
 *  (Zombies vs Aliens) and 3600 s for every other stage** — so on every other raid the
 *  slots are never filled and the wave really is one-at-a-time. The alien raid is the
 *  only swarm in the game. */
export interface WaveCadence {
  /** Enemies on the field at once: 1 + the five `enemySlots`, or 1 with no drip. */
  maxActive: number;
  /** Reinforcement clock in ms (0 = none) — the alien stage's `spawnTimer`. */
  dripMs: number;
}

/** The alien boss's `summonBoss` queue. GROUND TRUTH: `bossSummonList` is seeded in
 *  `initialSpawn` (0x57618) with four ABDUCTED HUMANS, and `summonBoss:` (0x5ee2c) pops
 *  index 0 then pushes one of five randomly-rolled replacements, so it never runs dry.
 *  `allowedToSummonBoss` (0x5eda4) is what actually limits it: the summoned actor is held
 *  in the `bossWall` ivar, so only ONE can be alive at a time. See BattleSim.runSpecial. */
export interface SummonConfig {
  /** FIFO queue, in the authored seed order. */
  queue: CombatUnit[];
  /** The five candidates a completed summon pushes back on (uniform roll). */
  pool: CombatUnit[];
}

/** One entry in a boss's merged action budget. GROUND TRUTH: the source keeps throws and
 *  specials in a SINGLE `bossActions` array and makes one weighted roll over all of them
 *  per action cycle, so a debris toss and a special compete for the same slot. Each
 *  throwable option is its own entry, carrying the authored `frequency` as `weight`.
 *  See BattleSim.stepBossActions. */
export type BossActionChoice =
  | { kind: "throw"; weight: number; option: BossThrowOption; special: never }
  | { kind: "special"; weight: number; special: BossSpecial; option: never };

// NOTE: there is deliberately no "crossing obstacle" hazard config here. An earlier
// ground-crossing obstacle/grab mechanic (a sprite or dot sliding along the lane, damaging
// or seizing zombies) was NOT part of the base game — it was fabricated during development
// and has been removed. The real, source-derived hazards are GrabberConfig (Circus Trapeze
// Artist) and CrabConfig (Beach crab) below. Do not reintroduce a crossing obstacle without
// ground truth from the binary.

/** Carried-grab hazard config (Circus Trapeze Artist). Ground truth: the actor sweeps
 *  in from the left, grabs the rear-most deployed zombie, then rises to carry it off; the
 *  player taps it (`damageSelf_100`) to whittle its HP — killing it drops (frees) the
 *  zombie back into the fight, but if it escapes with the zombie, that zombie dies.
 *  See docs/mechanics/RAID_TIMING_AND_HAZARDS.md (Trapeze Artist lifecycle). */
export interface GrabberConfig {
  sprite: string; // hazard art (e.g. hazard_trapeze_girl.png)
  hp: number; // tuned trapeze HP (source-derived value is 1000)
  tapDamage: number; // damage per tap (damageSelf_100 → 100)
  spawnDelayMs: number; // initial wait + respawn cadence (spawnState wait_4)
}

/** Beach crab hazard config (`BeachStageActorCrab`, Summer Break). Disassembled ground
 *  truth: it is NOT a combat enemy — it has no attack path and no gold loot. It spawns on
 *  the obstacle timer up to a concurrent cap, wanders the lane, and on touching a deployed
 *  zombie GRABS it (the zombie goes inert + invincible), holds ~2 s, then carries it off
 *  the LEFT edge, at which point the zombie is removed from the fight (source state 38 —
 *  explicitly not the death path). Tapping the crab deals `tapDamage` per tap; killing it
 *  frees the zombie back onto the lane. See docs/mechanics/RAID_TIMING_AND_HAZARDS.md.
 *
 *  CLIENT-ONLY: the server verifier builds its sim WITHOUT this, so the authoritative
 *  replay is the un-harassed ("optimistic") run — see RaidManager.crabOf. */
export interface CrabConfig {
  sprite: string; // beach_crab.png
  hp: number; // tuned crab HP (source-derived value is 1000)
  tapDamage: number; // hitBoxTouched -> damage:100 (10 taps at the authored 1000 HP)
  spawnMs: number; // obstacleSpawnTimer (5 s on raid 7)
  limit: number; // obstacleLimit — concurrent cap, slot returned when one dies
  holdMs: number; // grab -> carry delay (CCDelayTime 2.0 s)
}

/** The outcome of a resolved raid (fed to the Result panel + reward pipeline). */
/** What the fight can attest to about HOW it was won, beyond who lived and died.
 *
 *  This exists so achievement quests about combat TECHNIQUE ("defeat a boss with an
 *  explosion", "revive a zombie mid-invasion") can be granted authoritatively. The
 *  server re-runs the whole fight through this same BattleSim when it settles a raid,
 *  so everything here comes out of the SERVER's own replay — no client claim, and no
 *  concession path of the kind the client-only hazards needed. */
export interface RaidFeats {
  /** One entry per enemy destroyed by an activated ability, in the order they fell.
   *  `ability` is the ACTIVATED_ABILITY key (explode / explodeV2 / bash / bashV2). */
  abilityKills: { ability: string; boss: boolean }[];
  /** One entry per resurrection performed. `exploded` marks the case where the revived
   *  zombie was the one that had just blown ITSELF up — the Garden/Small combo. */
  resurrections: { exploded: boolean }[];
}

export function emptyRaidFeats(): RaidFeats {
  return { abilityKills: [], resurrections: [] };
}

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
  /** How the fight was won, for technique achievements. Optional so an outcome
   *  produced by an older client (or a hand-built test fixture) still parses. */
  feats?: RaidFeats;
}

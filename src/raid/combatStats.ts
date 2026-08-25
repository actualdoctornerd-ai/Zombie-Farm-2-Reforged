// ---------------------------------------------------------------------------
// Combat stat math — GROUND TRUTH recovered by disassembling the iOS binary
// (`Actor calculateFinal*`, `Actor damage:`, `GameState rollAgainstFrequencyInArray:`;
// see docs/mechanics/COMBAT_STATS_RECOVERED.md). This is the single source of truth
// for how a base stat + its buff/debuff channels resolve into an effective stat, and
// how one hit lands. Pure functions, no Pixi — unit-testable headlessly.
//
// Each combatant carries a base stat (power / attackSpeed / hitPointsTotal) plus two
// modifier channels: `passive` (gear / monoliths / unlocked abilities) and `temporary`
// (in-battle effects). The four `final*` functions fold those channels on with the
// exact caps the binary applies — the caps matter for balance, so keep them.
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Effective attack power. Binary: `power × max(0, 1 + passive + temporary)` — the
 *  multiplier floors at 0, so a combined −1.0 or worse zeroes damage output. */
export function finalPower(power: number, passiveChange = 0, temporaryChange = 0): number {
  return power * Math.max(0, 1 + passiveChange + temporaryChange);
}

/** Effective attack interval (seconds/ms between swings — LOWER is faster).
 *  Binary: `interval × (1 − change)`, where the passive part is capped at +0.5 and
 *  the combined change floored at −0.5 (so the multiplier stays ≤ 1.5). A positive
 *  change speeds the unit up (shorter interval). */
export function finalAttackInterval(
  interval: number,
  passiveChange = 0,
  temporaryChange = 0
): number {
  const change = Math.max(-0.5, Math.min(passiveChange, 0.5) + temporaryChange);
  return interval * (1 - change);
}

/** Effective damage reduction (0 = none, 0.5 = halve incoming). Binary:
 *  `clamp(passive, −0.5, +0.5) + temporary` — passive DR alone is capped to ±50%,
 *  temporary DR stacks on top uncapped. */
export function finalDamageReduction(passive = 0, temporary = 0): number {
  return clamp(passive, -0.5, 0.5) + temporary;
}

/** Effective max HP. Binary: `max(1, hitPointsTotal × (1 + change))`. */
export function finalHitPoints(hitPointsTotal: number, change = 0): number {
  return Math.max(1, hitPointsTotal * (1 + change));
}

/** Damage a single hit actually removes from HP. Binary (`Actor damage:`):
 *  flat `armor` subtracts first (floored at 0), THEN the % reduction applies:
 *  `max(0, incoming − armor) × (1 − damageReduction)`. */
export function applyDamage(incoming: number, armor = 0, damageReduction = 0): number {
  return Math.max(0, incoming - armor) * (1 - damageReduction);
}

/** Veterancy stat scale — each survived-invasion rank adds a flat +5% (binary:
 *  `modifyStatWithRank:` = `stat × (1 + 0.05 × rank)`, coefficient literal 0.05).
 *  `rank` is the 0..5 veterancy level (see zombie/traits.ts, which already exposes
 *  this as `veterancyMultiplier`; kept here too so combat math is self-contained). */
export const VET_RANK_STEP = 0.05;
export function veterancyScale(rank: number): number {
  return 1 + VET_RANK_STEP * Math.max(0, rank);
}

// ---------------------------------------------------------------------------
// Player-level stat scaling — GROUND TRUTH (`-[ZombieActor modifyStatWithLevelScale:ofType:]`,
// imp 0x4c031). A player zombie does NOT fight at its full listed stats until the
// player reaches level 25: each of str/con/dex ramps linearly from a per-group floor
// (the "endpoint") up to the zombie's base stat as the player levels 8 → 25.
//   scaled = lerp(endpoint, baseStat, t),  t = clamp((playerLevel − 8) / 17, 0, 1)
// So below level 8 the stat sits at its floor; at/above level 25 it is the full base.
// FOCUS is NOT scaled (the binary's ofType=4 falls through unchanged), only str/con/dex.
//
// The endpoint depends on the zombie's group (its ZombieActor* class): a chain of
// isKindOfClass tests picks the row. Values transcribed verbatim from the method's
// per-type immediate/literal endpoints. Proof the mapping is right: the `dex` floors
// equal the base dex of each group in zombies.json (Large 1.3, Headless 1.0, Regular
// 2.0, Garden 2.0), i.e. those groups have flat dex — which only holds if endpoint and
// stat line up. See docs/mechanics/COMBAT_STATS_RECOVERED.md.
export type ScaledStat = "str" | "con" | "dex";

/** Per-group low-level floors (keyed by reimpl group name; "Female" = ZombieActorGirl). */
export const LEVEL_SCALE_ENDPOINTS: Record<string, Record<ScaledStat, number>> = {
  Large: { str: 8.5, con: 6.5, dex: 1.3 },
  Regular: { str: 5.0, con: 5.0, dex: 2.0 },
  Garden: { str: 2.5, con: 2.5, dex: 2.0 },
  Female: { str: 3.4, con: 3.5, dex: 3.5 },
  Headless: { str: 3.0, con: 11.0, dex: 1.0 },
  Small: { str: 3.125, con: 2.75, dex: 4.0 },
};
/** Fallback endpoints for an unrecognized group (binary's isKindOfClass fall-through). */
export const LEVEL_SCALE_DEFAULT: Record<ScaledStat, number> = { str: 5.0, con: 5.0, dex: 2.0 };

/** Level-scale interpolation factor t ∈ [0,1]: 0 at level ≤ 8, 1 at level ≥ 25. */
export function levelScaleT(playerLevel: number): number {
  return clamp((playerLevel - 8) / 17, 0, 1);
}

/** Scale one of a zombie's str/con/dex for the current player level (see above).
 *  `group` is the zombie's group name; `base` is its full (level-25) stat value.
 *  Returns `base` unchanged once the player is level ≥ 25. Focus is never passed here. */
export function levelScaleStat(
  group: string,
  stat: ScaledStat,
  base: number,
  playerLevel: number
): number {
  const endpoint = (LEVEL_SCALE_ENDPOINTS[group] ?? LEVEL_SCALE_DEFAULT)[stat];
  return endpoint + levelScaleT(playerLevel) * (base - endpoint);
}

// ---------------------------------------------------------------------------
// Stat → fight-data conversion — GROUND TRUTH (`initFightDataAfterLoad`, recovered for
// BOTH ZombieActor and StageActor). The game turns a unit's (modified) raw stats into
// its combat values; these feed the calculateFinal* modifiers above.
//   power           = str × 10          (feeds per-swing damage)
//   hitPointsTotal  = con × 100
//   attackInterval  = C / dex seconds,  C = 2.0 for zombies, 1.0 for enemies
// The dex asymmetry is real: at equal dex an enemy attacks TWICE as often as a zombie.
// Per-swing melee damage (`Actor damageIn:`, deterministic — the only arc4random there is
// knockback force): damage = finalPower × attackDamageMultiplier × band, where `band` is the
// PLAYER-ZOMBIE LINEUP-DEPTH FALLOFF (see lineupDamageBand below). `damageMultiplier` defaults
// to 1.0 when the attack omits it (confirmed in-binary: `vmov d8,#1.0 ; cbz`), so the many
// enemy attacks that carry no multiplier still hit for finalPower×1×band. The target then
// applies the result via `applyDamage` (armor then damage-reduction). See
// docs/mechanics/COMBAT_STATS_RECOVERED.md.
//
// NOTE: these make the combat INPUTS faithful. The battle-sim loop (targeting, timing,
// scheduling, hazards) is still the reimpl's approximation — tune from here once the real
// sim is reversed.
export const POWER_PER_STR = 10; // power = str × 10
export const HP_PER_CON = 100; // hitPointsTotal = con × 100
/** Attack interval numerator (seconds): interval = ATTACK_INTERVAL_SEC[side] / dex. */
export const ATTACK_INTERVAL_SEC = { player: 2.0, enemy: 1.0 } as const;

// ---------------------------------------------------------------------------
// Attack CADENCE — GROUND TRUTH (`-[Actor getFightAttackSpeed]` 0x368e0, and the two
// `startAnim:interrupt:` overrides that consume it: `CivilianActorFight` 0x69be0 for
// enemies, `ZombieActor` 0x45898 for zombies). Pinned 2026-07-27.
//
// One attack cycle is EXACTLY `getFightAttackSpeed` seconds. Entering the attack state
// sets `attacking = YES` and schedules a REPEATING `doneAttacking:` at that interval;
// the moment `attacking` clears, the fight update re-arms `fightAttack:` with interval 0
// (i.e. the next frame). The attack ANIMATION does not gate anything — it is started by
// `fightAttack:` and the swing lands at `interval × damageTiming` inside the same cycle.
// So the raw fight-data clock IS the cadence, and the 2× player/enemy asymmetry above is
// real: at equal dex an enemy attacks twice as often as a zombie. (This retires the old
// `ENEMY_ATTACK_PACE = 2` fudge, which halved every enemy's DPS on a wrong rationale.)
//
//   interval = speedMultiplier × (ATTACK_INTERVAL_SEC[side] / dex) × lineupSpeedBand
//
// `speedMultiplier` comes from the attack rolled for THIS cycle (Attacks.json, default
// 1.0), so a heavy attack is both harder and slower — e.g. LumberjackSpecial is ×1.5
// damage on a ×5 cycle, ZombieDoubleStrike ×0.25 damage on a ×0.2 cycle.

/** Player-zombie lineup-depth SLOWDOWN bands — the cadence twin of LINEUP_DAMAGE_BANDS.
 *  Binary (0x36aae–0x36b4c): after `interval = speedMultiplier × finalAttackSpeed`, a
 *  player zombie's interval is multiplied by band[min(floor(index/5), 3)], so zombies
 *  behind the front five swing progressively slower as well as softer. Gated exactly
 *  like the damage band: only for units in `[fightMan zombies]`, skipped when
 *  `state ∈ {0x20, 0x1c}` and when `floor(index/5) == 0`. ENEMIES never pass through it. */
export const LINEUP_SPEED_BANDS = [1.0, 1.425, 2.0, 4.0] as const;

/** Interval multiplier for a player zombie at `index` in the army lineup (front = 0).
 *  1.0 for the front five, then ×1.425 / ×2 / ×4 per group of five. `bypass` (the
 *  special-attack states) or a negative/absent index → 1.0. GROUND TRUTH, see above. */
export function lineupSpeedBand(index: number, bypass = false): number {
  if (bypass || !(index >= 0)) return 1;
  const band = Math.floor(index / 5);
  return LINEUP_SPEED_BANDS[Math.min(band, LINEUP_SPEED_BANDS.length - 1)];
}

/** The Pirate Scallywag's attack-speed override (binary: `getFightAttackSpeed` 0x36960,
 *  reached via `isKindOfClass: PirateStageActorScallywag`). It throws away its own dex
 *  clock and MIRRORS the zombie it is facing:
 *
 *    finalAttackSpeed = max(0.5, opponentInterval² / 0.8)
 *
 *  The square is almost certainly a source bug (the same opponent value is fetched twice
 *  and multiplied), but it is what ships: against a fast zombie the Scallywag is fast,
 *  against a slow one it is very slow. `opponentIntervalSec` is the opponent's CURRENT
 *  effective interval in seconds. This is why a Scallywag reads as "swings every ~4 s"
 *  in reference footage while every other enemy runs at the raw 1/dex clock. */
/** Damage reduction the Protect aura grants ONE zombie, given how many carriers are
 *  deployed and whether this zombie is itself one of them.
 *
 *  Every body type takes the aura — Headless included, and Headless is the group that
 *  CARRIES Protect, so the tank bodies used to be the only ones it could not shield. A
 *  Bombie holds the highest hit points in the roster and still took every blow raw.
 *
 *  What a carrier does not do is shield ITSELF: the aura is what a Protect zombie gives
 *  the rest of the line. That keeps a lone carrier at zero (which is what the old
 *  `group === "Headless" ? 0` was, clumsily, encoding) while a real Headless line
 *  protects each of its members with every OTHER carrier's share.
 *
 *  Lives here, and not at either call site, because two places compute it — the
 *  CombatEngine build and BattleSim.refreshTeamAuras, which re-runs every tick. Fixing
 *  one and not the other silently un-does the change on the first step of the fight. */
export const PROTECT_STEP = 0.20;
export const PROTECT_CAP = 0.95;
export function protectReduction(carriers: number, isCarrier: boolean): number {
  const others = Math.max(0, carriers - (isCarrier ? 1 : 0));
  return Math.min(PROTECT_CAP, others * PROTECT_STEP);
}

export const SCALLYWAG_KEY = "PirateStageActorScallywag";
/** The Dread Pirate Arrrnold. He is NOT in the recovered override — the binary reaches it
 *  through `isKindOfClass: PirateStageActorScallywag` alone — so putting him here is a
 *  DELIBERATE DIVERGENCE. It is the raid's own stated rule: the Pirates' failure text reads
 *  "Rumors say pirates clobber anything that moves too fast", which the source only ever
 *  makes true of the minion. Reading it as a family trait is what this expresses, and it
 *  gives dex a job in the one fight where hit points have none (his 5000-damage slam is
 *  larger than the max HP of every zombie in the game, so nothing survives a second one
 *  whatever its con). Mirroring makes a SLOW front-liner the counter-play.
 *
 *  His mirror differs from the Scallywag's in all three of its terms, and every one of
 *  them is a balance dial rather than a recovered constant:
 *
 *   1. It reads the zombie's SPECIES BASE cycle, not its current one. The Scallywag
 *      mirrors what the zombie is actually doing (veterancy, mutations, level ramp,
 *      ability speed buffs, lineup depth — all of it), which is ground truth and stays.
 *      Arrrnold reads the body's catalog dex alone, so his pace is a property of WHAT you
 *      put in front of him, not how upgraded it is. That makes the counter-play something
 *      a player can see and choose (a Headless leads the line, and Headless has front
 *      priority) instead of something their own progression quietly takes away — under
 *      the effective-speed reading, every rank and every +dex mutation sped his slam up.
 *   2. His own divisor, derived from the tuning point below.
 *   3. His own floor — PIRATE_BOSS_MIN_SLAM_SEC, well above the Scallywag's 0.5 s. His
 *      slam is a one-hit kill on anything in the roster, so the floor is the worst case a
 *      fast species can bring on itself, and half a second between one-shots is not a
 *      fight.
 *
 *  Every zombie still dies to his second landed hit, so the seconds between them ARE the
 *  fight — that is the number worth naming. */
export const PIRATE_BOSS_KEY = "PirateStageActorBoss";
/** Enemies whose attack clock mirrors the zombie they face rather than their own dex. */
export const MIRROR_SPEED_KEYS: ReadonlySet<string> = new Set([SCALLYWAG_KEY, PIRATE_BOSS_KEY]);

/** The Scallywag's floor and divisor, as recovered. Ground truth; do not tune these. */
export const MIRROR_FLOOR_SEC = 0.5;
export const SCALLYWAG_MIRROR_DIVISOR = 0.8;

/** The recovered mirror: `max(0.5, opponentInterval² / 0.8)` against the opponent's
 *  CURRENT effective cycle. The Scallywag's, unchanged. */
export function mirroredAttackIntervalSec(opponentIntervalSec: number): number {
  return Math.max(MIRROR_FLOOR_SEC, (opponentIntervalSec * opponentIntervalSec) / SCALLYWAG_MIRROR_DIVISOR);
}

/** No matter how fast a species is, Arrrnold's slam lands no more often than this. A
 *  slam is a one-hit kill on every body in the roster, so this is the worst case a
 *  player can walk into — the fastest species (Small, base dex 4) sits here. */
export const PIRATE_BOSS_MIN_SLAM_SEC = 1.25;
/** The species the boss curve is tuned against: the Headless family's base dex of 1, so
 *  a 2 s catalog cycle. It is the slowest body in the game and the one with front
 *  priority, which makes it both the natural counter-play and the natural anchor. */
export const HEADLESS_SPECIES_CYCLE_SEC = 2.0;
/** What leading with that body buys: one slam every 6.5 s. The tuned number. */
export const PIRATE_BOSS_HEADLESS_SLAM_SEC = 6.5;
/** …which fixes the divisor. Derived, not authored, so the two numbers above stay the
 *  only ones to move when the fight is re-priced (≈0.6154). */
export const PIRATE_BOSS_MIRROR_DIVISOR =
  (HEADLESS_SPECIES_CYCLE_SEC * HEADLESS_SPECIES_CYCLE_SEC) / PIRATE_BOSS_HEADLESS_SLAM_SEC;

/** Arrrnold's slam clock against a zombie whose SPECIES BASE cycle is `speciesCycleSec`
 *  (2/catalog dex — no veterancy, mutations, level ramp, ability buff or lineup band). */
export function pirateBossSlamIntervalSec(speciesCycleSec: number): number {
  return Math.max(
    PIRATE_BOSS_MIN_SLAM_SEC,
    (speciesCycleSec * speciesCycleSec) / PIRATE_BOSS_MIRROR_DIVISOR
  );
}

/** The clock a mirroring enemy keeps against the zombie it faces. The two pirates read
 *  DIFFERENT things about that zombie, which is the whole reason this dispatch exists:
 *  the Scallywag mirrors its CURRENT cycle (`effectiveSec`, ground truth, so a decked-out
 *  army speeds the minions up), Arrrnold mirrors its SPECIES BASE (`speciesCycleSec`, so
 *  only the body type moves him). Both call sites go through here. */
export function mirrorIntervalSec(
  sourceKey: string,
  effectiveSec: number,
  speciesCycleSec: number
): number {
  return sourceKey === PIRATE_BOSS_KEY
    ? pirateBossSlamIntervalSec(speciesCycleSec)
    : mirroredAttackIntervalSec(effectiveSec);
}

/** Old McDonnell's Farm (raid 1) enemy speed-up — GROUND TRUTH (`getFightAttackSpeed`
 *  tail, 0x36b8e–0x36be6). When `zfGameData.currentEnemy == 1` the interval of every
 *  NON-zombie actor is multiplied by 0.66 at player level ≥ 10 and 0.44 at ≥ 15, so the
 *  starter raid keeps biting as you out-level it. No other raid does this. */
export const FARM_RAID_ID = 1;
export function farmRaidEnemyPace(raidId: number | undefined, playerLevel: number | undefined): number {
  if (raidId !== FARM_RAID_ID || playerLevel == null) return 1;
  if (playerLevel >= 15) return 0.44;
  if (playerLevel >= 10) return 0.66;
  return 1;
}

/** Burn damage per second while a zombie is on fire (boss `pixelFire` → `setOnFire`).
 *  Binary (`ZombieActor fightUpdate:` state 0x31 at 0x4dedc): `damage: hitPointsTotal/20 × dt`
 *  per frame = 5 % of MAX HP per second, through the normal `damage:` path (armor / DR /
 *  one-shot floor all apply). This RATE is ground truth and is used as recovered.
 *
 *  What the shipped game does NOT do is let it accumulate. `setOnFire` sets the zombie's
 *  destination to `[self position]` — its OWN current position — so the state-0x31 block
 *  burns once, immediately fails its `position == destinationPoint` test, and leaves for
 *  state 0x28. The burn lasts exactly ONE FRAME: 5 % ÷ 60 ≈ 0.083 % of max HP, about 2
 *  damage on a 3000 HP zombie. That is near-certainly a source bug (the surrounding code
 *  fetches the enemy, and moving to your own position is a no-op), and it left the Video
 *  Games boss's headline special worth nothing at all.
 *
 *  DELIBERATE DIVERGENCE: the reimpl burns for PIXEL_FIRE_BURN_MS at this rate instead, and
 *  hands the player a way to answer it (tap the fire out). The rate here is unchanged; only
 *  the duration is ours. See raid/videoGameStage.ts for the reasoning and
 *  docs/mechanics/ENEMY_DAMAGE_RECOVERED.md for the recovered reading this replaces. */
export const BURN_MAX_HP_FRACTION_PER_SEC = 0.05;

/** Flat damage of the Alien boss's laser bolt (`AlienStageBullet collidedWith:`,
 *  immediate 0x43480000 = 200.0f). Not a stat-derived value — a hard constant. */
export const ALIEN_LASER_DAMAGE = 200;

// ---------------------------------------------------------------------------
// The zombie WALKING LASER (laserBeam / its zomBeam upgrade) — DELIBERATE DIVERGENCE.
//
// Ground truth is 10 % of Power (`power = str × 10`, so one bolt landed for exactly the
// firer's strength stat). That reads fine on paper and is feeble in play: the tier-3
// Regular that first earns the beam has str 8.4, so its automatic shot chipped for 8
// while its own melee swing hit for 84.
//
// The reimpl DOUBLES it — 20 % of Power, i.e. 2 damage per point of strength:
//
//   damage = LASER_DAMAGE_PER_STR × (power / POWER_PER_STR)
//
// Strength is the ONLY input. dex still sets how OFTEN the beam fires (attackSpeed/3, /6
// for the Ver.2 upgrade — untouched ground truth), but it has no say in how hard one bolt
// lands. Nor does anything else: the beam skips the focus multiplier and both lineup-depth
// bands that a melee swing takes, so it is worth 0.6× a front-rank zombie's melee DPS at
// T3 and 1.2× at T4, rising well above that for a zombie fighting from the back ranks.

/** Laser damage per point of strength — twice the binary's, the whole divergence. */
export const LASER_DAMAGE_PER_STR = 2;

/** One walking-laser bolt's damage, from the firer's finalPower. Strength only — the
 *  caller's dex never enters here (it only schedules the shot). Floored at 1. */
export function laserHitDamage(power: number): number {
  return Math.max(1, Math.round((power / POWER_PER_STR) * LASER_DAMAGE_PER_STR));
}

// ---------------------------------------------------------------------------
// Lineup-depth damage falloff — GROUND TRUTH (`-[Actor damageIn:]` 0x372bc–0x37348, pinned
// 2026-07-17). A player zombie's per-swing damage is scaled by its INDEX in the army lineup
// (`[fightMan zombies] indexOfObject: self`), in groups of 5: only the front five hit at full
// strength; deeper zombies do progressively less. This is the damage-side twin of the
// "front rows fight" formation cap — a big army isn't a wall of full-power attackers.
//
//   band = LINEUP_DAMAGE_BANDS[min(floor(index / 5), 3)]     // 1.0 / 0.85 / 0.7 / 0.55
//
// Gated in-binary by THREE conditions; if any fails the band is 1.0 (full damage):
//   1. self isKindOfClass <player-zombie class> — ENEMIES fail this (they live in a separate
//      array, never in fightMan.zombies), so enemies ALWAYS deal ×1.0, never depth-penalized.
//   2. self.state ∉ {0x1f, 0x20} — two states bypass the penalty (the special-attack states,
//      e.g. Bash/Explode); pass `bypass=true` for an activated/special hit to skip the falloff.
//   3. floor(index/5) != 0 — the front band of five is full damage.
export const LINEUP_DAMAGE_BANDS = [1.0, 0.85, 0.7, 0.55] as const;

/** Player-zombie lineup-depth damage band for a zombie at `index` in the army lineup
 *  (front = 0). Returns 1.0 for the front five, then 0.85 / 0.7 / 0.55 per group of five.
 *  `bypass` (special-attack states) or a negative/absent index → 1.0 (no penalty). ENEMIES
 *  never pass through here — they always fight at 1.0. GROUND TRUTH, see above. */
export function lineupDamageBand(index: number, bypass = false): number {
  if (bypass || !(index >= 0)) return 1;
  const band = Math.floor(index / 5);
  return LINEUP_DAMAGE_BANDS[Math.min(band, LINEUP_DAMAGE_BANDS.length - 1)];
}

/** Max HP from constitution (binary: hitPointsTotal = con × 100). Floored at 1. */
export function deriveMaxHp(con: number): number {
  return Math.max(1, con * HP_PER_CON);
}

/** Attack interval in ms from dexterity (binary: C/dex seconds; C=2 zombie, 1 enemy).
 *  `dex` is guarded against 0 so a 0-dex unit doesn't stall the sim forever. */
export function deriveAttackIntervalMs(dex: number, side: "player" | "enemy"): number {
  return (ATTACK_INTERVAL_SEC[side] / Math.max(0.1, dex)) * 1000;
}

/** Per-swing melee damage BEFORE the lineup-depth band (binary: finalPower ×
 *  attackDamageMultiplier). `power` is the unit's finalPower (= effective str × 10);
 *  `multiplier` is the chosen attack's damageMultiplier (default 1). Multiply the result by
 *  `lineupDamageBand(index)` for a player zombie's normal swing (enemies/specials use band 1).
 *  Pre-armor/DR — the target applies those via `applyDamage`. */
export function deriveHitDamage(power: number, multiplier = 1): number {
  return power * multiplier;
}

/** Weighted random selection — the binary's universal picker
 *  (`+[GameState rollAgainstFrequencyInArray:]`). Sums every entry's `frequency`,
 *  draws `arc4random_uniform(Σfreq)`, and returns the first entry whose cumulative
 *  frequency passes the roll. So the `frequency` fields in Attacks.json /
 *  UnitStats.json `attacks[]`/`bossActions[]` are WEIGHTS, not percentages. `rand`
 *  is injectable for deterministic tests (default Math.random). Returns null on an
 *  empty / all-zero-weight list.
 *
 *  Note: the deterministic instant-resolver in CombatEngine collapses this to its
 *  expected value (frequency-weighted mean multiplier) on purpose; use this when a
 *  real per-swing roll is wanted (e.g. a live replay). */
export function pickByFrequency<T extends { frequency: number }>(
  entries: readonly T[],
  rand: () => number = Math.random
): T | null {
  const total = entries.reduce((s, e) => s + Math.max(0, e.frequency || 0), 0);
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const e of entries) {
    roll -= Math.max(0, e.frequency || 0);
    if (roll < 0) return e;
  }
  return entries[entries.length - 1] ?? null;
}

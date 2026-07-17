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

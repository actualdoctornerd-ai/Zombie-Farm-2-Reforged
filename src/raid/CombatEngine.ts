// Deterministic raid resolver. Builds transient CombatUnits from the player's
// selected zombies and one enemy wave, then runs a fixed-step auto-battle with NO
// rendering and NO randomness, returning the outcome. The MVP jumps straight from
// "Start" to the Result panel using this; a future live scene can replay the same
// math tick-by-tick.
//
// Damage model (per IMPLEMENTATION_RAIDS_PLAN combat MVP):
//   maxHp             = con * 10
//   attackCooldownMs  = clamp(3000 / dex, 600, 3500)
//   damage per hit    = max(1, round(str * avgMult))
// where avgMult is the frequency-weighted mean of a unit's attack damage
// multipliers (so the RNG of "which attack" collapses to its expected value —
// deterministic, and close enough for an instant resolve). Each unit attacks the
// first living enemy on the opposite team; a side loses when all its units die.
import type { OwnedZombie } from "../zombie/types";
import { veterancyMultiplier } from "../zombie/traits";
import { mutationBonus } from "../zombie/mutations";
import { activeAbilities, combatEffect } from "../zombie/abilities";
import { eliteEnemyStat, type EliteProfile } from "./eliteInvasion";
import {
  applyDamage,
  levelScaleStat,
  deriveMaxHp,
  deriveAttackIntervalMs,
  deriveHitDamage,
  farmRaidEnemyPace,
  lineupDamageBand,
  lineupSpeedBand,
  mirrorIntervalSec,
  POWER_PER_STR,
  MIRROR_SPEED_KEYS,
  protectReduction,
} from "./combatStats";
import type {
  AttackDef,
  CombatUnit,
  EnemyStat,
  RaidOutcome,
  RaidStage,
} from "./types";

const STEP_MS = 100; // simulation tick
const MAX_SIM_MS = 20 * 60 * 1000; // safety cap (min-damage 1 prevents true stalls)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Frequency-weighted mean of one Attacks.json field over a unit's attack list.
 *
 *  The binary rolls a fresh attack every cycle (`Actor setAttackVariation` →
 *  `rollAgainstFrequencyInArray:`), and the rolled attack sets BOTH that swing's
 *  `damageMultiplier` and its cycle length (`speedMultiplier`). This resolver is
 *  deterministic, so it collapses the roll to its expectation — and because the
 *  long-run DPS of a renewal process is `E[damage] / E[cycle]`, taking the mean of
 *  each field independently reproduces the real sustained DPS exactly. (For the
 *  Lumberjack: 0.9×1.0 + 0.1×1.5 damage over 0.9×1 + 0.1×5 cycles = the true 22.5
 *  dps, where using the mean damage at the base cadence would have said 30.) */
function avgField(
  attacks: { name: string; frequency: number }[] | undefined,
  table: Record<string, AttackDef>,
  field: "damageMultiplier" | "speedMultiplier"
): number {
  if (!attacks || attacks.length === 0) return 1;
  let wsum = 0;
  let fsum = 0;
  for (const a of attacks) {
    const mult = table[a.name]?.[field] ?? 1;
    const f = a.frequency || 0;
    wsum += mult * f;
    fsum += f;
  }
  return fsum > 0 ? wsum / fsum : 1;
}

function unit(
  id: string,
  sourceKey: string,
  team: "player" | "enemy",
  name: string,
  str: number,
  dex: number,
  con: number,
  focus: number,
  mult: number,
  isBoss: boolean,
  isGarden = false,
  isHeadless = false,
  /** Cycle-length multiplier: the rolled attack's `speedMultiplier` (enemies) times any
   *  per-raid pace rule. 1 = the raw dex clock. See combatStats "Attack CADENCE". */
  speedMult = 1
): CombatUnit {
  // Ground-truth stat->fight-data derivation (initFightDataAfterLoad):
  //   maxHp = con × 100; attack interval = (2s zombie / 1s enemy) ÷ dex.
  const maxHp = Math.max(1, Math.round(deriveMaxHp(con)));
  return {
    id,
    sourceKey,
    team,
    name,
    str,
    dex,
    con,
    focus,
    hp: maxHp,
    maxHp,
    attackCooldownMs: deriveAttackIntervalMs(dex, team) * speedMult,
    attacks: [{ name: "", frequency: 1, mult }],
    isBoss,
    alive: true,
    isGarden,
    isHeadless,
    abilities: [],
  };
}

/** Effective per-hit damage of a combat unit. Ground truth (`Actor damageIn:`):
 *  finalPower × attackDamageMultiplier × band, where finalPower = effective str × 10, the
 *  per-hit `mult` carries the attack's damageMultiplier plus focus/ability modifiers, and
 *  `band` is the player-zombie lineup-depth falloff (1.0 for the front five, then 0.85/0.7/
 *  0.55) — enemies always fight at band 1.0. `lineupIndex` is the attacker's slot in the
 *  player army (front = 0); ignored for enemies. Min 1 so the sim can't stall. */
function hitDamage(u: CombatUnit, lineupIndex = 0): number {
  const power = u.str * POWER_PER_STR;
  const base = deriveHitDamage(power, u.attacks[0]?.mult ?? 1);
  const band = u.team === "player" ? lineupDamageBand(lineupIndex) : 1;
  return Math.max(1, Math.round(base * band));
}

// Distraction model: during an invasion the enemy distracts your zombies, costing
// them a little combat throughput. The `focus` stat (0-100, Help.json: "higher
// focus = less likely distracted; premium zombies 100% focus") is the resistance.
// A unit's damage is scaled by focusFactor below — full at focus 100, down to
// (1 - DISTRACTION_K) at focus 0. The Concentration boost negates it entirely, so
// every zombie fights as if perfectly focused. Kept mild so the tutorial raid
// stays winnable with a low-focus starter army.
const DISTRACTION_K = 0.2;
export function focusFactor(focus: number, concentration: boolean): number {
  if (concentration) return 1;
  return 1 - DISTRACTION_K * (1 - clamp(focus, 0, 100) / 100);
}

/** Build the player's combat line from selected owned zombies. Each unit's stats
 *  compound in the SOURCE'S PIPELINE ORDER (`-[ZombieActor modifyStats:]`, which chains
 *  `modifyStatWithLevelScale:` → `modifyStatWithFarmerHeads:` → `modifyStatWithAbilities:`
 *  → `modifyStatWithRank:` → `modifyStatWithMutations:`), all deterministic:
 *   0. Player-level scale — the level-8→25 ramp, applied to the UNMUTATED base stat.
 *   1. Veterancy — +5%/rank from survived invasions (all stats).
 *   2. Its own unlocked ABILITIES (abilities.ts) — self buffs to damage / HP /
 *      speed / all-stats, gated exactly like the detail card (tier ≤ class rank
 *      AND that ability unlocked). Pass `abilityUnlocked` so combat matches the UI;
 *      omit it (tests) to run with abilities off.
 *   3. Original type-targeted auras — Chivalry buffs Girl zombies, Grace buffs
 *      Regular zombies, Protect reduces damage to non-Headless types, and
 *      Fortitude buffs Headless Life.
 *   4. MUTATIONS LAST — a flat +str/+con/+dex added on top of everything above, never
 *      scaled or multiplied. `OwnedZombie.str/con/dex` already INCLUDE the mutation
 *      bonus (makeOwned bakes it in so the detail card shows the listed stat), so the
 *      bonus is peeled off here, the rest of the chain runs, and it is added back.
 *      Baking it in before the level ramp — the old behaviour — let the lerp toward the
 *      group endpoint eat most of it: a full 5-slot set was worth ~25 % of its value at
 *      level 12, and only reached face value at level 25.
 *  Player attack multipliers aren't baked into zombies.json and the source attacks
 *  are ~1.0, so the base per-hit multiplier is 1x — scaled by the focus-based
 *  distraction factor (negated by Concentration) times any self damage ability. */
/** The lowest str/con/dex a player zombie can be reduced to. Only reachable via a
 *  mutation penalty (mutations.ts MutationStats): every other modifier is a positive
 *  multiplier on a positive base. Zero, not a small positive, because "does nothing"
 *  is a coherent outcome and the derivations below all define a sane behaviour for it
 *  — what must never happen is a NEGATIVE stat inverting the sign of a hit. */
export const MIN_COMBAT_STAT = 0;

export function buildPlayerUnits(
  party: OwnedZombie[],
  opts: {
    concentration?: boolean;
    abilityUnlocked?: (key: string) => boolean;
    /** Current player level. When given, str/con/dex are level-scaled per the
     *  binary's `modifyStatWithLevelScale:` (a zombie doesn't fight at full stats
     *  until level 25). Omit to fight at full base stats (tests / no-scale). */
    playerLevel?: number;
    farmerStrengthMult?: number;
    farmerLifeMult?: number;
  } = {}
): CombatUnit[] {
  // Abilities are off unless the caller supplies the per-ability unlock gate.
  const abilityUnlocked = opts.abilityUnlocked ?? (() => false);
  const conc = !!opts.concentration;
  const lvl = opts.playerLevel;

  // Resolve each unit's ability set once, then count the original group auras.
  // ZFActorFightEffect accumulates percentage changes additively.
  const rows = party.map((z) => {
    const keys = activeAbilities(z, abilityUnlocked);
    return { z, keys, eff: combatEffect(keys) };
  });
  const auraCount = (key: string) => rows.filter((r) => r.keys.includes(key)).length;
  const chivalry = auraCount("chivalry");
  const grace = auraCount("grace");
  const protect = auraCount("protect");
  const fortitude = auraCount("tankHitPointsBuff");

  return rows.map(({ z, keys, eff }) => {
    const v = veterancyMultiplier(z.invasions);
    const base = z.focus ?? 0;
    // Mutations are the LAST link of the source's stat chain, so peel them off the
    // listed stat here and add them back untouched once everything else has applied.
    const mut = mutationBonus(z.mutation);
    // Player-level stat ramp (binary modifyStatWithLevelScale:) — str/con/dex only,
    // NOT focus. Skipped (full base stats) when no playerLevel is supplied.
    const rawStr = z.str - mut.str;
    const rawDex = z.dex - mut.dex;
    const rawCon = z.con - mut.con;
    const bStr = lvl == null ? rawStr : levelScaleStat(z.group, "str", rawStr, lvl);
    const bDex = lvl == null ? rawDex : levelScaleStat(z.group, "dex", rawDex, lvl);
    const bCon = lvl == null ? rawCon : levelScaleStat(z.group, "con", rawCon, lvl);
    const statAura = z.group === "Female" ? chivalry : z.group === "Regular" ? grace : 0;
    const lifeAura = statAura + (z.group === "Headless" ? fortitude : 0);
    const auraBaseStr = bStr * v * eff.allStatsMult * eff.selfDamageMult *
      (opts.farmerStrengthMult ?? 1);
    const auraBaseDex = bDex * v * eff.allStatsMult * eff.selfSpeedMult;
    const auraBaseCon = bCon * v * eff.allStatsMult * eff.selfHpMult *
      (opts.farmerLifeMult ?? 1);
    // A mutation may carry a PENALTY (mutations.ts MutationStats), so the flat term
    // added here can be negative and can in principle outweigh a weak species' base
    // stat. Floor the result: a crippled zombie is meant to be bad, not inverted.
    // Below MIN_COMBAT_STAT the existing derivations take over (a 0 dex becomes the
    // 0.1 floor in deriveAttackIntervalMs = one swing per 20s; a 0 con becomes 1 HP in
    // unit(); a 0 str is simply no damage), which is the intended "useless but alive".
    //
    // No current mutation is negative, so this floor never binds on today's data and
    // every recorded raid replays identically. Authoring the first negative mutation
    // IS a rules change — bump the replay ruleset version in that same commit.
    const str = Math.max(MIN_COMBAT_STAT, auraBaseStr * (1 + statAura * 0.10) + mut.str);
    const dex = Math.max(MIN_COMBAT_STAT, auraBaseDex * (1 + statAura * 0.10) + mut.dex);
    const con = Math.max(MIN_COMBAT_STAT, auraBaseCon * (1 + lifeAura * 0.10) + mut.con);
    const focus = base * v * eff.allStatsMult;
    // Distraction resistance keys off the unit's real focus stat. Damage abilities
    // are already part of finalPower (`str`) so lasers and healing see them too.
    const mult = focusFactor(focus, conc);
    // `isGarden` is the SUPPORT flag, not the body type: it buys the whole rear-station
    // treatment (deploy-last, pinned at GARDEN_STATION_X outside the combat zone, boss
    // throws lobbed at it — see BattleSim armyOrder/assignFormation). A Garden zombie
    // with no healing-type ability has nothing to do back there — heal is the FIFTH
    // tier-1 unlock, so early accounts field exactly that zombie, and it stood at the
    // station doing nothing (soft-locking any fight it was the last survivor of). Only
    // a unit that can actually heal or revive stations; the rest fight in the line.
    // Ruleset v40(a) — see replay.ts.
    const supportsFromRear = z.group === "Garden" &&
      ["heal", "healAOE", "ressurect"].some((ability) => keys.includes(ability));
    const u = unit(
      z.id, z.key, "player", z.name,
      str, dex, con, focus,
      mult, false,
      supportsFromRear, z.group === "Headless"
    );
    u.group = z.group;
    // The BODY's clock, before anything the player did to this individual. Only the
    // pirate boss reads it (combatStats.PIRATE_BOSS_KEY): his slam is priced on the
    // species standing in front of him, so a Headless holds him off whether it is a
    // fresh recruit or a mutated Master.
    u.speciesCycleMs = deriveAttackIntervalMs(rawDex, "player");
    u.className = z.className;
    u.mutation = z.mutation;
    u.color = z.color;
    u.damageReduction = protectReduction(protect, keys.includes("protect"));
    u.teamAuraStats = {
      baseStr: auraBaseStr + mut.str,
      baseDex: auraBaseDex + mut.dex,
      baseCon: auraBaseCon + mut.con,
      strPerCarrier: auraBaseStr * 0.10,
      dexPerCarrier: auraBaseDex * 0.10,
      conPerCarrier: auraBaseCon * 0.10,
    };
    u.walkingSpeedMult = keys.includes("turboSpeed") ? 2 : 1;
    u.abilities = keys; // carried into the live scene (strip + activated moves)
    return u;
  });
}

/** Knockback / stun an enemy's attacks can inflict. An enemy knocks back if ANY of
 *  its attacks does (Attacks.json `knockBack`); its stun is the longest `stunTimer`
 *  among stun attacks (seconds → ms). Recovered from the binary — knockback sends the
 *  struck zombie to the back of the line (see RAID_TIMING_AND_HAZARDS.md). */
/** An enemy's knockback / stun, and HOW OFTEN each lands.
 *
 *  GROUND TRUTH: a unit does not have "an attack with effects" — it rolls ONE attack per
 *  swing out of its `attacks` list (`rollAgainstFrequencyInArray:`, the same weighted
 *  picker the boss action budget uses) and applies THAT attack's flags. So an effect
 *  carried by one entry lands at that entry's share of the list's total frequency.
 *
 *  This used to collapse the list to a single boolean, which handed every entry the
 *  effects of the rarest one. The Lumberjack is the clearest victim: `LumberjackSlice`
 *  is 90 % of his swings and carries nothing, while `LumberjackSpecial` is 10 % and
 *  carries the shove — so he knocked a zombie down the lane on EVERY hit instead of one
 *  in ten. Most units are unaffected (their effect entry is already 100 %); the ones that
 *  move are the Lumberjack at 10 %, the Lawyers boss's stun at 40 %, and the
 *  Special/TreeWorld/Valentine's minions 2 and 3 at 50 %. */
function attackEffects(
  attacks: { name: string; frequency: number }[] | undefined,
  table: Record<string, AttackDef>
): { knockBack: boolean; knockBackChance: number; stunMs: number; stunChance: number } {
  let stunMs = 0;
  let knockWeight = 0;
  let stunWeight = 0;
  let total = 0;
  for (const a of attacks ?? []) {
    const freq = a.frequency || 0;
    total += freq;
    const def = table[a.name];
    if (!def) continue;
    if (def.knockBack) knockWeight += freq;
    if (def.stun) {
      stunWeight += freq;
      stunMs = Math.max(stunMs, (def.stunTimer ?? 1) * 1000);
    }
  }
  const share = (weight: number) => (total > 0 ? weight / total : 0);
  return {
    knockBack: knockWeight > 0,
    knockBackChance: share(knockWeight),
    stunMs,
    stunChance: share(stunWeight),
  };
}

/** Representative damage-timing for an enemy's swing animation: the `damageTiming` of
 *  its most-frequent (primary) attack that defines one — the visible normal attack —
 *  falling back to a neutral mid-swing 0.5. Cosmetic only (drives the raid-scene lunge). */
function primaryDamageTiming(
  attacks: { name: string; frequency: number }[] | undefined,
  table: Record<string, AttackDef>
): number {
  let best: number | undefined;
  let bestFreq = -1;
  for (const a of attacks ?? []) {
    const dt = table[a.name]?.damageTiming;
    if (dt === undefined) continue;
    const f = a.frequency || 0;
    if (f > bestFreq) {
      bestFreq = f;
      best = dt;
    }
  }
  return best ?? 0.5;
}

/** Allocate an exact-size deterministic population from a weighted table. Start with
 * each entry's floor, then give the remaining slots to the largest fractional shares.
 * This preserves `population` exactly instead of independently rounding into extra units. */
function weightedPopulation(stage: RaidStage): string[] {
  const population = Math.max(0, Math.floor(stage.population ?? 0));
  const weighted = (stage.weighted ?? []).filter((entry) => entry.frequency > 0);
  const total = weighted.reduce((sum, entry) => sum + entry.frequency, 0);
  if (!population || total <= 0) return [];
  const shares = weighted.map((entry, index) => {
    const exact = (entry.frequency / total) * population;
    return { entry, index, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = population - shares.reduce((sum, share) => sum + share.count, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left-- <= 0) break;
    share.count++;
  }
  return shares.flatMap(({ entry, count }) => Array(count).fill(entry.enemy));
}

/** Build one enemy wave's combat line from a raid stage + stat/attack tables.
 *  Weighted-population waves fall back to filling `population` from the table.
 *
 *  `opts` carries the two context-dependent cadence rules recovered from
 *  `-[Actor getFightAttackSpeed]`; pass BOTH client- and server-side or the
 *  deterministic replay diverges:
 *   - `raidId` + `playerLevel` → Old McDonnell's farm speeds its enemies up as you
 *     out-level it (×0.66 at L10, ×0.44 at L15). No other raid scales.
 *   - the Scallywag is flagged here and mirrors its opponent at fight time.
 *
 *  `opts.elite` is the Brain Ticket's ELITE multipliers (eliteInvasion.ts), or
 *  null/absent for an ordinary invasion. It scales str/con/dex BEFORE the derivations
 *  below, so hit points, per-hit damage and the attack clock all follow from the scaled
 *  stat exactly as they do normally. Like the two rules above it, pass it identically on
 *  the client and the server or the deterministic replay diverges. */
export function buildEnemyUnits(
  stage: RaidStage,
  stats: Record<string, EnemyStat>,
  attacks: Record<string, AttackDef>,
  opts: { raidId?: number; playerLevel?: number; elite?: EliteProfile | null } = {}
): CombatUnit[] {
  const keys =
    stage.enemyKeys && stage.enemyKeys.length
      ? stage.enemyKeys
      : weightedPopulation(stage);
  return buildUnitsForKeys(keys, stage.bossKey ?? null, stats, attacks, opts);
}

/** Build combat units for an explicit list of unit keys — the shared body of
 *  `buildEnemyUnits` and of the alien boss's abductee roster (BattleSim's summonBoss).
 *  Everything an abducted human brings to the fight is derived exactly as a wave
 *  minion's is, so the same elite/pace context applies to both. */
export function buildUnitsForKeys(
  keys: string[],
  bossKey: string | null,
  stats: Record<string, EnemyStat>,
  attacks: Record<string, AttackDef>,
  opts: { raidId?: number; playerLevel?: number; elite?: EliteProfile | null } = {}
): CombatUnit[] {
  const out: CombatUnit[] = [];
  const pace = farmRaidEnemyPace(opts.raidId, opts.playerLevel);
  const add = (key: string, boss: boolean) => {
    const base = stats[key];
    if (!base) return;
    const st = eliteEnemyStat(base, opts.elite ?? null, boss);
    const u = unit(
      `e${out.length}`,
      key,
      "enemy",
      key,
      st.str ?? 1,
      st.dex ?? 1,
      st.con ?? 1,
      st.focus ?? 0,
      avgField(st.attacks, attacks, "damageMultiplier"),
      boss,
      false,
      false,
      avgField(st.attacks, attacks, "speedMultiplier") * pace
    );
    u.mirrorsOpponentSpeed = MIRROR_SPEED_KEYS.has(key);
    const fx = attackEffects(st.attacks, attacks);
    u.knockBack = fx.knockBack;
    u.knockBackChance = fx.knockBackChance;
    u.stunMs = fx.stunMs;
    u.stunChance = fx.stunChance;
    u.attackDamageTiming = primaryDamageTiming(st.attacks, attacks);
    out.push(u);
  };
  for (const k of keys) add(k, false);
  if (bossKey) add(bossKey, true);
  return out;
}

/** Run the deterministic auto-battle. Player wins iff all enemies die first.
 *
 *  Engagement model: **enemies come out ONE AT A TIME** (matching the live raid scene) —
 *  only the front enemy is "out": it attacks the lead zombie, and the player's whole living
 *  army focus-fires it. The rest of the wave is queued and doesn't act until it reaches the
 *  front. This is what makes army SIZE matter (concentration) instead of the enemy wave
 *  dog-piling the front zombie; a single strong enemy or a numbers disadvantage still loses.
 *  (Player-side melee-slot limits — how many zombies can reach the one enemy at once — are
 *  not yet modeled; today the whole army engages.) */
export function resolveRaid(
  player: CombatUnit[],
  enemy: CombatUnit[]
): RaidOutcome {
  // Fresh copies so callers can reuse their arrays (and so a future replay can
  // re-run from the same inputs).
  const p = player.map((u) => ({ ...u, hp: u.maxHp, alive: true }));
  const e = enemy.map((u) => ({ ...u, hp: u.maxHp, alive: true }));
  const cd = new Map<string, number>(); // unit id -> ms until next attack
  // Lineup index per player (front = 0) for the depth bands. This simple resolver
  // doesn't re-slot on knockback, so the static party order is the lineup.
  const lineup = new Map<string, number>(p.map((u, i) => [u.id, i]));
  /** A unit's effective cycle in ms: the depth SLOWDOWN band for zombies (ground truth
   *  `getFightAttackSpeed`), and for a mirroring pirate the mirror of its current foe —
   *  the foe's CURRENT cycle for a Scallywag, its SPECIES BASE cycle for Arrrnold. */
  const cycleMs = (u: CombatUnit, foe: CombatUnit | null) => {
    if (u.team === "player") return u.attackCooldownMs * lineupSpeedBand(lineup.get(u.id) ?? 0);
    if (u.mirrorsOpponentSpeed && foe) {
      const foeSec = (foe.attackCooldownMs * lineupSpeedBand(lineup.get(foe.id) ?? 0)) / 1000;
      const speciesSec = (foe.speciesCycleMs ?? foe.attackCooldownMs) / 1000;
      return mirrorIntervalSec(u.sourceKey, foeSec, speciesSec) * 1000;
    }
    return u.attackCooldownMs;
  };
  for (const u of [...p, ...e]) cd.set(u.id, cycleMs(u, null));

  const firstAlive = (arr: CombatUnit[]) => arr.find((u) => u.alive) ?? null;
  let rounds = 0;
  let playerDamage = 0;

  for (let t = 0; t < MAX_SIM_MS; t += STEP_MS) {
    const frontEnemy = firstAlive(e);
    if (!firstAlive(p) || !frontEnemy) break;
    // Acting units this tick: the ONE front enemy, then every living zombie (order fixed
    // for determinism — enemy first). Queued enemies stay off the field.
    const actors: CombatUnit[] = [frontEnemy, ...p];
    for (const u of actors) {
      if (!u.alive) continue;
      const foes = u.team === "player" ? e : p;
      const target = firstAlive(foes);
      const left = (cd.get(u.id) ?? u.attackCooldownMs) - STEP_MS;
      if (left > 0) {
        cd.set(u.id, left);
        continue;
      }
      cd.set(u.id, cycleMs(u, target)); // reset regardless of a valid target
      if (!target) continue;
      // Binary `Actor damage:`: flat armor subtracts first, then % reduction.
      const dmg = applyDamage(
        hitDamage(u, lineup.get(u.id) ?? 0),
        target.armor ?? 0,
        target.damageReduction ?? 0
      );
      target.hp -= dmg;
      rounds++;
      if (u.team === "player") playerDamage += dmg;
      if (target.hp <= 0) target.alive = false;
    }
  }

  const win = !firstAlive(e);
  return {
    win,
    rounds,
    survivors: p.filter((u) => u.alive).map((u) => u.id),
    losses: p.filter((u) => !u.alive).map((u) => u.id),
    enemiesBeaten: e.filter((u) => !u.alive).length,
    playerDamage,
  };
}

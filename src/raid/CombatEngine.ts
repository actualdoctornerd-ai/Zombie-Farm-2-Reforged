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
import { activeAbilities, combatEffect, ARMY_HP_MULT_CAP } from "../zombie/abilities";
import {
  applyDamage,
  levelScaleStat,
  deriveMaxHp,
  deriveAttackIntervalMs,
  deriveHitDamage,
  POWER_PER_STR,
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

// Enemy attack-pace correction. The disassembled fight-data interval is C/dex with
// C=1.0 for enemies (combatStats.ts, ground truth). But in the live scene enemies then
// re-attack the instant their clock expires — the reimpl sim doesn't model the per-swing
// attack-ANIMATION time that gates the real game's next strike, so enemies come out ~2×
// too fast. Eyeballed against the real game: a Pirate brute (dex 0.5) attacks ~every 4s
// and the boss (dex 0.4) ~every 5-6s — i.e. 2/dex, not 1/dex. So we scale enemy cooldowns
// by this. (Kept OUT of combatStats.ts so its disassembly ground truth + tests stay intact.)
const ENEMY_ATTACK_PACE = 2;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Frequency-weighted mean damage multiplier for a unit's attack list. */
function avgMult(
  attacks: { name: string; frequency: number }[] | undefined,
  table: Record<string, AttackDef>
): number {
  if (!attacks || attacks.length === 0) return 1;
  let wsum = 0;
  let fsum = 0;
  for (const a of attacks) {
    const mult = table[a.name]?.damageMultiplier ?? 1;
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
  isHeadless = false
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
    attackCooldownMs:
      deriveAttackIntervalMs(dex, team) * (team === "enemy" ? ENEMY_ATTACK_PACE : 1),
    attacks: [{ name: "", frequency: 1, mult }],
    isBoss,
    alive: true,
    isGarden,
    isHeadless,
    abilities: [],
  };
}

/** Effective per-hit damage of a combat unit. Ground truth (`Actor damageIn:`):
 *  finalPower × attackDamageMultiplier × K, where finalPower = effective str × 10 and the
 *  per-hit `mult` carries the attack's damageMultiplier plus focus/ability modifiers.
 *  Min 1 so the sim can't stall. */
function hitDamage(u: CombatUnit): number {
  const power = u.str * POWER_PER_STR;
  return Math.max(1, Math.round(deriveHitDamage(power, u.attacks[0]?.mult ?? 1)));
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
 *  compound three layers, all deterministic:
 *   1. Veterancy — +5%/rank from survived invasions (all stats).
 *   2. Its own unlocked ABILITIES (abilities.ts) — self buffs to damage / HP /
 *      speed / all-stats, gated exactly like the detail card (tier ≤ class rank
 *      AND that ability unlocked). Pass `abilityUnlocked` so combat matches the UI;
 *      omit it (tests) to run with abilities off.
 *   3. Army-wide sustain — heals / protection / revive / enemy-stun from any unit
 *      in the party lift every unit's effective HP (stacked, capped).
 *  Player attack multipliers aren't baked into zombies.json and the source attacks
 *  are ~1.0, so the base per-hit multiplier is 1x — scaled by the focus-based
 *  distraction factor (negated by Concentration) times any self damage ability. */
export function buildPlayerUnits(
  party: OwnedZombie[],
  opts: {
    concentration?: boolean;
    abilityUnlocked?: (key: string) => boolean;
    /** Current player level. When given, str/con/dex are level-scaled per the
     *  binary's `modifyStatWithLevelScale:` (a zombie doesn't fight at full stats
     *  until level 25). Omit to fight at full base stats (tests / no-scale). */
    playerLevel?: number;
  } = {}
): CombatUnit[] {
  // Abilities are off unless the caller supplies the per-ability unlock gate.
  const abilityUnlocked = opts.abilityUnlocked ?? (() => false);
  const conc = !!opts.concentration;
  const lvl = opts.playerLevel;

  // Resolve each unit's ability set once, and aggregate the army-wide sustain
  // across the whole party before building any unit.
  const rows = party.map((z) => {
    const keys = activeAbilities(z, abilityUnlocked);
    return { z, keys, eff: combatEffect(keys) };
  });
  const armyHpMult = Math.min(
    ARMY_HP_MULT_CAP,
    rows.reduce((m, r) => m * r.eff.armyHpMult, 1)
  );

  return rows.map(({ z, keys, eff }) => {
    const v = veterancyMultiplier(z.invasions);
    const base = z.focus ?? 0;
    // Player-level stat ramp (binary modifyStatWithLevelScale:) — str/con/dex only,
    // NOT focus. Skipped (full base stats) when no playerLevel is supplied.
    const bStr = lvl == null ? z.str : levelScaleStat(z.group, "str", z.str, lvl);
    const bDex = lvl == null ? z.dex : levelScaleStat(z.group, "dex", z.dex, lvl);
    const bCon = lvl == null ? z.con : levelScaleStat(z.group, "con", z.con, lvl);
    const str = bStr * v * eff.allStatsMult;
    const dex = bDex * v * eff.allStatsMult * eff.selfSpeedMult;
    const con = bCon * v * eff.allStatsMult * eff.selfHpMult;
    const focus = base * v * eff.allStatsMult;
    // Distraction resistance keys off the unit's real focus stat; self-damage
    // abilities and army-wide effects fold into the per-hit multiplier / HP.
    const mult = focusFactor(base, conc) * eff.selfDamageMult;
    const u = unit(
      z.id, z.key, "player", z.name,
      str, dex, con, focus,
      mult, false,
      z.group === "Garden", z.group === "Headless"
    );
    u.maxHp = Math.max(1, Math.round(u.maxHp * armyHpMult));
    u.hp = u.maxHp;
    u.abilities = keys; // carried into the live scene (strip + activated moves)
    return u;
  });
}

/** Knockback / stun an enemy's attacks can inflict. An enemy knocks back if ANY of
 *  its attacks does (Attacks.json `knockBack`); its stun is the longest `stunTimer`
 *  among stun attacks (seconds → ms). Recovered from the binary — knockback sends the
 *  struck zombie to the back of the line (see RAID_TIMING_AND_HAZARDS.md). */
function attackEffects(
  attacks: { name: string; frequency: number }[] | undefined,
  table: Record<string, AttackDef>
): { knockBack: boolean; stunMs: number } {
  let knockBack = false;
  let stunMs = 0;
  for (const a of attacks ?? []) {
    const def = table[a.name];
    if (!def) continue;
    if (def.knockBack) knockBack = true;
    if (def.stun) stunMs = Math.max(stunMs, (def.stunTimer ?? 1) * 1000);
  }
  return { knockBack, stunMs };
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

/** Build one enemy wave's combat line from a raid stage + stat/attack tables.
 *  Weighted-population waves fall back to filling `population` from the table. */
export function buildEnemyUnits(
  stage: RaidStage,
  stats: Record<string, EnemyStat>,
  attacks: Record<string, AttackDef>
): CombatUnit[] {
  const out: CombatUnit[] = [];
  const add = (key: string, boss: boolean) => {
    const st = stats[key];
    if (!st) return;
    const u = unit(
      `e${out.length}`,
      key,
      "enemy",
      key,
      st.str ?? 1,
      st.dex ?? 1,
      st.con ?? 1,
      st.focus ?? 0,
      avgMult(st.attacks, attacks),
      boss
    );
    const fx = attackEffects(st.attacks, attacks);
    u.knockBack = fx.knockBack;
    u.stunMs = fx.stunMs;
    u.attackDamageTiming = primaryDamageTiming(st.attacks, attacks);
    out.push(u);
  };
  const keys =
    stage.enemyKeys && stage.enemyKeys.length
      ? stage.enemyKeys
      : (stage.weighted ?? []).flatMap((w) =>
          Array(Math.max(1, Math.round((w.frequency / 100) * (stage.population ?? 0)))).fill(
            w.enemy
          )
        );
  for (const k of keys) add(k, false);
  if (stage.bossKey) add(stage.bossKey, true);
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
  for (const u of [...p, ...e]) cd.set(u.id, u.attackCooldownMs);

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
      const left = (cd.get(u.id) ?? u.attackCooldownMs) - STEP_MS;
      if (left > 0) {
        cd.set(u.id, left);
        continue;
      }
      cd.set(u.id, u.attackCooldownMs); // reset regardless of a valid target
      const target = firstAlive(foes);
      if (!target) continue;
      // Binary `Actor damage:`: flat armor subtracts first, then % reduction.
      const dmg = applyDamage(hitDamage(u), target.armor ?? 0, target.damageReduction ?? 0);
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

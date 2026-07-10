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
import { applyDamage, levelScaleStat } from "./combatStats";
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
  const maxHp = Math.max(1, Math.round(con * 10));
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
    attackCooldownMs: clamp(3000 / Math.max(0.1, dex), 600, 3500),
    attacks: [{ name: "", frequency: 1, mult }],
    isBoss,
    alive: true,
    isGarden,
    isHeadless,
    abilities: [],
  };
}

/** Effective per-hit damage of a combat unit. */
function hitDamage(u: CombatUnit): number {
  return Math.max(1, Math.round(u.str * (u.attacks[0]?.mult ?? 1)));
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
 *      AND the tier's boss beaten). Pass `tierUnlocked` so combat matches the UI;
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
    tierUnlocked?: (tier: number) => boolean;
    /** Current player level. When given, str/con/dex are level-scaled per the
     *  binary's `modifyStatWithLevelScale:` (a zombie doesn't fight at full stats
     *  until level 25). Omit to fight at full base stats (tests / no-scale). */
    playerLevel?: number;
  } = {}
): CombatUnit[] {
  // Abilities are off unless the caller supplies the tier-unlock gate.
  const tierUnlocked = opts.tierUnlocked ?? (() => false);
  const conc = !!opts.concentration;
  const lvl = opts.playerLevel;

  // Resolve each unit's ability set once, and aggregate the army-wide sustain
  // across the whole party before building any unit.
  const rows = party.map((z) => {
    const keys = activeAbilities(z, tierUnlocked);
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

/** Run the deterministic auto-battle. Player wins iff all enemies die first. */
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
    if (!firstAlive(p) || !firstAlive(e)) break;
    // Enemies act, then players — order is fixed for determinism.
    for (const side of [e, p]) {
      const foes = side === p ? e : p;
      for (const u of side) {
        if (!u.alive) continue;
        const left = (cd.get(u.id) ?? u.attackCooldownMs) - STEP_MS;
        if (left > 0) {
          cd.set(u.id, left);
          continue;
        }
        cd.set(u.id, u.attackCooldownMs); // reset regardless of a valid target
        const target = firstAlive(foes);
        if (!target) continue;
        // Binary `Actor damage:`: flat armor subtracts first, then % reduction.
        // Both default to 0 (no enemy/player DR is modeled yet) so this is
        // behavior-preserving today, but faithful in shape and DR-ready.
        const dmg = applyDamage(hitDamage(u), target.armor ?? 0, target.damageReduction ?? 0);
        target.hp -= dmg;
        rounds++;
        if (u.team === "player") playerDamage += dmg;
        if (target.hp <= 0) target.alive = false;
      }
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

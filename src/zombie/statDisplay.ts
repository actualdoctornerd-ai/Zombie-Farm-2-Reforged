// ---------------------------------------------------------------------------
// Displayed-stat resolution — the number the detail card / army list shows for a
// zombie's Damage / Speed / Life / Focus, and the per-modifier breakdown behind it.
//
// The shown value is NOT the raw stat: it folds in every ALWAYS-ON bonus that
// affects THIS zombie, then normalizes to the 0–100 reference bar (traits.displayStat):
//   effective = (base + mutation) × veterancy × Π(self passive stat-abilities)
//   shown     = round(effective / STAT_DISPLAY_MAX × 100)   [focus: round(effective)]
//
// Included modifiers (per the game + user spec):
//   • Mutation   — baked into the raw str/con/dex by makeOwned; additive; focus never.
//   • Veterancy  — ×(1 + 0.05·rank), scales ALL stats incl. focus (Master = +25%).
//   • Abilities  — ONLY the zombie's own passive ("self") stat buffs that are unlocked
//                  and in class-rank. Team/aura buffs (Chivalry, Grace, Heal, Protect…)
//                  and player-activated moves (Bash, Explode…) are excluded — they don't
//                  passively raise this unit's own stat. Mirrors raid/CombatEngine.
//
// Everything here is pure + headless-testable; no Pixi, no game-state object.
// ---------------------------------------------------------------------------

import { StatMeta, displayStat, veterancyMultiplier, veterancy, ABILITY_POOL } from "./traits";
import { ABILITY_KIND, ABILITY_COMBAT, activeAbilities, AbilityCombatEffect } from "./abilities";
import { mutationBonus } from "./mutations";

/** The minimum a zombie must carry to resolve its displayed stats. */
export interface StatSource {
  str: number;
  dex: number;
  con: number;
  focus: number;
  mutation: number; // bitmask (mutationBonus)
  invasions: number; // → veterancy rank
  key: string; // named-unique ability overrides
  group: string; // group ability set
  className: string; // colour class → ability rank
}

/** One line in a stat's hover breakdown. */
export interface StatModifierLine {
  label: string; // "Mutation", "+10% Power", "Veterancy (Master)"
  amount: string; // "+13" (mutation, display units) or "+25%" (multipliers)
  zero: boolean; // true when this modifier currently contributes nothing (dim it)
}

export interface StatBreakdown {
  base: number; // normalized base, before any modifier
  total: number; // normalized value with every modifier applied (what the tile shows)
  lines: StatModifierLine[]; // mutation → each self ability → veterancy, in that order
}

const STAT_KEYS = ["str", "dex", "con", "focus"] as const;

/** True if an ability effect raises one of the unit's OWN displayed stats (as opposed
 *  to an army-wide effect like `stun`'s armyHpMult, which touches no self stat). */
function affectsSelfStat(e: AbilityCombatEffect): boolean {
  return (
    (e.allStatsMult ?? 1) !== 1 ||
    (e.selfDamageMult ?? 1) !== 1 ||
    (e.selfHpMult ?? 1) !== 1 ||
    (e.selfSpeedMult ?? 1) !== 1
  );
}

/** The zombie's active, always-on, self-affecting stat abilities — the SAME gated set
 *  the detail card / CombatEngine use, minus team buffs, activated moves, and abilities
 *  whose only effect is army-wide. `abilityUnlocked` gates by beaten-boss tier. */
export function selfStatAbilities(
  z: Pick<StatSource, "key" | "group" | "className">,
  abilityUnlocked: (key: string) => boolean
): string[] {
  return activeAbilities(z, abilityUnlocked).filter(
    (k) => ABILITY_KIND[k] === "self" && affectsSelfStat(ABILITY_COMBAT[k] ?? {})
  );
}

/** One ability's multiplier on a single displayed stat (1 = no effect). "Damage" (str)
 *  tracks selfDamageMult, "Speed" (dex) selfSpeedMult, "Life" (con) selfHpMult; all four
 *  also carry allStatsMult (the "+N% All Stats" buffs, which the game applies to focus). */
export function abilityStatMult(key: string, stat: StatMeta["key"]): number {
  const e = ABILITY_COMBAT[key];
  if (!e) return 1;
  const all = e.allStatsMult ?? 1;
  if (stat === "str") return all * (e.selfDamageMult ?? 1);
  if (stat === "dex") return all * (e.selfSpeedMult ?? 1);
  if (stat === "con") return all * (e.selfHpMult ?? 1);
  return all; // focus — only "All Stats" touches it
}

function rawStat(z: StatSource, stat: StatMeta["key"]): number {
  return stat === "str" ? z.str : stat === "dex" ? z.dex : stat === "con" ? z.con : z.focus;
}

/** Full breakdown for one stat: base, every applied modifier (incl. +0 ones so the
 *  player sees the slot exists), and the normalized total the tile displays. */
export function statBreakdown(
  z: StatSource,
  stat: StatMeta["key"],
  abilityUnlocked: (key: string) => boolean
): StatBreakdown {
  const raw = rawStat(z, stat); // already includes the mutation bonus (makeOwned)
  const mut = stat === "focus" ? 0 : mutationBonus(z.mutation)[stat as "str" | "con" | "dex"];
  const baseRaw = raw - mut;
  const v = veterancyMultiplier(z.invasions);
  const abilities = selfStatAbilities(z, abilityUnlocked);

  let effective = raw * v;
  for (const k of abilities) effective *= abilityStatMult(k, stat);

  const lines: StatModifierLine[] = [];
  // Mutation — additive; shown in display units (e.g. "+13"). Focus can't be mutated,
  // so it never gets a mutation line. Shown even at +0 to reveal the slot exists.
  if (stat !== "focus") {
    const delta = displayStat(stat, raw) - displayStat(stat, baseRaw);
    lines.push({ label: "Mutation", amount: `${delta >= 0 ? "+" : ""}${delta}`, zero: mut === 0 });
  }
  // Each self stat-ability, in tier order, with its % on THIS stat (+0% where it
  // doesn't touch this stat — demonstrating it's present but not contributing here).
  for (const k of abilities) {
    const pct = Math.round((abilityStatMult(k, stat) - 1) * 100);
    lines.push({ label: ABILITY_POOL[k]?.label ?? k, amount: `${pct >= 0 ? "+" : ""}${pct}%`, zero: pct === 0 });
  }
  // Veterancy — always applicable to every stat; +0% at Newbie is still shown.
  const vpct = Math.round((v - 1) * 100);
  lines.push({ label: `Veterancy (${veterancy(z.invasions)})`, amount: `+${vpct}%`, zero: vpct === 0 });

  return { base: displayStat(stat, baseRaw), total: displayStat(stat, effective), lines };
}

/** The four displayed totals (Damage/Speed/Life/Focus) for a zombie — the value each
 *  stat tile shows, with every always-on bonus folded in. Convenience for surfaces
 *  that show the numbers without the hover breakdown (e.g. the compact army list). */
export function displayTotals(
  z: StatSource,
  abilityUnlocked: (key: string) => boolean
): Record<StatMeta["key"], number> {
  const out = {} as Record<StatMeta["key"], number>;
  for (const k of STAT_KEYS) out[k] = statBreakdown(z, k, abilityUnlocked).total;
  return out;
}

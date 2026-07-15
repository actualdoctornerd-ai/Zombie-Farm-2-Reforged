// Ability COMBAT EFFECTS — the bridge from the display-only ability matrix
// (traits.ts) into the deterministic raid resolver (raid/CombatEngine.ts) and,
// through the baked CombatUnit stats, the live battle sim (raid/BattleSim.ts).
//
// The resolver is deterministic and RNG-free by design: it already collapses the
// "which attack" RNG to an expected value (avgMult). Abilities follow the same
// philosophy — every effect is expressed as a deterministic multiplier on a stat
// the combat model already reads (per-hit damage, effective HP, or attack speed),
// so chance-based abilities ("small chance to hit twice") become their expected
// value ("+15% damage"). This keeps battles replayable and lets BOTH engines
// benefit for free, since they both consume the CombatUnit that buildPlayerUnits
// produces.
//
// A zombie's ACTIVE abilities are gated exactly like the detail card (see hud.ts
// buildZombieDetail): for each tier 1..(its colour-class rank), the tier's ability
// applies only once THAT ability has been unlocked (its tier's invasion boss beaten
// enough times to reach it). So combat power tracks what the player sees on the
// card — no hidden bonuses.

import { MAX_ABILITY_TIER, unitAbilityAt, abilityTierOf } from "./traits";
import { classTierRank } from "./taxonomy";
import type { OwnedZombie } from "./types";

// How an ability behaves in the live raid, which also decides whether it shows in
// the battle's top-left ability strip (RaidScene):
//   "self"      — a passive buff to its OWN stats (+% All / +% Life / Turbo Walk /
//                 the auto Laser attack / chance-based Stun/Block/Double). Baked
//                 into combat stats; NOT shown in the strip (no player decision).
//   "team"      — passively affects OTHER zombies (Heal / Heal All / Protect /
//                 Resurrect) or is a flavour buff on the party (Chivalry / Grace).
//                 Automatic; shown in the strip as an informational icon.
//   "activated" — a player-triggered move (Bash / Smash / Explode / Mini Buddy):
//                 tap it in the strip and one eligible zombie performs it. Shown
//                 in the strip as a tappable button with a ready-count badge.
export type AbilityKind = "self" | "team" | "activated";

export const ABILITY_KIND: Record<string, AbilityKind> = {
  // self (hidden from the strip)
  buffAllStats: "self", attackSpeedBuff: "self", powerBuff: "self",
  hitPointsBuff: "self", tankHitPointsBuff: "self", turboSpeed: "self",
  laserBeam: "self", zomBeam: "self", stun: "self", doubleStrike: "self", block: "self",
  // team (shown, automatic)
  heal: "team", healAOE: "team", protect: "team", ressurect: "team",
  chivalry: "team", grace: "team",
  // activated (shown, tappable — one zombie per tap)
  attachMini: "activated", bash: "activated", bashV2: "activated",
  explode: "activated", explodeV2: "activated",
};

/** Live-battle parameters for an ACTIVATED ability. `damageFactor` multiplies the
 *  performing zombie's normal per-hit damage into the payoff blow; `windupMs` is
 *  the telegraphed charge (Bash raises its arms for 4s, then hits massively). */
export interface ActivatedAbility {
  windupMs: number;
  /** Payoff = performer's base hit × this. Bash/Smash are huge; the trade is the
   *  long, exposed wind-up during which the zombie doesn't make normal attacks. */
  damageFactor: number;
  /** Hit every on-field enemy (Explode), not just the current target. */
  aoe?: boolean;
  /** Also stun the struck enemy(ies) for this long (delays their next attack). */
  stunMs?: number;
  /** Cooldown before the SAME zombie can be activated again. */
  cooldownMs: number;
}

export const ACTIVATED_ABILITY: Record<string, ActivatedAbility> = {
  //  Bash: 4s arms-up wind-up, then a massive single hit (user spec).
  bash: { windupMs: 4000, damageFactor: 8, cooldownMs: 6000 },
  //  Smash (Bash Ver.2): same tell, even bigger.
  bashV2: { windupMs: 4000, damageFactor: 14, cooldownMs: 6000 },
  //  Explode: shorter charge, hits the whole enemy line and stuns it.
  explode: { windupMs: 2500, damageFactor: 5, aoe: true, stunMs: 1500, cooldownMs: 7000 },
  explodeV2: { windupMs: 2500, damageFactor: 8, aoe: true, stunMs: 2500, cooldownMs: 7000 },
  // Mini Buddy is state-driven in BattleSim: mount before deployment, 2× run,
  // arrival stun, then deploy both units. These generic hit fields are unused.
  attachMini: { windupMs: 0, damageFactor: 0, cooldownMs: 5000 },
};

/** How one ability modifies its owner (and, for sustain/support, the whole army).
 *  Every field is a multiplier defaulting to 1 (no effect). */
export interface AbilityCombatEffect {
  /** Multiplies str/dex/con/focus together (the "+N% All Stats" buffs). */
  allStatsMult?: number;
  /** Multiplies this unit's per-hit damage. */
  selfDamageMult?: number;
  /** Multiplies this unit's effective HP. */
  selfHpMult?: number;
  /** Multiplies this unit's DEX (→ shorter attack cooldown / faster advance). */
  selfSpeedMult?: number;
  /** Multiplies the WHOLE player army's effective HP (heals, protection, revive,
   *  enemy-stun mitigation — all model as the army surviving longer). */
  armyHpMult?: number;
}

// Per-ability magnitudes, keyed by the ability_*.png basename used in traits.ts.
//
// CONFIRMED tags are the user-verified magnitudes already recorded in
// traits.ABILITY_POOL.effect (+5% All / +10% Speed / +10% Power / +10% Life,
// turboSpeed 2× walk, resurrect once). Everything marked EYEBALLED is a starting
// value to be tuned from playtest feedback — the flavour is real, the number isn't.
export const ABILITY_COMBAT: Record<string, AbilityCombatEffect> = {
  // ---- Tier 1 ----
  buffAllStats: { allStatsMult: 1.05 }, // CONFIRMED +5% all
  attackSpeedBuff: { selfSpeedMult: 1.1 }, // CONFIRMED +10% speed
  powerBuff: { selfDamageMult: 1.1 }, // CONFIRMED +10% power
  hitPointsBuff: { selfHpMult: 1.1 }, // CONFIRMED +10% life
  heal: {}, // live BattleSim performs actual targeted healing

  // ---- Tier 2 ----
  chivalry: { allStatsMult: 1.03 }, // EYEBALLED — no in-game description exists
  grace: { selfSpeedMult: 1.05 }, // EYEBALLED — no in-game description exists
  attachMini: { selfDamageMult: 1.1 }, // ACTIVATED (live) — modest instant-resolve EV
  protect: { armyHpMult: 1.08 }, // EYEBALLED "others take less damage when near"
  tankHitPointsBuff: { selfHpMult: 1.25 }, // EYEBALLED Fortitude "a lot tougher"

  // ---- Tier 3 ----
  laserBeam: { selfDamageMult: 1.15 }, // EYEBALLED auto ranged chip while advancing
  stun: { armyHpMult: 1.05 }, // EYEBALLED stunned enemies attack less → army survives
  explode: { selfDamageMult: 1.15 }, // ACTIVATED (live) — modest instant-resolve EV
  bash: { selfDamageMult: 1.15 }, // ACTIVATED (live) — modest instant-resolve EV
  turboSpeed: { selfSpeedMult: 1.15 }, // CONFIRMED 2× WALK (movement) — modest attack proxy here
  ressurect: { armyHpMult: 1.1 }, // CONFIRMED once-per-battle revive ≈ +army effective HP

  // ---- Tier 4 (the ".Ver.2" upgrades hit harder) ----
  zomBeam: { selfDamageMult: 1.25 }, // EYEBALLED auto laser v2 (also hits boss)
  doubleStrike: { selfDamageMult: 1.15 }, // EYEBALLED EV of a small double-hit chance
  explodeV2: { selfDamageMult: 1.25 }, // ACTIVATED (live) — modest instant-resolve EV
  bashV2: { selfDamageMult: 1.25 }, // ACTIVATED (live) — modest instant-resolve EV
  block: { selfHpMult: 1.15 }, // EYEBALLED EV of a small block chance
  healAOE: {}, // live BattleSim performs actual periodic heal-all
};

// Army-wide sustain stacks multiplicatively across the party (two healers help
// more than one), but is capped so a full support army can't become unkillable.
export const ARMY_HP_MULT_CAP = 1.6;

/** The gated, currently-active ability keys for one owned zombie — the SAME set
 *  the detail card shows: for each tier up to its class rank, the tier's ability
 *  applies only if that specific ability has been unlocked (its tier's invasion
 *  boss beaten enough times to reach it — see GameState.abilityUnlocked). */
export function activeAbilities(
  z: Pick<OwnedZombie, "key" | "group" | "className">,
  abilityUnlocked: (key: string) => boolean
): string[] {
  const rank = Math.min(MAX_ABILITY_TIER, classTierRank(z.className));
  const out: string[] = [];
  for (let t = 1; t <= rank; t++) {
    const key = unitAbilityAt(z.key, z.group, t);
    if (key && abilityUnlocked(key)) out.push(key);
  }
  return out;
}

/** The combined per-unit multipliers from a set of ability keys (army-wide effects
 *  are returned separately so the caller can aggregate them across the party). */
export function combatEffect(keys: string[]): Required<AbilityCombatEffect> {
  const acc = {
    allStatsMult: 1,
    selfDamageMult: 1,
    selfHpMult: 1,
    selfSpeedMult: 1,
    armyHpMult: 1,
  };
  for (const k of keys) {
    const e = ABILITY_COMBAT[k];
    if (!e) continue;
    acc.allStatsMult *= e.allStatsMult ?? 1;
    acc.selfDamageMult *= e.selfDamageMult ?? 1;
    acc.selfHpMult *= e.selfHpMult ?? 1;
    acc.selfSpeedMult *= e.selfSpeedMult ?? 1;
    acc.armyHpMult *= e.armyHpMult ?? 1;
  }
  return acc;
}

/** The single ACTIVATED move a zombie performs — the highest-tier activated
 *  ability in its set (a Silver Large's Smash outranks its Bash/Mini), or null if
 *  it has none. One activated move per zombie keeps the battle strip uncluttered. */
export function activatedKeyFor(keys: string[]): string | null {
  let best: string | null = null;
  let bestTier = 0;
  for (const k of keys) {
    if (ABILITY_KIND[k] !== "activated") continue;
    const t = abilityTierOf(k);
    if (t >= bestTier) {
      bestTier = t;
      best = k;
    }
  }
  return best;
}

/** The team-passive abilities in a set (Heal/Protect/Resurrect/Chivalry/…), for
 *  the battle strip's informational icons. */
export function teamAbilitiesIn(keys: string[]): string[] {
  return keys.filter((k) => ABILITY_KIND[k] === "team");
}

// Ability COMBAT EFFECTS — the bridge from the display-only ability matrix
// (traits.ts) into the deterministic raid resolver (raid/CombatEngine.ts) and,
// through the baked CombatUnit stats, the live battle sim (raid/BattleSim.ts).
//
// Always-on stat changes and type-targeted auras are resolved while CombatUnits
// are built. BattleSim implements the stateful abilities directly. Its proc
// sequence is deterministic for replay verification while preserving the exact
// integer-roll success counts recovered from the binary.
//
// A zombie's ACTIVE abilities are gated exactly like the detail card (see hud.ts
// buildZombieDetail): for each tier 1..(its colour-class rank), the tier's ability
// applies only once THAT ability has been unlocked (its tier's invasion boss beaten
// enough times to reach it). So combat power tracks what the player sees on the
// card — no hidden bonuses.

import { MAX_ABILITY_TIER, unitAbilityAt } from "./traits";
import { classTierRank } from "./taxonomy";
import type { OwnedZombie } from "./types";

// How an ability behaves in the live raid, which also decides whether it shows in
// the battle's top-left ability strip (RaidScene):
//   "self"      — a passive buff to its OWN stats (+% All / +% Life / Turbo Walk /
//                 the auto Laser attack / chance-based Stun/Block/Double). Baked
//                 into combat stats; NOT shown in the strip (no player decision).
//   "team"      — shown in the strip as an automatic/informational ability.
//                 Most affect other zombies (Heal / Heal All / Protect / Resurrect);
//                 Chivalry, Grace, Protect, and Fortitude are type-targeted auras.
//   "activated" — a player-triggered move (Bash / Smash / Explode / Mini Buddy):
//                 tap it in the strip and one eligible zombie performs it. Shown
//                 in the strip as a tappable button with a ready-count badge.
export type AbilityKind = "self" | "team" | "activated";

export const ABILITY_KIND: Record<string, AbilityKind> = {
  // self (hidden from the strip)
  buffAllStats: "self", attackSpeedBuff: "self", powerBuff: "self",
  hitPointsBuff: "self", turboSpeed: "self",
  laserBeam: "self", zomBeam: "self", stun: "self", doubleStrike: "self", block: "self",
  // team (shown, automatic)
  heal: "team", healAOE: "team", protect: "team", tankHitPointsBuff: "team", ressurect: "team",
  chivalry: "team", grace: "team",
  // activated (shown, tappable — one zombie per tap)
  attachMini: "activated", bash: "activated", bashV2: "activated",
  explode: "activated", explodeV2: "activated",
};

/** Authored live-battle parameters for an activated ability. */
export interface ActivatedAbility {
  /** Authored attack-duration multiplier. `Actor getFightAttackSpeed` multiplies
   *  the unit's final attack interval by this value. */
  speedMultiplier: number;
  /** Fraction of the authored attack animation at which damage lands. */
  damageTiming: number;
  /** Payoff = performer's final attack damage × this. */
  damageFactor: number;
  /** Hit every on-field enemy (Explode), not just the current target. */
  aoe?: boolean;
  /** Also stun the struck enemy(ies) for this long (delays their next attack). */
  stunMs?: number;
  /** Cooldown before the SAME zombie can be activated again. One-use abilities
   *  carry zero because they are disabled after their first activation. */
  cooldownMs: number;
  useOnce?: boolean;
  /** Whether an area attack is allowed to damage the boss. */
  hitBoss?: boolean;
  /** The move destroys its own performer (Explode). A suicide move is a FUSE rather
   *  than a swing, which changes three things in BattleSim: it can be lit from the
   *  combat zone with no enemy in front, its wind-up keeps burning down while the
   *  zombie has no target, and it detonates on schedule even into an empty field. */
  suicide?: boolean;
  /** GROUND TRUTH — `cantInterrupt` in Attacks.json, carried by EXACTLY four attacks:
   *  ZombieBash, ZombieBashV2, ZombieExplode and ZombieExplodeV2. `-[Actor fightAttack:]`
   *  (0x36d28) reads it off the attack variation rolled for this swing and writes
   *  `fightData.canInterrupt = !cantInterrupt`; `-[Actor doneAttacking:]` (0x37cd8) puts it
   *  back to YES when the swing ends. `-[Actor damageIn:]` (0x37738) refuses BOTH the stun
   *  and the knockback while it is NO. So committing to a bash or a fuse buys super armour
   *  for its duration — you cannot be shoved out of the move you paid for. */
  cantInterrupt?: boolean;
}

export const ACTIVATED_ABILITY: Record<string, ActivatedAbility> = {
  bash: {
    speedMultiplier: 2.5, damageTiming: 0.975,
    damageFactor: 2.75, aoe: true, cooldownMs: 10_000, cantInterrupt: true,
  },
  bashV2: {
    speedMultiplier: 1.5, damageTiming: 0.975,
    damageFactor: 1.8, aoe: true, stunMs: 1000, cooldownMs: 10_000, cantInterrupt: true,
  },
  explode: {
    speedMultiplier: 6, damageTiming: 1,
    damageFactor: 10, aoe: true, stunMs: 3000, cooldownMs: 0, useOnce: true, suicide: true,
    cantInterrupt: true,
  },
  explodeV2: {
    speedMultiplier: 6, damageTiming: 1,
    damageFactor: 10, aoe: true, stunMs: 3000, cooldownMs: 0, useOnce: true, suicide: true,
    hitBoss: true, cantInterrupt: true,
  },
  // Mini Buddy is state-driven in BattleSim: mount before deployment, 4× walk,
  // ram-stun, then deploy both units. The generic hit fields are unused.
  attachMini: {
    speedMultiplier: 1, damageTiming: 0, damageFactor: 0,
    cooldownMs: 0, useOnce: true,
  },
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
}

// Per-ability magnitudes, keyed by the ability_*.png basename used in traits.ts.
//
// Only always-on SELF stat changes live in this table. Auras, chance procs,
// movement-only changes, healing, resurrection, lasers, and buttons are modeled
// explicitly in CombatEngine/BattleSim from the recovered binary behavior.
export const ABILITY_COMBAT: Record<string, AbilityCombatEffect> = {
  // ---- Tier 1 ----
  buffAllStats: { allStatsMult: 1.05 }, // CONFIRMED +5% all
  attackSpeedBuff: { selfSpeedMult: 1.1 }, // CONFIRMED +10% speed
  powerBuff: { selfDamageMult: 1.1 }, // CONFIRMED +10% power
  hitPointsBuff: { selfHpMult: 1.1 }, // CONFIRMED +10% life
  heal: {}, // live BattleSim performs actual targeted healing

  // ---- Tier 2: authentic effects are type-targeted auras / activated state ----
  chivalry: {},
  grace: {},
  attachMini: {},
  protect: {},
  tankHitPointsBuff: {},

  // ---- Tier 3 ----
  laserBeam: {},
  stun: {},
  explode: {},
  bash: {},
  turboSpeed: {},
  ressurect: {},

  // ---- Tier 4 (the ".Ver.2" upgrades hit harder) ----
  zomBeam: {},
  doubleStrike: {},
  explodeV2: {},
  bashV2: {},
  block: {},
  healAOE: {},
};

/** Does ability slot `slot` (1..4: a zombie's colour-class tiers) work? Decided by the
 *  farm's Life Force level (lifeForce.ts abilitySlotUnlocked): slot k works from level k.
 *  The gate is the SLOT, never the ability's own tier. */
export type AbilitySlotGate = (slot: number) => boolean;

/** The gated, currently-active ability keys for one owned zombie — the SAME set
 *  the detail card shows: for each ability slot up to its class rank, the slot's
 *  ability applies only if that slot works at the farm's Life Force level. */
export function activeAbilities(
  z: Pick<OwnedZombie, "key" | "group" | "className">,
  slotUnlocked: AbilitySlotGate
): string[] {
  const rank = Math.min(MAX_ABILITY_TIER, classTierRank(z.className));
  const out: string[] = [];
  for (let t = 1; t <= rank; t++) {
    const key = unitAbilityAt(z.key, z.group, t);
    if (key && slotUnlocked(t)) out.push(key);
  }
  return out;
}

/** The combined per-unit, always-on multipliers from a set of ability keys. Team
 *  effects (auras, procs, healing, activated moves) are NOT here — CombatEngine and
 *  BattleSim apply those explicitly from the recovered binary behavior. */
export function combatEffect(keys: string[]): Required<AbilityCombatEffect> {
  const acc = {
    allStatsMult: 1,
    selfDamageMult: 1,
    selfHpMult: 1,
    selfSpeedMult: 1,
  };
  for (const k of keys) {
    const e = ABILITY_COMBAT[k];
    if (!e) continue;
    acc.allStatsMult *= e.allStatsMult ?? 1;
    acc.selfDamageMult *= e.selfDamageMult ?? 1;
    acc.selfHpMult *= e.selfHpMult ?? 1;
    acc.selfSpeedMult *= e.selfSpeedMult ?? 1;
  }
  return acc;
}

/** Activated moves that SHARE one button in the battle strip, each stack listed
 *  highest tier first.
 *
 *  Stacking exists for LAYOUT: an army that has unlocked everything owns five
 *  activated moves, and five buttons at ABILITY_ACTIVE_STEP apart ran off the bottom
 *  of a phone held in landscape, where the whole viewport is ~375 px tall. It costs
 *  the player a choice, so it is spent only where the choice is not worth having.
 *
 *  Explode / Explode Ver.2 IS such a pair: they are the same 10x suicide blast, and
 *  Ver.2 differs only by also hitting the boss. There is no fight in which you would
 *  rather spend the base one, so nothing is lost by letting `nextInGroup` resolve
 *  tier-first — and quite a lot would be lost by leaving the boss-hitting version
 *  unreachable behind a plain Explode.
 *
 *  Bash / Smash is NOT such a pair and is deliberately no longer stacked. Smash is
 *  not an upgrade of Bash, it is a different trade — 1.8x + a 1 s area stun against
 *  Bash's 2.75x — and which one wins depends on the fight in front of you:
 *
 *    - per second of committed time Smash is ~9% ahead (1.8 over a 1.46-cycle
 *      wind-up, against 2.75 over 2.44) and it stuns on top;
 *    - per 10 s recharge — the actual throughput gate, since `abilityCdMs` is set at
 *      commit — Bash wins from two enemies on the field upward, because its extra
 *      0.95x lands on every one of them while Smash's shorter wind-up buys back only
 *      single-target swings;
 *    - Bash's longer wind-up is more super armour (`cantInterrupt`) but also a longer
 *      window for the grabs and pixelFire that DO cancel a charge.
 *
 *  Stacking them handed that judgement to the tier ladder. Four buttons is the new
 *  worst case, and the column's pitch tightens to fit it (see abilityColumnStep). */
export const ACTIVATED_STACKS: readonly (readonly string[])[] = [
  ["explodeV2", "explode"],
];

/** The stack `key` belongs to (highest tier first), or null if it has no stackmate. */
export function activatedStackOf(key: string): readonly string[] | null {
  return ACTIVATED_STACKS.find((stack) => stack.includes(key)) ?? null;
}

/** The battle strip's activated BUTTONS, in slot order: one entry per button, each
 *  the keys that share it ordered highest tier first. Members the army does not
 *  carry are dropped, so an unstacked move (or a lone Bash) is a group of one.
 *
 *  Slot order follows FIRST APPEARANCE in `keys`, so a group takes the slot its
 *  earliest member would have taken and the column stays stable for the fight. */
export function activatedGroupsOf(keys: string[]): string[][] {
  const groups: string[][] = [];
  const placed = new Set<string>();
  for (const key of keys) {
    if (placed.has(key)) continue;
    const stack = activatedStackOf(key);
    const members = stack ? stack.filter((k) => keys.includes(k)) : [key];
    for (const member of members) placed.add(member);
    groups.push(members);
  }
  return groups;
}

/** The team-passive abilities in a set (Heal/Protect/Resurrect/Chivalry/…), for
 *  the battle strip's informational icons. */
export function teamAbilitiesIn(keys: string[]): string[] {
  return keys.filter((k) => ABILITY_KIND[k] === "team");
}

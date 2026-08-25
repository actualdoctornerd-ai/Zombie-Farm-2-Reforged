import { BASE } from "../base";
// Presentation metadata for the zombie detail card, using the AUTHENTIC game art
// (tools/prep_zombie_detail.py) and the AUTHENTIC text pulled from the game binary.
//
// Abilities in ZF2 are NOT stored in the extractable asset data — they're assigned
// by compiled logic. The real structure (user-confirmed 2026-07-07) is a fixed
// 6-groups × 4-tiers matrix (GROUP_ABILITIES below): each zombie GROUP has ONE
// ability per tier, and a unit shows the abilities for tiers 1..(its colour-class
// rank) — Green=t1, Blue=t1-2, Red=t1-3, Silver/Combined=t1-4. A tier's ability is
// usable once that tier's invasion boss is beaten (else a padlock). This is NOT
// random and a zombie never has more than 4 abilities (Small has none below t3, so
// mini abilities only appear on Red-and-up). Every one of the 22 ability icons is
// used exactly once across the matrix.

const ZD = BASE + "assets/ui/zdetail/";
const AB = BASE + "assets/ui/ability/";

// Shared chrome (backgrounds / frames).
export const STAT_TILE = `${ZD}stat_tile.png`; // purple rounded tile behind a glyph
export const VALUE_FILL = `${ZD}value_fill.png`; // black value-box body (repeat-x)
export const VALUE_END = `${ZD}value_end.png`; // black value-box right cap
export const ABILITY_FRAME = `${ZD}ability_frame.png`; // brown ability tile frame
// The Mausoleum's mutation board framed each mutation icon in this; the card's
// Mutations row reuses it (tools/prep_mutation_icons.py).
export const MUTATION_FRAME = `${ZD}mutation_frame.png`;
export const ABILITY_UNKNOWN = `${ZD}ability_unknown.png`; // the "?" placeholder glyph

export interface StatMeta {
  key: "str" | "dex" | "con" | "focus";
  label: string; // tooltip title
  desc: string; // tooltip body (exact game text)
  icon: string; // white glyph on the purple tile
}

// fist = damage, wing = speed, heart = life, crosshair = focus (matches the game).
// Descriptions are verbatim from the game binary.
export const STATS: StatMeta[] = [
  { key: "str", label: "Damage", desc: "How much damage the zombie inflicts.", icon: `${ZD}stat_damage.png` },
  // Speed's shipped line ("How fast the zombie is") hides half of what dex does: it
  // sets BOTH the advance speed and the attack interval (deriveAttackIntervalMs), so a
  // high-Speed zombie swings more often as well as walking sooner. Spelled out here.
  { key: "dex", label: "Speed", desc: "How fast the zombie moves and how quickly it attacks.", icon: `${ZD}stat_speed.png` },
  { key: "con", label: "Life", desc: "How much damage the zombie can take.", icon: `${ZD}stat_life.png` },
  { key: "focus", label: "Focus", desc: "How distracted the zombie is.", icon: `${ZD}stat_focus.png` },
];

// ---------------------------------------------------------------------------
// Stat DISPLAY normalization — GROUND TRUTH (user-verified 2026-07-17).
// ---------------------------------------------------------------------------
// The detail card never shows a zombie's raw str/con/dex. Each is rendered as a
// 0–100 bar = raw / (the strongest BASE tier-5 zombie's value for that stat) × 100,
// rounded. The three denominators are exactly the per-stat maxima across the six
// standard group tier-5s (Large wins Damage/Power, Headless wins Life, Small wins
// Speed). Verified to reproduce the game's shown Power/Speed/Life for Zombarian,
// Zombee, Zombielocks, Zombelly Dancer and the Flytrap zombie — all 20 values exact.
// Focus is already a 0–100 stat, so it is shown as-is.
//
// IMPORTANT: these are FIXED REFERENCE CONSTANTS, deliberately NOT derived from the
// live roster. Adding a stronger zombie later must NOT rescale everyone else's shown
// numbers — the reference stays put, so existing zombies always display the same
// value. A unit stronger than the reference simply reads ABOVE 100 (NOT clamped);
// e.g. George Washington (str 30) shows 129 Power. The reference is a stable "100 =
// this specific base zombie", not a hard cap.
export const STAT_DISPLAY_MAX: Record<"str" | "con" | "dex", number> = {
  str: 23.32, // Large tier-5 (Zomviking) base str — the Damage/Power reference
  con: 29.7, //  Headless tier-5 (Bombie) base con — the Life reference
  dex: 4.4, //   Small tier-5 (Zombricaun) base dex — the Speed reference
};

/** The reference stat a value of 100 represents, or null for focus (already 0–100). */
export function statDisplayMax(key: StatMeta["key"]): number | null {
  return key === "focus" ? null : STAT_DISPLAY_MAX[key];
}

/** Convert a raw combat stat to the whole-number value shown on the card. str/con/dex
 *  are normalized against STAT_DISPLAY_MAX (100 = the reference base zombie) and can
 *  exceed 100 for above-reference units — NOT clamped. Focus is already 0–100 and only
 *  gets rounded. Species base stats can be fractional, hence the round. Pass the
 *  FULLY-RESOLVED stat (mutation/veterancy already folded in) — normalization is linear
 *  so the shown value reflects those bonuses automatically. */
export function displayStat(key: StatMeta["key"], raw: number): number {
  const max = statDisplayMax(key);
  if (max === null) return Math.round(raw);
  return Math.round((raw / max) * 100);
}

export interface AbilityMeta {
  label: string;
  effect: string; // concise summary of the original game's compiled behavior
  desc: string; // original player-facing description recovered from the game binary
  icon: string; // real ability_*.png (key === icon basename)
}

// The full 22-ability pool, keyed by its ability_*.png basename. Labels and
// descriptions are the strings shipped in ZF2R. Effects summarize the behavior
// recovered from ZF2R's ARMv7 methods and authored Attacks.json; they deliberately
// do not describe the reimplementation's current approximations. The one exception is
// a deliberate DIVERGENCE that costs the player something: Explode now destroys the
// zombie that uses it, so both explosion rows say so — a price the card must quote.
export const ABILITY_POOL: Record<string, AbilityMeta> = {
  // ---- Tier 1 (mostly passive stat buffs; the buff IS the display name) ----
  buffAllStats: { label: "+5% All Stats", effect: "+5% All Stats", desc: "Zombie is a little stronger", icon: `${AB}ability_buffAllStats.png` },
  attackSpeedBuff: { label: "+10% Speed", effect: "+10% Speed", desc: "Zombie attacks faster", icon: `${AB}ability_attackSpeedBuff.png` },
  powerBuff: { label: "+10% Damage", effect: "+10% Damage", desc: "Zombie hits harder", icon: `${AB}ability_powerBuff.png` },
  hitPointsBuff: { label: "+10% Life", effect: "+10% Life", desc: "Zombie is tougher", icon: `${AB}ability_hitPointsBuff.png` },
  heal: { label: "Heal", effect: "Heals an ally for 50% Power", desc: "Heal other zombies", icon: `${AB}ability_heal.png` },
  // ---- Tier 2 ----
  chivalry: { label: "Chivalry", effect: "+10% Damage/Life and +10% Speed to nearby Girl zombies", desc: "Girl zombies are stronger around you", icon: `${AB}ability_chivalry.png` },
  grace: { label: "Grace", effect: "+10% Damage/Life and +10% Speed to nearby Regular zombies", desc: "Regular zombies are stronger around you", icon: `${AB}ability_grace.png` },
  attachMini: { label: "Mini Buddy", effect: "One pre-deployment mini ram", desc: "Carry a mini zombie and ram the enemy (use before sending zombie)", icon: `${AB}ability_attachMini.png` },
  protect: { label: "Protect", effect: "20% less damage to nearby non-Headless zombies", desc: "Other zombie types take less damage when you're near", icon: `${AB}ability_protect.png` },
  tankHitPointsBuff: { label: "Fortitude", effect: "+10% Life to Headless zombies", desc: "Headless zombies are a little tougher", icon: `${AB}ability_tankHitPointsBuff.png` },
  // ---- Tier 3 ----
  laserBeam: { label: "Laser Beam", effect: "Automatic shots for 20% Power", desc: "Shoot a laser beam while you're walking!", icon: `${AB}ability_laserBeam.png` },
  stun: { label: "Random Stun", effect: "4% chance to stun for 1 second", desc: "Small chance to stun your target", icon: `${AB}ability_stun.png` },
  explode: { label: "Explode", effect: "One 10× area hit and 3-second stun; the zombie is destroyed", desc: "Zombie will explode and stun the enemy (use when fighting)", icon: `${AB}ability_explode.png` },
  bash: { label: "Bash", effect: "2.75× attack; 10-second recharge", desc: "Bashes the enemy when activated (use when fighting)", icon: `${AB}ability_bash.png` },
  turboSpeed: { label: "Turbo Walking Speed", effect: "2× walking speed", desc: "Zombie walks twice as fast", icon: `${AB}ability_turboSpeed.png` },
  ressurect: { label: "Resurrect", effect: "Revives one fallen zombie at full Life, once per fight; it returns with its one-use moves spent", desc: "Resurrect any zombie once", icon: `${AB}ability_ressurect.png` },
  // ---- Tier 4 (the ".Ver.2" upgrades of earlier abilities) ----
  zomBeam: { label: "Laser Beam Ver.2", effect: "Automatic laser at 2× the base firing rate", desc: "New and improved", icon: `${AB}ability_zomBeam.png` },
  doubleStrike: { label: "Double Strike", effect: "29% chance of a bonus strike", desc: "Small chance to hit twice", icon: `${AB}ability_doubleStrike.png` },
  explodeV2: { label: "Explode Ver.2", effect: "One 10× area hit and 3-second stun; hits bosses; the zombie is destroyed", desc: "Can hit and stun the boss (use when fighting)", icon: `${AB}ability_explodeV2.png` },
  bashV2: { label: "Smash", effect: "1.8× attack and 1-second stun; 10-second recharge", desc: "Smashes the enemy when activated (use when fighting)", icon: `${AB}ability_bashV2.png` },
  block: { label: "Block", effect: "9% chance to block an attack", desc: "Small chance to block any attack", icon: `${AB}ability_block.png` },
  healAOE: { label: "Heal All", effect: "50% Power to all injured zombies every 20 seconds", desc: "Heal all zombies every once in awhile", icon: `${AB}ability_healAOE.png` },
};

// ---------------------------------------------------------------------------
// Ability tiers (t1-t4) — the REAL game structure (user-supplied, 2026-07-06)
// ---------------------------------------------------------------------------
// Each tier is gated behind an invasion boss: beating that tier's boss (winning
// its raid) unlocks the whole tier GLOBALLY, so every zombie whose colour class
// reaches that tier can use its group's ability there (Green=t1, Blue=t1-2,
// Red=t1-3, Silver/"Combined"+ = t1-4). Which ability a unit gets at each tier is
// fixed by its group (GROUP_ABILITIES), not random. A locked tier shows a padlock
// + "Defeat <boss> to unlock". (The game also had a Life Force requirement per
// tier, but that mechanic is intentionally dropped.)

/** Which invasion boss must be beaten (its raid won) to unlock a tier's pool. */
export const TIER_BOSS: Record<number, string> = {
  1: "Old McDonnell",
  2: "the Lawyers",
  3: "the Pirates",
  4: "the Ninjas",
};

/** Highest ability tier that exists (Silver/"Combined" zombies see all of these). */
export const MAX_ABILITY_TIER = 4;

/** ABILITY_POOL keys grouped by tier. Every pool key appears exactly once. */
export const ABILITY_TIER: Record<number, string[]> = {
  1: ["buffAllStats", "attackSpeedBuff", "powerBuff", "hitPointsBuff", "heal"],
  2: ["chivalry", "grace", "attachMini", "protect", "tankHitPointsBuff"],
  3: ["laserBeam", "stun", "explode", "bash", "turboSpeed", "ressurect"],
  4: ["zomBeam", "doubleStrike", "explodeV2", "bashV2", "block", "healAOE"],
};

/** The tier an ability belongs to (0 if it isn't assigned to any tier). */
export function abilityTierOf(key: string): number {
  for (let t = 1; t <= MAX_ABILITY_TIER; t++) {
    if (ABILITY_TIER[t].includes(key)) return t;
  }
  return 0;
}

// Each zombie GROUP's ability per tier (index 0 = t1 … index 3 = t4). A unit shows
// the abilities for tiers 1..(its colour-class rank), so it never has more than 4.
// `null` = the group has no ability at that tier (Small only gains one at t3/t4, so
// mini abilities appear on Red-and-up). Every ABILITY_POOL key is used exactly once.
export const GROUP_ABILITIES: Record<string, (string | null)[]> = {
  //         t1               t2                  t3            t4
  Regular:  ["buffAllStats",  "chivalry",         "laserBeam",  "zomBeam"],
  Female:   ["attackSpeedBuff", "grace",          "stun",       "doubleStrike"],
  Headless: ["hitPointsBuff", "protect",          "turboSpeed", "block"],
  Large:    ["powerBuff",     "attachMini",       "bash",       "bashV2"],
  Garden:   ["heal",          "tankHitPointsBuff", "ressurect", "healAOE"],
  Small:    [null,            null,               "explode",    "explodeV2"],
};

/** The ability key a group has at `tier` (1..4), or null if it has none there. */
export function groupAbilityAt(group: string, tier: number): string | null {
  return GROUP_ABILITIES[group]?.[tier - 1] ?? null;
}

// Named unique zombies override their group's ability set. The Crazy zombie
// (user-confirmed 2026-07-07) carries +5% All Stats, Chivalry, Random Stun, and
// Double Strike — one per tier (t1..t4), gated by those tiers' bosses.
export const SPECIAL_ABILITIES: Record<string, (string | null)[]> = {
  //                        t1              t2          t3      t4
  ZombieActorRegularCrazy: ["buffAllStats", "chivalry", "stun", "doubleStrike"],
};

/** The ability a specific unit has at `tier`: a named-unique override if any,
 *  else its group's ability. Key may be undefined (falls back to the group). */
export function unitAbilityAt(key: string | undefined, group: string, tier: number): string | null {
  const special = key ? SPECIAL_ABILITIES[key] : undefined;
  return special ? special[tier - 1] ?? null : groupAbilityAt(group, tier);
}

// Veterancy: a zombie ranks up each invasion it SURVIVES — a 6-rung ladder
// (user-confirmed 2026-07-07): Newbie (base) → Veteran 1..4 → Master, one rank per
// battle so Master is reached at the 5th. Each rung grants +5% to all stats
// (Master = +25%).
//
// `survivals` is the OwnedZombie.invasions counter, which the raid code increments
// only for units that live through a battle — so invasions == survived invasions
// today. When permanent casualties + a separate participation counter land, key
// this off the survivals count specifically.
export const VET_RANKS = ["Newbie", "Veteran 1", "Veteran 2", "Veteran 3", "Veteran 4", "Master"];
export const MAX_VET_RANK = VET_RANKS.length - 1; // 5 = Master
// Battles (survived invasions) required to REACH each rank — one per battle.
export const VET_THRESHOLDS = [0, 1, 2, 3, 4, 5];
/** Per-rank stat bonus (+5% of base per rank). */
export const VET_STAT_STEP = 0.05;

/** Rank level 0..5 from survived-invasion count (highest rank whose threshold is met). */
export function veterancyLevel(survivals: number): number {
  let level = 0;
  for (let i = 0; i < VET_THRESHOLDS.length; i++) {
    if (survivals >= VET_THRESHOLDS[i]) level = i;
  }
  return level;
}

/** Rank name for a survived-invasion count. */
export function veterancy(survivals: number): string {
  return VET_RANKS[veterancyLevel(survivals)];
}

/** All-stats multiplier from veterancy (1.0 at Recruit … 1.20 at Master). */
export function veterancyMultiplier(survivals: number): number {
  return 1 + VET_STAT_STEP * veterancyLevel(survivals);
}

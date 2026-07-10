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
  { key: "dex", label: "Speed", desc: "How fast the zombie is.", icon: `${ZD}stat_speed.png` },
  { key: "con", label: "Life", desc: "How much damage the zombie can take.", icon: `${ZD}stat_life.png` },
  { key: "focus", label: "Focus", desc: "How distracted the zombie is.", icon: `${ZD}stat_focus.png` },
];

export interface AbilityMeta {
  label: string;
  effect: string; // concise magnitude/effect tag (see EYEBALLED note below)
  desc: string; // in-game description where extracted (else eyeballed)
  icon: string; // real ability_*.png (key === icon basename)
}

// The full 22-ability pool, keyed by its ability_*.png basename. Labels and
// most descriptions are the REAL game text (extracted from the English
// localization: "…(use when fighting)", "+10% Speed", etc.). The `effect` tag is
// a short magnitude line: CONFIRMED by the user for the T1 stat buffs (+5% All
// Stats / +10% Speed / +10% Power / +10% Life), turboSpeed (2× walk) and
// ressurect (once); everything else is EYEBALLED (search "EYEBALLED") until the
// combat system needs real numbers.
export const ABILITY_POOL: Record<string, AbilityMeta> = {
  // ---- Tier 1 (mostly passive stat buffs; the buff IS the display name) ----
  buffAllStats: { label: "+5% All Stats", effect: "+5% All Stats", desc: "Boosts all of the zombie's stats by 5%.", icon: `${AB}ability_buffAllStats.png` },
  attackSpeedBuff: { label: "+10% Speed", effect: "+10% Speed", desc: "The zombie attacks 10% faster.", icon: `${AB}ability_attackSpeedBuff.png` },
  powerBuff: { label: "+10% Power", effect: "+10% Power", desc: "Increases the zombie's power by 10%.", icon: `${AB}ability_powerBuff.png` },
  hitPointsBuff: { label: "+10% Life", effect: "+10% Life", desc: "Increases the zombie's life by 10%.", icon: `${AB}ability_hitPointsBuff.png` },
  heal: { label: "Heal", effect: "Heals allies", desc: "Heal other zombies.", icon: `${AB}ability_heal.png` },
  // ---- Tier 2 ----
  chivalry: { label: "Chivalry", effect: "Buff", desc: "A knightly boon for your zombies.", icon: `${AB}ability_chivalry.png` }, // EYEBALLED: no in-game desc found
  grace: { label: "Grace", effect: "Buff", desc: "A graceful blessing for your zombies.", icon: `${AB}ability_grace.png` }, // EYEBALLED: no in-game desc found
  attachMini: { label: "Mini Buddy", effect: "Ram attack", desc: "Carry a mini zombie and ram the enemy (use before sending zombie).", icon: `${AB}ability_attachMini.png` },
  protect: { label: "Protect", effect: "Nearby allies −damage", desc: "Other zombie types take less damage when you're near.", icon: `${AB}ability_protect.png` },
  tankHitPointsBuff: { label: "Fortitude", effect: "+Defense", desc: "The zombie is a lot tougher.", icon: `${AB}ability_tankHitPointsBuff.png` }, // EYEBALLED magnitude
  // ---- Tier 3 ----
  laserBeam: { label: "Laser Beam", effect: "Ranged", desc: "Shoot a laser beam while you're walking!", icon: `${AB}ability_laserBeam.png` },
  stun: { label: "Random Stun", effect: "Small chance", desc: "Small chance to stun your target.", icon: `${AB}ability_stun.png` },
  explode: { label: "Explode", effect: "Active: explode + stun", desc: "Zombie will explode and stun the enemy (use when fighting).", icon: `${AB}ability_explode.png` },
  bash: { label: "Bash", effect: "Active", desc: "Bashes the enemy when activated (use when fighting).", icon: `${AB}ability_bash.png` },
  turboSpeed: { label: "Turbo Walking Speed", effect: "2× Walk Speed", desc: "Turbo walking speed.", icon: `${AB}ability_turboSpeed.png` },
  ressurect: { label: "Resurrect", effect: "Once per battle", desc: "Resurrect any zombie once.", icon: `${AB}ability_ressurect.png` },
  // ---- Tier 4 (the ".Ver.2" upgrades of earlier abilities) ----
  zomBeam: { label: "Laser Beam Ver.2", effect: "Ranged, hits boss", desc: "Can hit and stun the boss (use when fighting).", icon: `${AB}ability_zomBeam.png` },
  doubleStrike: { label: "Double Strike", effect: "Small chance", desc: "Small chance to hit twice.", icon: `${AB}ability_doubleStrike.png` },
  explodeV2: { label: "Explode Ver.2", effect: "Active: timed explode", desc: "Zombie will explode and stun in 5 seconds.", icon: `${AB}ability_explodeV2.png` },
  bashV2: { label: "Smash", effect: "Active", desc: "Smashes the enemy when activated (use when fighting).", icon: `${AB}ability_bashV2.png` },
  block: { label: "Block", effect: "Small chance", desc: "Small chance to block any attack.", icon: `${AB}ability_block.png` },
  healAOE: { label: "Heal All", effect: "Periodic AoE", desc: "Heal all zombies every once in awhile.", icon: `${AB}ability_healAOE.png` },
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

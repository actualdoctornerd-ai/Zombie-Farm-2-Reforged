// Pure helpers over the raid catalog: unlock/lock state, stage/difficulty
// selection, army-selection rules, and reward derivation. Player-facing raids run
// the live combat sim (BattleSim); instant resolution (CombatEngine) is retained
// only as a test/dev utility. No side effects — RaidManager applies these.
import { RaidDef, RaidStage } from "./types";

/** Minimum army to launch an invasion (Help.json: "at least 8, best with 16"). */
export const MIN_ARMY = 8;
/** Best/most an invasion is fought with (source rule). Also the selection cap. */
export const ARMY_CAP = 16;

/** The raid id of Old McDonnell's Farm — the tutorial invasion. */
export const MCDONNELL_ID = 1;

/** How many zombies an invasion needs to launch. Normally MIN_ARMY (8), but the
 *  first clears of Old McDonnell's Farm are eased so new players can start raiding
 *  without a full army — the very first clear needs just 1 (the tutorial grows a
 *  single zombie and sends it in), then 4, then the full army. `priorWins` is that
 *  raid's lifetime win count. */
export function minArmyFor(raid: RaidDef, priorWins: number): number {
  if (raid.id === MCDONNELL_ID) {
    if (priorWins <= 0) return 1;
    if (priorWins === 1) return 4;
  }
  return MIN_ARMY;
}

/** Real between-invasions cooldown (Help.json: "wait two hours between invasions,
 *  unless you purchase an Invasion Voucher"). Playtest-scaled in main.ts. */
export const RAID_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** The consumable that bypasses the cooldown (Market Boosts → boosts.json). */
export const VOUCHER_KEY = "invasion_voucher";

/** Format a remaining cooldown as "1h 03m" or "2:05" (m:ss under an hour). */
export function fmtCooldown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** UI power estimate for default army sorting only — combat uses raw stats. */
export function power(z: { str: number; dex: number; con: number; focus: number }): number {
  return z.str * 2 + z.dex * 3 + z.con * 1.5 + z.focus * 0.05;
}

/** A raid is enterable when it has playable stages and the level gate is met. */
export function isUnlocked(raid: RaidDef, level: number): boolean {
  return raid.playable && level >= raid.unlockLevel;
}

/** Why the player can't enter a raid ("" when they can). */
export function lockReason(raid: RaidDef, level: number): string {
  if (!raid.playable) return "Coming soon";
  if (level < raid.unlockLevel) return `Requires level ${raid.unlockLevel}`;
  return "";
}

/** The wave fought, scaled by player level. The source `stages` array is a
 *  difficulty ladder (verified against the real game on McDonnell): earlier
 *  stages have fewer enemies and no boss; the first boss stage lines up with the
 *  raid's `recommendedLevel`, and each level past that steps one stage harder.
 *
 *  e.g. McDonnell (boss stage 3, recommended 5): lvl3→[1] (3 grunts, no boss),
 *  lvl4→[2] (+lumberjack), lvl5→[3] (boss, no throws), lvl6→[4] (boss throws). */
export function fightStage(raid: RaidDef, playerLevel: number): RaidStage | null {
  if (!raid.stages.length) return null;
  let bossIdx = raid.stages.findIndex((s) => s.bossKey);
  if (bossIdx < 0) bossIdx = raid.stages.length - 1;
  const idx = Math.max(
    0,
    Math.min(raid.stages.length - 1, bossIdx + (playerLevel - raid.recommendedLevel))
  );
  return raid.stages[idx];
}

/** Ability tier this raid unlocks on a win (McDonnell=1 … Ninjas=4; 0 = none). */
export function raidTier(raid: RaidDef): number {
  return raid.id >= 1 && raid.id <= 4 ? raid.id : 0;
}

/** A first-of-each-tier reward preview for the select screen. */
export function rewardPreview(raid: RaidDef): string[] {
  return raid.loot.map((tier) => tier[0]).filter(Boolean);
}

/** Win gold, report-faithful. The wiki base is "Gold, *no casualties*" and the
 *  bonus is a "*possible* bonus" — real payouts (e.g. Aliens 4320, not 4000+2000)
 *  land below the ceiling when zombies fall. So both are scaled by `survivalFrac`
 *  (fraction of the deployed army still standing): a flawless win earns the full
 *  base + bonus, and every casualty cuts the take. Falls back to a level-scaled
 *  estimate for any raid without a wiki figure. */
export function winGold(raid: RaidDef, survivalFrac = 1): number {
  const f = Math.max(0, Math.min(1, survivalFrac));
  const hasData = raid.goldReward > 0 || raid.bonusGold > 0;
  // Fallback for raids without a wiki figure uses the binary's own gold formula
  // (`-[ZFFightMan getStandardGoldLootForStageLevel:]` = level×100×2.3 = level×230;
  // `getBonusGoldLootForStageLevel:` = level×100). We key it off recommendedLevel as
  // the stage level; the exact "stageLevel" ivar is unconfirmed (see
  // COMBAT_STATS_RECOVERED.md), but this is far closer than the old level×50 guess.
  const base = hasData ? raid.goldReward : Math.round(raid.recommendedLevel * 230);
  const bonus = hasData ? raid.bonusGold : Math.round(raid.recommendedLevel * 100);
  return Math.round(base * f) + Math.round(bonus * f);
}

/** The consumable that improves loot luck (Market Boosts → boosts.json). Each die
 *  spent raises the win's loot-luck bracket by one, shifting the drop toward rarer
 *  tiers (source `rollForDrop:`, applied via rollLootTier in finishRaid). */
export const DICE_KEY = "golden_dice";
/** The consumable that keeps zombies focused in battle (fight at full focus). */
export const CONCENTRATION_KEY = "concentration";

/** The single item drop awarded on a win (first entry of the first non-gold loot
 *  tier), stored raw into Received. Boost/other tiers are deferred. */
export function itemDrop(raid: RaidDef): string | null {
  const tier = raid.loot.find((t) => t.length && !t.includes("Bonus Gold"));
  return tier?.[0] ?? null;
}

/** Ceiling on useful Golden Dice for a raid. Each die raises the loot-luck bracket
 *  one step rarer; once the bracket reaches the raid's rarest populated tier, more
 *  dice can't reach anything rarer. So the cap is (number of non-empty tiers − 1). */
export function maxLuckTiers(raid: RaidDef): number {
  const tiers = raid.loot.filter((t) => t.some((x) => x)).length;
  return Math.max(0, tiers - 1);
}

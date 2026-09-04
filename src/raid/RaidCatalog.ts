// Pure helpers over the raid catalog: unlock/lock state, stage/difficulty
// selection, army-selection rules, and reward derivation. Player-facing raids run
// the live combat sim (BattleSim); instant resolution (CombatEngine) is retained
// only as a test/dev utility. No side effects — RaidManager applies these.
import type { BossThrowConfig, RaidDef, RaidStage } from "./types";
import { raidBoostBundle } from "./lootBundles";
import { deriveMaxHp, levelScaleStat } from "./combatStats";

/** Minimum army to launch an invasion (Help.json: "at least 8, best with 16"). */
export const MIN_ARMY = 8;
/** Hard ceiling on an invasion party, and the selection cap. The effective cap is
 *  `min(ARMY_CAP, zombieMax)`, and zombieMax tops out at 16 + the Zombie Monolith's
 *  +4 — so this must be 20 for the Monolith's four extra slots to be selectable. */
export const ARMY_CAP = 20;

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

/** Ease Old McDonnell's projectile cadence over his first two clears, in step
 *  with the tutorial army ramp above. A larger interval means fewer throws:
 *  half speed before the first win, two-thirds speed after it, then the stage's
 *  authored full-strength cadence from the third fight onward. */
export function bossThrowIntervalSecs(
  raid: RaidDef,
  stage: RaidStage,
  priorWins: number
): number {
  const rawSecs = stage.throwSpeed ?? raid.throwSpeed;
  const authoredSecs = rawSecs > 0 ? rawSecs : 2;
  if (raid.id !== MCDONNELL_ID) return authoredSecs;
  if (priorWins <= 0) return authoredSecs * 2;
  if (priorWins === 1) return authoredSecs * 1.5;
  return authoredSecs;
}

// ---------------------------------------------------------------------------
// PROJECTILE (boss THROW) SCALING — a deliberate divergence from the authored data.
//
// The recovered values are flat chip: `ZFFightPhysics throwProjectile:` reads a bossAction's
// authored `damage` straight into the projectile and hands it to `[zombie damage:]` with no
// conversion (see BattleSim's note). So Old McDonnell's 6/12/18 really are 6/12/18 — and so
// are the Pirate boss's 12.5/25/50, thrown once every EIGHT seconds, against zombies whose
// hit points are `con x 100`. A raid the player unlocks at level 21 was therefore lobbing
// 3.4 damage per second at an army with five figures of health between it: the projectile
// stopped being a mechanic and became set dressing, which is not what a boss standing on a
// roof hurling an anchor is supposed to read as.
//
// The fix keeps every boss's authored SHAPE — the light/medium/heavy split, each option's
// frequency, and the raid's own throw cadence — and re-bases only the magnitude, against one
// yardstick:
//
//   A boss's throws must be able to kill a level-appropriate, unmutated healer that no other
//   healer is supporting.
//
// The healer is the yardstick because it is who the throw is AIMED at. `throwTarget` picks the
// rear-most deployed zombie, which is the Garden support station once the army has walked out
// (BattleSim GARDEN_STATION_X) — the lob goes over the tanks and lands on the back line. A
// lone healer cannot heal itself either (Heal picks another zombie), so "the throws kill a
// solo healer" is a property the simulation can actually settle, and the one the magnitude is
// fitted to. See projectileScale.test.ts, which measures it in the real sim.
//
// The reference healer is the one a player on that rung would actually own: the most recently
// PURCHASABLE Garden zombie at the raid's level (`GARDEN_MARKET_LADDER`), level-scaled exactly
// as a real one would be (`levelScaleStat`). Scaling off the raid rather than off the player
// keeps this consistent with everything else about a raid: enemy stats do not track player
// level either, so a veteran replaying Old McDonnell still gets the tutorial's chicken, and
// Zedzox still throws like Zedzox.
//
// Old McDonnell's is the one exception and reads a DPS BAND instead of the flat yardstick,
// because it is the only raid whose throw CADENCE carries meaning — see the band below.

/** The Garden zombies the MARKET sells, as (unlock level, base con), cheapest first.
 *  Mirrors zombies.json — locked by projectileScale.test.ts, which re-derives it there so a
 *  new healer or a re-costed one cannot drift this table silently. Kept as a literal rather
 *  than an import so RaidCatalog stays free of the 95-entry zombie catalog.
 *
 *  Brain-gated SPECIALS are deliberately excluded. The Cupid Zombie is nominally on sale at
 *  level 20 and carries con 15 — three times the whole gold ladder's top rung — so counting
 *  it would make the reference "the best healer obtainable" rather than "the healer this
 *  level has reached", and would quadruple the floor at a single rung. */
export const GARDEN_MARKET_LADDER: ReadonlyArray<{ level: number; con: number }> = [
  { level: 6, con: 1.0 },   // Garden Zombie
  { level: 13, con: 2.5 },  // ZomBotanist
  { level: 20, con: 4.0 },  // Flower Zombie
  { level: 25, con: 5.5 },  // Zombee
];
/** Base con of the most recently purchasable Garden zombie at `level` — the healer a player
 *  on this rung would actually be fielding. Below the first rung it is the one they are
 *  about to be able to buy. */
export function referenceHealerCon(level: number): number {
  let con = GARDEN_MARKET_LADDER[0].con;
  for (const rung of GARDEN_MARKET_LADDER) if (level >= rung.level) con = rung.con;
  return con;
}
/** How long a boss must hold its throws ON one target to kill that reference healer. Fifteen
 *  seconds is the tuning knob for the whole rebalance: raise it and every boss's throws get
 *  lighter, lower it and they get heavier, and nothing else about a fight moves. */
export const THROW_LETHAL_MS = 15_000;
/** Floor/ceiling on the resulting hit count. Without them the cadence divides straight
 *  through: the Pirate boss throws once every EIGHT seconds, so an uncapped budget would ask
 *  for fifteen seconds' worth of damage in under two landed hits, and a half-second thrower
 *  would be diluted to nothing. Three landed heavies is the hardest a throw is allowed to
 *  read, and the anti-one-shot latch (BattleSim ONE_SHOT_FLOOR) makes it four in practice.
 *  The floor BINDS on the Lawyers and the Pirates — both throw too slowly for the window —
 *  so those two are the raids `THROW_LETHAL_MS` cannot move. */
export const THROW_MIN_LETHAL_HITS = 3;
export const THROW_MAX_LETHAL_HITS = 24;

/** Max HP of the level-appropriate reference healer for a fight at `level`: the market's
 *  most recent Garden zombie, level-scaled exactly as a real one would be.
 *
 *  This is NOT monotonic in level, and that is the ground truth rather than a bug. The
 *  Garden Zombie's base con (1.0) sits BELOW its group's level-8 floor (2.5), so as the
 *  ramp runs its hit points fall from the propped-up 250 toward its real 100 — a level-12
 *  player's best healer (215) really is frailer than a level-8 player's (250). The yardstick
 *  follows the healer. */
export function referenceHealerHp(level: number): number {
  return deriveMaxHp(levelScaleStat("Garden", "con", referenceHealerCon(level), level));
}

/** How many LANDED throws should kill that healer at this cadence. */
export function throwLethalHits(intervalMs: number): number {
  const raw = THROW_LETHAL_MS / Math.max(1, intervalMs);
  return Math.min(THROW_MAX_LETHAL_HITS, Math.max(THROW_MIN_LETHAL_HITS, raw));
}

// ---------------------------------------------------------------------------
// OLD McDONNELL'S IS FITTED TO A DPS BAND, not to the flat yardstick above.
//
// The yardstick fits damage to a fixed time-to-kill, which makes throw DPS constant
// whatever the cadence is — and McDonnell's is the one invasion whose cadence CARRIES
// meaning. Its ladder speeds up as the player climbs it (stage 4 throws every 2s, stage 5
// every 1.5s, stage 6 every 1s), and `bossThrowIntervalSecs` eases the first two clears
// on top of that (half speed, then two-thirds). Fitted flat, all nine combinations landed
// on exactly 16.7 dmg/s: the tutorial easing bought nothing but rarer, heavier hits, and
// the stage ladder's own escalation was flattened out of existence.
//
// So this raid's throws are fitted to a BAND instead. The slowest fight the game can
// present — the opening armed stage, on a player's very first clear, when `minArmyFor`
// still lets them launch with ONE zombie — throws at the floor. The fastest, which takes
// both a full army's worth of levels and two clears behind them, throws at the cap. Every
// combination in between lands in proportion to its pace, so the ladder escalates and the
// easing eases again. The knobs are DPS because that is the language the yardstick
// already speaks: the flat fit is `referenceHealerHp / 15s`, which at this raid's rung
// (250 hit points) is 16.7 — a floor of 12 and a cap of 20 straddle it.
export const MCDONNELL_THROW_DPS_FLOOR = 12;
export const MCDONNELL_THROW_DPS_CAP = 20;
/** The two ends of that pace. SLOWEST is stage 4's authored 2s cadence halved for a
 *  player's first clear; FASTEST is stage 6's authored 1s at full speed. Both are read off
 *  raids.json rather than chosen — they are simply the extremes `bossThrowIntervalSecs`
 *  can return for this raid. */
export const MCDONNELL_THROW_SLOWEST_MS = 4000;
export const MCDONNELL_THROW_FASTEST_MS = 1000;

/** Where a McDonnell cadence sits in that band, in damage per second. Interpolated on the
 *  throw RATE rather than on the interval, because rate is what DPS is proportional to —
 *  so an evenly-spaced ladder of cadences gives an evenly-spaced ladder of pressure. */
export function mcdonnellThrowDps(intervalMs: number): number {
  const rate = 1000 / Math.max(1, intervalMs);
  const slowest = 1000 / MCDONNELL_THROW_SLOWEST_MS;
  const fastest = 1000 / MCDONNELL_THROW_FASTEST_MS;
  const t = Math.min(1, Math.max(0, (rate - slowest) / (fastest - slowest)));
  return MCDONNELL_THROW_DPS_FLOOR + t * (MCDONNELL_THROW_DPS_CAP - MCDONNELL_THROW_DPS_FLOOR);
}

/** The per-throw damage the boss's whole throw table should AVERAGE to, weighted by each
 *  option's authored frequency exactly as `rollAgainstFrequencyInArray:` rolls it.
 *
 *  Every raid but Old McDonnell's reads the flat yardstick: the reference healer's hit
 *  points spread over `throwLethalHits` landed throws. McDonnell's reads its DPS band
 *  instead, so its cadence keeps meaning what it was authored to mean. */
export function targetThrowDamage(raid: RaidDef, intervalMs: number): number {
  if (raid.id === MCDONNELL_ID) return mcdonnellThrowDps(intervalMs) * (intervalMs / 1000);
  return referenceHealerHp(raid.unlockLevel) / throwLethalHits(intervalMs);
}

/** Re-base a boss's throw damage onto the fight's own rung, preserving the authored shape.
 *  Takes the RaidDef rather than a bare level so a caller cannot pick the wrong one of the
 *  two things this needs (the raid's rung, and whether it is the raid with a DPS band).
 *
 *  Every option is multiplied by ONE factor, so the light/medium/heavy split and the duds
 *  (the Beach fishbone, the Tree apple and the Valentine spoon are all authored at 0) survive
 *  untouched. The factor never drops below 1: this is a floor under a boss that throws too
 *  softly for its rung, not a re-authoring of one that already hits hard — Zedzox's flat 100s
 *  are left exactly as the binary has them. */
export function fightScaledThrow(
  config: BossThrowConfig | null,
  raid: RaidDef
): BossThrowConfig | null {
  if (!config || !config.options.length) return config;
  const weight = config.options.reduce((sum, o) => sum + Math.max(0, o.weight), 0);
  if (weight <= 0) return config;
  const mean = config.options.reduce((sum, o) => sum + o.damage * Math.max(0, o.weight), 0) / weight;
  if (mean <= 0) return config; // a boss whose every throw is an authored dud stays one
  const scale = Math.max(1, targetThrowDamage(raid, config.intervalMs) / mean);
  if (scale === 1) return config;
  return {
    intervalMs: config.intervalMs,
    options: config.options.map((o) => ({ ...o, damage: o.damage * scale })),
  };
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
  let bossIdx = raid.stages.findIndex((s) => s.bossKey || s.randomBoss);
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

/** The boosts this raid's loot table can hand over, in tier order, each with the
 *  quantity ONE drop pays (`raidBoostBundle` — Insta-Grow drops ten at a time). Loot
 *  names are matched against the boost catalog, so the farm objects filling the rest
 *  of the table stay out, and a boost listed in two tiers is only named once. */
export function boostDrops(
  raid: RaidDef,
  boosts: readonly { key: string; name: string }[]
): { key: string; name: string; qty: number }[] {
  const seen = new Set<string>();
  const out: { key: string; name: string; qty: number }[] = [];
  for (const tier of raid.loot) {
    for (const name of tier) {
      const boost = boosts.find((b) => b.name === name);
      if (!boost || seen.has(boost.key)) continue;
      seen.add(boost.key);
      out.push({ key: boost.key, name: boost.name, qty: raidBoostBundle(boost.key) });
    }
  }
  return out;
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

// ---- Random-boss waves (Robots) --------------------------------------------
//
// GROUND TRUTH `-[ZFFightMan initialSpawn]`: a raid whose data sets `randomBoss`
// (only Zombies vs Robots does) takes a branch guarded on that flag which copies the
// raid's `enemies` array — ONE entry per enemy type — into `enemyList`, picks index
// `floor((arc4random() % 100) / 100 * count) % count`, spawns THAT entry as the boss
// and `removeObjectAtIndex:`es it. `spawnEnemy` then draws the survivors the same
// way, one at a time, removing each as it goes. So the fight fields exactly one of
// each robot, in a random order, with a random one of them leading it — which is what
// the wiki describes ("There are three types of Robots here… any one of them has a
// random chance to be the Boss", population 3) and what the frequencies do NOT do.
//
// The reimplementation reproduces that as a one-shot resolution instead of a spawn
// loop, because everything downstream (boss specials, the wall template, the pinned
// server config, the replay) reads a stage with a concrete `bossKey`.

/** Deterministic 0..1 stream from a string seed (FNV-1a → mulberry32). Both the client
 *  and the server must draw the SAME wave or the verified replay diverges, so the draw
 *  is seeded by the raid session id rather than Math.random. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Allocate an exact-size deterministic population from a weighted table. Start with
 *  each entry's floor, then give the remaining slots to the largest fractional shares.
 *  This preserves `population` exactly instead of independently rounding into extra
 *  units. The list comes out GROUPED by type, in table order — which is the order the
 *  wave used to emerge in, every fight (see resolveStageWave). */
export function weightedPopulation(stage: RaidStage): string[] {
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

/** Seeded Fisher–Yates over a copy. Consumes exactly `items.length - 1` draws. */
function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Turn a stage into the concrete wave a fight will play — the spawn queue, in order.
 *
 *  A `randomBoss` stage (Robots) draws its boss from the roster, then orders the rest.
 *  A `weighted` stage (every other raid's single wave, and Old McDonnell's top two
 *  rungs) fields its exact authored multiset — counts per type unchanged — in a seeded
 *  SHUFFLE (ruleset 48). The old order was the allocation's own: grouped by type, table
 *  order, identical every fight, so the first Lawyer invasion looked exactly like the
 *  hundredth. Bosses never enter the list (BattleSim sorts them last regardless), and an
 *  authored `enemyKeys` stage (McDonnell's tutorial rungs — lumberjack last on purpose)
 *  is returned untouched. Every caller can resolve unconditionally and then read
 *  `bossKey` / `enemyKeys` normally.
 *
 *  `rand` must be seeded (see seededRandom) wherever the fight is server-verified: the
 *  Worker pins the order it draws at /raid/start into the session, and the client redraws
 *  from the same seed. The Robots' draw sequence is unchanged, so raid 5 is bit-identical
 *  to before the shuffle existed. */
export function resolveStageWave(stage: RaidStage, rand: () => number): RaidStage {
  if (stage.randomBoss) {
    const roster = (stage.weighted ?? []).map((entry) => entry.enemy).filter(Boolean);
    if (!roster.length) return stage;
    // Source order: the boss is drawn (and removed) first, then each remaining spawn.
    const bossKey = roster.splice(Math.min(roster.length - 1, Math.floor(rand() * roster.length)), 1)[0];
    const enemyKeys: string[] = [];
    while (roster.length) {
      enemyKeys.push(roster.splice(Math.min(roster.length - 1, Math.floor(rand() * roster.length)), 1)[0]);
    }
    // `enemyKeys` now drives the wave, so drop `weighted`: buildEnemyUnits prefers the
    // explicit list, and leaving both would let a later reader re-derive the old
    // frequency allocation (which could never field all three bots).
    return { ...stage, bossKey, enemyKeys, weighted: undefined, population: enemyKeys.length };
  }
  if (stage.weighted && !(stage.enemyKeys && stage.enemyKeys.length)) {
    const enemyKeys = shuffled(weightedPopulation(stage), rand);
    if (!enemyKeys.length) return stage;
    // Same reasoning as above: the list drives the wave, and `weighted` would let a
    // later reader re-derive the grouped order.
    return { ...stage, enemyKeys, weighted: undefined, population: enemyKeys.length };
  }
  return stage;
}

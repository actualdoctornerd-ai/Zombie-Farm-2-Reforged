// Elite invasions — what a Brain Ticket buys.
//
// A Brain Ticket is the Invasion Voucher's expensive cousin: it skips the same
// between-invasions wait, but it also QUADRUPLES the fight's brain and rare-zombie odds
// and, in exchange, promotes the invasion to ELITE — the authored wave fought at scaled
// stats. Nothing else about the raid changes: same enemies, same wave size, same gold,
// same loot table, same hazards. Only the numbers move.
//
// DETERMINISM CONTRACT. The scaling here feeds `buildEnemyUnits` and the boss's
// throw/special/wall configuration, all of which are part of the deterministic fight the
// server replays. The client (RaidManager.beginRaid) and the server (raidVerifier's two
// `buildPinned*` paths) must therefore derive the profile from the SAME inputs — the raid
// id and the session's elite flag — and nothing else. Editing a profile changes every
// elite transcript, so it is a ruleset change: bump RAID_RULESET_VERSION in the same
// commit (see replay.ts).
//
// ---------------------------------------------------------------------------
// CALIBRATION
//
// Difficulty is measured as p* — the weakest army that still wins, expressed as a stat
// multiplier on a 16-strong roster of the best catalog zombies, run headlessly through
// the real BattleSim. Lower p* = easier. eliteInvasion.balance.test.ts computes it and
// asserts the relationships below; these are the values it measured when the table was
// fitted:
//
//   raid                 normal   elite      the rung it was fitted to
//   Old McDonnell's        0.11    0.60      not a p* target — see below
//   Summer Break           0.12    0.51      between Pirates and Robots
//   Tree World             0.11    0.56      between Pirates and Robots
//   Valentine's Day        0.11    0.56      between Pirates and Robots
//   Circus                 0.10    0.66      Robots, normally
//   Lawyers                0.28    0.69      Robots, normally
//   Pirates                0.46    1.72   \
//   Ninjas                 0.77    1.78    |
//   Robots                 0.75    1.98    >  the elite RAMP (see below)
//   Aliens                 1.00    2.16    |
//   Video Games            1.48    2.57   /
//
// (Re-measured at ruleset 35: the formation fix there lifted every rung a little, and
// the Pirates a lot — see raid 3's entry for why, and for the re-fit that answers it.
// Re-measured again at ruleset 40: the standing-front-row reach lifted every rung
// +3-9% — Pirates and Video Games elites the high end — without moving any rung off
// its band, so the profiles themselves were left alone.)
//
// THE TOP FIVE ARE A RAMP, not a band. The five late invasions are fitted to a smooth
// climb in ladder order — 1.58 at the Pirates (rec 21) up to 2.22 at the Video Games
// (rec 43), in even steps of roughly 0.13-0.19 — so a player working up the ladder meets a
// Brain Ticket fight a little harder each time, and the hardest elite invasion in the
// game is the last one they unlock.
//
// It used to be a BAND: the Robots, the Aliens and the Video Games shared one tier at the
// top, because the Video Games' ORDINARY fight measured 2.11-2.72 and there was no
// headroom above it to ramp into. That number was never the raid's design — it was
// `turnZombie` silently deleting a zombie every few seconds (see BattleSim's turnZombie
// case, and docs/mechanics/ENEMY_DAMAGE_RECOVERED.md). With the conversion in place the
// ordinary fight measures 1.33, still the hardest on the ladder but no longer a cliff,
// and the headroom the band existed to work around came back. Hence this re-fit: raids
// 3/4/5/6 come DOWN off the old shared tier and raid 9 goes UP to sit above them all.
//
// OLD McDONNELL'S IS NOT FITTED TO A p* TARGET, and that is the one place this metric
// let the tuning down. It was fitted to the Pirates (p* 0.40) and measured there — but p*
// only asks "can you win", and against a wave that feeble the answer stayed yes whatever
// the profile did, so the fitted numbers produced a fight that played like the tutorial
// with a bigger boss. Playtested and rejected as far too soft. It is now specified in HIT
// POINTS instead — the ordinary Pirates' bulk, 40,000 across the wave with a 12,000 boss
// — and p* 0.56 is simply where that lands. See its table entry.
//
// THE CEILING IS REAL, and it is why the ramp tops out at 2.21 rather than higher. A
// measuring-stick army stops winning the Video Games not far above their elite figure,
// and 20 zombies barely beat 16 (only the front of the formation engages), so army SIZE
// is not the answer either. Elite has to fit under that.
//
// SHAPE, not just size. Each raid spends its budget on the mechanic it is known for, so
// an elite run feels like more of THAT invasion rather than uniform stat inflation.
//
// ---------------------------------------------------------------------------
// THE PROJECTILE RE-FIT (ruleset 34) — why every `throwDamage` in this table moved.
//
// `throwDamage` multiplies the ORDINARY fight's throw, and until ruleset 34 that throw was
// the authored chip value: a mechanic that had stopped being one (see
// RaidCatalog.fightScaledThrow). So these multipliers were never fitted against anything.
// They were fitted against nothing, and it shows — measured as damage per second against
// the reference healer the yardstick is sized on, the elite projectile ranged from 11
// (Lawyers, which needed 22 SECONDS to kill it) to 259 (Circus, which needed 0.8).
//
// Ruleset 34 makes the ordinary throw real, and it lands hardest exactly where the old
// numbers were most inflated. Left alone, the two multiplied together: elite Circus went to
// 343 dmg/s — a healer deleted in six tenths of a second — and elite Pirates to 74, a 4.86x
// step on a base that had itself just gone up 4.42x. That is the whole reason this block
// exists: a floor under the ordinary throw is not a licence to raise the elite one by the
// same factor twice.
//
// So `throwDamage` is now fitted as a STEP over the rebalanced throw, and the step is what
// each profile is documented by:
//
//   raid                 step   raid                 step
//   Old McDonnell's      3.00   Summer Break         4.00
//   Lawyers              2.00   Circus               3.99
//   Pirates              2.00   Video Games          2.22   (unchanged — see below)
//   Ninjas               2.20   Tree World           4.01
//   Robots               2.00   Valentine's Day      4.01
//
// The band is 2x-4x and the ORDER inside it is the old table's own, compressed: the raids
// whose ordinary throw the rebalance barely touched (Summer 1.23x, Tree 1.57x, Valentine
// 1.60x, Circus 1.33x) keep the most elite headroom, and the raids it lifted hardest
// (Pirates 4.42x, Lawyers 3.65x) keep the least, because their elite throw is now a step on
// a far heavier base. In absolute terms that still leaves elite Pirates throwing 243 a hit
// against elite Summer Break's 56 — the step is small there precisely because the base is
// not. `throwRate` is untouched throughout: how OFTEN a boss throws is its character (the
// Circus ringmaster still juggles at 3x), and the step is delivered through damage.
//
// The Video Games are the control: raid 9 is the one invasion whose ordinary throw the
// rebalance does not touch at all (Zedzox's flat 100s already clear the floor), and its
// profile comes out of the re-fit unchanged at 1.72. A re-fit that moved it would have been
// re-authoring rather than accounting.
//
// Guarded by `projectileScale.test.ts`, which measures the step from the shipped config on
// both sides of `eliteBossThrow` — so a profile edit and a yardstick edit both have to face
// the same assertion.
// ---------------------------------------------------------------------------

import type { BossSpecial, BossThrowConfig, EnemyStat } from "./types";

/** The consumable that starts an elite invasion (Market → Boosts). */
export const BRAIN_TICKET_KEY = "brain_ticket";

/** How much an elite invasion multiplies its brain tiers (brainDrops.brainDropTable)
 *  and its rare-zombie chance (zombieDrops.raidZombieDropRate). The whole point of the
 *  ticket — the difficulty is the price. */
export const ELITE_BRAIN_LUCK = 4;

/** Per-raid stat/behaviour multipliers for an elite fight. Every field multiplies; 1
 *  means "unchanged". */
export interface EliteProfile {
  /** Enemy `str` — per-hit damage (damage = str x 10 x attack multiplier). */
  str: number;
  /** Enemy `con` — hit points (hp = con x 100). Restraint here is deliberate: HP is
   *  what makes a fight LONG, and a fight that outlives the four-minute replay cap
   *  (RAID_MAX_TICKS) cannot settle at all. */
  con: number;
  /** The BOSS's `con`, when it should not scale with the rest of the wave. Absent means
   *  "same as `con`". A separate lever because minions and bosses carry very different
   *  shares of a wave's hit points, so one multiplier cannot place both: Old McDonnell's
   *  boss is 38% of his wave, the Aliens' is 17%, and asking for "a 40,000 wave with a
   *  12,000 boss" is simply not expressible with a single number. */
  bossCon?: number;
  /** Enemy `dex` — attack cadence (interval = 1 / dex seconds). Held to modest values
   *  everywhere: past roughly 1.6x, enemies stop reading as enemies and start reading
   *  as a strobe. */
  dex: number;
  /** Boss projectile damage — a step over the fight's REBALANCED throw
   *  (RaidCatalog.fightScaledThrow), not over the authored chip value. See the projectile
   *  re-fit in the header for the band these are fitted to. */
  throwDamage: number;
  /** Boss projectile RATE — 2 means twice as many throws (half the interval). */
  throwRate: number;
  /** Hit points of the blocker the boss's `wall` special drops (Ninja carrotWall /
   *  Robot junkWall). Capped low on purpose: the wall is tapped down by hand, so a big
   *  multiplier is a big multiplier on MANUAL INPUT, and a wall the army cannot chew
   *  through in time can stalemate a fight into the replay cap. */
  wallHp: number;
  /** Damage of the boss's non-throw specials (alien laser, pixel fire, telekinesis…). */
  specialDamage: number;
}

const PLAIN: EliteProfile = {
  str: 1, con: 1, dex: 1, throwDamage: 1, throwRate: 1, wallHp: 1, specialDamage: 1,
};

/** Fallback for a raid with no authored profile (a new invasion, before it is tuned).
 *  A flat, unremarkable step up — never nothing, so a Brain Ticket is never a pure
 *  refund of 10,000 gold. */
export const DEFAULT_ELITE_PROFILE: EliteProfile = {
  str: 2, con: 1.8, dex: 1.3, throwDamage: 2, throwRate: 1.4, wallHp: 1.4, specialDamage: 2,
};

export const ELITE_PROFILES: Readonly<Record<number, EliteProfile>> = {
  // 1 — Old McDonnell's Farm. No signature mechanic to lean on, so it does what the
  // farmhands would do if they were any good: everything, harder.
  //
  // The con multipliers are the largest in the table BY A MILE, and they are not typos.
  // His wave is the feeblest in the game — 5,200 hit points total, against 34,500 for the
  // Pirates and 132,000 for the Video Games — so a merely-proportionate lift still left
  // every farmhand dying to a single volley and the boss on 5,800 hit points. Playtest
  // verdict on that version: not tanky enough, by a lot.
  //
  // The target is a 40,000 wave with a 12,000 boss — near enough the ORDINARY Pirates
  // (34,500 / 12,000), which is the rung this raid was aimed at all along. Minions and
  // boss need different multipliers to land it (see `bossCon`): x8.75 takes the ten
  // farmhands and lumberjacks from 3,200 to 28,000, and x6 takes the boss from 2,000 to
  // 12,000.
  //
  // Everything ELSE stayed where it was, and that restraint is load-bearing. Lengthening
  // a fight already multiplies the damage taken; raising str on top of it (x4 was tried)
  // turned an unmutated 16-strong roster's casualties into a total wipe. The ask was
  // tankier, so tankiness is the only thing that moved.
  //
  // `throwDamage` 2.9 -> 2 in the projectile re-fit, for a step of 3.00 — the largest in
  // the band, and deliberately so: this is the only raid whose ORDINARY throws are fitted
  // to a DPS band (12 at the tutorial end, 20 at the top of its ladder) rather than to the
  // flat yardstick, so an elite fight here steps off whichever rung the player is on.
  1: { str: 2.9, con: 8.75, bossCon: 6, dex: 1.6, throwDamage: 2, throwRate: 1.5, wallHp: 1, specialDamage: 2.9 },

  // 2 — Zombies vs Lawyers. The Corporate boss is the ladder's speed threat: fast
  // punches and the Double Punch stun. So this is the one profile that spends most of
  // its budget on DEX, and the stun special hits hardest of all.
  2: { str: 1.6, con: 1.8, dex: 1.85, throwDamage: 1.48, throwRate: 1.35, wallHp: 1, specialDamage: 2.1 },

  // 3 — Zombies vs Pirates. Pirates hit like a cannon and their Scallywag mirrors your
  // attack speed, so speed is explicitly NOT their lever: dex stays at 1.0 and the whole
  // budget goes into raw power. An elite pirate one-shots almost anything it reaches;
  // the counterplay is the same as it always was — do not bring a fast army.
  //
  // v31 RE-FIT (x0.90 on every multiplier's distance from 1.0, shape untouched) — the
  // bottom rung of the elite RAMP, fitted to p* 1.50. It comes down slightly because the
  // whole top of the ladder came down off the old shared band; see the header. Its
  // character is untouched, dex very much included.
  //
  // `throwDamage` 4.86 -> 2 in the projectile re-fit (step 2.00), the biggest cut in the
  // table after the Circus. Nothing about the elite pirate got softer: this raid's ordinary
  // throw went up 4.42x in ruleset 34 — the largest lift of any invasion — and 4.86 on top
  // of that was the same increase charged twice. The anchor still lands for 243.
  //
  // v35 RE-FIT (x0.85 on the STAT levers' distance from 1.0 — str, con, specialDamage;
  // dex and the two throw fields untouched, the latter because they are fitted by the
  // projectile band above rather than to a p* rung). The formation fix in ruleset 35 —
  // an enemy no longer stands idle while the line re-forms behind a reinforcement — moved
  // every rung UP, and it moved THIS one hardest by far: 1.50 -> 1.80, against 1.67 -> 1.72
  // at the Ninjas above it. That is the fix landing where it should. An elite pirate
  // one-shots the zombie it reaches, so this is the raid that spends the most of its time
  // with a fresh zombie walking up to replace a dead one, and it was collecting the free
  // window every time. Left alone it would have overtaken the Ninjas and inverted the
  // bottom of the ramp. Re-fitted to p* 1.58, which restores the order and keeps the climb
  // smooth; the shape, and the character it encodes, are untouched.
  3: { str: 5.28, con: 2.84, dex: 1, throwDamage: 2, throwRate: 1, wallHp: 1, specialDamage: 3.98 },

  // 4 — Zombies vs Ninjas. Their mechanic is the carrot WALL, so the wall gets tougher
  // (more taps, and more of the army's damage spent on it) — but only to ~1.6x, see
  // `wallHp`. The rest is a broad stat lift.
  //
  // `throwDamage` 2.74 -> 1.34 in the projectile re-fit (step 2.20); the wall, which is
  // what this raid is actually about, is untouched.
  //
  // v31 RE-FIT (x1.157 on every multiplier's distance from 1.0, shape untouched) — the
  // ramp's second rung, fitted to p* 1.66. Alone among the five it goes slightly UP: the
  // ramp is a straight climb in ladder order, and the Ninjas sit between a Pirates raid
  // that came down and a Robots raid that came down further.
  // v46 FIFO RE-FIT: corrected front-line ordering made this rung overshoot its intended
  // relationship to the Video Games. Its non-projectile multipliers step down together;
  // the calibrated throw step stays exactly as authored above.
  4: { str: 2.85, con: 1.76, dex: 1.39, throwDamage: 1.34, throwRate: 1.64, wallHp: 1.55, specialDamage: 2.31 },

  // 5 — Zombies vs Robots. One of each bot, a random one leading, each with its own
  // special (junk wall, telekinesis). Bots are already the tankiest wave in the game, so
  // con is held back and the budget goes into their specials and their punch.
  //
  // `throwDamage` 2.4 -> 1.4 in the projectile re-fit (step 2.00). The BrainBot is the one
  // boss that abandons its perch mid-fight and stops throwing at all, so the projectile was
  // never where its danger lived; the telekinesis is (`specialDamage`, untouched).
  //
  // v31 RE-FIT (x0.826 on every multiplier's distance from 1.0, shape untouched) — the
  // ramp's middle rung, fitted to p* 1.82. It was one of the three sharing the old top
  // band; with the Video Games' ordinary fight no longer a cliff there is room for a
  // proper climb above it, so it steps down to make that room.
  5: { str: 2.61, con: 1.92, dex: 1.43, throwDamage: 1.4, throwRate: 1.43, wallHp: 1.54, specialDamage: 3.04 },

  // 6 — Zombies vs Aliens. Twenty minions, a summoning boss and the laser. Their normal
  // fight is already the longest on the ladder (over two minutes), so con barely moves —
  // an elite alien wave is not a longer grind, it is a far more dangerous one.
  //
  // v27 RE-FIT, and it goes DOWN — the mechanics now supply the danger the multipliers
  // used to have to fake. Two recovered changes pull in opposite directions and the
  // second wins by a distance (see raid/alienStage.ts):
  //   * the SWARM (six aliens at once instead of one) made the raid EASIER against a big
  //     army, because sixteen zombies chewing six targets clear twenty minions in a
  //     fraction of the wall-clock a one-at-a-time queue took;
  //   * the ABDUCTEES made it much harder. They are beamed into the middle of the stage
  //     and stand there, so unlike every other enemy in the game they are not something
  //     the army walks up to — they are a roadblock across the lane that the whole army
  //     has to stop and clear, one after another, for as long as the boss keeps casting.
  // Measured on the balance stick, the ORDINARY invasion went 0.84 -> 0.93 (it is a real
  // fight now, not a queue) and the elite one blew past the stick entirely at 5.16. This
  // brings it back between the Robots and the Video Games, at multipliers well below
  // where they started, after the playtest passes that settled the minion's str at 5 and
  // moved the wave's hold line right; see UNIT_OVERRIDES in tools/prep_raids.py and
  // ENEMY_HOLD_X in BattleSim.
  //
  // v31 RE-FIT (x0.78 on every multiplier's distance from 1.0, shape untouched) — the
  // ramp's fourth rung, fitted to p* 1.98 and landing at 2.04. p* is STEP-LIKE here: the
  // nearest values either side of 0.78 measure 1.89 and 2.06, with nothing in between, so
  // 2.04 is chosen as the one that keeps the ramp's steps even rather than as a miss.
  // Currently measures 0.97 / 2.04.
  //
  // The remaining four are INERT on this raid and are left alone rather than scaled for
  // the look of the table: the alien boss has no `throw` and no `wall`, and its
  // `alienLaser` action carries no authored `damage`, so `specialDamage` multiplies a
  // zero and BattleSim falls through to the flat 200 the binary hard-codes.
  6: { str: 2.56, con: 1.31, dex: 1.35, throwDamage: 2.78, throwRate: 1.51, wallHp: 1, specialDamage: 4.04 },

  // 7 — Summer Break. No signature boss mechanic (the crab is a client-side hazard and
  // is deliberately left alone — see below), so it scales broadly, with heavier beach
  // balls. `throwDamage` 4 -> 2.22 in the projectile re-fit, which still leaves it near the
  // TOP of the band (step 4.00): ruleset 34 barely moved this raid's ordinary throw (1.23x,
  // the smallest lift of any invasion that moved at all), so its elite headroom survived
  // almost intact.
  7: { str: 3.2, con: 3.2, dex: 1.6, throwDamage: 2.22, throwRate: 1.8, wallHp: 1, specialDamage: 3.2 },

  // 8 — Zombies vs Circus. The ringmaster's juggling act is the mechanic, and it still is:
  // elite throws come three times as often (`throwRate` 3, untouched, and the largest in
  // the table) and the raid sits at the top of the projectile band with the Summer and
  // seasonal fights.
  //
  // `throwDamage` 8 -> 1.33 in the projectile re-fit, and that is the single largest cut in
  // this table's history. The 8 was not a difficulty decision — it was the number needed to
  // make a projectile matter when the ordinary throw was 14.55 of chip damage. Ruleset 34
  // makes the ordinary throw real, and 8x on top of it measured 343 dmg/s: an elite
  // ringmaster deleting the healer he is aimed at in six tenths of a second, from off
  // screen, before the army had finished walking out. At 1.33 the juggling still lands
  // FOUR times an ordinary Circus fight's projectile pressure, delivered as three lighter
  // hits rather than one absurd one, which is what juggling ought to look like.
  //
  // str and con go x2 on their distance from 1.0 (2.8 -> 4.6, 3 -> 5) in the same change,
  // and that is not a difficulty pass either — it is the same budget, moved. This is the
  // only invasion whose boss has NO action but the throw, so the projectile was carrying a
  // real share of the elite fight's difficulty rather than merely looking absurd: cutting it
  // alone dropped the elite p* from 0.62 to 0.39 and took the raid clean off the rung it is
  // fitted to (Robots, normally). At 4.6/5 it measures 0.61 again. `dex` is deliberately NOT
  // part of the move and stays at 1.6 — see the field's own note about the strobe.
  //
  // The TRAPEZE ARTIST is untouched — it is grabbed zombies and frantic tapping, and
  // multiplying a hazard multiplies manual input rather than difficulty.
  8: { str: 4.6, con: 5, dex: 1.6, throwDamage: 1.33, throwRate: 3, wallHp: 1, specialDamage: 3 },

  // 9 — Zombies vs Video Games. The last invasion unlocked, the hardest ordinary fight on
  // the ladder, and now the TOP OF THE ELITE RAMP too — it spends what it has on
  // turnZombie and pixelFire, the specials that make the fight what it is.
  //
  // v31 RE-FIT (x2.33 on every multiplier's distance from 1.0, shape untouched), fitted to
  // p* 2.20 and measuring 2.21. This is the largest single move any profile in this table
  // has ever taken, and it is a correction rather than a difficulty pass. The profile was
  // deliberately kept tiny for as long as the raid's ORDINARY fight measured 2.11-2.72 —
  // there was no headroom to put an elite step into, and the note that used to live here
  // said as much. That difficulty was `turnZombie` deleting a front zombie outright every
  // few seconds; with the conversion in place the ordinary fight measures 1.33 and the
  // headroom is back, so the Brain Ticket can finally buy a real fight here instead of
  // just the brains. The step is now 1.66x, in line with the rest of the table.
  //
  // Its multipliers are still the SMALLEST in the table by a distance, and that is right:
  // it is scaling the heaviest baseline in the game.
  //
  // Alone in the table it came through the ruleset 34 projectile re-fit UNCHANGED, and that
  // is the check on the whole exercise rather than an oversight: Zedzox's authored flat 100s
  // already cleared the yardstick, so his ordinary throw did not move, so his elite step
  // (2.22) did not need to.
  // v46 FIFO RE-FIT: the corrected line made the Aliens narrowly overtake this final rung,
  // so its non-projectile profile gets a small lift to keep the last unlocked invasion the
  // hardest elite fight. The independently calibrated projectile step stays unchanged.
  9: { str: 1.64, con: 1.48, dex: 1.32, throwDamage: 1.72, throwRate: 1.29, wallHp: 1, specialDamage: 2.13 },

  // 10 / 11 — Tree World and Valentine's Day. Seasonal, no signature mechanic, and the
  // two weakest waves after McDonnell's, so they take the same broad treatment as
  // Summer Break with a little more of it. `throwDamage` 4.9 -> 2.11 in the projectile
  // re-fit; like Summer Break they keep a top-of-band step (4.01) because ruleset 34 lifted
  // their ordinary throws only 1.57x and 1.60x. Their apple and spoon are authored duds and
  // stay duds — an elite multiplier on zero is still zero.
  10: { str: 3.8, con: 3.8, dex: 1.6, throwDamage: 2.11, throwRate: 1.9, wallHp: 1, specialDamage: 3.8 },
  11: { str: 3.8, con: 3.8, dex: 1.6, throwDamage: 2.11, throwRate: 1.9, wallHp: 1, specialDamage: 3.8 },
};

/** The multipliers this fight runs under: null for an ordinary invasion (so every
 *  caller can pass the result straight through and the non-elite path stays exactly the
 *  code it was), the raid's profile for an elite one. */
export function eliteProfile(raidId: number, elite: boolean): EliteProfile | null {
  if (!elite) return null;
  return ELITE_PROFILES[raidId] ?? DEFAULT_ELITE_PROFILE;
}

/** Scale one enemy's stat template. Only str/con/dex move — attack lists, boss actions
 *  and the loot flags are the raid's own data and stay untouched. `isBoss` selects
 *  `bossCon` over `con` where a profile sets one. */
export function eliteEnemyStat(
  stat: EnemyStat,
  profile: EliteProfile | null,
  isBoss = false
): EnemyStat {
  if (!profile) return stat;
  return {
    ...stat,
    str: (stat.str ?? 1) * profile.str,
    con: (stat.con ?? 1) * ((isBoss ? profile.bossCon : undefined) ?? profile.con),
    dex: (stat.dex ?? 1) * profile.dex,
  };
}

/** Scale the boss's projectile config: harder hits, and `throwRate` times as many of
 *  them (a rate multiplier DIVIDES the interval). */
export function eliteBossThrow(
  config: BossThrowConfig | null,
  profile: EliteProfile | null
): BossThrowConfig | null {
  if (!config || !profile) return config;
  return {
    intervalMs: config.intervalMs / Math.max(0.01, profile.throwRate),
    options: config.options.map((option) => ({ ...option, damage: option.damage * profile.throwDamage })),
  };
}

/** Scale the boss's non-throw specials. Cast and cooldown are left alone: they are the
 *  player's window to react, and shrinking them turns "harder" into "unreadable". */
export function eliteBossSpecials(
  specials: BossSpecial[],
  profile: EliteProfile | null
): BossSpecial[] {
  if (!profile) return specials;
  return specials.map((special) => ({ ...special, damage: special.damage * profile.specialDamage }));
}

/** Scale the hit points of a boss-summoned wall. */
export function eliteWallHp(hp: number, profile: EliteProfile | null): number {
  return profile ? hp * profile.wallHp : hp;
}

/** Everything an elite fight multiplies, as plain numbers, for the profile table's own
 *  regression test and for tooling. */
export function eliteMultipliers(raidId: number): EliteProfile {
  return eliteProfile(raidId, true) ?? PLAIN;
}

// HALLOWEEN NIGHTS: "the night is still young".
//
// A won Halloween invasion offers to keep going. Each further NIGHT is the same fight again,
// fought by the survivors at full health, against an opposition that is much bulkier and
// somewhat harder-hitting than the last; and the further the chain goes, the likelier the
// rare zombie and, gently, the brains. A night pays like any
// other win the moment it is won, so fleeing (or losing) a night costs only that night:
// everything the earlier ones paid is already banked. Owner design, 2026-10-24.
//
// A BRAIN TICKET starts the chain two nights in: "Elite Night 1" is fought at night 3's
// strength, Elite Night 2 at night 4's, and so on, with the usual elite 4x on brains and
// rare zombies on every night of it. The NIGHT a player sees (and the drop curve) counts
// from 1 either way; the STAGE (nightStage) is what the fight is scaled by.
//
// THE CURVE. Every hour from the second is a two-minute fight on a SLOW climb: each hour
// steps a fixed fraction of the way up the old one-hour-at-a-time curve (nightDifficulty),
// so Hour 12 lands between that curve's 6th and 7th rung, at two thirds of its hit points
// (owner, 2026-10-25). Hour 12 is meant to be an achievement: beatable, but only reliably by
// a fully optimised army played well. Loot climbs on the same slow step.
//
// PURE and shared: the client composes its fight from this, the Worker pins its config from
// it, and the difficulty harness measures it. A disagreement between any two is a replay
// desync, so nothing here may read a save, a clock or a device.
import type { EliteProfile } from "./eliteInvasion";
import { HALLOWEEN_RAID_ID } from "./zombieDrops";

/** The ordinary fight is night 1; every continuation is the next night up. */
export const FIRST_NIGHT = 1;
/** The chain's hard cap. Players see each night as an HOUR of the Count's party (see
 *  nightLabel), and twelve hours is a whole night, so Hour 12 is the last one offered
 *  (owner, 2026-10-24), and the ordinary curve is built to end there (NIGHT_LAST_DIFFICULTY).
 *  A Brain Ticket run's STAGE runs two past it (MAX_STAGE). */
export const MAX_NIGHT = 12;

/** Where Hour 12 sits on the OLD hour curve (one old rung per hour: HP (1 + n(n-1)/2) x
 *  1.2^(n-1), damage +125% a rung). Hour h sits at nightDifficulty(h), a straight line from
 *  1 (Hour 1) to this (Hour 12), so each hour climbs ~0.53 of an old rung.
 *
 *  Chosen against REAL armies (owner, 2026-10-25). The harness was first calibrated on
 *  production: replaying the 22 real Hour 6-7 sessions with each player's exact army, it
 *  matched the real result on 21 (clear times within seconds; the miss ran pessimistic).
 *  Then the top 8 of 30 current level-45 accounts flew Hours 11-12, four seeds each:
 *
 *                       expert + Concentration      competent, no Concentration
 *      6.7              7 of 8 win Hour 12           #1-#3 win it every time        too easy
 *      6.85 (this)      #1-#4 4/4, #5 2/4, rest 0     #1-#2 1/4, rest 0              target
 *      7.0              #3 4/4, #2 2/4, rest 0        nobody                         too hard
 *
 *  The full ladder at 6.85, two-minute clock, real armies (last hour won): level-45 top
 *  accounts 12 (116-119 s), #8 account 11, median 9, bottom quarter 4; level-40 strong 8,
 *  median 5; level-30 median 6 (Hour 7 half the time), strong 5; level-20 2. */
export const NIGHT_LAST_DIFFICULTY = 6.85;
/** Hit points from hour 2 are this share of the old curve's at the same difficulty: the
 *  clock is two minutes, not three (owner, 2026-10-25). */
export const NIGHT_HP_SCALE = 2 / 3;
/** The old curve's x1.2 compounding on its growing base step (1, 2, 4, 7, 11, 16 ...). */
export const NIGHT_HP_COMPOUND = 1.2;
/** Damage on the old curve: +125% of base a rung (2026-10-25). */
export const NIGHT_DAMAGE_STEP = 1.25;
/** The win gold an hour pays from hour 2 on, as a share of the invasion's: the hours are a
 *  brains-and-zombies chase, not a gold farm (owner, 2026-10-24), but going further pays
 *  better (2026-10-25): 25%, then NIGHT_GOLD_STEP more per rung of difficulty, never below
 *  25%; about 49% at Hour 12. Night 1 pays in full. */
export const NIGHT_GOLD_SHARE = 0.25;
export const NIGHT_GOLD_STEP = 0.05;
/** Every hour after the first is on a two-minute clock (owner, 2026-10-25; was three).
 *  Clocking out is an ordinary loss. A full Hour 1-12 run is ~13 minutes of fighting. */
export const NIGHT_TIME_LIMIT_MS = 2 * 60 * 1000;
/** DO OR DIE (owner, 2026-10-25): when a Halloween fight's clock runs out it is not lost yet.
 *  One more minute plays, with every enemy at twice its dex, every enemy blow doubled (~4x
 *  damage a second) and the boss throwing twice as fast (BattleSim.DO_OR_DIE_HASTE /
 *  DO_OR_DIE_DAMAGE), under a flashing red countdown; only running that out is the loss.
 *  The point is a choice: retreat with what you won, or push on and risk the army. Every
 *  hour, Hour 1 included. */
export const DO_OR_DIE_MS = 60 * 1000;

/** This fight's Do or Die overtime: a minute on Halloween, none anywhere else. */
export function doOrDieMs(raidId: number): number {
  return hasNights(raidId) ? DO_OR_DIE_MS : 0;
}

/** How long after a won night the next one may still be started. Generous, because the
 *  result panel, the revival offer and a phone call all happen in between; bounded,
 *  because a chain is one sitting, not a standing pass around the cooldown. */
export const NIGHT_CONTINUE_WINDOW_MS = 15 * 60 * 1000;

/** How many nights ahead a Brain Ticket starts the chain: Elite Night 1 is night 3's fight. */
export const ELITE_NIGHT_OFFSET = 2;
/** The highest STAGE a fight is scaled at: Elite Hour 12, two past the ordinary Hour 12. The
 *  elite chain is NOT capped at Hour 12's strength (owner, 2026-10-25): Hour 12 is the
 *  achievement to clear, Elite Hour 12 something harder that today's best armies may not
 *  manage until builds and content catch up. Elite Hours 11 and 12 climb the same line on
 *  to stage 13 (~x52 hit points) and 14 (~x67), against Hour 12's ~x41. */
export const MAX_STAGE = MAX_NIGHT + ELITE_NIGHT_OFFSET;
/** Rare-zombie odds multiply by this per rung of difficulty (nightDifficulty): 1% on Hour 1,
 *  ~2.9% on Hour 6, ~10.7% on Hour 12 on an ordinary run, before the caps in zombieDrops. */
export const NIGHT_ZOMBIE_GROWTH = 1.5;
/** Brain odds multiply by this per rung of difficulty: a gentle climb from a halved start. */
export const NIGHT_BRAIN_GROWTH = 1.1;
/** Halloween's brain odds as a share of its rung's (which sits just under the Pirates'), on
 *  every hour and on a Brain Ticket too. Set so a full twelve-hour run pays ~1.5 brains on
 *  average, and a full Brain Ticket run ~5.8 (owner, 2026-10-25; was 0.5, ~2.5 / ~9.6): the
 *  rare zombies and the coffins are the prize, the brains a bonus. Before the brain pity
 *  (brainDrops.BRAIN_PITY_INVASIONS), which is account-wide and lifts a run from a clean
 *  streak to ~2.2. */
export const HALLOWEEN_BRAIN_SCALE = 0.294;

/** Does this invasion offer further nights? */
export function hasNights(raidId: number): boolean {
  return raidId === HALLOWEEN_RAID_ID;
}

/** A night number off the wire or a session: an integer in [FIRST_NIGHT, MAX_NIGHT]. */
export function clampNight(night: unknown): number {
  const n = Math.floor(Number(night));
  return Number.isFinite(n) ? Math.max(FIRST_NIGHT, Math.min(MAX_NIGHT, n)) : FIRST_NIGHT;
}

/** A fight STAGE off a session or the wire: an integer in [FIRST_NIGHT, MAX_STAGE]. */
export function clampStage(stage: unknown): number {
  const n = Math.floor(Number(stage));
  return Number.isFinite(n) ? Math.max(FIRST_NIGHT, Math.min(MAX_STAGE, n)) : FIRST_NIGHT;
}

/** How far up the old one-rung-per-hour curve a STAGE sits: 1 on Hour 1, rising in a
 *  straight line to NIGHT_LAST_DIFFICULTY on Hour 12, and on past it for the elite chain's
 *  stages 13-14. Fractional; every curve below reads it. */
export function nightDifficulty(night: number | undefined): number {
  const n = clampStage(night);
  return 1 + ((NIGHT_LAST_DIFFICULTY - 1) * (n - FIRST_NIGHT)) / (MAX_NIGHT - FIRST_NIGHT);
}

/** Enemy hit-point multiplier on `night`: 1 on Hour 1, then NIGHT_HP_SCALE of the old curve
 *  at nightDifficulty (x1.0 on Hour 2, ~x6.3 on Hour 6, ~x40.7 on Hour 12). */
export function nightHpMult(night: number): number {
  if (clampStage(night) <= FIRST_NIGHT) return 1;
  const s = nightDifficulty(night);
  return NIGHT_HP_SCALE * (1 + (s * (s - 1)) / 2) * Math.pow(NIGHT_HP_COMPOUND, s - 1);
}

/** Enemy damage multiplier on `night`: the old +125% a rung at nightDifficulty (x1.66 on
 *  Hour 2, ~x4.3 on Hour 6, ~x8.3 on Hour 12). The Count's slam follows it. */
export function nightDamageMult(night: number): number {
  return 1 + NIGHT_DAMAGE_STEP * (nightDifficulty(night) - 1);
}

/** The multipliers a night runs under, layered over the fight's own profile (`base`, null
 *  for an ordinary Halloween invasion). Night 1 is the ordinary fight, untouched. */
export function nightProfile(night: number, base: EliteProfile | null): EliteProfile | null {
  if (clampStage(night) <= FIRST_NIGHT) return base;
  const hp = nightHpMult(night);
  const dmg = nightDamageMult(night);
  const b: EliteProfile = base ?? {
    str: 1, con: 1, dex: 1, throwDamage: 1, throwRate: 1, wallHp: 1, specialDamage: 1,
  };
  return {
    ...b,
    con: b.con * hp,
    bossCon: (b.bossCon ?? b.con) * hp,
    str: b.str * dmg,
    throwDamage: b.throwDamage * dmg,
    specialDamage: b.specialDamage * dmg,
  };
}

/** This fight's clock: two minutes from hour 2, else whatever the raid uses. */
export function nightTimeLimitMs(raidId: number, night: number | undefined, ordinaryMs: number): number {
  return hasNights(raidId) && clampStage(night) > FIRST_NIGHT ? NIGHT_TIME_LIMIT_MS : ordinaryMs;
}

/** The difficulty STAGE a night is fought at: the night itself, or two hours further on a
 *  Brain Ticket run (ELITE_NIGHT_OFFSET), so Elite Hour 12 is stage 14 (MAX_STAGE). Scaling
 *  and the clock read the stage; the label and the drop curve read the night. */
export function nightStage(night: number | undefined, elite: boolean): number {
  return Math.min(MAX_STAGE, clampNight(night) + (elite ? ELITE_NIGHT_OFFSET : 0));
}

/** Rare-zombie luck on `night`: x1.5 per rung of difficulty, compounding (elite's 4x is
 *  applied apart). */
export function nightZombieLuck(night: number | undefined): number {
  return Math.pow(NIGHT_ZOMBIE_GROWTH, nightDifficulty(clampNight(night)) - 1);
}

/** The share of the invasion's win gold `night` pays: all of it on night 1, then a quarter
 *  rising NIGHT_GOLD_STEP per rung of difficulty past the second, never below a quarter. */
export function nightGoldShare(night: number | undefined): number {
  if (clampNight(night) <= FIRST_NIGHT) return 1;
  return Math.max(NIGHT_GOLD_SHARE, NIGHT_GOLD_SHARE + NIGHT_GOLD_STEP * (nightDifficulty(clampNight(night)) - 2));
}

/** Brain luck on `night`: half the rung's, then x1.1 per rung of difficulty, compounding
 *  (elite's 4x is applied apart). Every Halloween brain roll goes through this, night 1
 *  included. */
export function nightBrainLuck(night: number | undefined): number {
  return HALLOWEEN_BRAIN_SCALE * Math.pow(NIGHT_BRAIN_GROWTH, nightDifficulty(clampNight(night)) - 1);
}

/** "Hour 3" / "Elite Hour 1". The code says NIGHT throughout; the player sees hours of
 *  one long night, which is what makes "midnight approaches" read right. */
export function nightLabel(night: number, elite: boolean): string {
  return `${elite ? "Elite Hour" : "Hour"} ${clampNight(night)}`;
}

/** The line before each night. The chain is one night of the party wearing on: later,
 *  darker, and the Count's guests stronger each time (owner, 2026-10-24: time and strength,
 *  not new monsters). Indexed by the night being offered (2 = after the first win); past
 *  the end the last line repeats. */
const NIGHT_LINES: readonly { title: string; line: string }[] = [
  { title: "The night is still young.", line: "The Count and his guests are just getting started." },
  { title: "It's getting late.", line: "The party's getting rowdier, and his guests are getting stronger." },
  { title: "Midnight approaches.", line: "It's getting darker, and the vibe at this party is starting to feel a little off." },
  { title: "Midnight.", line: "Right on cue, the Count's guests are getting their second wind." },
  { title: "The witching hour has arrived.", line: "The party is in full swing, and his guests have never been stronger." },
];

/** What the "keep going?" prompt says before `nextNight`. Short, darker each night, and
 *  always clear that losing the next one costs none of what was already won. */
export function nightPrompt(nextNight: number, elite = false): { title: string; body: string } {
  const night = clampNight(nextNight);
  const { title, line } = NIGHT_LINES[Math.min(NIGHT_LINES.length - 1, Math.max(0, night - 2))];
  return {
    title,
    body: `${line} Fight ${nightLabel(night, elite)}? ` +
      "Win or lose, you keep everything you've already won.",
  };
}

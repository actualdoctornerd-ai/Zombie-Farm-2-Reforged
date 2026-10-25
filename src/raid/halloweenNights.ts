// HALLOWEEN NIGHTS: "the night is still young".
//
// A won Halloween invasion offers to keep going. Each further NIGHT is the same fight again,
// fought by the survivors at full health, against an opposition that is much bulkier and
// somewhat harder-hitting than the last; and the further the chain goes, the likelier the
// rare zombie (x1.5 a night) and, gently, the brains (x1.1 a night). A night pays like any
// other win the moment it is won, so fleeing (or losing) a night costs only that night:
// everything the earlier ones paid is already banked. Owner design, 2026-10-24.
//
// A BRAIN TICKET starts the chain two nights in: "Elite Night 1" is fought at night 3's
// strength, Elite Night 2 at night 4's, and so on, with the usual elite 4x on brains and
// rare zombies on every night of it. The NIGHT a player sees (and the drop curve) counts
// from 1 either way; the STAGE (nightStage) is what the fight is scaled by.
//
// THE CURVE IS MOSTLY HIT POINTS. A night is meant to be lost on the CLOCK, not by watching
// the army die, so the scaling is chiefly bulk, with a smaller damage step so the later
// nights still bite; and nights carry a shorter, three-minute clock than an ordinary
// invasion's four. Night 5 is pitched to stretch a maxed endgame (level-45) army.
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
 *  (owner, 2026-10-24). Hour 7 is already past anything an army can clear (nightHpMult),
 *  so the cap is about the story, not the balance. A Brain Ticket run's stage is clamped
 *  here too, so Elite Hours 11 and 12 are both fought at Hour 12's strength. */
export const MAX_NIGHT = 12;

/** Hit points on night n: a base step that grows each night (+100% of base, then +200%,
 *  +300%, ...: 1, 2, 4, 7, 11, 16 ...) times a gentle x1.2 compounding. Owner's curve,
 *  2026-10-24, replacing a flat x2.75 compounding that read as a wall at night 5-6.
 *
 *  Measured with the difficulty harness against the owner's buffed wave (Count con 100 /
 *  str 30, minions con 28-40), four seeds, winning clears in seconds on the 180 s clock:
 *
 *                              n2       n3       n4       n5        n6         n7
 *      level 45, maxed        47-54    63-72    84-94   114-129   158-172   out of time
 *      level 45, ordinary     50-57    69-75   94-106   133-147  out of time
 *      level 30, ordinary     61-72    82-94  112-132   161-177  out of time
 *      level 20, ordinary    102-138   wiped
 *
 *  Damage is what bites the lower levels: they are worn down rather than run out of time. */
export const NIGHT_HP_COMPOUND = 1.2;
/** Damage on night n: +100% of base a night (x1, x2, x3 ...). */
export const NIGHT_DAMAGE_STEP = 1;
/** The win gold a night pays from night 2 on, as a share of the invasion's: the nights are a
 *  brains-and-zombies chase, not a gold farm (owner, 2026-10-24). Night 1 pays in full. */
export const NIGHT_GOLD_SHARE = 0.25;
/** Every night after the first is on a three-minute clock. Clocking out is an ordinary
 *  loss, which is the whole intent of an HP-led curve. */
export const NIGHT_TIME_LIMIT_MS = 3 * 60 * 1000;
/** How long after a won night the next one may still be started. Generous, because the
 *  result panel, the revival offer and a phone call all happen in between; bounded,
 *  because a chain is one sitting, not a standing pass around the cooldown. */
export const NIGHT_CONTINUE_WINDOW_MS = 15 * 60 * 1000;

/** How many nights ahead a Brain Ticket starts the chain: Elite Night 1 is night 3's fight. */
export const ELITE_NIGHT_OFFSET = 2;
/** Rare-zombie odds multiply by this each night (1%, 1.5%, 2.25%, ... on an ordinary run). */
export const NIGHT_ZOMBIE_GROWTH = 1.5;
/** Brain odds multiply by this each night: a gentle climb from a halved start. */
export const NIGHT_BRAIN_GROWTH = 1.1;
/** Halloween's brain odds are HALF its rung's (which sits just under the Pirates'), on every
 *  night and on a Brain Ticket too. A long night chain is quick for a strong army, and the
 *  full rate paid ~7 brains a ticketed run (owner, 2026-10-24): the rare zombies and the
 *  coffins are meant to be the prize, the brains a good bonus. */
export const HALLOWEEN_BRAIN_SCALE = 0.5;

/** Does this invasion offer further nights? */
export function hasNights(raidId: number): boolean {
  return raidId === HALLOWEEN_RAID_ID;
}

/** A night number off the wire or a session: an integer in [FIRST_NIGHT, MAX_NIGHT]. */
export function clampNight(night: unknown): number {
  const n = Math.floor(Number(night));
  return Number.isFinite(n) ? Math.max(FIRST_NIGHT, Math.min(MAX_NIGHT, n)) : FIRST_NIGHT;
}

/** Enemy hit-point multiplier on `night`. */
export function nightHpMult(night: number): number {
  const n = clampNight(night);
  return (1 + (n * (n - 1)) / 2) * Math.pow(NIGHT_HP_COMPOUND, n - 1);
}

/** Enemy damage multiplier on `night`. */
export function nightDamageMult(night: number): number {
  return 1 + NIGHT_DAMAGE_STEP * (clampNight(night) - 1);
}

/** The multipliers a night runs under, layered over the fight's own profile (`base`, null
 *  for an ordinary Halloween invasion). Night 1 is the ordinary fight, untouched. */
export function nightProfile(night: number, base: EliteProfile | null): EliteProfile | null {
  if (clampNight(night) <= FIRST_NIGHT) return base;
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

/** This fight's clock: three minutes from night 2, else whatever the raid uses. */
export function nightTimeLimitMs(raidId: number, night: number | undefined, ordinaryMs: number): number {
  return hasNights(raidId) && clampNight(night) > FIRST_NIGHT ? NIGHT_TIME_LIMIT_MS : ordinaryMs;
}

/** The difficulty STAGE a night is fought at: the night itself, or two nights further on a
 *  Brain Ticket run (ELITE_NIGHT_OFFSET). Scaling and the clock read the stage; the label and
 *  the drop curve read the night. */
export function nightStage(night: number | undefined, elite: boolean): number {
  return Math.min(MAX_NIGHT, clampNight(night) + (elite ? ELITE_NIGHT_OFFSET : 0));
}

/** Rare-zombie luck on `night`: x1.5 a night, compounding (elite's 4x is applied apart). */
export function nightZombieLuck(night: number | undefined): number {
  return Math.pow(NIGHT_ZOMBIE_GROWTH, clampNight(night) - 1);
}

/** The share of the invasion's win gold `night` pays: all of it on night 1, a quarter after. */
export function nightGoldShare(night: number | undefined): number {
  return clampNight(night) > FIRST_NIGHT ? NIGHT_GOLD_SHARE : 1;
}

/** Brain luck on `night`: half the rung's, then x1.1 a night, compounding (elite's 4x is
 *  applied apart). Every Halloween brain roll goes through this, night 1 included. */
export function nightBrainLuck(night: number | undefined): number {
  return HALLOWEEN_BRAIN_SCALE * Math.pow(NIGHT_BRAIN_GROWTH, clampNight(night) - 1);
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

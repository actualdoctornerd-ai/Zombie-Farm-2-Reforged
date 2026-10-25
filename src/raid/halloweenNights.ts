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
/** A ceiling on the chain, only so a number can never grow without bound. Night 7 is
 *  already past anything an army can clear (see NIGHT_HP_GROWTH). */
export const MAX_NIGHT = 30;

/** Hit-point growth per night, compounding: night n fields `NIGHT_HP_GROWTH^(n-1)` times
 *  the ordinary bulk (x2.75, x7.6, x20.8, x57.2 for nights 2-5).
 *
 *  It has to be steep because an endgame clear is mostly WALKING: a maxed level-45 army
 *  spends ~35 s of a 39 s night 1 deploying and closing in, so x8 bulk only took that clear
 *  to 69 s. Measured with the difficulty harness (unlockArmy marks, real BattleSim, six
 *  wave seeds), winning clears in seconds, 180 s cap:
 *
 *                              night 2   night 3   night 4   night 5    night 6
 *      level 45, maxed          43-49     58-67     86-99    145-157   out of time
 *      level 45, ordinary       45-51     63-72    96-110    176 expert / out of time
 *      level 30, ordinary       55-65     76-89   118-131   out of time
 *      level 20, ordinary      90-115   149-175  out of time
 *
 *  Night 5 is the owner's "extremely difficult for an endgame army"; past it the clock
 *  wins. Nearly every loss on that curve is a clock-out, not a wipe. */
export const NIGHT_HP_GROWTH = 2.75;
/** Damage growth per night, linear and deliberately smaller: night n hits `1 + step*(n-1)`
 *  times as hard (x1.3 ... x2.2 at night 5), so long nights still cost the odd zombie. */
export const NIGHT_DAMAGE_STEP = 0.3;
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
/** Brain odds multiply by this each night: a gentle climb from the raid's own rung, which
 *  sits just under the Pirates'. */
export const NIGHT_BRAIN_GROWTH = 1.1;

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
  return Math.pow(NIGHT_HP_GROWTH, clampNight(night) - 1);
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

/** Brain luck on `night`: x1.1 a night, compounding (elite's 4x is applied apart). */
export function nightBrainLuck(night: number | undefined): number {
  return Math.pow(NIGHT_BRAIN_GROWTH, clampNight(night) - 1);
}

/** "Night 3" / "Elite Night 1". */
export function nightLabel(night: number, elite: boolean): string {
  return `${elite ? "Elite Night" : "Night"} ${clampNight(night)}`;
}

/** The line before each night, darker as the chain goes on. Indexed by the night being
 *  offered (2 = after the first win); past the end the last line repeats. */
const NIGHT_LINES: readonly { title: string; line: string }[] = [
  { title: "The Count is beaten... for now.", line: "His guests are already climbing back out of their coffins." },
  { title: "Something stirs in the cellar.", line: "Whatever the Count keeps down there is waking up." },
  { title: "The moon turns red.", line: "The graveyard is emptying, and it's all headed your way." },
  { title: "Midnight. The bells won't stop.", line: "Few zombies come back from a night like this." },
  { title: "There will be no dawn.", line: "The house wants you to stay. Forever." },
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

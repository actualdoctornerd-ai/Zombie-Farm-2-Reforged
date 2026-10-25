// HALLOWEEN NIGHTS: "the night is still young".
//
// A won Halloween invasion offers to keep going. Each further NIGHT is the same fight again,
// fought by the survivors at full health, against an opposition that is much bulkier and
// somewhat harder-hitting than the last; and the further the chain goes, the likelier the
// rare zombie. A night pays like any other win the moment it is won, so fleeing (or losing)
// a night costs only that night: everything the earlier ones paid is already banked.
// Owner design, 2026-10-24.
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

/** Rare-zombie luck on `night`: night n rolls at n times the raid's rate. */
export function nightZombieLuck(night: number | undefined): number {
  return clampNight(night);
}

/** What the "keep going?" prompt says before `nextNight`. The first is the original line;
 *  the rest climb towards midnight. */
export function nightPrompt(nextNight: number): { title: string; body: string } {
  const night = clampNight(nextNight);
  const luck = `Rare zombies are ${night}x as likely tonight.`;
  const keep = "Head home now and you keep everything you've won.";
  if (night <= 2) {
    return {
      title: "The night is still young...",
      body: `The Count's guests are just getting started. Fight on into Night ${night}? ` +
        `They'll be a whole lot tougher. ${luck} ${keep}`,
    };
  }
  if (night === 3) {
    return {
      title: "The moon climbs higher...",
      body: `Something's stirring in the cellar. Night ${night} will be meaner still. ${luck} ${keep}`,
    };
  }
  if (night === 4) {
    return {
      title: "The witching hour approaches...",
      body: `The whole graveyard's awake now. Night ${night} is no place for the faint of heart. ` +
        `${luck} ${keep}`,
    };
  }
  return {
    title: night === 5 ? "Midnight strikes..." : "The night never ends...",
    body: `Night ${night}. Only the bravest zombies dance till dawn. ${luck} ${keep}`,
  };
}

// Epic Boss (EpicEventStageBossActor) animation selection.
//
// An Epic Boss is the one enemy drawn from authored full-body strips rather than a
// paper-doll rig, so it needs its own tiny state machine: which strip is on screen,
// whether that strip loops, and — for the attack — WHICH FRAME, because the attack
// strip is driven by the sim's attack clock instead of free-running playback.
//
// WHY THE ATTACK IS CLOCK-DRIVEN. EpicEventEnemy.json authors a `duration` on every
// animation EXCEPT `attack` (checked: all five animated bosses author enter, and
// Skunkarella authors idle/defeat/escape too — none authors attack). The attack strip
// has no duration of its own because the fight clock IS its duration: one cycle is
// exactly `1/dex` seconds for an enemy, the swing lands at `interval x damageTiming`
// inside that cycle, and the animation gates nothing (see combatStats.ts's cadence
// note, recovered from the binary).
//
// Free-running the strip at a fixed frame rate cannot express that. The strips are
// 1.5x-2x LONGER than the cycle they belong to (Dr. Groundhog: 12 frames vs a 500 ms
// cycle), so a one-shot that has to finish before it can restart drops most of the
// boss's swings — it played once every two or three attacks and froze on its last
// frame in between. Mapping frame index off the attack clock instead gives exactly one
// full pass per swing, with the impact frame on the sim's hit, at any dex.
//
// This is the same warp EnemyActor's strip path already uses for framed enemies; the
// Epic Boss simply had a separate, playback-based route that missed it.

export type EpicBossAnimationName =
  | "defeat" | "escape" | "fly" | "enter" | "attack" | "idle";

export interface EpicBossAnimationInput {
  /** SimUnit.alive — a dead boss plays its defeat strip. */
  alive: boolean;
  /** Launching back out through the sky (fight already decided; presentation only). */
  leaving: boolean;
  /** SimUnit.state. */
  state: string;
  /** Whether this boss shipped a strip for a given state. Not every boss has all six:
   *  the three whose frame metadata was lost carry only the states someone has since
   *  ordered by hand, so a missing strip has to degrade rather than freeze the token. */
  has: (name: EpicBossAnimationName) => boolean;
}

/** Which strip belongs on screen this frame. Falls back to idle — the one strip every
 *  boss has — rather than naming a state this boss cannot draw. */
export function selectEpicBossAnimation(input: EpicBossAnimationInput): EpicBossAnimationName {
  const wanted: EpicBossAnimationName =
    !input.alive ? "defeat"
      : input.leaving ? "escape"
        : input.state === "falling" ? "fly"
          : input.state === "landing" ? "enter"
            : input.state === "fight" ? "attack"
              : "idle";
  return input.has(wanted) ? wanted : "idle";
}

/** Strips that repeat rather than settling on their last frame. `attack` is absent on
 *  purpose: it repeats, but off the attack clock (see epicAttackFrameIndex), not off
 *  playback, so it must not be handed to the sprite as a looping animation. */
export function epicBossAnimationLoops(name: EpicBossAnimationName): boolean {
  return name === "fly" || name === "idle";
}

/**
 * The frame of a strip that is fitted to a beat rather than played at its authored
 * rate: `progress` runs 0..1 across the beat and the whole strip runs with it.
 *
 * Used for the sky entrance, where the beat is EPIC_BOSS_LAND_MS of SIM time (shared
 * with the server's replay, so it cannot move per boss) while the authored enter
 * strips run anywhere from 0.4 s to 2.0 s. Fitting shows the whole entrance instead of
 * cutting it off part-way through.
 */
export function epicStripFrameIndex(progress: number, frameCount: number): number {
  if (frameCount <= 1) return 0;
  const t = Math.max(0, Math.min(1, progress));
  return Math.min(frameCount - 1, Math.floor(t * frameCount));
}

/**
 * The attack strip's frame for a point in the attack cycle.
 *
 * `atkProg` is 0 at the instant of contact and fills to 1 at the next one. The strip is
 * laid over that so its frame at `damageTiming` lands on the hit: the tail past the
 * impact frame plays out over the start of the next cycle, and the wind-up occupies the
 * rest.
 *
 * That tail is why the caller must hand this a progress read through `attackPhase`
 * rather than `1 - attackMs / cooldownMs`, which is what it used to compute for itself.
 * Progress 0 asserts a blow just landed, and the sim re-arms an idle enemy's clock every
 * tick — so a boss re-engaging replayed its post-impact frames at nothing. Dr Groundhog
 * and the Loco Locust connect at 0.25, which makes that THREE QUARTERS of a twelve- and
 * a nine-frame strip.
 */
export function epicAttackFrameIndex(
  atkProg: number,
  damageTiming: number,
  frameCount: number
): number {
  if (frameCount <= 1) return 0;
  const timing = Math.max(0, Math.min(1, damageTiming));
  const prog = Math.max(0, Math.min(1, atkProg));
  const recovery = 1 - timing;
  const sourceT = prog <= recovery ? timing + prog : prog - recovery;
  return Math.max(0, Math.min(frameCount - 1, Math.floor(sourceT * frameCount)));
}

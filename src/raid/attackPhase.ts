// Where a combatant is in its CURRENT swing, for the rigs that draw it.
//
// The renderer used to read this straight off the sim: `1 - timerMs / cooldownMs`. That
// works only while the attack timer is actually armed with `cooldownMs`, and for two
// whole families of combatant it never is:
//
//   * `BattleSim.cycleMs` is the one funnel every re-arm goes through, and it does not
//     return `cooldownMs`. A player zombie behind the front five takes a lineup band
//     (×1.425 / ×2 / ×4), and the two pirates throw their own dex clock away and mirror
//     the zombie they face — Arrrnold slams every 6.5 s against a Headless body off a
//     2.5 s `cooldownMs`.
//   * With `timerMs` bigger than `cooldownMs`, the old ratio is NEGATIVE for most of the
//     cycle and clamps to 0. Arrrnold's arms therefore reached the top exactly as the hit
//     landed, froze there for the ~3.9 s the clamp lasted, and then played a full slam at
//     the moment the ratio finally came off 0 — a swing that connected with nothing,
//     4 s after the one that did.
//
// The second half of the same defect is the post-contact tail. An authored swing's
// contact frame sits at `damageTiming` (0.95 for the pirate slam), so progress in
// `[0, 1-damageTiming)` is drawing the FOLLOW-THROUGH of the blow that just landed.
// Whenever an enemy loses its target the sim re-arms its timer every tick (`hold`), so
// re-engaging put progress back at 0 and the rig replayed that follow-through — a full
// slam, out of nowhere, dealing nothing. A front row that dies and refills a few times in
// a second (or a knockback shoving its target in and out of reach) fires one per
// transition, which is the "attacking like crazy" burst.
//
// So: track what the timer was ARMED with rather than assuming, and only draw the tail
// when a blow really did land inside it. Both readings come from state the sim already
// publishes (`timerMs` and `struckThisTick`) — nothing here feeds back into the fight.

/** Per-combatant swing bookkeeping. Owned by the renderer's token, one per actor. */
export interface AttackPhase {
  /** The interval the sim last armed this attacker's timer with — its REAL cycle. */
  cycleMs: number;
  /** Last raw `timerMs`, to spot a re-arm (the timer going UP). */
  prevTimerMs: number;
  /** Since this attacker last landed a blow. Gates the post-contact tail. */
  sinceStrikeMs: number;
}

/** A re-arm is the timer moving up at all; the epsilon only keeps float noise out. */
const REARM_EPS_MS = 0.5;
/** How far past the tail's own length a strike still counts as "just landed" — one
 *  simulation tick plus a display frame, so a hit seen a frame late still draws. */
const TAIL_SLACK_MS = 64;

export function newAttackPhase(cycleMs = 1): AttackPhase {
  return { cycleMs: Math.max(1, cycleMs), prevTimerMs: cycleMs, sinceStrikeMs: Infinity };
}

/**
 * Read this frame's attack timer.
 *
 * `fighting` is whether the rig is drawing a swing at all. While it is NOT, the cycle
 * simply tracks the timer: an idle enemy's clock is re-armed every tick, and following it
 * means the swing it eventually starts is scaled by the interval it will actually take.
 * While it IS, only an upward jump counts — that is the sim re-arming for the next blow,
 * and the value it jumped to is the interval until that blow lands.
 */
export function observeAttackTimer(phase: AttackPhase, timerMs: number, fighting: boolean) {
  if (!fighting || timerMs > phase.prevTimerMs + REARM_EPS_MS) {
    phase.cycleMs = Math.max(1, timerMs);
  }
  phase.prevTimerMs = timerMs;
}

/** This attacker connected on the tick just simulated. */
export function markStruck(phase: AttackPhase) {
  phase.sinceStrikeMs = 0;
}

/** Advance the strike age by one rendered frame. Call after posing. */
export function ageAttackPhase(phase: AttackPhase, dtMs: number) {
  if (phase.sinceStrikeMs !== Infinity) phase.sinceStrikeMs += Math.max(0, dtMs);
}

/**
 * How much of a cycle a pose spends drawing the PREVIOUS blow's follow-through.
 *
 * Only a SOURCE-ROTATED pose has one. Those run the authored timeline from
 * `damageTiming` round to 1 and then 0 back to `damageTiming` (clipRuntime's
 * `sourceAttackProgress`), so their first `1 - damageTiming` is the tail of the blow
 * that just landed and their REST pose sits at the far end of it. That is the player's
 * bite/scratch, an enemy clip with `timeBase: "source"`, and the frame-strip actors.
 *
 * A pose driven by the cooldown WINDOW instead — the procedural `EnemyActor` swing,
 * which rests for the first 28% and swings over the remaining 72%, and a
 * `timeBase: "cycle"` clip, whose t IS the cooldown — draws no follow-through at all.
 * Its rest pose is at the START of the cycle, so there is nothing to suppress and a
 * hold would park it MID-LUNGE: Old McDonnell's tail would be 0.6, which is 98% of the
 * way through his thrust. Those get 0.
 */
export function postContactTail(damageTiming: number, sourceRotated: boolean): number {
  if (!sourceRotated) return 0;
  return Math.max(0, Math.min(1, 1 - damageTiming));
}

/**
 * 0..1 through the current swing, where 0 is the instant of contact. `tail` is what
 * `postContactTail` returned for this pose; `visualTimerMs` is the tick-interpolated
 * countdown (see visualCountdown).
 */
export function attackProgress(
  phase: AttackPhase,
  visualTimerMs: number,
  tail: number
): number {
  const cycle = Math.max(1, phase.cycleMs);
  const prog = Math.max(0, Math.min(1, 1 - visualTimerMs / cycle));
  // Inside the follow-through window with no blow behind it: hold at the end of the tail,
  // which is the swing's rest pose, and wind up from there. A tail of 0 (a pose with no
  // follow-through) makes this unreachable, which is exactly right — its rest pose is
  // where `prog` already starts.
  if (prog < tail && phase.sinceStrikeMs > tail * cycle + TAIL_SLACK_MS) return tail;
  return prog;
}

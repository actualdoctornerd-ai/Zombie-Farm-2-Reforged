// A simulated player, and the loop that flies a fight with one.
//
// WHY THIS EXISTS. The old difficulty measurement ran `while (!sim.finished) sim.step()`
// — a fight with nobody at the controls. Every activated move (Bash, Smash, Explode,
// Mini Buddy) was measured as if it did not exist; every focus bubble sat un-popped, so
// the distraction penalty was charged at maximum for the whole fight; no wall was
// chipped, no fire smothered, no converted zombie broken open, no placard answered and
// no saucer cast cancelled. The number that came out was the FLOOR of a fight, reported
// as its difficulty — and the floor-to-ceiling gap is not a constant across raids. It is
// widest exactly where the newest mechanics are.
//
// WHY IT SPEAKS THE TRANSCRIPT. `RaidReplayInput` is already a deterministic, 8-verb,
// server-verified grammar for everything a player can do, and `BattleSim` already
// exposes a read-side observer for each verb. A pilot restricted to those two surfaces
// buys two things that no amount of care could otherwise guarantee:
//
//   1. Every harness run emits a REAL transcript. Feed it to `replayRaid` against a
//      server-built sim and the run proves itself legal and reproducible — so a
//      difficulty number can never again describe a fight the game would refuse.
//   2. That same transcript drops into the Raid Lab's playback mode, so you can WATCH
//      the exact fight the harness scored instead of trusting it.
//
// WHAT A PILOT MAY READ. Only the public observer surface a real HUD reads. A pilot that
// reaches into `sim.units` for an enemy's hit points is measuring a fight no player can
// play, which is the mistake this whole layer exists to stop making. The one deliberate
// exception is `sim.players`/`sim.units` for the pilot's OWN army — the battle strip,
// the health bar and the field all show the player their own zombies.
//
// WHAT IT MAY NOT DO. It may not exceed what a client could transmit. `RAID_MAX_INPUTS`
// is 512 over four minutes and the live client holds back a 64-input reserve for hazard
// taps; both are mirrored here, because a pilot that out-taps the transcript is
// measuring a ceiling no player can reach.
import type { BattleSim } from "../BattleSim";
import { maxTicksFor, RAID_MAX_INPUTS, RAID_TICK_MS, type RaidReplayInput } from "../replay";
import type { RaidOutcome } from "../types";

/** `RaidReplayInput` without the bookkeeping the driver owns. */
type Untracked<T> = T extends unknown ? Omit<T, "seq" | "tick"> : never;

/** An action that reaches the server's replay. */
export type TranscribedAction = Untracked<RaidReplayInput>;

/** The two CLIENT-ONLY rescues. The verifier builds its sim without a trapeze or a crab
 *  (see raidVerifier.grabberOf), so these taps change the player's fight and never reach
 *  the transcript. They are actions a real player makes, so a pilot must be able to make
 *  them — but a flight that uses them is measuring the CLIENT's fight, and its transcript
 *  will not reproduce it on the server. That asymmetry is the design, not a bug: it is
 *  one-way self-harm, and conflating the two fights is what voided ~6% of Circus and
 *  Beach victories. */
export type UntranscribedAction =
  | { type: "crabTap"; id: string }
  | { type: "grabberTap"; id: string }
  | { type: "megaBotTap" };

export type PilotAction = TranscribedAction | UntranscribedAction;

export interface Pilot {
  readonly id: string;
  /** Fresh per-fight state. `seed` makes a pilot's own randomness reproducible. */
  reset(seed: string): void;
  /** At most ONE action per tick — a player does one thing at a time, and letting a
   *  pilot fire a whole queue in a single 50 ms frame is the cheapest way to build a
   *  superhuman by accident. Returning null is the common case. */
  decide(sim: BattleSim, tick: number): PilotAction | null;
}

export interface FlightOptions {
  /** Hard stop. Defaults to the replay cap — a fight past it has no outcome at all. */
  maxTicks?: number;
  /** Seed for the pilot's own randomness (its misses and hesitations). */
  seed?: string;
  /** Tap pacing the sim enforces on rescue hazards. Defaults to whatever the sim was
   *  built with (the authored touch cadence), because that is what a phone plays at. */
  hazardTapCooldownMs?: number;
}

export interface Flight {
  outcome: RaidOutcome;
  win: boolean;
  /** THE headline for the loss-less target: how many zombies did not come home. */
  losses: number;
  survivors: number;
  ticks: number;
  secs: number;
  /** The four-minute fight clock ran out with both sides standing. On the live service
   *  that settles as an ordinary loss — so keep it as its own reading, because as a plain
   *  `win: false` it is indistinguishable from being wiped out, and the two say completely
   *  different things about a rung. A rating that cannot see the difference cannot see a
   *  fight that is unfinishable rather than merely hard. */
  timedOut: boolean;
  retreated: boolean;
  /** A timeout in which NOTHING WAS STILL HAPPENING: the army was alive and had taken
   *  no hit point off the enemy for the last `STALL_WINDOW_MS`.
   *
   *  Separated from `timedOut` because it is a different KIND of thing. A plain timeout
   *  is an army grinding too slowly, which is a tuning answer. This is a rules answer:
   *  the fight has no ending, and no amount of player skill or army power reaches one.
   *  The shape seen on raid 14 is an army whose last survivors are all rear-station
   *  Gardens — pinned outside the combat zone by `supportsFromRear`, while the enemies
   *  hold their own line waiting for someone to come to them — but the test is
   *  deliberately about PROGRESS rather than about that one shape, so it catches the
   *  next deadlock too.
   *
   *  On the live service a deadlock and a slow grind settle identically
   *  (`truncated_transcript`: no result, no reward, no explanation), which is exactly
   *  why the harness has to be the thing that tells them apart. */
  deadlocked: boolean;
  /** Seconds the fight spent taking no hit point off the enemy before it ended. */
  stalledSecs: number;
  /** A legal transcript of everything the pilot did that the server would see. */
  inputs: RaidReplayInput[];
  /** Actions the sim REFUSED. A high count means the pilot is misreading the fight —
   *  worth watching, because on the live finish path a refusal is silently dropped. */
  refused: number;
  /** Actions dropped because the transcript budget was spent. Non-zero means the pilot
   *  wants to tap more than a client could transmit, and the fight it measured is
   *  therefore easier than the one it would have played. */
  budgetDropped: number;
  /** Client-only rescue taps. Non-zero means this flight's transcript will NOT reproduce
   *  it on the server — see `UntranscribedAction`. */
  untranscribed: number;
}

/** The live client's own reserve: hazard taps stop being taken once the transcript nears
 *  its cap, so the room left goes to bubbles, abilities and the retreat. Refusing the tap
 *  is what keeps the two simulations in step — recording it past the cap would fail the
 *  whole finish with `too_many_inputs`. Mirrored from RaidScene.canRecordHazardTap. */
const HAZARD_RESERVE = 64;
const HAZARD_TYPES = new Set(["wallTap", "fireTap", "turnedTap"]);

/** No damage dealt for this long, in a fight that then ran out of clock, is a deadlock
 *  rather than a slow grind. Thirty seconds is far longer than any legitimate lull — the
 *  longest gap the game can produce is a boss descent plus a walk-in — so it does not
 *  fire on a fight that is merely struggling. */
const STALL_WINDOW_MS = 30_000;
/** How often progress is sampled. One second: the window is thirty, and summing enemy
 *  hit points every 50 ms tick would be a measurable share of a flight's cost. */
const PROGRESS_SAMPLE_TICKS = 20;

/** Run one fight to its end with a pilot at the controls.
 *
 *  The tick contract is the verifier's, exactly: an action stamped tick T is applied
 *  BEFORE tick T is stepped (see replay.advanceRaidSegment). And, like the live client,
 *  only an action the sim ACCEPTS is transcribed — RaidScene records on the return value
 *  of every tap, so a refused tap is a tap that never happened. */
export function flyFight(sim: BattleSim, pilot: Pilot, opts: FlightOptions = {}): Flight {
  const maxTicks = opts.maxTicks ?? maxTicksFor(sim);
  if (opts.hazardTapCooldownMs !== undefined) sim.hazardTapCooldownMs = opts.hazardTapCooldownMs;
  pilot.reset(opts.seed ?? "flight");

  const inputs: RaidReplayInput[] = [];
  let seq = 0;
  let refused = 0;
  let budgetDropped = 0;
  let untranscribed = 0;
  let retreated = false;
  let ticks = 0;
  const enemyHp = () => sim.units.reduce(
    (sum, u) => (u.team === "enemy" && u.alive ? sum + Math.max(0, u.hp) : sum), 0);
  let lastHp = enemyHp();
  let lastProgressTick = 0;

  for (; ticks < maxTicks && !sim.finished && !retreated; ticks++) {
    const action = pilot.decide(sim, ticks);
    if (action) {
      const budget = HAZARD_TYPES.has(action.type)
        ? RAID_MAX_INPUTS - HAZARD_RESERVE
        : RAID_MAX_INPUTS;
      if (action.type === "crabTap") {
        if (sim.tapCrab(action.id)) untranscribed++; else refused++;
      } else if (action.type === "grabberTap") {
        if (sim.tapGrabber(action.id)) untranscribed++; else refused++;
      } else if (action.type === "megaBotTap") {
        if (sim.tapMegaBotEyes()) untranscribed++; else refused++;
      } else if (seq >= budget) {
        // Over budget the client does not tap at all, so neither does the pilot: a tap
        // applied here and left out of the transcript is exactly the desync that made
        // the server keep fighting a wall the player had already knocked down.
        budgetDropped++;
      } else if (apply(sim, action)) {
        inputs.push({ ...action, seq: ++seq, tick: ticks } as RaidReplayInput);
        if (action.type === "retreat") retreated = true;
      } else {
        refused++;
      }
    }
    if (sim.finished || retreated) break;
    sim.step(RAID_TICK_MS);
    if (ticks % PROGRESS_SAMPLE_TICKS === 0) {
      const hp = enemyHp();
      if (hp < lastHp) lastProgressTick = ticks;
      lastHp = hp;
    }
  }

  const outcome = sim.outcome();
  // Two ways to run out of clock, and the FIRST is the one that happens: the sim stops
  // itself at four minutes (MAX_SIM_MS) and reports an ordinary loss with `outOfTime`
  // set, so `!sim.finished` catches nothing unless a caller passed a shorter `maxTicks`.
  // Reading only that flag folds every real timeout into the loss pile — which is
  // exactly the bucket the all-Garden deadlock was hiding in.
  const timedOut = outcome.outOfTime === true || (!sim.finished && !retreated);
  const standing = sim.units.some((u) => u.team === "player" && u.alive);
  const stalledMs = (ticks - lastProgressTick) * RAID_TICK_MS;
  return {
    outcome,
    deadlocked: timedOut && standing && stalledMs >= STALL_WINDOW_MS,
    stalledSecs: stalledMs / 1000,
    win: sim.finished && !retreated && outcome.win,
    losses: outcome.losses.length,
    survivors: outcome.survivors.length,
    ticks,
    secs: (ticks * RAID_TICK_MS) / 1000,
    timedOut,
    retreated,
    inputs,
    refused,
    budgetDropped,
    untranscribed,
  };
}

/** Send one transcribed action into the sim. Returns whether it took. */
function apply(sim: BattleSim, action: TranscribedAction): boolean {
  switch (action.type) {
    case "bubble": return sim.popBubble(action.unitId);
    case "ability": return sim.activate(action.abilityKey);
    case "wallTap": return sim.tapWall(action.unitId);
    case "fireTap": return sim.tapFire(action.unitId);
    case "turnedTap": return sim.tapTurned(action.unitId);
    case "signPick": return sim.pickSign(action.offer, action.option);
    case "castCancel": return sim.cancelCast(action.slot ?? 0);
    case "trapezeTap": return sim.tapTrapeze(action.unitId);
    case "retreat": return true;
  }
}

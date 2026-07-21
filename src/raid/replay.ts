import { BattleSim, type BattleSimSnapshot } from "./BattleSim";
import type { RaidOutcome } from "./types";

// 6: hazards moved client-only (the verifier no longer simulates the trapeze) and
// `clientWin` concessions were added — in-flight v5 sessions must not replay under these
// rules, so the bump invalidates them via the existing stale_ruleset path.
export const RAID_RULESET_VERSION = 6;
export const RAID_TICK_MS = 50;
export const RAID_MAX_TICKS = 4 * 60 * 1000 / RAID_TICK_MS;
export const RAID_MAX_INPUTS = 512;
export const RAID_MAX_TRANSCRIPT_BYTES = 32 * 1024;

export type RaidReplayInput =
  | { seq: number; tick: number; type: "bubble"; unitId: string }
  | { seq: number; tick: number; type: "ability"; abilityKey: string }
  | { seq: number; tick: number; type: "retreat" };

export type ReplayResult =
  | { ok: true; outcome: RaidOutcome; retreated: boolean }
  | { ok: false; error: string };

export type SegmentResult =
  | { ok: true; snapshot: BattleSimSnapshot; finished: boolean; outcome?: RaidOutcome; retreated: boolean; lastSeq: number }
  | { ok: false; error: string };

/** Advance an existing verifier snapshot. Input ticks/sequences remain global, while
 * only the new segment is simulated. A checkpoint never accepts retreat. */
export function advanceRaidSegment(
  sim: BattleSim,
  startTick: number,
  finalTick: number,
  startingSeq: number,
  inputs: RaidReplayInput[],
  allowRetreat: boolean
): SegmentResult {
  if (!Number.isInteger(startTick) || !Number.isInteger(finalTick) || finalTick < startTick || finalTick > RAID_MAX_TICKS) {
    return { ok: false, error: "bad_final_tick" };
  }
  if (!Array.isArray(inputs) || inputs.length > RAID_MAX_INPUTS) return { ok: false, error: "too_many_inputs" };
  if (JSON.stringify(inputs).length > RAID_MAX_TRANSCRIPT_BYTES) return { ok: false, error: "transcript_too_large" };
  let lastSeq = startingSeq;
  let lastTick = startTick;
  let sawRetreat = false;
  for (const input of inputs) {
    if (sawRetreat) return { ok: false, error: "input_after_retreat" };
    if (!input || !Number.isInteger(input.seq) || input.seq !== lastSeq + 1) return { ok: false, error: "bad_sequence" };
    if (input.seq > RAID_MAX_INPUTS) return { ok: false, error: "too_many_inputs" };
    if (!Number.isInteger(input.tick) || input.tick < lastTick || input.tick > finalTick) return { ok: false, error: "bad_input_tick" };
    if (startTick > 0 && input.tick <= startTick) return { ok: false, error: "bad_input_tick" };
    if (input.type === "retreat" && !allowRetreat) return { ok: false, error: "retreat_requires_finish" };
    if (input.type === "retreat") sawRetreat = true;
    lastSeq = input.seq;
    lastTick = input.tick;
  }
  let cursor = 0;
  let retreated = false;
  for (let tick = startTick; tick <= finalTick; tick++) {
    while (cursor < inputs.length && inputs[cursor].tick === tick) {
      const input = inputs[cursor++];
      if (sim.finished) return { ok: false, error: "input_after_finish" };
      if (input.type === "bubble") {
        if (typeof input.unitId !== "string" || !sim.popBubble(input.unitId)) return { ok: false, error: "illegal_bubble" };
      } else if (input.type === "ability") {
        if (typeof input.abilityKey !== "string" || !sim.activate(input.abilityKey)) return { ok: false, error: "illegal_ability" };
      } else if (input.type === "retreat") {
        retreated = true;
      } else return { ok: false, error: "bad_input_type" };
    }
    if (retreated || sim.finished || tick === finalTick) break;
    sim.step(RAID_TICK_MS);
  }
  return {
    ok: true,
    snapshot: sim.snapshot(),
    finished: sim.finished || retreated,
    outcome: sim.finished || retreated ? (retreated ? { ...sim.outcome(), win: false, survivors: [] } : sim.outcome()) : undefined,
    retreated,
    lastSeq,
  };
}

/** Replay only outcome-relevant input against a server-built BattleSim. Rendering and
 * wall-clock frame cadence never enter this function. */
export function replayRaid(sim: BattleSim, finalTick: number, inputs: RaidReplayInput[]): ReplayResult {
  const advanced = advanceRaidSegment(sim, 0, finalTick, 0, inputs, true);
  if (!advanced.ok) return advanced;
  if (!advanced.finished || !advanced.outcome) return { ok: false, error: "truncated_transcript" };
  return { ok: true, retreated: advanced.retreated, outcome: advanced.outcome };
}

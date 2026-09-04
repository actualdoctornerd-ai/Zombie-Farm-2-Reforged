import { describe, expect, it } from "vitest";
import { createPinnedSim, type PinnedRaidConfig } from "../src/raidVerifier";
import { advanceRaidSegment, replayRaid, RAID_MAX_TICKS } from "../../src/raid/replay";
import circusSession from "./fixtures/circusTruncatedSession.json";

// `config_json` of raid_sessions_v3 d5090dc7-8b96-44ea-8d32-40bcdbcb7631 — a real Circus
// (raid 8) invasion that the player WON on screen and the verifier threw away. Kept
// verbatim because the incident is the regression: 104 Circus and 31 Beach victories
// across 84 accounts were rejected this way, all of them `clientWin=1`.
// Its pinned wave predates ruleset 48: the `enemyKeys` in it are the old grouped order
// (grouped by type, table order). A pinned config carries its resolved list, so the
// replay reads it verbatim and the fixture stays valid — it simply is not an order a
// fight started under v48 would draw.
const CONFIG = circusSession as unknown as PinnedRaidConfig;
const REPORTED_FINAL_TICK = 2043; // what the client said; the server's own fight is longer

describe("client-only hazard timeline divergence", () => {
  it("settles the Circus win the verifier used to reject", () => {
    const replayed = replayRaid(createPinnedSim(CONFIG), REPORTED_FINAL_TICK, []);

    // Before the fix this was `truncated_transcript` → 422 → the victory was erased.
    expect(replayed).toMatchObject({ ok: true });
    if (!replayed.ok) return;
    expect(replayed.outcome.win).toBe(true);

    // The server needed its own, longer fight to get there — that gap IS the bug, and it
    // is now recorded rather than fatal.
    expect(replayed.divergence.overrunTicks).toBeGreaterThan(0);
    expect(replayed.divergence.inputsAfterFinish).toBe(0);

    // Whatever it decided, it still accounts for every locked unit exactly once.
    const accounted = [...replayed.outcome.survivors, ...replayed.outcome.losses];
    expect(new Set(accounted).size).toBe(accounted.length);
    expect(new Set(accounted)).toEqual(new Set(CONFIG.rosterIds));
  });

  it("is deterministic — the overrun is the server's own fight, not a race", () => {
    // Deliberately reusing ONE config object across all three: the verifier is handed the
    // same parsed config every time, so a sim that writes back into it makes the replay
    // stop being a pure function of (config, transcript). `bossThrow.intervalMs` did
    // exactly that — enrage halved it in place, and the second replay of a fight started
    // against an already-enraged boss and lost it.
    const runs = [0, 1, 2].map(() => replayRaid(createPinnedSim(CONFIG), REPORTED_FINAL_TICK, []));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it("does not write back into the config it was handed", () => {
    const before = JSON.stringify(CONFIG);
    replayRaid(createPinnedSim(CONFIG), REPORTED_FINAL_TICK, []);
    expect(JSON.stringify(CONFIG)).toBe(before);
  });

  it("reaches the same verdict no matter what finalTick the client claims", () => {
    // The client's tick said when the PLAYER's fight ended. It no longer decides the
    // server's, so a shorter or longer claim cannot change the settled outcome.
    const early = replayRaid(createPinnedSim(CONFIG), 1, []);
    const late = replayRaid(createPinnedSim(CONFIG), REPORTED_FINAL_TICK, []);
    expect(early.ok && late.ok && early.outcome).toEqual(late.ok ? late.outcome : null);
  });

  it("still stops dead at a retreat instead of fighting on", () => {
    const retreated = replayRaid(createPinnedSim(CONFIG), 400, [{ seq: 1, tick: 400, type: "retreat" }]);
    expect(retreated).toMatchObject({ ok: true, retreated: true });
    if (!retreated.ok) return;
    expect(retreated.outcome.win).toBe(false);
    expect(retreated.outcome.survivors).toEqual([]);
    // A retreat is the player ending the fight, so there is nothing left to run out.
    expect(retreated.divergence.overrunTicks).toBe(0);
  });

  it("drops a tap its own sim refuses instead of throwing the victory away", () => {
    // The residual of the same outage: a grabbed zombie leaves the client and the server
    // disagreeing about a UNIT's state, not just the fight's length, and the finish died
    // on `illegal_ability`. Refusing a tap is refusing the player help, so it can only
    // cost the server's army — settle its own fight and record the disagreement.
    const clean = replayRaid(createPinnedSim(CONFIG), 400, []);
    const forged = replayRaid(createPinnedSim(CONFIG), 400, [
      { seq: 1, tick: 10, type: "ability", abilityKey: "forged" },
      { seq: 2, tick: 10, type: "bubble", unitId: "not-in-this-raid" },
    ]);
    expect(forged).toMatchObject({ ok: true });
    if (!forged.ok || !clean.ok) return;
    expect(forged.divergence.refusedInputs).toBe(2);
    expect(forged.outcome).toEqual(clean.outcome); // a refused tap changes nothing
  });

  it("still rejects a structurally broken transcript", () => {
    // Forgiveness stops at "well-formed". A missing id is a broken transcript.
    expect(replayRaid(createPinnedSim(CONFIG), 400, [
      { seq: 1, tick: 10, type: "bubble" } as never,
    ])).toMatchObject({ error: "illegal_bubble" });
    expect(replayRaid(createPinnedSim(CONFIG), 400, [
      { seq: 1, tick: 10, type: "ability" } as never,
    ])).toMatchObject({ error: "illegal_ability" });
  });

  it("never simulates past the four-minute cap", () => {
    // The overrun is bounded by RAID_MAX_TICKS, not by how long the fight wants to run,
    // so a pathological config costs the isolate a fixed ceiling and no more.
    const started = Date.now();
    const replayed = replayRaid(createPinnedSim(CONFIG), 1, []);
    expect(replayed).toMatchObject({ ok: true });
    if (!replayed.ok) return;
    expect(1 + replayed.divergence.overrunTicks).toBeLessThanOrEqual(RAID_MAX_TICKS);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("leaves checkpoints exact — only the finish path runs on", () => {
    // A mid-fight checkpoint must not simulate past its segment, or the snapshot it
    // stores would be ahead of the fight the player is still playing.
    const segment = advanceRaidSegment(createPinnedSim(CONFIG), 0, 300, 0, [], false);
    expect(segment).toMatchObject({ ok: true });
    if (!segment.ok) return;
    expect(segment.finished).toBe(false);
    expect(segment.divergence).toEqual({ overrunTicks: 0, inputsAfterFinish: 0, refusedInputs: 0 });
  });

  it("drops a tap that lands after the server's fight ended", () => {
    // The mirror image: the hazard-free replay finishes FIRST, then the player's late tap
    // arrives. It used to be `input_after_finish`; it cannot affect a settled fight.
    const full = replayRaid(createPinnedSim(CONFIG), RAID_MAX_TICKS, []);
    expect(full.ok).toBe(true);
    if (!full.ok) return;

    const lateTap = replayRaid(createPinnedSim(CONFIG), RAID_MAX_TICKS, [
      { seq: 1, tick: RAID_MAX_TICKS - 1, type: "bubble", unitId: CONFIG.rosterIds[0] },
    ]);
    expect(lateTap).toMatchObject({ ok: true });
    if (!lateTap.ok) return;
    expect(lateTap.divergence.inputsAfterFinish).toBe(1);
    expect(lateTap.outcome).toEqual(full.outcome);
  });
});

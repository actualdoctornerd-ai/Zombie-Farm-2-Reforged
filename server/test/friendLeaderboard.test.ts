import { describe, expect, it } from "vitest";
import { LEADERBOARD_COUNTER_KEYS, leaderboardStatsFromJson } from "../src/logic";

/** The client's lifetime tally as it rides the presentation blob (`ui.stats`),
 *  i.e. what json_extract hands the route as a string. */
function statsJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    startedAt: 1_700_000_000_000,
    harvested: { carrot: 412, "zombie-crop_regular": 30 },
    planted: 500, plowed: 480, treesHarvested: 12,
    goldEarned: 190_000, goldSpent: 175_400,
    brainsEarned: 42, brainsSpent: 30,
    zombiesGrown: 30, zombiesCombined: 9, zombiesSold: 4, zombiesLost: 6,
    raidsWon: 22, raidsLost: 5,
    ...over,
  });
}

describe("leaderboardStatsFromJson", () => {
  it("projects the tally the client writes, summing the per-crop map", () => {
    const stats = leaderboardStatsFromJson(statsJson());
    expect(stats).toEqual({
      harvested: 442,
      planted: 500, plowed: 480, treesHarvested: 12,
      goldEarned: 190_000, brainsEarned: 42,
      zombiesGrown: 30, zombiesCombined: 9,
      raidsWon: 22, raidsLost: 5,
    });
    // The projection is a closed set: nothing beyond the declared counters leaks
    // to friends, however many keys a future client adds to the tally.
    expect(Object.keys(stats!).sort())
      .toEqual([...LEADERBOARD_COUNTER_KEYS, "harvested"].sort());
  });

  it("reads no tally as null, not as a farm of zeroes", () => {
    expect(leaderboardStatsFromJson(null)).toBeNull();
    expect(leaderboardStatsFromJson("")).toBeNull();
    expect(leaderboardStatsFromJson("not json")).toBeNull();
    for (const notATally of ["null", "[]", "7", '"stats"']) {
      expect(leaderboardStatsFromJson(notATally), notATally).toBeNull();
    }
  });

  it("clamps damaged counters to 0 instead of trusting the write-time gate", () => {
    const stats = leaderboardStatsFromJson(statsJson({
      plowed: -3, planted: 1.5, goldEarned: "190000",
      raidsWon: Number.MAX_VALUE, treesHarvested: null,
    }));
    expect(stats).toMatchObject({
      plowed: 0, planted: 0, goldEarned: 0, raidsWon: 0, treesHarvested: 0,
      // The untouched counters still read through.
      brainsEarned: 42, zombiesGrown: 30, raidsLost: 5,
    });
  });

  it("survives a hostile harvested map", () => {
    expect(leaderboardStatsFromJson(statsJson({ harvested: [1, 2] }))!.harvested).toBe(0);
    expect(leaderboardStatsFromJson(statsJson({ harvested: null }))!.harvested).toBe(0);
    expect(
      leaderboardStatsFromJson(statsJson({ harvested: { carrot: -5, corn: 2.5, pea: 7 } }))!.harvested
    ).toBe(7);
  });

  it("tolerates a tally with counters missing entirely (first-session farm)", () => {
    const stats = leaderboardStatsFromJson(JSON.stringify({ startedAt: 1, harvested: {} }));
    expect(stats).not.toBeNull();
    for (const key of LEADERBOARD_COUNTER_KEYS) expect(stats![key]).toBe(0);
    expect(stats!.harvested).toBe(0);
  });
});

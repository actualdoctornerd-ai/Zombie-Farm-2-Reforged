import { describe, expect, it } from "vitest";
import type { FriendLeaderboardEntry, FriendLeaderboardStats } from "../net/api";
import { LEADERBOARD_CATEGORIES, rankLeaderboard } from "./leaderboard";

const cat = (key: string) => {
  const found = LEADERBOARD_CATEGORIES.find((c) => c.key === key);
  if (!found) throw new Error(`no such category: ${key}`);
  return found;
};

const stats = (over: Partial<FriendLeaderboardStats> = {}): FriendLeaderboardStats => ({
  harvested: 0, planted: 0, plowed: 0, treesHarvested: 0,
  goldEarned: 0, brainsEarned: 0, zombiesGrown: 0, zombiesCombined: 0,
  raidsWon: 0, raidsLost: 0,
  ...over,
});

const farmer = (
  accountId: string,
  name: string,
  level: number,
  s: FriendLeaderboardStats | null,
  self?: boolean
): FriendLeaderboardEntry => ({ accountId, name, level, stats: s, self });

describe("rankLeaderboard", () => {
  it("ranks best-first and ties share a rank (1, 2, 2, 4)", () => {
    const rows = rankLeaderboard([
      farmer("a", "Ann", 3, stats({ raidsWon: 10 })),
      farmer("b", "Bob", 9, stats({ raidsWon: 25 }), true),
      farmer("c", "Cid", 5, stats({ raidsWon: 10 })),
      farmer("d", "Dot", 2, stats({ raidsWon: 4 })),
    ], cat("raidsWon"));
    expect(rows.map((r) => [r.entry.accountId, r.rank, r.value])).toEqual([
      ["b", 1, 25], ["a", 2, 10], ["c", 2, 10], ["d", 4, 4],
    ]);
  });

  it("ranks Level off the server-derived column even with no tally published", () => {
    const rows = rankLeaderboard([
      farmer("a", "Ann", 3, null),
      farmer("b", "Bob", 9, null, true),
    ], cat("level"));
    expect(rows.map((r) => [r.entry.accountId, r.rank])).toEqual([["b", 1], ["a", 2]]);
  });

  it("sinks farmers with no tally below every ranked row, unranked", () => {
    const rows = rankLeaderboard([
      farmer("a", "Ann", 3, null),
      farmer("b", "Bob", 9, stats()), // a real tally of 0 IS ranked
      farmer("c", "Cid", 5, stats({ goldEarned: 7 })),
    ], cat("goldEarned"));
    expect(rows.map((r) => [r.entry.accountId, r.rank, r.value])).toEqual([
      ["c", 1, 7], ["b", 2, 0], ["a", null, null],
    ]);
  });

  it("breaks ties by name then account id, so the order is stable", () => {
    const tied = [
      farmer("z2", "mia", 1, stats({ harvested: 5 })),
      farmer("z1", "Mia", 1, stats({ harvested: 5 })),
      farmer("a9", "Zed", 1, stats({ harvested: 5 })),
    ];
    const order = rankLeaderboard(tied, cat("harvested")).map((r) => r.entry.accountId);
    expect(order).toEqual(["z1", "z2", "a9"]);
    // Same input in another arrival order lands the same.
    expect(rankLeaderboard([...tied].reverse(), cat("harvested")).map((r) => r.entry.accountId))
      .toEqual(order);
  });

  it("handles an empty board (signed in, no friends yet loses nothing)", () => {
    expect(rankLeaderboard([], cat("level"))).toEqual([]);
  });
});

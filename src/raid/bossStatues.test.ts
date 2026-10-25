import { describe, it, expect } from "vitest";
import { RaidManager } from "./RaidManager";
import { GameState } from "../GameState";
import { BOSS_STATUE_WINS, GOLDEN_STATUE_WINS, statueFlagKey } from "./bossStatues";
import type { RaidDef, RaidOutcome } from "./types";

// The OFFLINE half of the Boss Statue milestones (online: server/src/v3/raid.ts). The rules
// themselves are pinned in server/test/loot.test.ts; this pins that finishRaid feeds them
// the real win count, stores the flags, and grants the statue to Received.

const raid = (id: number) => ({
  id, name: "Test", recommendedLevel: 5, goldReward: 0, bonusGold: 0, xp: 0,
  loot: [["Bonus Gold"], [], [], [], [], []],
}) as unknown as RaidDef;
const PARTY = [{ id: "a" }] as never;
const WIN: RaidOutcome = { win: true, rounds: 1, survivors: ["a"], losses: [], enemiesBeaten: 1, playerDamage: 0 };

function makeManager() {
  const state = new GameState();
  const zombies = { roster: () => [], recordInvasion: () => {}, removeCasualties: () => {} } as never;
  const assets = { drops: {}, boosts: [], placeables: [] } as never;
  const raids = new RaidManager(assets, state, zombies, { save: () => {} });
  return { state, raids };
}

const statuesIn = (state: GameState) => state.received.filter((name) => name.endsWith("Statue"));

describe("offline Boss Statue milestones", () => {
  it("grants the stone statue on the 15th win and the golden one on the 50th", () => {
    const { state, raids } = makeManager();
    for (let i = 1; i < BOSS_STATUE_WINS; i++) raids.finishRaid(raid(1), PARTY, WIN, 0, false, 0, false);
    expect(statuesIn(state)).toEqual([]);
    raids.finishRaid(raid(1), PARTY, WIN, 0, false, 0, false);
    expect(statuesIn(state)).toContain("Old McDonnell Statue");
    expect(state.zombieDryWins[statueFlagKey(1, false)]).toBe(1);
    for (let i = BOSS_STATUE_WINS + 1; i <= GOLDEN_STATUE_WINS; i++)
      raids.finishRaid(raid(1), PARTY, WIN, 0, false, 0, false);
    expect(statuesIn(state)).toContain("Golden Old McDonnell Statue");
  });

  it("never grants one for a dual invasion", () => {
    const { state, raids } = makeManager();
    for (let i = 0; i < GOLDEN_STATUE_WINS + 5; i++) raids.finishRaid(raid(12), PARTY, WIN, 0, false, 0, false);
    expect(statuesIn(state)).toEqual([]);
  });
});

// Halloween's Count statues are earned on the HOUR won (Hour 6 / Hour 12), not the 15th /
// 50th win: they must stay out of BOSS_STATUES, which would start the win milestones.
describe("event boss statues", () => {
  it("are real placeables and drop names, with no win-count milestone attached", async () => {
    const { BOSS_STATUES, EVENT_BOSS_STATUES, bossStatueFor } = await import("./bossStatues");
    const placeables = (await import("../../public/assets/placeables.json")).default as { key: string; sprite: string }[];
    const drops = (await import("../../public/assets/raids/drops.json")).default as Record<string, { tile: string }>;
    const count = EVENT_BOSS_STATUES[16];
    expect(count.name).toBe("Count von Uberbiss Statue");
    expect(bossStatueFor(16)).toBeNull();
    expect(Object.keys(BOSS_STATUES)).not.toContain("16");
    for (const [name, tile] of [[count.name, count.tile], [count.goldenName, count.goldenTile]]) {
      expect(placeables.find((p) => p.key === tile)?.sprite).toBe(`${tile}.png`);
      expect(drops[name]?.tile).toBe(tile);
    }
  });
});

describe("Halloween's hour statues", () => {
  const settle = async (night: number, flags: Record<string, number> = {}, goldenRoll = 0.5, roll = 0.5, wins = 1) =>
    (await import("./bossStatues")).settleBossStatue(16, wins, flags, goldenRoll, roll, night);
  const STONE = "Count von Uberbiss Statue";
  const GOLDEN = "Golden Count von Uberbiss Statue";

  it("pays the stone statue on the first win of Hour 6, and not before", async () => {
    for (let night = 1; night <= 5; night++) expect((await settle(night)).drop).toBeNull();
    const first = await settle(6);
    expect(first.drop).toBe(STONE);
    expect(first.flags["statue:16"]).toBe(1);
    // ...once: the next Hour 6 win pays nothing more without luck.
    expect((await settle(6, first.flags)).drop).toBeNull();
  });

  it("pays the golden statue on the first win of Hour 12, even before the stone one", async () => {
    const had = { "statue:16": 1 };
    const g = await settle(12, had);
    expect(g.drop).toBe(GOLDEN);
    expect(g.flags["goldenStatue:16"]).toBe(1);
    const fresh = await settle(12);
    expect(fresh.drop).toBe(GOLDEN); // golden first; the stone comes on a later Hour 6+ win
    expect((await settle(6, fresh.flags)).drop).toBe(STONE);
  });

  it("pays a Brain Ticket run two hours early: stone on Elite Hour 4, golden on Elite Hour 10", async () => {
    const { settleBossStatue } = await import("./bossStatues");
    const elite = (night: number, flags: Record<string, number> = {}) =>
      settleBossStatue(16, 1, flags, 0.5, 0.5, night, true);
    for (let night = 1; night <= 3; night++) expect(elite(night).drop).toBeNull();
    const stone = elite(4);
    expect(stone.drop).toBe(STONE);
    for (let night = 5; night <= 9; night++) expect(elite(night, stone.flags).drop).toBeNull();
    expect(elite(10, stone.flags).drop).toBe(GOLDEN);
  });

  it("ignores the win count: 50 wins on Hour 1 earn nothing", async () => {
    expect((await settle(1, {}, 0.5, 0.5, 50)).drop).toBeNull();
  });

  it("then rolls 2% stone and 1% golden on ANY hour, once each is earned", async () => {
    const both = { "statue:16": 1, "goldenStatue:16": 1 };
    expect((await settle(1, both, 0.009, 0.5)).drop).toBe(GOLDEN);
    expect((await settle(1, both, 0.011, 0.019)).drop).toBe(STONE);
    expect((await settle(1, both, 0.011, 0.021)).drop).toBeNull();
    // Not yet earned: no repeat chance.
    expect((await settle(1, {}, 0, 0)).drop).toBeNull();
  });
});

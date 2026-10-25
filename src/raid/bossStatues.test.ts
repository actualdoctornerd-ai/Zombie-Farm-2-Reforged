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

// Halloween's Count statues exist as ITEMS (placeables, drop names, sell price) but nothing
// grants them yet: they must stay out of BOSS_STATUES, which would start the win milestones.
describe("event boss statues", () => {
  it("are real placeables and drop names, with no milestone attached", async () => {
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

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

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { RaidManager } from "./RaidManager";
import { GameState } from "../GameState";
import { BRAIN_PITY_INVASIONS } from "./brainDrops";
import { OLD_MC_ZOMBIE_KEY, RAID_ZOMBIE_PITY_WINS } from "./zombieDrops";
import type { RaidDef, RaidOutcome } from "./types";

// The OFFLINE half of the two silent pity systems (online lives in server/src/v3/raid.ts,
// on raid_state_v3.brain_dry_streak / zombie_dry_json). beginRaid pre-rolls the brain drop
// with the streak as a floor; finishRaid is what SETTLES both streaks and rolls the rare
// zombie, and that's what's pinned here.

// Tier 0 (raidTier === 0, so no ability unlock) with an empty loot table, so the
// settlement reduces to exactly the currency bookkeeping this test is about.
const RAID = {
  id: 99, name: "Test Invasion", recommendedLevel: 20,
  goldReward: 100, bonusGold: 0, xp: 0, loot: [[], [], [], []],
} as unknown as RaidDef;

const PARTY = [{ id: "a" }] as never;
const WIN: RaidOutcome = { win: true, rounds: 1, survivors: ["a"], losses: [], enemiesBeaten: 1, playerDamage: 0 };
const LOSS: RaidOutcome = { win: false, rounds: 1, survivors: [], losses: ["a"], enemiesBeaten: 0, playerDamage: 0 };

function makeManager() {
  const state = new GameState();
  const zombies = { roster: () => [], recordInvasion: () => {}, removeCasualties: () => {} } as never;
  const granted: string[] = [];
  const raids = new RaidManager({} as never, state, zombies, {
    save: () => {},
    grantZombie: (key: string) => { granted.push(key); },
  });
  return { state, raids, granted };
}

describe("offline invasion brain pity", () => {
  it("counts a brainless boss win towards the guarantee", () => {
    const { state, raids } = makeManager();
    raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    expect(state.brainDryStreak).toBe(1);
  });

  it("reaches the guarantee after exactly the threshold of dry boss wins", () => {
    const { state, raids } = makeManager();
    for (let i = 0; i < BRAIN_PITY_INVASIONS; i++) raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    expect(state.brainDryStreak).toBe(BRAIN_PITY_INVASIONS);
  });

  it("clears the streak when brains are paid, and credits them", () => {
    const { state, raids } = makeManager();
    for (let i = 0; i < 3; i++) raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    const before = state.brains;
    const view = raids.finishRaid(RAID, PARTY, WIN, 0, false, 1, true);
    expect(view.brains).toBe(1);
    expect(state.brains).toBe(before + 1);
    expect(state.brainDryStreak).toBe(0);
  });

  it("leaves the streak alone for fights that could never pay a brain", () => {
    const { state, raids } = makeManager();
    raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    // A boss-less stage (the low-level McDonnell's ladder) rolls no brains...
    raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, false);
    // ...and a loss pays nothing at all.
    raids.finishRaid(RAID, PARTY, LOSS, 0, false, 0, true);
    expect(state.brainDryStreak).toBe(1);
  });

  it("does not settle the local streak while the server owns the reward", () => {
    const { state, raids } = makeManager();
    raids.finishRaid(RAID, PARTY, WIN, 0, true, 0, true);
    expect(state.brainDryStreak).toBe(0);
  });
});

// A Pirates-tier fixture (unlockLevel 21) for the first-clear double. Same tier-0 /
// empty-loot shape as RAID so only the brain bookkeeping is in play.
const PIRATES_TIER = {
  id: 98, name: "Test Pirates", recommendedLevel: 21, unlockLevel: 21,
  goldReward: 100, bonusGold: 0, xp: 0, loot: [[], [], [], []],
} as unknown as RaidDef;

describe("offline first-clear brain grant", () => {
  // A fresh GameState starts with 1 brain, so every balance check is a delta.
  it("pays 1 brain the first time a low invasion is cleared, and never again", () => {
    const { state, raids } = makeManager();
    const start = state.brains;
    const first = raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    expect(first.firstClear).toBe(true);
    expect(first.brains).toBe(1);
    expect(state.brains).toBe(start + 1);
    const second = raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    expect(second.firstClear).toBe(false);
    expect(second.brains).toBe(0);
    expect(state.brains).toBe(start + 1);
  });

  it("pays 2 brains for the Pirates tier and up, on top of a rolled drop", () => {
    const { state, raids } = makeManager();
    const start = state.brains;
    const view = raids.finishRaid(PIRATES_TIER, PARTY, WIN, 0, false, 1, true);
    expect(view.brains).toBe(3); // 1 rolled + 2 first-clear
    expect(state.brains).toBe(start + 3);
  });

  it("pays even on a boss-less stage — it rewards the clear, not the boss", () => {
    const { state, raids } = makeManager();
    const start = state.brains;
    const view = raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, false);
    expect(view.brains).toBe(1);
    expect(state.brains).toBe(start + 1);
  });

  it("does not touch the pity streak — only the rolled drop settles it", () => {
    const { state, raids } = makeManager();
    const start = state.brains;
    raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    expect(state.brains).toBe(start + 1); // first-clear brain paid...
    expect(state.brainDryStreak).toBe(1); // ...but the dry streak still advanced.
  });

  it("pays nothing extra online — the server owns the grant", () => {
    const { state, raids } = makeManager();
    const start = state.brains;
    const view = raids.finishRaid(RAID, PARTY, WIN, 0, true, 0, true);
    expect(view.brains).toBe(0);
    expect(state.brains).toBe(start);
  });
});

// Old McDonnell's — the raid that drops Old McZombie at 1%. Empty loot so the item roll
// stays out of the way; goldReward keeps winGold honest.
const MCDONNELLS = {
  id: 1, name: "Old McDonnell's Farm", recommendedLevel: 5,
  goldReward: 100, bonusGold: 0, xp: 0, loot: [[], [], [], []],
} as unknown as RaidDef;

describe("offline rare-zombie pity", () => {
  // Pin the natural 1% roll to a MISS so the streak is the only thing that can pay out.
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0.999); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("counts dry wins of the raid and hands the zombie over at the threshold", () => {
    const { state, raids, granted } = makeManager();
    // Just short of the guarantee, with the natural 1% roll missing every time.
    for (let i = 0; i < RAID_ZOMBIE_PITY_WINS; i++) raids.finishRaid(MCDONNELLS, PARTY, WIN, 0, false, 0, true);
    expect(state.zombieDryWins["1"]).toBe(RAID_ZOMBIE_PITY_WINS);

    const view = raids.finishRaid(MCDONNELLS, PARTY, WIN, 0, false, 0, true);
    expect(granted).toContain(OLD_MC_ZOMBIE_KEY);
    expect(view.loot.some((drop) => drop.name === "Old McZombie")).toBe(true);
    // ...and the next streak starts from scratch rather than paying out again.
    expect(state.zombieDryWins["1"]).toBe(0);
  });

  it("keeps the streak per raid — losses and other invasions do not feed it", () => {
    const { state, raids } = makeManager();
    raids.finishRaid(MCDONNELLS, PARTY, WIN, 0, false, 0, true);
    raids.finishRaid(MCDONNELLS, PARTY, LOSS, 0, false, 0, true);
    // A raid with no rare zombie of its own never even gets a key.
    raids.finishRaid(RAID, PARTY, WIN, 0, false, 0, true);
    expect(state.zombieDryWins).toEqual({ "1": 1 });
  });

  it("leaves the streak to the server while signed in", () => {
    const { state, raids, granted } = makeManager();
    for (let i = 0; i < RAID_ZOMBIE_PITY_WINS + 1; i++) raids.finishRaid(MCDONNELLS, PARTY, WIN, 0, true, 0, true);
    expect(state.zombieDryWins).toEqual({});
    expect(granted).toEqual([]);
  });
});

describe("offline rare-zombie luck from Golden Dice", () => {
  // 0.015 is a miss against the bare 1% and a hit against one die's 2%, so this pins that
  // finishRaid actually forwards the dice it was handed into the rare-zombie roll.
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0.015); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("misses that roll with no dice spent", () => {
    const { raids, granted } = makeManager();
    raids.finishRaid(MCDONNELLS, PARTY, WIN, 0, false, 0, true);
    expect(granted).toEqual([]);
  });

  it("lands it with one die spent", () => {
    const { raids, granted } = makeManager();
    const view = raids.finishRaid(MCDONNELLS, PARTY, WIN, 1, false, 0, true);
    expect(granted).toEqual([OLD_MC_ZOMBIE_KEY]);
    expect(view.loot.some((drop) => drop.name === "Old McZombie")).toBe(true);
  });
});

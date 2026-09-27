// PRACTICE (raid/practice.ts): the client's half of the no-stakes prototype. The Worker owns
// the rules online (server/test/integration/dualInvasion.spec.ts); this pins that the client
// says the same thing — the cards, the launch and the result — and that offline play, where
// the client is the authority, honours it too.
import { describe, expect, it } from "vitest";
import { RaidManager } from "./RaidManager";
import { GameState } from "../GameState";
import { CONCENTRATION_KEY, DICE_KEY, isUnlocked, RAID_COOLDOWN_MS, VOUCHER_KEY } from "./RaidCatalog";
import { MAX_TIER } from "./dualInvasion";
import { DUAL_PRACTICE, effectiveUnlockLevel, isPracticeRaid, PRACTICE_UNLOCK_LEVEL } from "./practice";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import raidsJson from "../../public/assets/raids/raids.json";
import type { RaidDef, RaidOutcome } from "./types";

const raids = raidsJson as RaidDef[];
const PARTY_IDS = Array.from({ length: 10 }, (_, i) => `z${i}`);
const NOW = RAID_COOLDOWN_MS * 10;

function atLevel(level: number) {
  const state = new GameState();
  while (state.level < level) state.addXp(1_000);
  return state;
}

function makeManager(level: number) {
  const state = atLevel(level);
  const roster = PARTY_IDS.map((id) => ({
    id, key: "ZombieActorRegularTier1", name: id, typeName: "Regular", group: "Regular",
    className: "Green", str: 5, dex: 2, con: 5, focus: 50, invasions: 0, mutation: 0,
    stored: false, col: 0, row: 0,
  }));
  const recorded: string[][] = [];
  const removed: string[][] = [];
  const zombies = {
    roster: () => roster,
    recordInvasion: (ids: string[]) => { recorded.push(ids); },
    removeCasualties: (ids: string[]) => { removed.push(ids); },
  } as never;
  const assets = {
    raids, enemyStats: enemyStatsJson, raidAttacks: attacksJson, boosts: [], drops: {},
  } as never;
  const manager = new RaidManager(assets, state, zombies, { save: () => {} }, RAID_COOLDOWN_MS, () => NOW);
  return { state, manager, recorded, removed };
}

describe.skipIf(!DUAL_PRACTICE)("practice", () => {
  it("covers the four dual invasions and nothing else", () => {
    for (const r of raids) expect(isPracticeRaid(r.id), r.name).toBe(r.id >= 12 && r.id <= 15);
  });

  it("opens them at level 40", () => {
    const raid12 = raids.find((r) => r.id === 12)!;
    expect(effectiveUnlockLevel(raid12)).toBe(PRACTICE_UNLOCK_LEVEL);
    expect(isUnlocked(raid12, PRACTICE_UNLOCK_LEVEL - 1)).toBe(false);
    expect(isUnlocked(raid12, PRACTICE_UNLOCK_LEVEL)).toBe(true);
    // The story raids keep their own gates.
    const raid9 = raids.find((r) => r.id === 9)!;
    expect(effectiveUnlockLevel(raid9)).toBe(raid9.unlockLevel);
  });

  it("offers every tier on the card, and says it is practice", () => {
    const { manager } = makeManager(PRACTICE_UNLOCK_LEVEL);
    const card = manager.raidCards().find((c) => c.id === 13)!;
    expect(card.unlocked).toBe(true);
    expect(card.practice).toBe(true);
    expect(card.tierUnlocked).toBe(MAX_TIER);
    expect(manager.raidCards().find((c) => c.id === 9)!.practice).toBe(false);
  });

  it("launches on cooldown at any tier, and spends nothing", () => {
    const { state, manager } = makeManager(PRACTICE_UNLOCK_LEVEL);
    state.lastRaidAt = NOW; // a live cooldown
    state.addBoost(VOUCHER_KEY, 1);
    state.addBoost(CONCENTRATION_KEY, 1);
    state.addBoost(DICE_KEY, 3);
    const setup = manager.beginRaid(14, PARTY_IDS, {
      tier: MAX_TIER, useVoucher: true, concentration: true, dice: 3,
    })!;
    expect(setup).not.toBeNull();
    expect(setup.tier).toBe(MAX_TIER);
    expect(setup.concentration).toBe(false);
    expect(setup.dice).toBe(0);
    expect(setup.brainDrop).toBe(0);
    expect(state.boostCount(VOUCHER_KEY)).toBe(1);
    expect(state.boostCount(CONCENTRATION_KEY)).toBe(1);
    expect(state.boostCount(DICE_KEY)).toBe(3);
  });

  it("settles for nothing: no reward, no veterancy, no casualty, no cooldown", () => {
    const { state, manager, recorded, removed } = makeManager(PRACTICE_UNLOCK_LEVEL);
    const setup = manager.beginRaid(12, PARTY_IDS, { tier: 5 })!;
    const outcome: RaidOutcome = {
      win: true, rounds: 1, survivors: PARTY_IDS.slice(2), losses: PARTY_IDS.slice(0, 2),
      enemiesBeaten: 10, playerDamage: 0,
    };
    const gold = state.gold;
    const xp = state.xp;
    const brains = state.brains;
    const lastRaidAt = state.lastRaidAt;
    const view = manager.finishRaid(setup.raid, setup.party, outcome, 0, false, 0, false, false, setup.tier);
    expect(view.practice).toBe(true);
    expect(view.zombiesLost, "what it WOULD have cost").toBe(2);
    expect([view.gold, view.brains, view.xp]).toEqual([0, 0, 0]);
    expect(view.loot).toEqual([]);
    expect(recorded, "no veterancy").toEqual([]);
    expect(removed, "nobody removed").toEqual([]);
    expect([state.gold, state.xp, state.brains]).toEqual([gold, xp, brains]);
    expect(state.lastRaidAt).toBe(lastRaidAt);
    expect(state.raidWins("12")).toBe(0);
  });
});

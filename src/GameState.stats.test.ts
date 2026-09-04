import { describe, expect, it } from "vitest";
import { GameState } from "./GameState";
import { newFarmStats } from "./stats";

// Gold and brains reach the player down half a dozen different roads — addGold
// offline, the economy client's optimistic apply and the server reconcile that
// follows it online. The lifetime totals are read off the BALANCE for that reason:
// it is the one thing every road agrees on, and the only way to count an online
// harvest exactly once.
describe("lifetime currency totals", () => {
  it("counts what comes in and what goes out, separately", () => {
    const s = new GameState();
    const gold0 = s.gold;

    s.addGold(500);
    s.spendGold(200);
    s.addBrains(4);
    s.spendBrains(1);

    expect(s.stats.goldEarned).toBe(500);
    expect(s.stats.goldSpent).toBe(200);
    expect(s.gold).toBe(gold0 + 300);
    expect(s.stats.brainsEarned).toBe(4);
    expect(s.stats.brainsSpent).toBe(1);
  });

  it("counts an online reconcile's movement exactly once", () => {
    const s = new GameState();
    // The optimistic credit a harvest applies, then the server's own figure for the
    // same harvest arriving a moment later.
    s.syncBalance(s.gold + 120, s.brains, s.xp);
    s.syncBalance(s.gold + 0, s.brains, s.xp);

    expect(s.stats.goldEarned).toBe(120);
    expect(s.stats.goldSpent).toBe(0);
  });

  it("does not book a loaded balance as income", () => {
    const s = new GameState();
    // What SaveManager.applySave does with a long-running farm's save.
    s.apply({ name: "Zoe", gold: 250_000, brains: 90, xp: 40_000, zombieCount: 9, zombieMax: 16 });
    s.restoreStats(newFarmStats(1_800_000_000_000));

    expect(s.stats.goldEarned).toBe(0);
    expect(s.stats.brainsEarned).toBe(0);

    // …and counting resumes normally from there.
    s.addGold(10);
    expect(s.stats.goldEarned).toBe(10);
  });

  it("refuses a purchase without booking it as spending", () => {
    const s = new GameState();
    expect(s.spendGold(s.gold + 1)).toBe(false);
    expect(s.stats.goldSpent).toBe(0);
  });
});

// The wobble that inflated one player's brains to 141 earned / 127 spent against a
// real 62: a balance that dips and recovers is booked on BOTH sides. The remedy hands a
// booking back when the movement behind it never happened, and shifts the baseline so
// the correction that follows books nothing.
describe("giving a booking back", () => {
  it("nets a refused online spend to zero on both sides", () => {
    const s = new GameState();
    const before = s.gold;
    // The optimistic spend (booked), then the server refuses it: the delta leaves the
    // overlay and the balance springs back to what the server always held.
    s.syncBalance(before - 100, s.brains, s.xp);
    expect(s.stats.goldSpent).toBe(100);
    s.unbookCurrency(-100, 0);
    s.syncBalance(before, s.brains, s.xp);
    expect(s.stats.goldSpent).toBe(0);
    expect(s.stats.goldEarned).toBe(0);
  });

  it("books a dropped spend exactly once, when the server's balance carries it", () => {
    const s = new GameState();
    const before = s.brains;
    s.syncBalance(s.gold, before - 3, s.xp); // optimistic spend, booked
    s.unbookCurrency(0, -3);                  // the overlay is cleared (writer lost)
    s.syncBalance(s.gold, before - 3, s.xp); // …but the server had applied it
    expect(s.stats.brainsSpent).toBe(3);
    expect(s.stats.brainsEarned).toBe(0);
  });

  it("never drives a counter below zero", () => {
    const s = new GameState();
    s.unbookCurrency(-50, 4);
    expect(s.stats.goldSpent).toBe(0);
    expect(s.stats.brainsEarned).toBe(0);
  });
});

describe("lifetime farm and zombie counters", () => {
  it("credits a zombie crop as both a harvest and a zombie", () => {
    const s = new GameState();
    s.recordHarvest("carrot", false);
    s.recordHarvest("carrot", false);
    s.recordHarvest("ZombieActorRegularTier1", true);

    expect(s.stats.harvested).toEqual({ carrot: 2, ZombieActorRegularTier1: 1 });
    expect(s.stats.zombiesGrown).toBe(1);
  });

  it("counts a settled invasion on the side it landed", () => {
    const s = new GameState();
    s.recordRaidSettled(true);
    s.recordRaidSettled(false); // a loss, or a retreat
    s.recordRaidSettled(true);

    expect(s.stats.raidsWon).toBe(2);
    expect(s.stats.raidsLost).toBe(1);
  });

  it("un-counts a zombie bought back at the post-raid revival offer", () => {
    const s = new GameState();
    const fallen = (id: string) => ({
      id, key: "ZombieActorRegularTier1", mutation: 0, invasions: 2, diedAt: 1,
    });
    s.recordFallen([fallen("z1"), fallen("z2")]);
    expect(s.stats.zombiesLost).toBe(2);

    s.forgetFallen(["z1"]);
    expect(s.stats.zombiesLost).toBe(1);
  });
});

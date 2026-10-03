import { describe, it, expect } from "vitest";
import { RAIDS, raidEcon, winGold, raidUnlocked } from "../src/raidCatalog";
import { invasionWinXp, repeatInvasionXp } from "../../src/raid/repeatXp";

describe("raidCatalog", () => {
  it("has all 15 playable raids, the 11 source ones with positive gold", () => {
    expect(Object.keys(RAIDS)).toHaveLength(15);
    for (const [id, r] of Object.entries(RAIDS)) {
      expect(r.xp, id).toBeGreaterThan(0);
      // The four dual invasions (12-15) carry gold 0 DELIBERATELY: the wiki has no figure
      // for a raid it never had, so winGold falls back to pricing them off recLevel. The
      // eleven source raids all have a real wiki figure and must keep it.
      if (Number(id) <= 11) expect(r.gold, id).toBeGreaterThan(0);
      else expect(r.gold, id).toBe(0);
      expect(r.recLevel, id).toBeGreaterThan(0);
    }
  });
  it("raidEcon looks up known ids and rejects unknown", () => {
    expect(raidEcon(1)).toMatchObject({ gold: 1200, bonus: 400, xp: 50 });
    expect(raidEcon(6)).toMatchObject({ gold: 4000, bonus: 2000 });
    expect(raidEcon(999)).toBeUndefined();
    expect(raidEcon(0)).toBeUndefined();
  });
  it("mirrors raids.json unlock levels", () => {
    expect(raidEcon(1)).toMatchObject({ unlockLevel: 0, playable: true }); // McDonnell: from the start
    expect(raidEcon(9)).toMatchObject({ unlockLevel: 43 }); // Video Games: the richest raid
    expect(raidEcon(2)).toMatchObject({ unlockLevel: 16 });
  });
});

// The repeat-XP table lives in src/raid/repeatXp.ts and is imported by BOTH sides, so
// there is no mirror to drift. What CAN drift is coverage: this server catalog is
// hand-maintained, so a raid added here without a repeat value would quietly pay 0 on
// every win after its first.
describe("repeat-invasion XP vs the server raid catalog", () => {
  it("prices a repeat win for every raid the server will settle", () => {
    for (const id of Object.keys(RAIDS).map(Number)) {
      expect(repeatInvasionXp(id), `raid ${id}`).toBeGreaterThan(0);
    }
  });

  it("pays the authored bonus on the first clear and the trickle after, never both", () => {
    for (const [key, r] of Object.entries(RAIDS)) {
      const id = Number(key);
      expect(invasionWinXp(id, r.xp, true), `raid ${id} first clear`).toBe(r.xp);
      expect(invasionWinXp(id, r.xp, false), `raid ${id} repeat`).toBe(repeatInvasionXp(id));
      expect(invasionWinXp(id, r.xp, false, true), `raid ${id} elite repeat`).toBe(repeatInvasionXp(id) * 4);
    }
  });

  // A repeat win must never out-earn the raid's own first clear, or the reward ordering
  // players are taught ("the first one is the big one") stops being true.
  it("keeps even an elite repeat below the first clear", () => {
    for (const [key, r] of Object.entries(RAIDS)) {
      expect(repeatInvasionXp(Number(key), true), `raid ${key}`).toBeLessThan(r.xp);
    }
  });
});

describe("raidUnlocked — server mirror of RaidCatalog.isUnlocked", () => {
  it("gates the richest raid behind its unlock level", () => {
    // The whole point: a level-1 account must not reach raid 9 (5000+1200 gold AND 5500
    // first-clear XP, which converts to ~free level-up brains).
    expect(raidUnlocked(RAIDS[9], 1)).toBe(false);
    expect(raidUnlocked(RAIDS[9], 42)).toBe(false);
    expect(raidUnlocked(RAIDS[9], 43)).toBe(true);
    expect(raidUnlocked(RAIDS[9], 45)).toBe(true);
  });
  it("lets the starter raid through at any level", () => {
    expect(raidUnlocked(RAIDS[1], 1)).toBe(true); // unlockLevel 0
  });
  it("refuses an unplayable raid regardless of level", () => {
    expect(raidUnlocked({ ...RAIDS[1], playable: false }, 99)).toBe(false);
  });
});

describe("winGold — server mirror of RaidCatalog.winGold", () => {
  const mc = RAIDS[1]; // McDonnell: base 1200, bonus 400

  it("pays base + bonus on a flawless win", () => {
    expect(winGold(mc, 1)).toBe(1600);
  });
  it("scales base and bonus by the survival fraction", () => {
    expect(winGold(mc, 0.5)).toBe(600 + 200); // round(1200*.5)+round(400*.5)
    expect(winGold(mc, 0)).toBe(0);
  });
  it("clamps the survival fraction to [0,1] — no reward above the raid ceiling", () => {
    expect(winGold(mc, 5)).toBe(1600); // clamped to 1
    expect(winGold(mc, -3)).toBe(0); // clamped to 0
    // Non-finite garbage pays nothing (conservative) rather than the ceiling.
    expect(winGold(mc, NaN)).toBe(0);
    expect(winGold(mc, Infinity)).toBe(0);
  });
  it("matches the biggest raid's ceiling", () => {
    // Spelled out rather than read back off RAIDS[9], so an accidental edit to the
    // catalog has to be justified here too. Video Games' base moved 5,000 -> 6,300
    // deliberately: it is the last invasion unlocked and the hardest fight on the
    // ladder, and at 5,000 it paid barely more per run than the Aliens five levels
    // below it. Keep in step with tools/prep_raids.py WIKI_GOLD.
    expect(winGold(RAIDS[9], 1)).toBe(6300 + 1200); // Video Games
  });
});

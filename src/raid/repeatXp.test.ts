// Guards on the repeat-invasion XP table. Two of these are the interesting ones:
// the DERIVATION check (the table really is 1% of the unlock level's requirement) and
// the MONOTONICITY check (a later invasion never pays less than an earlier one) — the
// second is what the four hand-set rungs exist to satisfy, and the pair together stop
// a future edit from silently reintroducing the flat floor the set values replaced.

import { describe, expect, it } from "vitest";
import raidRows from "../../public/assets/raids/raids.json";
import { XP_THRESHOLDS } from "../GameState";
import {
  ELITE_REPEAT_XP_MULTIPLIER,
  REPEAT_INVASION_XP,
  REPEAT_XP_FLOOR,
  invasionWinXp,
  repeatInvasionXp,
} from "./repeatXp";

interface Row { id: number; name: string; unlockLevel: number; xp: number; playable?: boolean }
const RAIDS = raidRows as unknown as Row[];

/** XP to advance FROM `level`, mirroring the server's xpToNextLevel. */
function xpToNext(level: number): number {
  const i = Math.max(1, Math.min(XP_THRESHOLDS.length, Math.floor(level)));
  if (i >= XP_THRESHOLDS.length) return XP_THRESHOLDS[XP_THRESHOLDS.length - 1] - XP_THRESHOLDS[XP_THRESHOLDS.length - 2];
  return XP_THRESHOLDS[i] - XP_THRESHOLDS[i - 1];
}

/** The four values placed by hand because the 1% formula collapsed onto the floor for
 *  every raid unlocking between levels 8 and 16. Everything NOT listed here must still
 *  come out of the formula exactly. */
const HAND_SET: Readonly<Record<number, number>> = { 7: 12, 10: 12, 11: 12, 8: 14, 2: 16 };

describe("repeat-invasion XP table", () => {
  it("covers every playable raid, and nothing else", () => {
    const playable = RAIDS.filter((r) => r.playable !== false).map((r) => r.id).sort((a, b) => a - b);
    expect(Object.keys(REPEAT_INVASION_XP).map(Number).sort((a, b) => a - b)).toEqual(playable);
  });

  it("derives each un-set rung as 1% of the unlock level's XP requirement, floored at 10", () => {
    for (const raid of RAIDS) {
      if (HAND_SET[raid.id] !== undefined) continue;
      // The dual invasions unlock at 46-49, above the level cap while levels 46-50 are
      // withheld (see XP_THRESHOLDS); their rungs were derived from the withheld curve and
      // are unused meanwhile — practice pays no XP.
      if (raid.unlockLevel > XP_THRESHOLDS.length) continue;
      const derived = Math.max(REPEAT_XP_FLOOR, Math.round(xpToNext(raid.unlockLevel) / 100));
      expect(REPEAT_INVASION_XP[raid.id], `${raid.name} (unlock ${raid.unlockLevel})`).toBe(derived);
    }
  });

  it("keeps the hand-set rungs where they were placed", () => {
    for (const [id, value] of Object.entries(HAND_SET)) {
      expect(REPEAT_INVASION_XP[Number(id)]).toBe(value);
    }
  });

  // The bug the hand-set values fix: levels 8-19 all cost 500-1,000 XP, so the raw 1%
  // formula floors five separate raids at 10 and Circus (unlock 12) would pay LESS than
  // Summer Break (unlock 8). Sorting by unlock level must produce a non-decreasing ladder.
  it("never pays a later-unlocking invasion less than an earlier one", () => {
    const ladder = [...RAIDS]
      .filter((r) => r.playable !== false)
      .sort((a, b) => a.unlockLevel - b.unlockLevel || a.id - b.id);
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1];
      const here = ladder[i];
      expect(
        REPEAT_INVASION_XP[here.id],
        `${here.name} (unlock ${here.unlockLevel}) vs ${prev.name} (unlock ${prev.unlockLevel})`
      ).toBeGreaterThanOrEqual(REPEAT_INVASION_XP[prev.id]);
    }
  });

  // The whole anti-farming premise: the value is a property of the RAID, so no amount of
  // player progress makes an old invasion worth farming. If this ever fails, someone has
  // reintroduced current-level pricing.
  it("is a function of the raid alone — nothing about the player enters it", () => {
    expect(repeatInvasionXp(1)).toBe(10);
    expect(repeatInvasionXp(9)).toBe(140);
    // McDonnell's (unlock 1) stays worth a fraction of the Video Games (unlock 43),
    // whoever is invading it.
    expect(repeatInvasionXp(9)).toBeGreaterThan(repeatInvasionXp(1) * 10);
  });

  it("pays nothing for an unknown raid rather than falling back to another's figure", () => {
    expect(repeatInvasionXp(999)).toBe(0);
    expect(repeatInvasionXp(999, true)).toBe(0);
  });
});

describe("brain ticket multiplier", () => {
  it("quadruples every rung", () => {
    expect(ELITE_REPEAT_XP_MULTIPLIER).toBe(4);
    for (const raid of RAIDS) {
      expect(repeatInvasionXp(raid.id, true)).toBe(REPEAT_INVASION_XP[raid.id] * 4);
    }
  });
});

describe("invasionWinXp", () => {
  it("pays the authored first-clear bonus on the first win, and only that", () => {
    // Video Games: 5,500 authored vs a 140 repeat. The two never stack.
    expect(invasionWinXp(9, 5500, true)).toBe(5500);
    expect(invasionWinXp(9, 5500, true, true)).toBe(5500);
  });

  it("pays the repeat trickle on every later win", () => {
    expect(invasionWinXp(9, 5500, false)).toBe(140);
    expect(invasionWinXp(9, 5500, false, true)).toBe(560);
  });

  // A first clear is worth 10-40x a repeat on every raid, so the one-time bonus stays
  // the headline reward and the trickle stays a trickle.
  it("keeps every first clear worth far more than a repeat of the same raid", () => {
    for (const raid of RAIDS) {
      if (!raid.xp) continue;
      expect(
        invasionWinXp(raid.id, raid.xp, true),
        raid.name
      ).toBeGreaterThan(invasionWinXp(raid.id, raid.xp, false, true));
    }
  });

  it("never returns a negative amount for a raid authored with no first-clear XP", () => {
    expect(invasionWinXp(1, 0, true)).toBe(0);
    expect(invasionWinXp(1, -5, true)).toBe(0);
  });
});

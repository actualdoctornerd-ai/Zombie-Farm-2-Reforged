import { describe, expect, it } from "vitest";
import {
  BRAIN_PITY_AMOUNT,
  BRAIN_PITY_INVASIONS,
  BRAIN_RAMP_LEVEL,
  brainDropChance,
  brainDropTable,
  FIRST_CLEAR_BRAIN_DOUBLE_LEVEL,
  firstClearBrains,
  nextBrainDryStreak,
  rollBrainDrop,
  rollBrainDropWithPity,
} from "./brainDrops";
import { ELITE_BRAIN_LUCK } from "./eliteInvasion";

describe("invasion brain drops", () => {
  it("doubles rate without changing the 5/3/1 awards", () => {
    expect(brainDropTable(20)).toEqual([
      { amount: 5, chance: 0.02 },
      { amount: 3, chance: 0.04 },
      { amount: 1, chance: 0.1 },
    ]);
  });

  it("reports the any-brains chance the invasion card shows", () => {
    // Every tier must miss for a win to pay nothing: 1 - .98 * .96 * .9.
    expect(brainDropChance(20)).toBeCloseTo(1 - 0.98 * 0.96 * 0.9, 12);
    // Level scaling carries through — a low-level raid pays less often.
    expect(brainDropChance(5)).toBeLessThan(brainDropChance(20));
    // Never negative, never past certainty.
    expect(brainDropChance(0)).toBeGreaterThan(0);
    expect(brainDropChance(100)).toBeLessThan(1);
  });

  it("rolls rarest-first and awards at most one tier", () => {
    expect(rollBrainDrop(20, () => 0.019)).toBe(5);
    const rolls = [0.5, 0.039];
    expect(rollBrainDrop(20, () => rolls.shift() ?? 1)).toBe(3);
    expect(rollBrainDrop(20, () => 1)).toBe(0);
  });

  it("pays 1 first-clear brain below the Pirates' unlock level and 2 from it up", () => {
    // The Pirates unlock at 21 (raids.json) — the double starts exactly there.
    expect(FIRST_CLEAR_BRAIN_DOUBLE_LEVEL).toBe(21);
    expect(firstClearBrains(0)).toBe(1); // Old McDonnell's
    expect(firstClearBrains(8)).toBe(1); // seasonal raids
    expect(firstClearBrains(16)).toBe(1); // Lawyers
    expect(firstClearBrains(21)).toBe(2); // Pirates
    expect(firstClearBrains(43)).toBe(2); // Video Games
  });
});

describe("brain odds keep climbing past the ramp level", () => {
  // The old table clamped at BRAIN_RAMP_LEVEL, so every invasion from the Pirates
  // (rec 21) up paid identical brain odds — the plateau this regression guards.
  const CATALOG_REC_LEVELS = [5, 8, 12, 16, 21, 26, 31, 36, 43];

  it("is strictly increasing across the whole invasion ladder", () => {
    const odds = CATALOG_REC_LEVELS.map((level) => brainDropChance(level));
    for (let i = 1; i < odds.length; i++) expect(odds[i]).toBeGreaterThan(odds[i - 1]);
  });

  it("keeps the same slope above the ramp level instead of flattening", () => {
    // Two steps of equal size either side of the reference level move the 1-brain
    // tier by the same amount — i.e. one straight line, no knee at BRAIN_RAMP_LEVEL.
    const commonest = (level: number) => brainDropTable(level)[2].chance;
    const below = commonest(BRAIN_RAMP_LEVEL) - commonest(BRAIN_RAMP_LEVEL - 10);
    const above = commonest(BRAIN_RAMP_LEVEL + 10) - commonest(BRAIN_RAMP_LEVEL);
    expect(above).toBeCloseTo(below, 12);
  });

  it("stays stingy at the top of the ladder", () => {
    // The hardest invasion still pays nothing three wins in four.
    expect(brainDropChance(43)).toBeLessThan(0.3);
  });

  it("floors at zero rather than going negative below the ladder", () => {
    expect(brainDropTable(-50).every((tier) => tier.chance > 0)).toBe(true);
  });
});

describe("elite (Brain Ticket) luck", () => {
  it("multiplies every tier by the elite factor", () => {
    const plain = brainDropTable(20);
    const elite = brainDropTable(20, ELITE_BRAIN_LUCK);
    for (let i = 0; i < plain.length; i++) {
      expect(elite[i].amount).toBe(plain[i].amount);
      expect(elite[i].chance).toBeCloseTo(plain[i].chance * ELITE_BRAIN_LUCK, 12);
    }
  });

  it("turns a roll that would have missed into a drop", () => {
    // At rec 20 the tiers are 2% / 4% / 10% ordinarily and 8% / 16% / 40% elite, so a
    // 12% roll misses every ordinary tier and lands on the elite 3-brain one.
    expect(rollBrainDrop(20, () => 0.12)).toBe(0);
    expect(rollBrainDrop(20, () => 0.12, ELITE_BRAIN_LUCK)).toBe(3);
  });

  it("carries through the pity roll", () => {
    expect(rollBrainDropWithPity(20, 0, () => 0.12, ELITE_BRAIN_LUCK)).toBe(3);
  });

  it("cannot push a tier past certainty", () => {
    for (const tier of brainDropTable(1000, ELITE_BRAIN_LUCK)) {
      expect(tier.chance).toBeLessThan(1);
    }
  });
});

describe("brain pity floor", () => {
  const dry = () => 1; // every tier misses

  it("pays nothing while the dry streak is short of the threshold", () => {
    for (let streak = 0; streak < BRAIN_PITY_INVASIONS; streak++) {
      expect(rollBrainDropWithPity(20, streak, dry)).toBe(0);
    }
  });

  it("guarantees the smallest stack once the streak reaches the threshold", () => {
    expect(rollBrainDropWithPity(20, BRAIN_PITY_INVASIONS, dry)).toBe(BRAIN_PITY_AMOUNT);
    expect(BRAIN_PITY_AMOUNT).toBe(1);
  });

  it("never overrides a natural roll — luck beats the floor", () => {
    expect(rollBrainDropWithPity(20, BRAIN_PITY_INVASIONS, () => 0.019)).toBe(5);
    expect(rollBrainDropWithPity(20, 0, () => 0.019)).toBe(5);
  });

  it("counts a dry invasion up and resets on any brain", () => {
    let streak = 0;
    for (let i = 0; i < BRAIN_PITY_INVASIONS; i++) streak = nextBrainDryStreak(streak, 0);
    expect(streak).toBe(BRAIN_PITY_INVASIONS);
    // The guaranteed brain lands, and the next invasion starts from scratch.
    expect(nextBrainDryStreak(streak, rollBrainDropWithPity(20, streak, dry))).toBe(0);
    expect(rollBrainDropWithPity(20, 0, dry)).toBe(0);
  });

  it("clamps the stored streak and shrugs off a garbage value", () => {
    expect(nextBrainDryStreak(BRAIN_PITY_INVASIONS, 0)).toBe(BRAIN_PITY_INVASIONS);
    expect(nextBrainDryStreak(999, 0)).toBe(BRAIN_PITY_INVASIONS);
    expect(nextBrainDryStreak(-5, 0)).toBe(1);
    expect(nextBrainDryStreak(3, 3)).toBe(0);
  });

  it("takes at most nine invasions to see a brain, however unlucky", () => {
    let streak = 0;
    let paid = 0;
    for (let invasion = 1; invasion <= BRAIN_PITY_INVASIONS + 1; invasion++) {
      const brains = rollBrainDropWithPity(20, streak, dry);
      if (brains > 0) paid = invasion;
      streak = nextBrainDryStreak(streak, brains);
    }
    expect(paid).toBe(BRAIN_PITY_INVASIONS + 1);
  });
});

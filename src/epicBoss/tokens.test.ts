import { describe, expect, it } from "vitest";
import { dropsEpicBossToken, epicBossTokenChance } from "./tokens";

describe("Epic Boss crop tokens", () => {
  it("rewards longer and more valuable crops without exceeding the recovered 35% ceiling", () => {
    const carrot = epicBossTokenChance(15 * 60_000, 16);
    const onion = epicBossTokenChance(24 * 60 * 60_000, 60);
    const premium = epicBossTokenChance(24 * 60 * 60_000, 205);
    expect(carrot).toBeGreaterThan(0);
    expect(onion).toBeGreaterThan(carrot);
    expect(premium).toBe(0.35);
  });

  it("uses an injectable roll and rejects crops with no time or value", () => {
    expect(dropsEpicBossToken(0, 100, () => 0)).toBe(false);
    const chance = epicBossTokenChance(60 * 60_000, 100);
    expect(dropsEpicBossToken(60 * 60_000, 100, () => chance - 0.001)).toBe(true);
    expect(dropsEpicBossToken(60 * 60_000, 100, () => chance)).toBe(false);
  });
});

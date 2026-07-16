import { describe, expect, it } from "vitest";
import { farmerCooldownMs, farmerGold, farmerMultiplier, farmerZombieGrowMs } from "./farmer";

describe("priced Farmer head effects", () => {
  it("applies the exact source percentages", () => {
    expect(farmerGold(100, 12)).toBe(110);
    expect(farmerGold(100, 14)).toBe(110);
    expect(farmerZombieGrowMs(1_000, 13)).toBe(750);
    expect(farmerMultiplier(2, "zombieLife")).toBe(1.1);
    expect(farmerMultiplier(6, "zombieLife")).toBe(1.1);
    expect(farmerMultiplier(3, "zombieStrength")).toBe(1.1);
    expect(farmerMultiplier(7, "zombieStrength")).toBe(1.1);
    expect(farmerCooldownMs(1_000, 8)).toBe(750);
    expect(farmerCooldownMs(1_000, 9)).toBe(750);
  });

  it("leaves unrelated and cosmetic heads neutral", () => {
    expect(farmerGold(100, 15)).toBe(100);
    expect(farmerMultiplier(12, "zombieLife")).toBe(1);
  });
});

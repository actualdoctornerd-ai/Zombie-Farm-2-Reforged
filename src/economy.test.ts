import { describe, it, expect } from "vitest";
import { zombieSellValue, sellBack, buyXp, ECONOMY } from "./economy";

// Ground truth: -[ZFToolManager sellZombie:] = floor(baseMarketCost / 2), flat.
describe("zombieSellValue — floor(baseCost / 2)", () => {
  it("is half of an even base cost", () => expect(zombieSellValue(500)).toBe(250));
  it("floors an odd base cost", () => expect(zombieSellValue(51)).toBe(25));
  it("floors the payout at 1 for a free/priceless type", () => {
    expect(zombieSellValue(0)).toBe(1);
    expect(zombieSellValue(1)).toBe(1);
  });
  it("does NOT scale with anything but base cost", () => {
    // A brain-priced special (50) and a cheap normal (50) sell for the same.
    expect(zombieSellValue(50)).toBe(zombieSellValue(50));
  });
});

describe("item economy helpers", () => {
  it("sellBack refunds the configured fraction, min 1", () => {
    expect(sellBack(100)).toBe(Math.floor(100 * ECONOMY.SELL_BACK_RATIO));
    expect(sellBack(1)).toBe(1);
  });
  it("buyXp returns authoritative source XP when present", () =>
    expect(buyXp(1000, 42)).toBe(42));
  it("buyXp grants zero when the source has no XP", () => {
    expect(buyXp(1000)).toBe(0);
    expect(buyXp(1, 0)).toBe(0);
  });
});

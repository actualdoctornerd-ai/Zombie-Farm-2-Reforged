import { describe, expect, it } from "vitest";
import { compactGold } from "./compactNumber";

describe("compactGold", () => {
  it("leaves counts under 100,000 alone", () => {
    expect(compactGold(0)).toBe("0");
    expect(compactGold(400)).toBe("400");
    expect(compactGold(99_999)).toBe("99999");
  });
  it("abbreviates thousands from 100,000, truncating", () => {
    expect(compactGold(100_000)).toBe("100k");
    expect(compactGold(123_999)).toBe("123k");
    expect(compactGold(999_999)).toBe("999k");
  });
  it("abbreviates millions with one truncated decimal", () => {
    expect(compactGold(1_000_000)).toBe("1mil");
    expect(compactGold(1_234_567)).toBe("1.2mil");
    expect(compactGold(1_990_000)).toBe("1.9mil");
    expect(compactGold(12_345_678)).toBe("12.3mil");
  });
  it("abbreviates billions", () => {
    expect(compactGold(2_500_000_000)).toBe("2.5bil");
  });
});

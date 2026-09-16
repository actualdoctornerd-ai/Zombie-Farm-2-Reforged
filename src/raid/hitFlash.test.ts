import { describe, expect, it } from "vitest";
import { HIT_FLASH_SEC, HIT_FLASH_TINT, NO_TINT, hitFlashTint } from "./hitFlash";

describe("hitFlashTint", () => {
  it("is the full wash at the instant of the hit and white once it is spent", () => {
    expect(hitFlashTint(HIT_FLASH_SEC)).toBe(HIT_FLASH_TINT);
    expect(hitFlashTint(0)).toBe(NO_TINT);
    expect(hitFlashTint(-1)).toBe(NO_TINT); // a token stepped past the end
  });

  it("only ever DARKENS — a Pixi tint multiplies, so no channel may exceed 0xff", () => {
    for (let r = HIT_FLASH_SEC; r >= 0; r -= HIT_FLASH_SEC / 20) {
      const tint = hitFlashTint(r);
      for (const shift of [16, 8, 0]) expect((tint >> shift) & 0xff).toBeLessThanOrEqual(0xff);
      expect((tint >> 16) & 0xff).toBe(0xff); // red is untouched: this is a red wash
    }
  });

  it("eases out — the wash is monotonically weaker as the remaining time falls", () => {
    let prevGreen = -1;
    for (let k = 0; k <= 1.0001; k += 0.1) {
      const green = (hitFlashTint(HIT_FLASH_SEC * (1 - k)) >> 8) & 0xff;
      expect(green).toBeGreaterThan(prevGreen);
      prevGreen = green;
    }
    expect(prevGreen).toBe(0xff); // and lands exactly on no-tint
  });

  it("clamps a wash re-armed mid-fade rather than overshooting", () => {
    expect(hitFlashTint(HIT_FLASH_SEC * 2)).toBe(HIT_FLASH_TINT);
  });
});

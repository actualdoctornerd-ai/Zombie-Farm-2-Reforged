import { describe, expect, it } from "vitest";
import { DEFAULT_ZOMBIE_EYE_TINT, zombiePartTint } from "./appearance";

describe("zombie appearance", () => {
  it("keeps default eyes light yellow while other tintable parts use the body color", () => {
    expect(zombiePartTint("defaultEyeL", 0x123456)).toBe(DEFAULT_ZOMBIE_EYE_TINT);
    expect(zombiePartTint("defaultEyeR.png", 0x123456)).toBe(DEFAULT_ZOMBIE_EYE_TINT);
    expect(zombiePartTint("defaultHead", 0x123456)).toBe(0x123456);
  });
});

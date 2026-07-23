import { describe, expect, it } from "vitest";
import { multiplyObjectTint, objectTint } from "./assets";

describe("placeable object tint", () => {
  it("packs the original Market RGB channels for Pixi", () => {
    expect(objectTint([153, 153, 255])).toBe(0x9999ff);
    expect(objectTint([169, 100, 54])).toBe(0xa96436);
    expect(objectTint()).toBe(0xffffff);
  });

  it("combines an authored tint with the placement-state wash", () => {
    expect(multiplyObjectTint(0x9999ff, 0x9cffa0)).toBe(0x5e99a0);
    expect(multiplyObjectTint(0xffffff, 0xff8a8a)).toBe(0xff8a8a);
  });
});

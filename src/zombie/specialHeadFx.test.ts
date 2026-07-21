import { describe, expect, it } from "vitest";
import { specialHeadFxKind } from "./specialHeadFx";

describe("special head effects", () => {
  it("puts the red-core aura on Kindlehead", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier2")).toBe("kindle");
  });

  it("puts the blue-core aura on Flamehead", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier3")).toBe("flame");
  });

  it("puts confetti on Party Zombie", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier4")).toBe("confetti");
  });

  it("does not decorate other headless tiers", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier1")).toBeNull();
  });
});

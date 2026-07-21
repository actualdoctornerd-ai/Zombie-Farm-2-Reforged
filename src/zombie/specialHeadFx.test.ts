import { describe, expect, it } from "vitest";
import { specialHeadFxKind } from "./specialHeadFx";

describe("special head effects", () => {
  it("puts fire on Kindlehead", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier2")).toBe("fire");
  });

  it("puts confetti on Party Zombie", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier4")).toBe("confetti");
  });

  it("does not decorate other headless tiers", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier3")).toBeNull();
  });
});

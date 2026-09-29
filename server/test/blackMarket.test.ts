import { describe, expect, it } from "vitest";
import { matchesMutationRequirement } from "../src/v3/blackMarket";
import { blackMarketFilterKeys } from "../src/rosterCatalog";

describe("Black Market mutation matching", () => {
  it("ORs alternatives in one slot", () => {
    const broccoliOrCauliflower = 128 | 512;
    expect(matchesMutationRequirement(128, 1, broccoliOrCauliflower)).toBe(true);
    expect(matchesMutationRequirement(512, 1, broccoliOrCauliflower)).toBe(true);
    expect(matchesMutationRequirement(4, 1, broccoliOrCauliflower)).toBe(false);
  });

  it("ANDs requirements across different slots", () => {
    const carrotEyesAndTurnipArm = 4 | 8;
    expect(matchesMutationRequirement(4, 1, carrotEyesAndTurnipArm)).toBe(false);
    expect(matchesMutationRequirement(8, 1, carrotEyesAndTurnipArm)).toBe(false);
    expect(matchesMutationRequirement(4 | 8 | 1024, 1, carrotEyesAndTurnipArm)).toBe(true);
  });

  it("preserves broad any-mutation and no-mutation requests", () => {
    expect(matchesMutationRequirement(4, 1, null)).toBe(true);
    expect(matchesMutationRequirement(0, 0, null)).toBe(true);
    expect(matchesMutationRequirement(16384, 0, null, 16384)).toBe(true);
    expect(matchesMutationRequirement(16384 | 4, 0, null, 16384)).toBe(false);
    expect(matchesMutationRequirement(0, 1, null)).toBe(false);
  });
});

describe("Black Market browse filters", () => {
  it("resolves each axis to catalog keys and intersects the two", () => {
    const green = blackMarketFilterKeys("Green", undefined) ?? [];
    expect(green).toContain("ZombieActorRegularTier1");
    expect(green).not.toContain("ZombieActorRegularTier2");

    const garden = blackMarketFilterKeys(undefined, "Garden") ?? [];
    expect(garden).toContain("ZombieActorGardenTier1");
    expect(garden).not.toContain("ZombieActorRegularTier1");

    const greenGarden = blackMarketFilterKeys("Green", "Garden") ?? [];
    expect(greenGarden).toEqual(green.filter((key) => garden.includes(key)));
    expect(greenGarden).toContain("ZombieActorGardenTier1");
  });

  it("files the tier-less uniques under Special", () => {
    const special = blackMarketFilterKeys("Special", undefined) ?? [];
    expect(special).toContain("ZombieActorRegularCrazy");
    expect(special).toContain("ZombieActorGardenCupid");
  });

  it("ignores unset and unrecognized values without dropping the other axis", () => {
    expect(blackMarketFilterKeys(undefined, undefined)).toBeNull();
    expect(blackMarketFilterKeys("Chartreuse", "Wobbly")).toBeNull();
    expect(blackMarketFilterKeys("Chartreuse", "Garden"))
      .toEqual(blackMarketFilterKeys(undefined, "Garden"));
  });
});

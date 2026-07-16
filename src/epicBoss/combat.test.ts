import { describe, expect, it } from "vitest";
import { DR_GROUNDHOG } from "./catalog";
import { rollEpicBossLoot } from "./combat";

describe("Epic Boss fallback loot", () => {
  it("unlocks source rewards by defeated level and prefers missing rewards", () => {
    expect(rollEpicBossLoot(DR_GROUNDHOG, 1, new Set(), () => 0)).toBeNull();
    expect(rollEpicBossLoot(DR_GROUNDHOG, 2, new Set(), () => 0)?.name).toContain("Evil Device");
    const owned = new Set(["Dr. Groundhog's Evil Device"]);
    expect(rollEpicBossLoot(DR_GROUNDHOG, 4, owned, () => 0)?.name).toContain("Tricycle");
  });

  it("does not duplicate the pet once collected", () => {
    const owned = new Set(DR_GROUNDHOG.loot.map((loot) => loot.name));
    const result = rollEpicBossLoot(DR_GROUNDHOG, 20, owned, () => 0);
    expect(result?.stageActor).toBeUndefined();
  });
});

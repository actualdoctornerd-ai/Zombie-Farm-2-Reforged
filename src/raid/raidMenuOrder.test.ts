import { describe, expect, it } from "vitest";
import raidsJson from "../../public/assets/raids/raids.json";
import { compareRaidMenuOrder } from "./raidMenuOrder";
import type { RaidDef } from "./types";

describe("invasion menu order", () => {
  it("places seasonal invasions at their progression positions", () => {
    const names = (raidsJson as unknown as RaidDef[])
      .filter((raid) => raid.playable)
      .sort(compareRaidMenuOrder)
      .map((raid) => raid.name);
    expect(names.slice(0, 5)).toEqual([
      "Old McDonnell's Farm",
      "Valentine's Day",
      "Tree World",
      "Summer Break",
      "Zombies vs Circus",
    ]);
  });

  it("uses recommended level and id as deterministic tie-breakers", () => {
    const rows = [
      { id: 3, unlockLevel: 5, recommendedLevel: 8 },
      { id: 2, unlockLevel: 5, recommendedLevel: 6 },
      { id: 1, unlockLevel: 5, recommendedLevel: 6 },
    ];
    expect(rows.sort(compareRaidMenuOrder).map((row) => row.id)).toEqual([1, 2, 3]);
  });
});

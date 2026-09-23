// A dual invasion is fought on a SHIPPED raid's stage, and has to look like it.
//
// Raids 12-15 borrow raid 2/4/8/6's backdrop, parallax layers, perch structure and boss
// wholesale (tools/prep_raids.py DUAL_INVASIONS). Every per-raid PRESENTATION correction
// the client keeps is keyed by raid id and eyeballed against the real game, so a borrowed
// stage that does not also borrow those corrections renders visibly wrong — and renders,
// which means nothing failed and nothing was logged. That is what these pin.
//
// Measured before the fix, in the Raid Lab: raid 12's Lawyer boss sat at perch fraction
// 0.14 where raid 2's sits at 0.46 — a third of the screen height above the roof he is
// supposed to be standing behind. All four were wrong, each by exactly its source raid's
// correction, and raid 14 had also lost the Circus trapeze.
import { describe, expect, it } from "vitest";
import { stageRaidId } from "./RaidCatalog";
import { DUAL_INVASION_IDS } from "./dualInvasion";
import { grabberFor } from "./fightConfig";
import raidsJson from "../../public/assets/raids/raids.json";
import type { RaidDef } from "./types";

const raids = raidsJson as RaidDef[];
const byId = new Map(raids.map((r) => [r.id, r]));
const duals = raids.filter((r) => (DUAL_INVASION_IDS as readonly number[]).includes(r.id));
/** The stage a raid's top rung fights — which is the one a dual invasion copied. */
const lastStage = (raid: RaidDef) => raid.stages[raid.stages.length - 1];

describe("a borrowed stage", () => {
  it("names the raid it borrowed, and only a borrower does", () => {
    expect(duals).toHaveLength(DUAL_INVASION_IDS.length);
    for (const raid of duals) {
      expect(raid.stageOf, `raid ${raid.id} says whose stage it is on`).toBeGreaterThan(0);
      expect(byId.has(raid.stageOf!), `raid ${raid.id}: stage raid exists`).toBe(true);
      expect(raid.stageOf).not.toBe(raid.id);
    }
    // An authored invasion is its own stage. `stageRaidId` must be an identity for all
    // eleven of them, or every presentation table it now keys would move at once.
    for (const raid of raids.filter((r) => r.stageOf === undefined)) {
      expect(stageRaidId(raid)).toBe(raid.id);
    }
  });

  it("really is the same scene: same backdrop, same layers, same boss", () => {
    // The assertion behind the whole mechanism. If a dual invasion ever stops being a
    // pixel-for-pixel copy of its source's stage, keying its corrections to that source
    // becomes wrong and this test is where that argument breaks first.
    for (const raid of duals) {
      const source = byId.get(stageRaidId(raid))!;
      expect(raid.levelAssets, `raid ${raid.id} parallax layers`).toEqual(source.levelAssets);
      expect(raid.music, `raid ${raid.id} theme`).toBe(source.music);
      expect(raid.stages[0].bossKey, `raid ${raid.id} boss`).toBe(lastStage(source).bossKey);
    }
  });

  it("inherits the grab hazard exactly where the stage has one", () => {
    // Keyed on `raid.id` this answered null for raid 14, silently deleting the trapeze
    // from a fight whose stage is built around it.
    for (const raid of duals) {
      const source = byId.get(stageRaidId(raid))!;
      const mine = grabberFor(raid);
      const theirs = grabberFor(source);
      expect(mine, `raid ${raid.id} vs its stage (${source.id})`).toEqual(theirs);
    }
    expect(grabberFor(byId.get(14)!), "the Circus stage really does have one").not.toBeNull();
  });

  it("does NOT inherit anything that decides the fight", () => {
    // `stageRaidId` is for presentation alone. A borrowed stage inherits how it looks,
    // never how it plays — route the wave, the cadence, the ladder or the rewards through
    // it and a dual invasion quietly adopts another raid's balance.
    for (const raid of duals) {
      const source = byId.get(stageRaidId(raid))!;
      expect(raid.recommendedLevel).toBeGreaterThan(source.recommendedLevel);
      // The WAVE, not just its table: raid 15 fields the same alien minion its source
      // does and half as many of them, so the composition has to be compared whole.
      expect({
        weighted: raid.stages[0].weighted, population: raid.stages[0].population,
      }).not.toEqual({
        weighted: lastStage(source).weighted, population: lastStage(source).population,
      });
      expect(raid.name).not.toBe(source.name);
    }
  });
});

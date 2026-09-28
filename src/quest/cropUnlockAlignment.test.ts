import { describe, expect, it } from "vitest";
import plants from "../../public/assets/plants.json";
import quests from "../../public/assets/quests.json";
import zombies from "../../public/assets/zombies.json";
import { XP_THRESHOLDS } from "../GameState";
import { cropMutationBits } from "../zombie/cropMutations";

// The crop rebalance (tools/reforge_economy.py CROP_REBALANCE) respreads the 25
// regular crops over levels 1-45. Two invariants have to hold for that ladder to
// be playable, and both were violated at some point while designing it:
//
//   1. Nothing unlocks above the level cap. The first draft put the capstone crop
//      at level 50, which no account can ever reach.
//   2. No quest asks for a crop that unlocks after the quest itself does, or the
//      quest sits on the rail as an impossible objective.
//
// Neither is expressible in plants.json alone, so they live here.

const LEVEL_CAP = XP_THRESHOLDS.length;

/** Quest requirement kinds whose `notificationObject` names a crop. */
const CROP_EVENTS = new Set([
  "kCropPlantedNotification",
  "kCropHarvestedNotification",
  "kCropHarvestedZombieNotification",
]);

interface QuestDef {
  title: string;
  levelRequired: number;
  prerequisiteQuest: number;
  seasonal: boolean;
  epicEvent: boolean;
  requirements: { notificationID: string; notificationObject: string }[];
}
const QUESTS = quests as unknown as Record<string, QuestDef>;

const cropByName = new Map(plants.map((p) => [p.name.toLowerCase(), p]));

/** The level a quest actually becomes available at. `levelRequired: -1` means
 *  "inherit", so the real gate is the highest requirement in the prerequisite
 *  chain — reading the field alone reports a gate that is too low. */
function effectiveGate(id: string, seen = new Set<string>()): number {
  const q = QUESTS[id];
  if (!q || seen.has(id)) return 0;
  seen.add(id);
  const own = q.levelRequired > 0 ? q.levelRequired : 0;
  const prereq = String(q.prerequisiteQuest);
  return QUESTS[prereq] ? Math.max(own, effectiveGate(prereq, seen)) : own;
}

describe("crop unlock ladder", () => {
  it("never unlocks a crop above the level cap", () => {
    expect(LEVEL_CAP).toBe(45);
    for (const p of plants) {
      expect.soft(p.level, `${p.key} unlocks at ${p.level}, cap is ${LEVEL_CAP}`)
        .toBeLessThanOrEqual(LEVEL_CAP);
    }
  });

  it("tops out exactly at the cap, so the last level still unlocks something", () => {
    const regular = plants.filter((p) => !p.seasonal);
    expect(Math.max(...regular.map((p) => p.level))).toBe(LEVEL_CAP);
  });

  it("unlocks at most two regular crops on any one level", () => {
    const perLevel = new Map<number, string[]>();
    for (const p of plants.filter((x) => !x.seasonal)) {
      perLevel.set(p.level, [...(perLevel.get(p.level) ?? []), p.key]);
    }
    for (const [level, keys] of perLevel) {
      expect.soft(keys.length, `level ${level}: ${keys.join(", ")}`).toBeLessThanOrEqual(2);
    }
  });
});

describe("quest gates match crop unlocks", () => {
  it("never asks for a crop that unlocks after the quest becomes available", () => {
    let checked = 0;
    for (const [id, q] of Object.entries(QUESTS)) {
      // Seasonal and epic-event quests run on their own schedules, and seasonal
      // crops are excluded from the rebalance, so neither is in scope here.
      if (q.seasonal || q.epicEvent) continue;
      const gate = effectiveGate(id);
      for (const req of q.requirements ?? []) {
        if (!CROP_EVENTS.has(req.notificationID)) continue;
        // "" is the format's wildcard ("harvest any 15 crops").
        const crop = cropByName.get((req.notificationObject || "").trim().toLowerCase());
        // Requirements naming a zombie or a tree are gated by their own catalogs.
        if (!crop || crop.seasonal) continue;
        checked++;
        expect.soft(
          crop.level,
          `quest ${id} "${q.title}" opens at level ${gate} but needs ${crop.key} (level ${crop.level})`,
        ).toBeLessThanOrEqual(gate);
      }
    }
    // Guards the guard: a rename in either file would otherwise make every
    // lookup miss and leave this test asserting nothing at all.
    expect(checked).toBeGreaterThanOrEqual(14);
  });
});

// The market mutant is the pre-mutated unit; planting any zombie beside the
// matching crop is the other route to the same mutation. Reforged unlocks the
// mutant AHEAD of its crop so buying one is the only early access to that
// mutation — but it also carries a tier-graded body, so how far ahead it can
// sit is bounded from two directions. See tools/reforge_economy.py.
const MAX_LEAD = 5;

interface ZombieRow {
  key: string; name: string; level: number; tier: number;
  category: string; className: string; mutation?: number;
}
const ZOMBIES = zombies as unknown as ZombieRow[];
const mutants = ZOMBIES.filter((z) => z.category === "mutant");

/** Earliest crop level that can grow a given mutation bit. Tier-4 crops reuse a
 *  lower tier's bit, so a bit can have more than one crop. */
function earliestCropFor(bit: number): number | null {
  const levels = plants
    .filter((p) => cropMutationBits(p.key).includes(bit))
    .map((p) => p.level);
  return levels.length ? Math.min(...levels) : null;
}

describe("market mutants vs the crops that grow their mutation", () => {
  it("never unlocks a mutant more than five levels before its crop", () => {
    expect(mutants).toHaveLength(15);
    for (const m of mutants) {
      const crop = earliestCropFor(m.mutation ?? 0);
      expect(crop, `${m.name} carries bit ${m.mutation}, which no crop grows`).not.toBeNull();
      expect.soft(
        crop! - m.level,
        `${m.name} unlocks at ${m.level}, ${crop! - m.level} levels before its crop (${crop})`,
      ).toBeLessThanOrEqual(MAX_LEAD);
    }
  });

  it("keeps the mutant tier bands ordered and non-overlapping", () => {
    const bands = new Map<number, number[]>();
    for (const m of mutants) bands.set(m.tier, [...(bands.get(m.tier) ?? []), m.level]);
    const tiers = [...bands.keys()].sort((a, b) => a - b);
    for (let i = 1; i < tiers.length; i++) {
      const prevMax = Math.max(...bands.get(tiers[i - 1])!);
      const thisMin = Math.min(...bands.get(tiers[i])!);
      expect.soft(
        thisMin,
        `tier ${tiers[i]} mutants start at ${thisMin}, before tier ${tiers[i - 1]} ends at ${prevMax}`,
      ).toBeGreaterThan(prevMax);
    }
  });

  it("keeps each mutant's colour class and tier number in agreement", () => {
    // Both are overridden together in tools/reforge_economy.py
    // (MUTANT_CLASS_REBALANCE) and mean different things at runtime: the class
    // decides ability-tier access and the Black Market gate, the number decides
    // fertilize chance and Zombie Pot species selection. If they ever drift, a
    // zombie reads as one tier and behaves as another.
    const CLASS_FOR_TIER: Record<number, string> = { 1: "Green", 2: "Blue", 3: "Red", 4: "Silver", 5: "Special" };
    for (const m of mutants) {
      expect.soft(
        m.className,
        `${m.name} is tier ${m.tier} but wears ${m.className}`,
      ).toBe(CLASS_FOR_TIER[m.tier]);
    }
  });

  it("puts every mutant in a colour band the ordinary zombies also occupy there", () => {
    // A mutant should not wear a colour the player has not started seeing yet.
    const ordinary = ZOMBIES.filter((z) => z.category === "normal");
    for (const m of mutants) {
      const sameColour = ordinary.filter((z) => z.className === m.className).map((z) => z.level);
      if (!sameColour.length) continue;
      expect.soft(
        m.level,
        `${m.name} is ${m.className} at level ${m.level}, but ordinary ${m.className}s only start at ${Math.min(...sameColour)}`,
      ).toBeGreaterThanOrEqual(Math.min(...sameColour));
    }
  });

  it("never sells a mutant before the ordinary zombies of its own tier", () => {
    const ordinary = ZOMBIES.filter((z) => z.category === "normal");
    for (const m of mutants) {
      const peers = ordinary.filter((z) => z.tier === m.tier).map((z) => z.level);
      if (!peers.length) continue;
      expect.soft(
        m.level,
        `${m.name} (tier ${m.tier}) unlocks at ${m.level}, before its ordinary tier opens at ${Math.min(...peers)}`,
      ).toBeGreaterThanOrEqual(Math.min(...peers));
    }
  });
});

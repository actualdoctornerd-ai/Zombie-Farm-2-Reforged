// The Reforged-original achievements: the authored catalog itself, and the invariants
// that keep it from quietly breaking the imported one.
import { describe, it, expect } from "vitest";
import imported from "../../public/assets/quests.json";
import reforged from "../../public/assets/quests_reforged.json";
import raids from "../../public/assets/raids/raids.json";
import plants from "../../public/assets/plants.json";
import { GAUGE_NOTIFICATION } from "./questProgress";
import { QuestEvent } from "./events";
import { questBonusRewardInfo, questRewardInfo } from "./types";
import { ABILITY_SUBJECT, EXPLODED_MINI_SUBJECT } from "../raid/featQuestEvents";
import { RARE_INVASION_ZOMBIE_SUBJECT } from "../raid/zombieDrops";

type Quest = (typeof reforged)[keyof typeof reforged];
const QUESTS = Object.entries(reforged) as [string, Quest][];
const LIVE = new Set<string>(Object.values(QuestEvent));

describe("reforged achievement catalog", () => {
  it("collides with no imported quest id", () => {
    const importedIds = new Set(Object.keys(imported));
    for (const [id] of QUESTS) expect(importedIds.has(id), id).toBe(false);
  });

  // The four-slot rail sorts by numeric id, so this is what guarantees an achievement
  // the player is ignoring can never push the next authored progression quest off it.
  it("sorts after every imported quest, so the rail keeps showing progression", () => {
    const highestImported = Math.max(...Object.keys(imported).map(Number));
    for (const [id] of QUESTS) expect(Number(id), id).toBeGreaterThan(highestImported);
  });

  it("keys each record by its own id", () => {
    for (const [id, quest] of QUESTS) expect(quest.id).toBe(id);
  });

  it("listens only to events that have a live emitter", () => {
    for (const [id, quest] of QUESTS) {
      for (const requirement of quest.requirements) {
        // A gauge reads the farm instead of listening (quest/questProgress.ts), and must
        // name a reading that exists.
        if ((requirement as { gauge?: string }).gauge) {
          expect(requirement.notificationID, id).toBe(GAUGE_NOTIFICATION);
          expect(["uniqueItemsPlaced", "almanacZombies"]).toContain((requirement as { gauge?: string }).gauge);
          continue;
        }
        expect(LIVE.has(requirement.notificationID), `${id}: ${requirement.notificationID}`).toBe(true);
      }
    }
  });

  it("names only subjects something actually posts", () => {
    const raidNames = new Set((raids as { name: string }[]).map((raid) => raid.name));
    const abilitySubjects = new Set(Object.values(ABILITY_SUBJECT));
    // A crop harvest posts the plant's display name (server/src/v3/engine.ts harvestPlot).
    const cropNames = new Set((plants as { name: string }[]).map((plant) => plant.name));
    for (const [id, quest] of QUESTS) {
      for (const requirement of quest.requirements) {
        const subject = requirement.notificationObject;
        if (!subject) continue; // wildcard
        const known =
          (requirement.notificationID === QuestEvent.CropHarvested && cropNames.has(subject)) ||
          raidNames.has(subject) ||
          abilitySubjects.has(subject) ||
          subject === RARE_INVASION_ZOMBIE_SUBJECT ||
          subject === EXPLODED_MINI_SUBJECT;
        expect(known, `${id} names an unpostable subject: "${subject}"`).toBe(true);
      }
    }
  });

  it("gates every quest behind a level and a reachable prerequisite", () => {
    const ids = new Set(QUESTS.map(([id]) => id));
    for (const [id, quest] of QUESTS) {
      expect(quest.levelRequired, id).toBeGreaterThan(0);
      expect(quest.levelRequired, id).toBeLessThanOrEqual(45);
      if (quest.prerequisiteQuest < 0) continue;
      const prerequisite = String(quest.prerequisiteQuest);
      expect(ids.has(prerequisite), `${id} needs ${prerequisite}`).toBe(true);
      // A prerequisite gated ABOVE its dependant would make the chain unreachable in
      // the order it reads — the successor would unlock before the quest it follows.
      const parent = reforged[prerequisite as keyof typeof reforged];
      expect(parent.levelRequired, `${id} unlocks before its prerequisite`)
        .toBeLessThanOrEqual(quest.levelRequired);
    }
  });

  it("pays XP, with a brain only on the hardest rungs", () => {
    const withBrains = QUESTS.filter(([, quest]) => (quest as { rewardBrains?: number }).rewardBrains);
    expect(withBrains.length).toBe(6);
    for (const [id, quest] of QUESTS) {
      // Omni-Farmer is the one exception (owner, 2026-11-11): 100k gold, the 90x90 farm and
      // the Green Flower Ticket. Pinned in quest/omniFarmer.test.ts.
      if (id === "20018") continue;
      expect(quest.rewardType, id).toBe(0); // XP
      expect(quest.rewardValue, id).toBeGreaterThan(0);
      const brains = (quest as { rewardBrains?: number }).rewardBrains ?? 0;
      expect(brains, id).toBeLessThanOrEqual(1);
      // A brain rung must also be one of the late, expensive ones — otherwise the
      // scarcest currency in the game leaks out of an early quest.
      if (brains) expect(quest.levelRequired, id).toBeGreaterThanOrEqual(15);
    }
  });

  // ONE policy governs both catalogs, and it is NOT a share-of-a-level band.
  //
  // The band rule priced a quest from `levelRequired` alone and never looked at how
  // much work the objective asked for. That is invisible while every quest wants a
  // handful of actions, and absurd once one wants hundreds: a 500-plow achievement
  // gated at level 8 paid 75 XP while a 250-plow quest gated at 27 paid 750 — twice
  // the work for a tenth of the reward, and both "inside the bands".
  //
  // What actually has to hold is DOMINANCE: within a category, no quest may pay less
  // total XP than one that unlocks no later AND asks for no more actions. That is
  // strictly weaker than "XP per action must rise with level" — which is unsatisfiable,
  // since a 3-action quest always beats a 30-action one per action unless payouts scale
  // linearly — but it is exactly strong enough to catch a work/pay inversion.
  const CATEGORY: Record<string, string> = {
    kSoilPlowedNotification: "plowing", kNewSoilPlowedNotification: "plowing",
    kCropPlantedNotification: "planting", kCropHarvestedNotification: "crop harvest",
    kCropHarvestedZombieNotification: "zombie harvest",
    kItemBoughtNotification: "buying",
    kCombinerCombinedNotification: "combining",
    kCombinerHarvestedNotification: "combining",
    kCombinerCollectedNotification: "combining",
    kInvasionSuccessfulNotification: "invasion",
    kInvasionPerfectGameNotification: "invasion",
    kEliteInvasionSuccessfulNotification: "invasion",
    kElitePerfectGameNotification: "invasion",
    kLootItemWonNotification: "invasion loot",
    kEnemyDefeatedByAbilityNotification: "combat feat",
    kBossDefeatedByAbilityNotification: "combat feat",
    kZombieResurrectedNotification: "combat feat",
  };

  // Buying is deliberately exempt. Its objectives cost GOLD, which is the real effort
  // and is invisible to a count of actions — "buy 2 Zen Garden pieces" is a bigger ask
  // than two hundred plows. Judging it on actions alone would flag the whole category.
  const UNPRICED_BY_ACTION = new Set(["buying"]);

  type Priced = {
    id: string; title: string; category: string;
    level: number; actions: number; xp: number; prerequisite: number;
  };

  type CatalogQuest = {
    id: string; title: string; rewardType: number; rewardValue: number;
    levelRequired: number; prerequisiteQuest: number; epicEvent: boolean; seasonal: boolean;
    requirements: { notificationID: string; notificationObject?: string; countTotal: number }[];
  };
  const ALL: Record<string, CatalogQuest> = {
    ...(imported as unknown as Record<string, CatalogQuest>),
    ...(reforged as unknown as Record<string, CatalogQuest>),
  };

  // A quest's real gate is the highest in its prerequisite chain, not its own field:
  // quest 22 ships `levelRequired: -1` but follows quest 21, which is gated at 25.
  const effectiveLevel = (id: string, seen = new Set<string>()): number => {
    const quest = ALL[id];
    if (!quest || seen.has(id)) return 1;
    seen.add(id);
    const own = Math.max(1, quest.levelRequired);
    return quest.prerequisiteQuest >= 0
      ? Math.max(own, effectiveLevel(String(quest.prerequisiteQuest), seen))
      : own;
  };

  const priced: Priced[] = [];
  for (const [id, quest] of Object.entries(ALL)) {
    if (quest.rewardType !== 0 || quest.epicEvent || quest.seasonal || !quest.rewardValue) continue;
    const categories = new Set(quest.requirements.map((r) => CATEGORY[r.notificationID]));
    if (categories.size !== 1) continue; // mixed-objective quests have no single yardstick
    const [category] = [...categories];
    if (!category || UNPRICED_BY_ACTION.has(category)) continue;
    priced.push({
      id, title: quest.title, category,
      level: effectiveLevel(id),
      actions: quest.requirements.reduce((n, r) => n + r.countTotal, 0),
      xp: quest.rewardValue,
      prerequisite: quest.prerequisiteQuest,
    });
  }

  it("never pays less for strictly more work (the dominance invariant)", () => {
    const failures: string[] = [];
    for (const quest of priced) {
      for (const other of priced) {
        if (other.id === quest.id || other.category !== quest.category) continue;
        // A chain successor legitimately out-pays its own prerequisite at the same
        // gate — that is the chain advancing, not an inversion.
        if (quest.prerequisite === Number(other.id) || other.prerequisite === Number(quest.id)) continue;
        if (other.level <= quest.level && other.actions <= quest.actions && other.xp > quest.xp) {
          failures.push(
            `${quest.category}: ${quest.id} "${quest.title}" (level ${quest.level}, ` +
            `${quest.actions} actions) pays ${quest.xp} XP, but ${other.id} "${other.title}" ` +
            `(level ${other.level}, ${other.actions} actions) pays ${other.xp}`
          );
        }
      }
    }
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  // Dominance alone is NOT enough. It orders two quests only when one is worse on
  // both axes, and the original bug was worse on neither: Groundskeeper asked 500
  // plows at level 8 while Live Laugh Plow asked 250 at level 27 — more work at an
  // EARLIER gate, so neither dominates and the inversion slips through.
  //
  // The check that catches that shape compares XP PER ACTION down a single ladder:
  // same event, same wildcard-vs-named subject, so the actions really are the same
  // deed. As the gate rises the rate must not collapse.
  //
  // Two exclusions keep it honest rather than noisy:
  //   - countTotal 1 is a milestone ("win an elite invasion"), priced for the EVENT.
  //     Against a grind quest it always looks better per action and means nothing.
  //   - multi-objective quests have no single per-action rate to speak of.
  // TOLERANCE exists because the ladder is hand-authored, not computed: a rung may
  // sit slightly under the one before it (Plow Now Brown Cow is 10% under It's Plow
  // Or Never) without anything being wrong. A real inversion is far larger — the
  // shipped Groundskeeper paid 62% under the rung below it.
  const RATE_TOLERANCE = 0.25;

  it("never lets XP-per-action collapse as the gate rises on one ladder", () => {
    const ladders = new Map<string, Priced[]>();
    for (const [id, quest] of Object.entries(ALL)) {
      if (quest.rewardType !== 0 || quest.epicEvent || quest.seasonal || !quest.rewardValue) continue;
      if (quest.requirements.length !== 1) continue;
      const [requirement] = quest.requirements;
      if (requirement.countTotal < 2) continue;
      const subject = (requirement as { notificationObject?: string }).notificationObject;
      const key = `${requirement.notificationID}:${subject ? "named" : "any"}`;
      const rung: Priced = {
        id, title: quest.title, category: key,
        level: effectiveLevel(id), actions: requirement.countTotal,
        xp: quest.rewardValue, prerequisite: quest.prerequisiteQuest,
      };
      ladders.set(key, [...(ladders.get(key) ?? []), rung]);
    }

    const failures: string[] = [];
    for (const [key, rungs] of ladders) {
      rungs.sort((a, b) => a.level - b.level);
      let best = 0;
      let bestRung: Priced | undefined;
      for (const rung of rungs) {
        const rate = rung.xp / rung.actions;
        if (bestRung && rate < best * (1 - RATE_TOLERANCE)) {
          failures.push(
            `${key}: ${rung.id} "${rung.title}" (level ${rung.level}, ${rung.actions} ` +
            `actions, ${rung.xp} XP) pays ${rate.toFixed(2)}/action, far under the ` +
            `${best.toFixed(2)}/action set by "${bestRung.title}" at level ${bestRung.level}`
          );
        }
        if (rate > best) { best = rate; bestRung = rung; }
      }
    }
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("covers the categories the invariant is meant to police", () => {
    // A typo in CATEGORY would silently empty the check rather than fail it.
    const categories = new Set(priced.map((q) => q.category));
    expect(categories).toContain("plowing");
    expect(categories).toContain("crop harvest");
    expect(categories).toContain("invasion");
    expect(categories).toContain("combining");
    expect(priced.length).toBeGreaterThan(25);
  });

  // The floor still matters on its own: levels 1-7 need 25-250 XP in total, so a
  // percentage-derived reward there would round to single digits.
  it("never pays less than the 20 XP floor", () => {
    for (const [id, quest] of Object.entries(ALL)) {
      if (quest.rewardType !== 0 || quest.epicEvent || !quest.rewardValue) continue;
      expect(quest.rewardValue, `${id} "${quest.title}"`).toBeGreaterThanOrEqual(20);
    }
  });

  it("scales the payout with the gate", () => {
    const sorted = [...QUESTS].sort((a, b) => a[1].levelRequired - b[1].levelRequired);
    const first = sorted[0][1];
    const last = sorted[sorted.length - 1][1];
    expect(last.rewardValue).toBeGreaterThan(first.rewardValue);
  });

  it("surfaces both reward lines to the HUD", () => {
    const legend = reforged["20005"];
    expect(questRewardInfo(legend)?.label).toBe("+400 XP");
    expect(questBonusRewardInfo(legend)?.label).toBe("+1 Brain");
    // An imported quest has no bonus line at all.
    expect(questBonusRewardInfo({ rewardBrains: undefined })).toBeNull();
  });

  it("asks the Flawless Tour for every stage of the main ladder", () => {
    const tour = reforged["20014"];
    const ladder = (raids as { id: number; name: string; playable: boolean }[])
      .filter((raid) => raid.id >= 1 && raid.id <= 6)
      .map((raid) => raid.name);
    expect(tour.requirements.map((r) => r.notificationObject).sort()).toEqual([...ladder].sort());
  });
});

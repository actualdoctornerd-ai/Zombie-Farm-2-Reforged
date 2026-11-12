// Omni-Farmer (owner, 2026-11-11): the level-44 quest that unlocks the 90x90 farm.
// Pins the authored quest to what was asked for and to the farm tier it opens.
import { describe, expect, it } from "vitest";
import reforged from "../../public/assets/quests_reforged.json";
import plants from "../../public/assets/plants.json";
import upgrades from "../../public/assets/upgrades.json";
import zombies from "../../public/assets/zombies.json";
import boosts from "../../public/assets/boosts.json";
import { OMNI_FARMER_EXPANSION_SIZE, OMNI_FARMER_PRIZE_ZOMBIE, OMNI_FARMER_QUEST_ID, omniAlmanacClassifier, omniFarmerUnlocked } from "./omniFarmer";
import { GAUGE_NOTIFICATION } from "./questProgress";

type Req = { notificationID: string; notificationObject: string; countTotal: number; gauge?: string; sweep?: boolean };
const quest = (reforged as Record<string, {
  title: string; levelRequired: number; requirements: Req[];
  sweep?: { each: number; best: number }; rewardUnlock?: string;
}>)[OMNI_FARMER_QUEST_ID];

describe("Omni-Farmer", () => {
  it("is the level-44 quest of that name", () => {
    expect(quest.title).toBe("Omni-Farmer");
    expect(quest.levelRequired).toBe(44);
    expect(quest.rewardUnlock).toMatch(/90/);
  });

  it("asks for 50 different items placed and 50 Almanac zombies, any mix of basic and special", () => {
    const gauges = quest.requirements.filter((r) => r.gauge);
    expect(gauges.map((r) => [r.gauge, r.countTotal])).toEqual([
      ["uniqueItemsPlaced", 50],
      ["almanacZombies", 50],
    ]);
    for (const r of gauges) expect(r.notificationID).toBe(GAUGE_NOTIFICATION);
  });

  it("asks for 5 elite invasion wins, any invasion", () => {
    const wins = quest.requirements.filter((r) => r.notificationID.includes("Invasion"));
    expect(wins.map((r) => [r.notificationID, r.notificationObject, r.countTotal]))
      .toEqual([["kEliteInvasionSuccessfulNotification", "", 5]]);
  });

  it("sweeps exactly the crops unlocked by level 44 — no seasonal, prize or zombie crops", () => {
    const expected = (plants as { name: string; level: number; seasonal?: boolean; prize?: boolean }[])
      .filter((p) => !p.seasonal && !p.prize && p.level >= 1 && p.level <= 44)
      .map((p) => p.name)
      .sort();
    const members = quest.requirements.filter((r) => r.sweep);
    expect(members.map((r) => r.notificationObject).sort()).toEqual(expected);
    expect(members.length).toBe(24);
    for (const r of members) {
      // Ordinary crops only: zombie crops post kCropHarvestedZombieNotification.
      expect(r.notificationID).toBe("kCropHarvestedNotification");
      expect(r.countTotal).toBe(quest.sweep!.best);
    }
    expect(quest.sweep).toMatchObject({ each: 5, best: 500 });
  });

  it("opens the 90x90 tier, priced flat at the 80x80's 4M gold / 30 brains", () => {
    const tiers = (upgrades as { mapSize: { size: number; gold: number; brains: number; quest?: string; endlessTier?: number }[] }).mapSize;
    const tier = tiers.find((t) => t.size === OMNI_FARMER_EXPANSION_SIZE)!;
    const below = tiers.find((t) => t.size === OMNI_FARMER_EXPANSION_SIZE - 10)!;
    expect(tier.quest).toBe(OMNI_FARMER_QUEST_ID);
    expect([tier.gold, tier.brains]).toEqual([below.gold, below.brains]);
    expect(tiers.filter((t) => t.quest).length).toBe(1);
  });

  describe("Almanac classes", () => {
    type Row = { key: string; name: string; category: string; marketHidden?: boolean; rewardOnly?: boolean | null };
    const rows = zombies as Row[];
    const classOf = omniAlmanacClassifier(rows);
    const named = (cls: "basic" | "special") => rows.filter((r) => classOf(r.key) === cls).map((r) => r.name);

    it("counts every normal species as basic: six body types x Green, Blue, Red, Silver, Obsidian", () => {
      expect(named("basic")).toHaveLength(30);
      expect(named("basic")).toEqual(expect.arrayContaining(["Zombie", "Zyborg", "Zombot", "Robo Zombie", "Zombinator"]));
    });

    it("counts epic, invasion and the five plantable Market specials as special", () => {
      const specials = named("special");
      const plantable = rows.filter((r) => r.category === "special" && !r.marketHidden && !r.rewardOnly).map((r) => r.name);
      expect(plantable.sort()).toEqual(["Bombie", "Crazy Zombie", "Cupid Zombie", "Dapper Zombie", "Granny Zombie"]);
      expect(specials).toEqual(expect.arrayContaining([
        ...plantable,
        "Dr. Zombie", // Epic Boss
        "Old McZombie", // invasion drop
        "Sheriff Zombie", // elite invasion drop
      ]));
      expect(specials.length + named("basic").length).toBeGreaterThanOrEqual(50); // reachable
    });

    it("leaves mutants and Zombie Pot promotions out", () => {
      expect(classOf("ZombieActorRegularTier1Potatoes")).toBeUndefined(); // Potato Zombie (mutant)
      expect(classOf("ZombieActorGardenTier5")).toBeUndefined(); // Zombutterfly (Pot tier-5)
      expect(classOf("ZombieActorRegularTier5")).toBeUndefined(); // Zombotron (Pot tier-5)
    });
  });

  it("pays 100k gold, the 90x90 unlock and the Green Flower Ticket", () => {
    const q = (reforged as Record<string, { rewardType: number; rewardValue: number; rewardItems?: { name: string }[] }>)[OMNI_FARMER_QUEST_ID];
    expect([q.rewardType, q.rewardValue]).toEqual([1, 100_000]); // 1 = Gold
    expect(q.rewardItems?.map((item) => item.name)).toEqual(["Green Flower Ticket"]);
  });

  it("wires the ticket to the Green Flower: never sold, plants it, a day to grow, no Insta-Grow", () => {
    type Boost = { key: string; name: string; notForSale?: boolean; icon: string };
    const ticket = (boosts as Boost[]).find((b) => b.name === "Green Flower Ticket")!;
    expect(ticket).toMatchObject({ key: "green_flower_ticket", notForSale: true });
    type Zombie = { key: string; ticket?: string; noInstaGrow?: boolean; growMs: number; className: string; str: number; con: number };
    const all = zombies as Zombie[];
    const flower = all.find((z) => z.key === OMNI_FARMER_PRIZE_ZOMBIE)!;
    expect(flower).toMatchObject({ ticket: ticket.key, noInstaGrow: true, growMs: 86_400_000, className: "Silver" });
    // Comparable to a Zombee, with a little less Constitution.
    const zombee = all.find((z) => z.key === "ZombieActorGardenTier4")!;
    expect(flower.str).toBe(zombee.str);
    expect(flower.con).toBeLessThan(zombee.con);
    // The only ticket zombie.
    expect(all.filter((z) => z.ticket).map((z) => z.key)).toEqual([OMNI_FARMER_PRIZE_ZOMBIE]);
  });

  it("is unlocked only by completing the quest", () => {
    expect(omniFarmerUnlocked([])).toBe(false);
    expect(omniFarmerUnlocked(["20017", "1"])).toBe(false);
    expect(omniFarmerUnlocked(["20017", OMNI_FARMER_QUEST_ID])).toBe(true);
  });
});

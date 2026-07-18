import { describe, it, expect } from "vitest";
import { rollLoot, resolveLoot, lootEligible, bonusGoldFor, BONUS_GOLD } from "../src/loot";
import { RAID_LOOT, dropEcon, raidLoot } from "../src/raidLootCatalog";
import { rollLootTier } from "../../src/raid/LootTable";

const none = () => 0;

describe("raidLootCatalog — mirror of raids.json loot", () => {
  it("has a 6-tier table for all 11 raids", () => {
    expect(Object.keys(RAID_LOOT)).toHaveLength(11);
    for (const [id, tiers] of Object.entries(RAID_LOOT)) {
      expect(tiers.length, id).toBe(6);
      expect(tiers[0], id).toContain(BONUS_GOLD); // tier 0 is always the gold pity drop
    }
  });
  it("mirrors drops.json metadata for the entries it can drop", () => {
    expect(dropEcon("Windmill")).toMatchObject({ unique: true, tile: "windmill" });
    expect(dropEcon("Scarecrow")).toMatchObject({ unique: false }); // a repeatable decoration
    expect(dropEcon("Rusty Fragment")).toMatchObject({ limit: 3 }); // the only limited entry
    expect(dropEcon("Bonus Gold")).toMatchObject({ gold: true });
    expect(dropEcon("nope")).toBeUndefined();
  });
  it("every loot entry across every raid resolves to real drop metadata", () => {
    // A typo in the generated table would silently make an entry always-eligible.
    for (const [id, tiers] of Object.entries(RAID_LOOT)) {
      for (const tier of tiers) for (const name of tier) expect(dropEcon(name), `${id}:${name}`).toBeDefined();
    }
  });
});

describe("lootEligible — unique / limit filters", () => {
  it("filters a unique once owned, at all", () => {
    expect(lootEligible("Windmill", none)).toBe(true);
    expect(lootEligible("Windmill", () => 1)).toBe(false);
    // A non-unique decoration keeps dropping.
    expect(lootEligible("Scarecrow", () => 5)).toBe(true);
  });
  it("filters a limited entry only once its cap is reached", () => {
    expect(lootEligible("Rusty Fragment", () => 2)).toBe(true); // limit 3
    expect(lootEligible("Rusty Fragment", () => 3)).toBe(false);
  });
  it("keeps unlimited entries eligible however many you own", () => {
    expect(lootEligible(BONUS_GOLD, () => 999)).toBe(true);
  });
});

describe("rollLoot — server roll over the raid's tiers", () => {
  it("uses the SAME tier thresholds as the client (one shared definition)", () => {
    // rollLoot must agree with LootTable.rollLootTier, which is imported from the client
    // source rather than copied — this pins that they can't drift apart.
    // raid 1: tier 0 = Bonus Gold, tier 1 = Haystack.
    expect(rollLootTier(0.05, 0)).toBe(0);
    expect(rollLoot(1, 0, none, 0.05, 0)).toBe(BONUS_GOLD);
    expect(rollLootTier(0.2, 0)).toBe(1);
    expect(rollLoot(1, 0, none, 0.2, 0)).toBe("Haystack");
  });

  it("picks uniformly within the chosen tier", () => {
    // raid 1 tier 2 = ["Insta-Plow", "Insta-Harvest"]; roll 0.5 lands in tier 2 at B=0.
    expect(rollLoot(1, 0, none, 0.5, 0)).toBe("Insta-Plow");
    expect(rollLoot(1, 0, none, 0.5, 0.99)).toBe("Insta-Harvest");
  });

  it("walks DOWN to a commoner tier when the rolled tier is exhausted", () => {
    // raid 1 tier 5 = ["Windmill"], which is unique. Own it, roll the rarest tier at high
    // luck, and the roll must fall back to tier 4 (Scarecrow) rather than drop nothing.
    const ownWindmill = (n: string) => (n === "Windmill" ? 1 : 0);
    expect(rollLoot(1, 5, none, 0.99, 0)).toBe("Windmill"); // tier 5 when un-owned
    expect(rollLoot(1, 5, ownWindmill, 0.99, 0)).toBe("Scarecrow"); // tier 4 fallback
  });

  it("returns null when a raid is unknown", () => {
    expect(rollLoot(999, 0, none, 0.5, 0)).toBeNull();
  });

  it("uses the dice count for luck — more dice, rarer tiers", () => {
    // B=0 can reach tier 0; B>=1 makes the common tiers unreachable (ground truth).
    expect(rollLoot(1, 0, none, 0.05, 0)).toBe(BONUS_GOLD); // tier 0
    expect(rollLoot(1, 1, none, 0.05, 0)).toBe("Haystack"); // tier 1 — no more pity gold
    expect(rollLoot(1, 5, none, 0.99, 0)).toBe("Windmill"); // tier 5, the signature drop
  });
});

describe("resolveLoot — what a drop becomes", () => {
  it("pays bonus gold for the Bonus Gold entry, scaled by the raid's level", () => {
    expect(bonusGoldFor(5)).toBe(500);
    expect(resolveLoot(BONUS_GOLD, 5)).toEqual({ kind: "gold", name: BONUS_GOLD, gold: 500 });
  });

  it("resolves a boost drop BY NAME, not by the drops.json gold flag", () => {
    // The trap: Golden Dice carries `gold: true` in drops.json but is a BOOST. The client
    // keys off the literal name "Bonus Gold", so keying off the flag would wrongly turn
    // Golden Dice into gold.
    expect(dropEcon("Golden Dice")).toMatchObject({ gold: true });
    expect(resolveLoot("Golden Dice", 5)).toEqual({ kind: "boost", name: "Golden Dice", key: "golden_dice" });
    expect(resolveLoot("Invasion Voucher", 5)).toMatchObject({ kind: "boost", key: "invasion_voucher" });
  });

  it("treats everything else as an item for the Received bucket", () => {
    expect(resolveLoot("Scarecrow", 5)).toEqual({ kind: "item", name: "Scarecrow" });
  });

  it("grants nothing when nothing dropped", () => {
    expect(resolveLoot(null, 5)).toEqual({ kind: "none" });
  });

  it("never pays brains through item loot — verified invasion brains use a separate table", () => {
    // No raid loot table contains a brain entry (the brain drop is a separate roll), so
    // this is belt-and-braces: if one were ever added, it must not mint premium currency
    // off a forged win.
    expect(dropEcon("10 Brains")).toMatchObject({ brains: true });
    expect(resolveLoot("10 Brains", 5)).toEqual({ kind: "none" });
    const brainy = Object.entries(RAID_LOOT).flatMap(([id, tiers]) =>
      tiers.flat().filter((n) => dropEcon(n)?.brains).map((n) => `${id}:${n}`)
    );
    expect(brainy).toEqual([]); // no loot table pays brains today
  });
});

describe("raidLoot lookup", () => {
  it("resolves known raids and rejects unknown", () => {
    expect(raidLoot(1)).toBeDefined();
    expect(raidLoot(999)).toBeUndefined();
  });
});

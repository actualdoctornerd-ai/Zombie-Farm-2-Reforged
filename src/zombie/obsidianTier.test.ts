// The Obsidian tier: six gravestone zombies above the Silvers, one unlocking per level
// from 40 to 45, planted once the Obsidian Grave is placed. Designed with the owner on
// 2026-09-24 (art: tools/obsidian_zombies.py; rows: tools/prep_market.py
// AUTHORED_ZOMBIES; grave: tools/prep_placeables.py OBSIDIAN_GRAVE).
//
// What makes the tier unusual, and what this pins:
//  1. They are ORDINARY gravestone zombies (category "normal", gold, on sale) that draw
//     from the special-zombie atlas: each is its body type's ordinary rig (the manifest's
//     `base`) with a few recoloured attachments laid over it.
//  2. Their class, Obsidian, is a new rung above Silver with its own grave, and the
//     Zombie Pot can never trade one down.
//  3. The stats were set by one rule: beat the strongest zombie a player can PLANT in
//     the same body type, and stay under the prizes of the invasions that open at the
//     tier's own levels.
import { describe, expect, it } from "vitest";
// @ts-ignore — node test environment only (the app has no @types/node)
import { existsSync } from "node:fs";
import zombieRows from "../../public/assets/zombies.json";
import placeableRows from "../../public/assets/placeables.json";
import zombieModels from "../../public/assets/zombie/models.json";
import specialFrames from "../../public/assets/zombie/special_frames.json";
import specialModels from "../../public/assets/zombie/special_models.json";
import { OBJECTS } from "../../server/src/objectCatalog";
import {
  mergeSpecialZombieModel, placeablePurchaseLimit, purchasableZombies,
  type PlaceableDef, type ZombieDef, type ZombieModel,
} from "../assets";
import { BLACK_MARKET_COLOR_LEVELS } from "../blackMarketRules";
import {
  ALIENS_RAID_ID, RAID_ELITE_ZOMBIE_DROPS, RAID_ZOMBIE_DROPS, VIDEO_GAMES_RAID_ID,
} from "../raid/zombieDrops";
import { graveNeededFor } from "../ui/hudTypes";
import { selectCombineSpecies } from "./combineSpecies";
import { zombieFarmScale } from "./displayScale";
import { specialHeadFxKind } from "./specialHeadFx";
import { classify, classTierRank, CLASS_COLOR } from "./taxonomy";

const zombies = zombieRows as ZombieDef[];
const placeables = placeableRows as PlaceableDef[];
const models = zombieModels as unknown as Record<string, ZombieModel>;
type Manifest = Parameters<typeof mergeSpecialZombieModel>[2];
const manifests = specialModels as unknown as Record<string, Manifest>;

const tier = zombies.filter((zombie) => zombie.className === "Obsidian");
const byGroup = (group: string) => tier.find((zombie) => zombie.group === group)!;

/** The balance yardstick: sqrt(DPS x HP) with HP = con x 100, a hit = str x 10, and a
 *  swing every 2 / dex seconds. */
const strength = (z: Pick<ZombieDef, "str" | "dex" | "con">) =>
  Math.sqrt(((z.str * 10) / (2 / z.dex)) * z.con * 100);

describe("Obsidian tier catalog", () => {
  it("is six gravestone zombies, one per body type, one per level from 40 to 45", () => {
    expect(tier.map((zombie) => [zombie.level, zombie.name, zombie.group])).toEqual([
      [40, "Nightshade Zombie", "Garden"],
      [41, "ZomTitan", "Large"],
      [42, "Zemon", "Small"],
      [43, "Zomchantress", "Female"],
      [44, "Plasmahead", "Headless"],
      [45, "Zombinator", "Regular"],
    ]);
    for (const zombie of tier) {
      expect(zombie.key).toMatch(/Tier6$/);
      expect(zombie.category).toBe("normal");
      expect(zombie.tier).toBe(6);
      expect(zombie.brainsNeeded).toBe(false);
      expect(zombie.classColor).toBe(CLASS_COLOR.Obsidian);
      // The runtime classifier reads the same class off the key.
      expect(classify(zombie.key)).toEqual({
        group: zombie.group, className: "Obsidian", classColor: CLASS_COLOR.Obsidian,
      });
    }
    const onSale = purchasableZombies(zombies).map((zombie) => zombie.key);
    expect(tier.every((zombie) => onSale.includes(zombie.key))).toBe(true);
  });

  it("sees every ability tier and stands at its family's ordinary farm size", () => {
    expect(classTierRank("Obsidian")).toBe(classTierRank("Silver"));
    for (const zombie of tier) {
      expect(zombieFarmScale(zombie.group, zombie.className, zombie.key))
        .toBe(zombieFarmScale(zombie.group, "Silver", zombie.key.replace("Tier6", "Tier4")));
    }
  });

  it("each beats the strongest zombie that body type can plant, and every Silver", () => {
    const plantable = purchasableZombies(zombies)
      .filter((zombie) => zombie.className !== "Obsidian");
    for (const zombie of tier) {
      const rivals = plantable.filter((other) => other.group === zombie.group);
      expect(rivals.length).toBeGreaterThan(0);
      const best = Math.max(...rivals.map(strength));
      expect(strength(zombie), zombie.name).toBeGreaterThan(best);
      const silver = zombies.find((other) => other.key === zombie.key.replace("Tier6", "Tier4"))!;
      expect(zombie.str).toBeGreaterThan(silver.str);
      expect(zombie.con).toBeGreaterThan(silver.con);
      expect(zombie.dex).toBeGreaterThanOrEqual(silver.dex);
      expect(zombie.cost).toBeGreaterThan(silver.cost);
    }
  });

  it("stays under the prizes of the invasions a level-40 player is fighting", () => {
    // The prizes are the rare drops a player chases; a zombie bought outright must not
    // outclass the ones on offer at its own levels — the Aliens' and Video Games'
    // (regular and Brain Ticket). Earlier invasions' prizes are a different matter:
    // the Zombinator (775) out-scores the Deputy, MerZombie, Zombie Bot and Omega
    // Zombie Bot (624-748), which were fitted to levels 25-31.
    const lateRaids = [ALIENS_RAID_ID, VIDEO_GAMES_RAID_ID];
    const prizes = lateRaids.flatMap((id) => [RAID_ZOMBIE_DROPS[id], RAID_ELITE_ZOMBIE_DROPS[id]])
      .map((drop) => zombies.find((zombie) => zombie.key === drop.key)!);
    expect(prizes).toHaveLength(4);
    const weakestPrize = Math.min(...prizes.map(strength));
    for (const zombie of tier) expect(strength(zombie), zombie.name).toBeLessThan(weakestPrize);
  });
});

describe("Obsidian Grave", () => {
  const grave = placeables.find((entry) => entry.key === "gravestoneObsidian")!;
  const silver = placeables.find((entry) => entry.key === "gravestoneSilver")!;

  it("is the Silver Grave recoloured, one per farm, on sale at the tier's first level", () => {
    expect(grave).toBeDefined();
    expect(grave.name).toBe("Obsidian Grave");
    expect(grave.category).toBe("functional");
    expect(grave.variantOf).toBe("gravestoneSilver");
    expect(grave.sprite).toBe(silver.sprite);
    expect(grave.color).toBeDefined();
    expect(grave.level).toBe(Math.min(...tier.map((zombie) => zombie.level)));
    expect(grave.brainsNeeded).toBe(true);
    expect(grave.cost).toBeGreaterThan(silver.cost);
    expect(placeablePurchaseLimit(grave)).toBe(1);
  });

  it("matches the server's object catalog", () => {
    const server = OBJECTS.gravestoneObsidian;
    expect(server).toEqual({
      cost: grave.cost, brains: grave.brainsNeeded, xp: grave.xp, level: grave.level, purchaseLimit: 1,
    });
  });

  it("is the grave that unlocks planting the class, and gates it on the Black Market", () => {
    expect(graveNeededFor("Obsidian")).toBe("Obsidian");
    expect(BLACK_MARKET_COLOR_LEVELS.Obsidian).toBe(grave.level);
  });
});

describe("Obsidian in the Zombie Pot", () => {
  const titan = byGroup("Large");
  const brute = zombies.find((zombie) => zombie.key === "ZombieActorLargeTier3")!;
  const parent = (zombie: ZombieDef) => ({
    key: zombie.key, group: zombie.group, className: zombie.className, isSpecial: false,
  });

  it("keeps an Obsidian in slot 1 — never the tier-5 roll, never a Silver", () => {
    // random() = 0 would win every tier-5 roll; the Obsidian must still come out.
    expect(selectCombineSpecies(parent(titan), parent(brute), 45, () => 0)).toBe(titan.key);
    expect(selectCombineSpecies(parent(titan), parent(titan), 45, () => 0)).toBe(titan.key);
    // A job persisted without its class still reads the tier off the key.
    expect(selectCombineSpecies({ key: titan.key, group: "Large" }, { key: brute.key, group: "Large" }, 45, () => 0))
      .toBe(titan.key);
  });

  it("is never bred: slot 1 decides, so an Obsidian in slot 2 does not carry over", () => {
    expect(selectCombineSpecies(parent(brute), parent(titan), 45, () => 0.99)).toBe(brute.key);
  });
});

describe("Obsidian art", () => {
  const BASES: Record<string, string> = {
    ZombieActorGardenTier6: "ZombieActorGardenTier3",
    ZombieActorLargeTier6: "ZombieActorLargeTier4",
    ZombieActorSmallTier6: "ZombieActorSmallTier4",
    ZombieActorGirlTier6: "ZombieActorGirlTier5",
    ZombieActorHeadlessTier6: "ZombieActorHeadlessTier1",
    ZombieActorRegularTier6: "ZombieActorRegularTier4",
  };

  it("wears its body type's ordinary rig, with every recoloured part on the atlas", () => {
    for (const zombie of tier) {
      const manifest = manifests[zombie.key] as Manifest & { base?: string };
      expect(manifest, zombie.name).toBeDefined();
      expect(manifest.base).toBe(BASES[zombie.key]);
      expect(models[manifest.base!], manifest.base).toBeDefined();
      for (const part of manifest.parts) {
        expect(`${zombie.key}:${part.file}` in specialFrames, `${zombie.name} ${part.file}`).toBe(true);
      }
      expect(existsSync(new URL(`../../public/assets/zombie/portrait/${zombie.key}.png`, import.meta.url)))
        .toBe(true);
    }
  });

  it("merges over the base rig: base scale, dark skin, recoloured parts in their slots", () => {
    const merged = (key: string) => {
      const zombie = tier.find((entry) => entry.key === key)!;
      const manifest = manifests[key] as Manifest & { base: string };
      return mergeSpecialZombieModel(models[manifest.base], zombie, manifest, (f) => `special:${key}:${f}`);
    };
    // The Plasmahead is the plain headless body at the Party Zombie's size, not the
    // bigger size a named Headless special takes.
    const plasma = merged("ZombieActorHeadlessTier6");
    expect(plasma.scale).toBe(models.ZombieActorHeadlessTier4.scale);
    expect(plasma.parts.every((part) => part.file.startsWith("default"))).toBe(true);
    // The ZomTitan's mane is its own purple texture, in place of the Zombarian's.
    const titan = merged("ZombieActorLargeTier6").parts.map((part) => part.file);
    expect(titan).toContain("special:ZombieActorLargeTier6:barbarianHair.png");
    expect(titan).not.toContain("barbarianHair");
    // The Zomchantress's lilac eyes replace the default eyes rather than doubling them.
    const chant = merged("ZombieActorGirlTier6").parts.map((part) => part.file);
    expect(chant).toContain("special:ZombieActorGirlTier6:EyeL.png");
    expect(chant).not.toContain("defaultEyeL");
    // Dark skin on every one: nothing bright is left in the tint.
    for (const zombie of tier) {
      const color = merged(zombie.key).color;
      expect(Math.max(...color), zombie.name).toBeLessThanOrEqual(140);
    }
  });

  it("gives the Plasmahead a plasma head and the Zomchantress sparkles", () => {
    expect(specialHeadFxKind("ZombieActorHeadlessTier6")).toBe("plasma");
    expect(specialHeadFxKind("ZombieActorGirlTier6")).toBe("sparkle");
    // A Pumpking replaces the plasma head, as it does Flamehead's flame…
    expect(specialHeadFxKind("ZombieActorHeadlessTier6", 8192)).toBeNull();
    // …but sparkles are not a head, so they stay.
    expect(specialHeadFxKind("ZombieActorGirlTier6", 8192)).toBe("sparkle");
  });
});

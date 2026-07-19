import { describe, expect, it } from "vitest";
import zombieRows from "../../public/assets/zombies.json";
import boostRows from "../../public/assets/boosts.json";
import specialFrames from "../../public/assets/zombie/special_frames.json";
import specialModels from "../../public/assets/zombie/special_models.json";
import { purchasableZombies, type BoostDef, type ZombieDef } from "../assets";

const zombies = zombieRows as ZombieDef[];
const boosts = boostRows as BoostDef[];

describe("complete special-zombie roster", () => {
  it("implements every recovered named special with its dedicated art", () => {
    const named = zombies.filter((zombie) => zombie.specialSprite);
    expect(named).toHaveLength(40);
    expect(new Set(named.map((zombie) => zombie.key)).size).toBe(40);
    expect(named.every((zombie) => zombie.category === "special")).toBe(true);
    expect(named.every((zombie) => zombie.key in specialModels)).toBe(true);
    for (const zombie of named) {
      const model = specialModels[zombie.key as keyof typeof specialModels];
      expect(model.parts.length).toBeGreaterThan(0);
      expect(model.parts.every((part) => `${zombie.key}:${part.file}` in specialFrames)).toBe(true);
      const hasDedicatedHead = model.parts.some((part) => part.file === "Head.png");
      if (!model.floatingHead && !hasDedicatedHead) {
        expect(model.neck).toEqual({ x: 7, y: -36 });
      }
      for (const part of model.parts.filter((entry) =>
        entry.file === "Hat.png" || entry.file === "Features3.png")) {
        expect(part.group).toBe("head");
      }
    }
  });

  it("exposes exactly the five permanent plantable specials", () => {
    const plantableSpecials = purchasableZombies(zombies)
      .filter((zombie) => zombie.category === "special");
    expect(plantableSpecials.map((zombie) => zombie.name).sort()).toEqual([
      "Bombie", "Crazy Zombie", "Cupid Zombie", "Dapper Zombie", "Granny Zombie",
    ]);
    expect(plantableSpecials.every((zombie) =>
      zombie.cost === 5 && zombie.level === 20 && zombie.brainsNeeded === true
    )).toBe(true);
  });

  it("keeps all Epic rewards out of the plantable Market", () => {
    const market = new Set(purchasableZombies(zombies).map((zombie) => zombie.key));
    const rewards = zombies.filter((zombie) => zombie.rewardOnly);
    expect(rewards).toHaveLength(15);
    expect(rewards.every((zombie) => !market.has(zombie.key))).toBe(true);
  });

  it("routes every hidden gift to a distinct real catalog zombie", () => {
    const giftKeys = boosts.filter((boost) => boost.effect === "gift").map((boost) => boost.giftZombieKey);
    expect(giftKeys.sort()).toEqual([
      "ZombieActorGardenCupid",
      "ZombieActorGardenCupidPink",
      "ZombieActorGardenTier3GreenFlower",
      "ZombieActorRegularCrazy",
    ]);
    expect(giftKeys.every((key) => zombies.some((zombie) => zombie.key === key))).toBe(true);
  });
});

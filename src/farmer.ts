export type FarmerEffectKey =
  | "harvestGold"
  | "zombieGrowTime"
  | "zombieLife"
  | "zombieStrength"
  | "invasionCooldown";

/** Source-priced head bonuses keyed by PlayerDictionary head ID. */
const HEAD_EFFECTS: Partial<Record<number, { key: FarmerEffectKey; amount: number }>> = {
  12: { key: "harvestGold", amount: 0.10 }, // Paper Bag
  14: { key: "harvestGold", amount: 0.10 }, // Pumpkin
  13: { key: "zombieGrowTime", amount: -0.25 }, // Monolith
  2: { key: "zombieLife", amount: 0.10 },
  6: { key: "zombieLife", amount: 0.10 },
  3: { key: "zombieStrength", amount: 0.10 },
  7: { key: "zombieStrength", amount: 0.10 },
  8: { key: "invasionCooldown", amount: -0.25 },
  9: { key: "invasionCooldown", amount: -0.25 },
};

export function farmerEffect(headId: number, key: FarmerEffectKey): number {
  const effect = HEAD_EFFECTS[headId];
  return effect?.key === key ? effect.amount : 0;
}

export const farmerMultiplier = (headId: number, key: FarmerEffectKey): number =>
  1 + farmerEffect(headId, key);

export const farmerGold = (value: number, headId: number): number =>
  Math.max(0, Math.round(value * farmerMultiplier(headId, "harvestGold")));

export const farmerZombieGrowMs = (value: number, headId: number): number =>
  Math.max(1, Math.round(value * farmerMultiplier(headId, "zombieGrowTime")));

export const farmerCooldownMs = (value: number, headId: number): number =>
  Math.max(0, Math.round(value * farmerMultiplier(headId, "invasionCooldown")));

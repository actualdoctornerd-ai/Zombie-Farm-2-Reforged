/**
 * Invasion cards occupy the progression ladder at their authored unlock position.
 * Seasonal is availability metadata, not a separate menu section.
 */
export function compareRaidMenuOrder(
  a: { unlockLevel: number; recommendedLevel: number; id: number },
  b: { unlockLevel: number; recommendedLevel: number; id: number }
): number {
  return a.unlockLevel - b.unlockLevel ||
    a.recommendedLevel - b.recommendedLevel ||
    a.id - b.id;
}

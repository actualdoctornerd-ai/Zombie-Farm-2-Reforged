// A tiny notification bus mirroring the game's NSNotificationCenter-style events.
// Gameplay code posts events (plow/plant/harvest/buy/…); the QuestSystem subscribes
// and advances quest objectives. Kept generic so any future system (raids, social,
// mutations) can post its own notifications without touching this file.

/** Canonical quest notification IDs (from Quests.plist requirements). Farm ones
 *  have live emitters today; the rest are posted once their systems exist. */
export const QuestEvent = {
  SoilPlowed: "kSoilPlowedNotification",
  NewSoilPlowed: "kNewSoilPlowedNotification",
  CropPlanted: "kCropPlantedNotification",
  CropHarvested: "kCropHarvestedNotification",
  ZombieHarvested: "kCropHarvestedZombieNotification",
  ItemBought: "kItemBoughtNotification",
  CombinerCombined: "kCombinerCombinedNotification",
  CombinerHarvested: "kCombinerHarvestedNotification",
  // Raid / social / epic — no emitters yet (quests using these stay dormant):
  InvasionSuccessful: "kInvasionSuccessfulNotification",
  InvasionPerfectGame: "kInvasionPerfectGameNotification",
  EpicStageEnemyDefeated: "kEpicStageEnemyDefeatedNotification",
  EpicBossEpicItemWon: "kEpicBossEpicItemWonNotification",
  LootItemWon: "kLootItemWonNotification",
  StageActorDefeated: "kStageActorDefeated",
  PhotoTaken: "kPhotoTakenNotification",
  SocialDidVisit: "kSocialManagerDidVisit",
  SocialDidFinishTag: "kSocialManagerDidFinishTag",
  SocialDidGiftBrain: "kSocialManagerDidGiftBrain",
} as const;

type Handler = (notificationID: string, object: string, n: number) => void;

export class QuestBus {
  private handlers = new Set<Handler>();

  /** Subscribe to every posted event. Returns an unsubscribe fn. */
  subscribe(fn: Handler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  /**
   * Post a game event. `object` is the specific subject (crop/zombie/item name);
   * pass "" when there's no subject. `n` is the increment (default 1).
   */
  post(notificationID: string, object = "", n = 1) {
    for (const fn of this.handlers) fn(notificationID, object, n);
  }
}

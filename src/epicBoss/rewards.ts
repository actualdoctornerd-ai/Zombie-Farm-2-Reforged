/** Epic-event quest rewards use dedicated catalog keys even though the recovered
 * source data points several of them at generic Regular/Girl actor classes. Keeping
 * this mapping shared prevents the client quest flow and authoritative Worker grant
 * from disagreeing about which named zombie was earned. */
export const EPIC_QUEST_ZOMBIE_REWARDS: Readonly<Record<string, string>> = {
  "1000": "ZombieActorDrZombie",
  "1011": "ZombieActorOmegaDrZombie",
  "2000": "ZombieActorBandido",
  "2011": "ZombieActorVagabond",
  "3000": "ZombieActorCaptain",
  "3011": "ZombieActorAdmiral",
  "4000": "ZombieActorChristmasGhost",
  "4011": "ZombieActorScrooge",
  "5000": "ZombieActorDiva",
  "5011": "ZombieActorMadame",
  "8000": "ZombieActorBrockColey",
  "9000": "ZombieActorProto",
  "9011": "ZombieActorZombug",
  "10000": "ZombieActorZomdini",
  "10011": "ZombieActorZomtar",
};

export const epicQuestZombieReward = (questId: string): string | null =>
  EPIC_QUEST_ZOMBIE_REWARDS[questId] ?? null;

/** Farm first; once the authoritative deployed cap is full, preserve the earned
 * unit in zombie storage. Storage overflow remains protected and visible. */
export const shouldStoreEpicReward = (activeCount: number, activeCapacity: number): boolean =>
  activeCount >= Math.max(0, activeCapacity);

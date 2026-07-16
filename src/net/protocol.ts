/** Wire contract for the authoritative gameplay protocol. Keep this module free of
 * browser and Worker dependencies so both sides compile against the same shapes. */
export const GAMEPLAY_PROTOCOL = 3 as const;
export const COMMAND_BATCH_LIMIT = 64;
export const COMMAND_BATCH_WINDOW_MS = 10_000;
export const PRESENTATION_WINDOW_MS = 60_000;

export type CommandStatus = "applied" | "duplicate" | "rejected" | "dependency_failed";

export interface CommandResult {
  sequence: number;
  status: CommandStatus;
  error?: string;
  createdIds?: string[];
}

export type GameplayCommand =
  | { type: "farm.plow"; oc: number; or: number }
  | { type: "farm.plant"; oc: number; or: number; cropKey: string }
  | { type: "farm.harvest"; oc: number; or: number }
  | { type: "farm.remove"; oc: number; or: number }
  | { type: "power.buy"; key: string }
  | { type: "power.use"; key: string; oc?: number; or?: number; target?: "zombie_pot" }
  | { type: "object.buy"; catalogKey: string; clientInstanceId?: string }
  | { type: "object.refund"; instanceId: string }
  | { type: "object.upgrade"; instanceId: string; catalogKey: string }
  | { type: "object.status"; instanceId: string; status: "placed" | "stored" }
  | { type: "object.harvest_trees"; instanceIds: string[] }
  | { type: "storage.move"; itemKey: string; direction: "store" | "take"; quantity: number }
  | { type: "roster.sell"; unitId: string }
  | { type: "roster.status"; unitId: string; stored: boolean }
  | { type: "roster.combine"; parentAId: string; parentBId: string }
  | { type: "shop.size"; size: number; currency: "gold" | "brains" }
  | { type: "shop.climate"; terrain: string }
  | { type: "farmer.buy"; headId: number }
  | { type: "farmer.equip"; headId: number }
  | { type: "pet.buy"; petKey: string }
  | { type: "pet.equip"; petKey: string | null }
  | { type: "tutorial.complete" };

export interface SequencedCommand {
  sequence: number;
  command: GameplayCommand;
}

export interface CommandBatchRequest {
  protocolVersion: typeof GAMEPLAY_PROTOCOL;
  deviceId: string;
  batchId: string;
  firstSequence: number;
  expectedAccountVersion: number;
  writerGeneration: number;
  takeWriter?: boolean;
  commands: SequencedCommand[];
}

export interface BalanceProjection {
  gold: number;
  brains: number;
  xp: number;
}

export type FarmPlotProjection =
  | { state: "plowed" }
  | { state: "spent"; zombie?: boolean }
  | {
      state: "planted";
      cropKey: string;
      plantedAt: number;
      growMs: number;
      sell: number;
      xp: number;
      fertilized: boolean;
      zombie: boolean;
    };

export interface FarmDocumentProjection {
  version: number;
  plots: Record<string, FarmPlotProjection>;
}

export interface FunctionalObjectProjection {
  instanceId: string;
  catalogKey: string;
  status: "placed" | "stored";
  readyAt?: number;
}

export interface ObjectDocumentProjection {
  version: number;
  objects: FunctionalObjectProjection[];
}

export interface QuestProjection {
  version: number;
  completed: string[];
  progress: { questId: string; counts: number[] }[];
}

export interface EpicBossProjection {
  runId: string;
  bossId: string;
  activatedAt: number;
  expiresAt: number;
  level: number;
  maxHp: number;
  currentHp: number;
  encounterStartedAt: number;
  retryReadyAt: number;
  completedAt: number;
  attackOrder: string[];
}

export interface RosterUnitProjection {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
  stored: boolean;
  lockedByRaid?: string;
}

export interface GameplayProjection {
  balance: BalanceProjection;
  farm: FarmDocumentProjection;
  objects: ObjectDocumentProjection;
  quests: QuestProjection;
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  roster: RosterUnitProjection[];
  farmSize: number;
  climates: string[];
  farmerHeads: number[];
  farmerHeadId: number;
  ownedPets: string[];
  activePet: string | null;
  zombieMax: number;
  tutorialRewarded: boolean;
  raids: { progress: Record<string, number>; lastRaidAt: number };
  epicBoss?: EpicBossProjection | null;
}

export interface PresentationProjection {
  version: number;
  data: Record<string, unknown>;
}

export interface SocialBootstrap {
  friends: { accountId: string; name: string; friendCode: string }[];
  incomingRequestCount: number;
  inboxCount: number;
}

export interface ResumableRaidProjection {
  sessionId: string;
  raidId: string;
  startedAt: number;
  expiresAt: number;
  earliestFinishAt: number;
  rosterIds: string[];
}

export interface BootstrapResponse {
  protocolVersion: typeof GAMEPLAY_PROTOCOL;
  serverTime: number;
  minimumProtocolVersion: number;
  mutationsEnabled: boolean;
  accountVersion: number;
  writerGeneration: number;
  writerDeviceId: string | null;
  gameplay: GameplayProjection;
  presentation: PresentationProjection;
  social: SocialBootstrap;
  resumableRaid: ResumableRaidProjection | null;
}

export interface CommandBatchResponse {
  protocolVersion: typeof GAMEPLAY_PROTOCOL;
  batchId: string;
  accountVersion: number;
  writerGeneration: number;
  serverTime: number;
  results: CommandResult[];
  gameplay: GameplayProjection;
  farmVersionBefore: number;
  farmVersionAfter: number;
  netDelta: BalanceProjection;
  questChanges: { questId: string; counts: number[]; completed: boolean }[];
  createdZombieIds: string[];
}

export interface PresentationRequest {
  protocolVersion: typeof GAMEPLAY_PROTOCOL;
  expectedVersion: number;
  data: Record<string, unknown>;
}

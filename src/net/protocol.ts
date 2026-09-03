/** Wire contract for the authoritative gameplay protocol. Keep this module free of
 * browser and Worker dependencies so both sides compile against the same shapes. */
import type { PeriodicScopeState } from "../quest/periodic/types";

export const GAMEPLAY_PROTOCOL = 3 as const;
export const CLIENT_INTEGRITY_VERSION = 5 as const;
export const COMMAND_BATCH_LIMIT = 64;
// Mutations coalesce into one /commands POST per window. Widened from 10s to 30s to
// cut request volume while actively farming (~3x fewer batches). Safe because the
// outbox is durable in localStorage with idempotent batchId replay, dependent
// actions (raids/spends) force an immediate flush via settle(), and the queue also
// flushes on beforeunload / visibilitychange:hidden.
export const COMMAND_BATCH_WINDOW_MS = 30_000;
export const PRESENTATION_WINDOW_MS = 60_000;
/** How many plots one bulk farm command may carry.
 *
 *  A plot is 4x4 tiles and the largest farm is 70x70, so 289 plots is the whole board —
 *  which is exactly the point. Plowing or planting a field used to emit one command per
 *  plot, and the Worker's rolling-minute budget is counted in SEMANTIC commands, so a
 *  single full-farm pass could not physically fit inside it. The queue then spent minutes
 *  draining behind 429s while `settle()` held the invasion launch hostage — the reported
 *  "I can't start battles when I have a lot of planting/plowing queued". One stroke is now
 *  one command. */
export const FARM_BULK_LIMIT = 289;

export type CommandStatus = "applied" | "duplicate" | "rejected" | "dependency_failed";

export interface CommandResult {
  sequence: number;
  status: CommandStatus;
  error?: string;
  createdIds?: string[];
  /** Source plots for zombies created by a farm/power command. This avoids pairing
   * bulk-harvest identities by two different iteration orders. */
  createdZombieSources?: { id: string; oc: number; or: number }[];
  /** For a bulk farm command that partly succeeded: how many of its plots the server
   *  refused, and why the first of them was refused. A whole-command rejection still
   *  uses `status: "rejected"` + `error`; this is the middle case, where the player
   *  deserves one summary rather than either silence or a toast per plot. */
  rejectedPlots?: number;
  rejectedPlotError?: string;
}

export type GameplayCommand =
  | { type: "writer.claim" }
  | { type: "farm.plow"; oc: number; or: number }
  | { type: "farm.plant"; oc: number; or: number; cropKey: string; fertilized?: boolean }
  // Bulk forms of the two commands a drag-paint stroke produces by the hundred. The
  // single-plot forms above stay on the wire for cached older clients; a current client
  // only ever sends these (see FARM_BULK_LIMIT and EconomyClient.submitFarm). Each is
  // applied plot by plot, in order, by exactly the single-plot rules.
  | { type: "farm.plow_many"; plots: { oc: number; or: number }[] }
  | {
      type: "farm.plant_many";
      cropKey: string;
      plots: { oc: number; or: number; fertilized?: boolean }[];
    }
  /** Bulk harvest, the same way. The farmer harvests a field one plot at a time and
   *  each plot used to be its own semantic command against the Worker's 120-a-minute
   *  budget, so a big field harvested by hand crossed it inside one window and the
   *  outbox backed off behind 429s for minutes — which is what "my quests take ages to
   *  update" turned out to be. Each plot is harvested under exactly the single-plot
   *  rules; the zombies it grows come back paired to their plots in
   *  `createdZombieSources`, never by list position. */
  | { type: "farm.harvest_many"; plots: { oc: number; or: number }[] }
  | { type: "farm.harvest"; oc: number; or: number }
  | { type: "farm.remove"; oc: number; or: number }
  /** Relocate a plot and whatever is growing on it. Layout only — the crop,
   *  its timers and its value are carried across untouched. */
  | { type: "farm.move"; oc: number; or: number; toOc: number; toOr: number }
  | { type: "power.buy"; key: string }
  | { type: "power.use"; key: string; oc?: number; or?: number; target?: "zombie_pot" }
  | { type: "object.buy"; catalogKey: string; clientInstanceId?: string }
  | { type: "object.refund"; instanceId: string }
  | { type: "object.upgrade"; instanceId: string; catalogKey: string }
  | { type: "object.status"; instanceId: string; status: "placed" | "stored" }
  | { type: "object.harvest_trees"; instanceIds: string[] }
  | { type: "storage.claim"; itemName: string; clientInstanceId?: string }
  | { type: "storage.move"; itemKey: string; direction: "store" | "take"; quantity: number }
  | { type: "roster.sell"; unitId: string }
  | { type: "roster.status"; unitId: string; stored: boolean }
  | { type: "roster.combine_start"; potId: string; parentAId: string; parentBId: string; playerLevel?: number }
  /** `stored`: collect the child straight into the Mausoleum (the player chose the
   *  crypt, or the farm is full). Omitted keeps the old farm-first placement. */
  | { type: "roster.combine"; potId?: string; parentAId: string; parentBId: string;
      playerLevel?: number; stored?: boolean }
  | { type: "shop.size"; size: number; currency: "gold" | "brains" }
  | { type: "shop.climate"; terrain: string }
  | { type: "farmer.buy"; headId: number }
  | { type: "farmer.equip"; headId: number }
  /** Pin the head supplying bonuses; null hands the job back to the worn head. */
  | { type: "farmer.bonus"; headId: number | null }
  | { type: "pet.buy"; petKey: string }
  | { type: "pet.equip"; petKey: string | null }
  | { type: "pet.pen"; petKeys: string[] }
  /** Carve a fallen zombie onto a placed Memorial Statue. Server-owned because a
   *  friend visiting the farm renders the statue from the authoritative object
   *  projection — a client-held occupant would show them a bare plinth, or an
   *  impossible zombie. `name` is the only client-authored field, exactly as it is
   *  for a living unit (roster names live in the presentation blob). */
  | { type: "memorial.enshrine"; instanceId: string; unitId: string; name?: string }
  /** Take whoever is on this statue back off it, into the graveyard. */
  | { type: "memorial.clear"; instanceId: string }
  /** Collect a finished daily/weekly quest's XP. Unlike the catalog quests — which
   *  grant themselves inside the transaction that completes them — a periodic quest
   *  waits to be claimed, so this is the only command that pays one out. */
  | { type: "quest.periodic_claim"; scope: "daily" | "weekly"; questId: string }
  /** Ask the server to derive the daily/weekly board this client has just generated
   *  for itself. The client draws the board the instant it qualifies — the level-up it
   *  saw optimistically, or a period rollover — with the same deterministic generator
   *  the server runs, so the two agree without the board ever crossing the wire: the
   *  command carries no quests, only the scope and the level the client drew for. The
   *  server derives the period from its own clock, clamps `level` to the XP it holds,
   *  refuses a scope that already has this period's board (`already_authored` — never
   *  a re-roll, which would be a free reset of counts and claims) or a level below the
   *  scope's unlock (`below_unlock`), and otherwise installs the identical set. */
  | { type: "quest.periodic_author"; scope: "daily" | "weekly"; level: number }
  /** Record Boss Tokens the CLIENT rolled on harvest. Deliberately unverified: the
   *  server no longer rolls for tokens itself and does not re-check this claim, so an
   *  edited client can mint tokens. That is an accepted trade — a token buys one Epic
   *  Boss attempt, the drop rate is generous, and the alternative (a server roll) made
   *  the token arrive a batch window after the crop it came out of, so the pop-up
   *  effect played over an empty plot. `runId` pins the grant to the run the client
   *  rolled against, so a token cannot leak into a later event. */
  | { type: "epicBoss.token"; runId: string; count?: number }
  | { type: "tutorial.complete" };

/** Ceiling on one `epicBoss.token` command, so an Insta-Harvest across a full field
 *  folds into a single command instead of one per lucky plot. */
export const EPIC_BOSS_TOKEN_GRANT_LIMIT = 64;

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
  purchaseCost?: number;
  purchaseCurrency?: "gold" | "brains";
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

/** Daily/weekly quests. Client-authored, server-verified: the client generates a
 *  scope's board the moment it qualifies and asks the server to derive the identical
 *  one (`quest.periodic_author`), while the counts and the claims stay server-owned
 *  like the catalog quests. The set is regenerated whenever its UTC period rolls over,
 *  and each quest's XP is collected by a `quest.periodic_claim` command rather than
 *  granted on completion. Either scope is null until it unlocks (daily at level 5,
 *  weekly at 15). */
export interface PeriodicQuestProjection {
  version: number;
  daily: PeriodicScopeState | null;
  weekly: PeriodicScopeState | null;
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
  /** Harvested attempts for this run. Cleared when the event ends or is replaced. */
  tokenCount: number;
  completedAt: number;
  attackOrder: string[];
  /** The favourite crop whose harvest lured this boss, or absent when the event was
   *  bought with brains. Set only by the server's own roll (v3/engine.ts), so it doubles
   *  as the "this event arrived unasked" flag the client announces on. */
  startedCrop?: string;
}

export interface RosterUnitProjection {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
  stored: boolean;
  lockedByRaid?: string;
  /** True when the unit is the player's OWN zombie coming back out of Black Market
   *  escrow (they cancelled their sale). It arrives under a new server unit id, so
   *  without this the client would read it as a first-time arrival and credit the
   *  Zombie Almanac again. Absent on every other unit — and on an older Worker,
   *  where the client simply keeps the pre-fix behaviour. */
  restored?: boolean;
  /** Inherited body tint, carried authoritatively for units whose colour has to
   *  survive a change of unit id — a Black Market cancel or delivery mints a new
   *  one, and the presentation hint that used to hold the tint is keyed by the old
   *  id. Absent means "no inherited tint": the client falls back to its own
   *  presentation hint and then to the species' catalog colour. */
  color?: [number, number, number];
}

/** A zombie that died in an invasion and was not revived — the graveyard a Memorial
 *  Statue draws from. Deliberately the SAME minimal shape as a living roster unit:
 *  everything else on the card (species name, body type, class, stats) is derived
 *  from the catalog by key + mutation, exactly as it is for a unit that is alive.
 *
 *  A fallen zombie is display data. Nothing can return it to the roster: the one
 *  chance to keep it was the brain-priced offer made when the raid settled. */
export interface FallenUnitProjection {
  id: string;
  key: string;
  /** Player-chosen individual name, or absent for the deterministic default. Names
   *  are client-authored for the living too (they ride the presentation blob), so
   *  this carries the same weight — none. Captured at death because the roster row
   *  it came from is gone by the time anything asks. */
  name?: string;
  mutation: number;
  invasions: number;
  color?: [number, number, number];
  /** Epoch ms the zombie was lost. */
  diedAt: number;
  /** Epoch ms it last came OFF a statue, if it ever has. The graveyard is ordered
   *  and capped by `releasedAt ?? diedAt`, so a zombie the player takes off a plinth
   *  rejoins at the top rather than being evicted by an old date of death. Never
   *  displayed — the plaque always shows `diedAt`. */
  releasedAt?: number;
  /** The placed Memorial Statue this zombie stands on. Absent = still in the
   *  graveyard, waiting for one. At most one zombie per statue, enforced by a
   *  unique index server-side. */
  memorialObjectId?: string;
}

export interface GameplayProjection {
  balance: BalanceProjection;
  farm: FarmDocumentProjection;
  objects: ObjectDocumentProjection;
  quests: QuestProjection;
  /** Optional so a client running against a Worker that predates daily/weekly quests
   *  simply shows no periodic panel instead of failing to parse the bootstrap. */
  periodicQuests?: PeriodicQuestProjection;
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  roster: RosterUnitProjection[];
  /** The graveyard + who stands on each Memorial Statue. Absent on a Worker that
   *  predates memorials, which clients read as "no dead to remember". */
  fallen?: FallenUnitProjection[];
  farmSize: number;
  climates: string[];
  farmerHeads: number[];
  /** The head worn: appearance only, and the face friends see beside the name. */
  farmerHeadId: number;
  /** The head whose bonus is pinned, or null to follow the worn one. Absent from a
   *  Worker that predates the split — clients read that as null. */
  farmerBonusHeadId?: number | null;
  ownedPets: string[];
  activePet: string | null;
  penPets: string[];
  zombieMax: number;
  /** Permanent dynamic-pricing flag: first Zombie Pot is gold, later Pots are brains. */
  zombiePotBought?: boolean;
  tutorialRewarded: boolean;
  /** Per running Zombie Pot, the parent id that went into SLOT 1 — the slot that decides
   *  the result species. Recorded when the combine starts because the collect command
   *  arrives an hour later from a client that may have rebuilt its job from the roster,
   *  which is ordered by creation and so cannot be read as slot order. Server-owned:
   *  entries appear on `roster.combine_start` and are dropped on `roster.combine`. */
  potSlots?: Record<string, string>;
  raids: { progress: Record<string, number>; lastRaidAt: number };
  raidRevival?: {
    sessionId: string;
    zombies: { id: string; key: string; mutation: number; invasions: number; stored: boolean }[];
    costPerZombie: 1;
  } | null;
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

/** How recently a friend played, at the only resolution the server discloses to them.
 *  Deliberately coarse — the raw last-online instant never leaves the server. */
export type FriendActivity = "today" | "week" | "away";

/** Online gift economy, mirroring server/src/db.ts. There is no ceiling on gifts per
 *  day — gold is the only brake, and the per-recipient rules (once a day, and not
 *  while they hold an unopened one from you) are enforced server-side. These live
 *  here only so the client can quote a cost before sending (the "Gift all"
 *  confirmation). server/test/logic.test.ts asserts the two copies stay equal. */
export const FREE_DAILY_GIFTS = 2;
export const GIFT_GOLD_COST = 100;
export const GIFT_XP_REWARD = 5;

/** Friends per account, mirroring server/src/db.ts. The cap bounds ACCEPTING, not
 *  receiving — requests keep arriving at a full list and wait in the inbox — so the
 *  client needs the number only to explain a refused accept. */
export const MAX_FRIENDS = 50;

/** What opening a friend's gift paid out. The contents are rolled by the server when
 *  the gift is SENT and stored on it, so nothing the recipient does can change them —
 *  the one exception is the first gift opened each day, which is always a brain. The
 *  inbox deliberately does not carry this: the box stays closed until it is claimed. */
export interface GiftReward {
  kind: "brain" | "gold";
  amount: number;
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
  /** The Worker's `RAID_RULESET_VERSION`. The client compares this against its own
   *  constant at boot: a mismatch means this tab's JS predates (or postdates) the
   *  deployed Worker, so `/raid/start` would reject every launch with
   *  `426 stale_ruleset`. Surfacing it here lets the client prompt a reload up front
   *  instead of failing at the Invade button. */
  raidRulesetVersion: number;
  /** Whether this Worker accepts friend invasions (`PVP_ENABLED`). The client shows
   *  its Invasions surfaces only when true, so launching PvP is one Worker-var flip:
   *  no client redeploy, no dead button while the feature is parked. Optional —
   *  an older Worker simply doesn't send it, which reads as "off". */
  pvpEnabled?: boolean;
  mutationsEnabled: boolean;
  accountVersion: number;
  writerGeneration: number;
  writerDeviceId: string | null;
  writer: {
    status: "free" | "mine" | "other";
    generation: number;
    lastActivityAt: number;
  };
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

export type BlackMarketOrderKind = "BUY_ZOMBIE" | "SELL_ZOMBIE";
export type BlackMarketOrderStatus = "OPEN" | "FULFILLED" | "CANCELLED";
/** What a post is priced in. Chosen per post by whoever created it, and fixed for the
 *  life of that post — escrow, settlement and payout all move the same currency. */
export type BlackMarketCurrency = "BRAINS" | "GOLD";

export interface BlackMarketOrderView {
  id: string;
  kind: BlackMarketOrderKind;
  zombieKey: string;
  mutated: boolean;
  /** Mutation-choice mask requested by a BUY_ZOMBIE order. Bits within one body
   * slot are OR alternatives; requirements across different slots are ANDed. */
  mutationRequired?: number;
  mutation?: number;
  invasions?: number;
  /** The listed zombie's body tint, so its card looks like the unit it describes
   *  rather than a stock member of the species. SELL_ZOMBIE only; absent means the
   *  catalog colour. */
  color?: [number, number, number];
  /** The asking price, in `currency`. */
  price: number;
  currency: BlackMarketCurrency;
  /** @deprecated Mirror of `price`, kept so a client cached from before gold posts
   *  existed still renders a number. Read `price` + `currency`. */
  priceBrains: number;
  status: BlackMarketOrderStatus;
  createdAt: number;
  /** When this post drops off the board and its escrow goes home (createdAt + three
   *  days). A repost restarts it. Absent from an older Worker's response. */
  expiresAt?: number;
  /** The earliest its creator may bump it back to the top of "newest" (createdAt +
   *  the repost cooldown). Only meaningful on `mine`. Absent from an older Worker. */
  repostableAt?: number;
  creatorName: string;
  mine: boolean;
}

export interface BlackMarketSummary {
  activePosts: number;
  postsToday: number;
  activeLimit: 10;
  dailyLimit: 50;
  /** Currency the market is holding for this account: sales that settled while they were
   *  away and have not been collected yet, split by what they were priced in. Optional —
   *  an older deployed Worker omits them, and the panel simply shows no held total. */
  heldBrains?: number;
  heldGold?: number;
  serverTime: number;
}

export interface BlackMarketListResponse {
  orders: BlackMarketOrderView[];
  nextCursor: string | null;
  summary: BlackMarketSummary;
}

export interface BlackMarketMutationResponse {
  ok: true;
  order: BlackMarketOrderView;
  summary: BlackMarketSummary;
}

/** One of the caller's own orders that a counterparty fulfilled and the caller has
 * not yet collected. Collecting is what hands over what the trade owes them: the
 * zombie (`awaitingClaim`) and/or the payment the market is holding for a sale
 * (`awaitingPayout`). With neither flag the card is a pure notice. */
export interface BlackMarketFulfillmentView {
  id: string;
  kind: BlackMarketOrderKind;
  zombieKey: string;
  mutated: boolean;
  /** The traded unit's details — the sale's escrowed zombie, or the one delivered
   * for a filled request. Absent only on trades that predate delivered-unit
   * recording (migration 0033). */
  mutation?: number;
  invasions?: number;
  /** The traded unit's body tint. Absent on trades settled before it was recorded
   *  (migration 0041), and on any unit that never had one. */
  color?: [number, number, number];
  price: number;
  currency: BlackMarketCurrency;
  /** @deprecated Mirror of `price`; see BlackMarketOrderView. */
  priceBrains: number;
  createdAt: number;
  fulfilledAt: number;
  /** Display name of the OTHER player in the trade, whichever side the viewer is on. */
  fulfilledBy: string;
  /** This card owes the viewer the traded zombie: the trade settled, but the unit
   *  waits on the order until they collect it. Collecting is what mints it, and it is
   *  refused while their farm and Mausoleum are both full. Absent on the pure
   *  brains-earned card an older Worker is the only source of. */
  awaitingClaim?: boolean;
  /** This card owes the viewer `price` in `currency`: their sale settled and the market
   *  is holding the payment until they collect it (migration 0043). Absent on a card
   *  whose payment already landed — including every trade older than that change. */
  awaitingPayout?: boolean;
}

export interface BlackMarketFulfillmentsResponse {
  fulfillments: BlackMarketFulfillmentView[];
}

/** A zombie that a collect just minted into the caller's roster. */
export interface ClaimedUnit {
  unitId: string;
  zombieKey: string;
  mutation: number;
  invasions: number;
  /** True when the army was full and it went to the Mausoleum instead. */
  stored: boolean;
}

export interface BlackMarketCollectResponse {
  ok: true;
  alreadyCollected: boolean;
  /** Set when this collect took delivery of a zombie, so the client knows to refresh
   *  its authoritative roster (and can say where the unit landed). */
  claimed?: ClaimedUnit;
  /** Currency this collect actually paid out of the market (a settled sale), in whichever
   *  the sale was priced in. Absent when there was none to pay — including a repeat
   *  collect, which pays nothing. */
  brainsPaid?: number;
  goldPaid?: number;
  /** The account's authoritative balance, echoed so collecting shows the brains the
   *  trade already paid. Settlement credits them when the OTHER player fulfils the
   *  order, so without this the creator's client keeps a stale balance until its next
   *  bootstrap or command batch. Optional: an older deployed Worker omits it, and the
   *  client falls back to an explicit refresh. */
  balance?: BalanceProjection;
}

/** One completed trade from the caller's perspective (they were creator OR
 * fulfiller of the order). */
export interface BlackMarketHistoryEntry {
  id: string;
  kind: BlackMarketOrderKind;
  /** True when the caller created the post; false when they fulfilled it. */
  mine: boolean;
  /** True when the caller received the payment (they sold a zombie either via
   * their own sale post or by filling someone's request). */
  earned: boolean;
  zombieKey: string;
  /** The delivered unit's mutation mask. Null on filled requests that predate
   * delivered-unit recording (migration 0033). */
  mutation: number | null;
  invasions: number;
  /** The delivered unit's body tint. Absent on trades that predate migration 0041
   *  and on units that never had one. */
  color?: [number, number, number];
  price: number;
  currency: BlackMarketCurrency;
  /** @deprecated Mirror of `price`; see BlackMarketOrderView. */
  priceBrains: number;
  /** Display name of the other party in the trade. */
  counterparty: string;
  fulfilledAt: number;
}

/** Lifetime aggregates over ALL of the caller's completed trades (not just the
 * page of entries returned alongside). */
export interface BlackMarketBestSale {
  zombieKey: string;
  price: number;
  currency: BlackMarketCurrency;
  /** @deprecated Mirror of `price`; see BlackMarketOrderView. */
  priceBrains: number;
  mutation: number | null;
}

export interface BlackMarketTradeStats {
  sold: {
    count: number;
    brains: number;
    gold: number;
    /** Biggest single sale in each currency. Two amounts in different currencies are
     *  not comparable, so there is no single "best trade" to report — `best` is the
     *  brains one (the only kind that existed before gold posts) and `bestGold` its
     *  counterpart. Either is null when they have never earned that currency here. */
    best: BlackMarketBestSale | null;
    bestGold: BlackMarketBestSale | null;
  };
  bought: { count: number; brains: number; gold: number };
  mostTraded: { zombieKey: string; count: number } | null;
}

export interface BlackMarketHistoryResponse {
  stats: BlackMarketTradeStats;
  /** Most recent completed trades, newest first (capped server-side). */
  entries: BlackMarketHistoryEntry[];
}

import type { GameState } from "../GameState";
import * as api from "./api";
import { CommandQueue } from "./commandQueue";
import type { BootstrapResponse, CommandBatchResponse, GameplayCommand } from "./protocol";

export interface InventoryInput {
  type: "buy" | "use" | "grant";
  key: string;
  qty?: number;
  unitId?: string;
  localZombieHarvests?: { id: string; oc: number; or: number }[];
  oc?: number;
  or?: number;
  target?: "zombie_pot";
}

export type RosterInput =
  | { type: "sell"; unitId: string }
  | { type: "grant"; unitId: string; key: string; mutation?: number; invasions?: number }
  | { type: "veteran"; unitIds: string[] }
  | { type: "casualty"; unitIds: string[] }
  | { type: "combineStart"; potId?: string; parentAId: string; parentBId: string; playerLevel?: number }
  | { type: "combineCollect"; potId?: string; unitId: string; key: string; mutation?: number };

export interface FarmActionInput {
  type: "plant" | "harvest" | "plow" | "remove";
  oc: number;
  or: number;
  cropKey?: string;
  fertilized?: boolean;
  unitId?: string;
}

interface OptimisticDelta {
  gold: number;
  brains: number;
  xp: number;
  inventoryKey?: string;
  inventoryCount?: number;
  localUnitId?: string;
  localZombieHarvests?: { id: string; oc: number; or: number }[];
  localObjectId?: string;
}

/** Compatibility facade used by the current gameplay code. Every non-raid method
 * feeds one protocol-v3 queue; none of these methods owns an HTTP stream anymore. */
export class EconomyClient {
  private readonly queue: CommandQueue;
  private base: api.Balance | null = null;
  private serverInv: Record<string, number> = {};
  private optimistic = new Map<number, OptimisticDelta>();
  private authoritativeUnitIds = new Map<string, string>();
  private deferredRosterAliases: Record<string, string> = {};
  private deferredObjectAliases: Record<string, string> = {};
  private deferredRejectedObjectIds = new Set<string>();
  private combineParents = new Map<string, {
    parentAId: string; parentBId: string; playerLevel?: number;
  }>();
  private commandsBySequence = new Map<number, GameplayCommand>();
  private ready = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempt = 0;

  onShopState: ((size: number, climates: string[]) => void) | null = null;
  onFarmerState: ((headIds: number[], equippedHeadId: number) => void) | null = null;
  onPetState: ((ownedPets: string[], activePet: string | null, penPets: string[]) => void) | null = null;
  onQuestState: ((state: api.QuestStateResult) => void) | null = null;
  onQuestChanges: ((changes: api.QuestChange[]) => void) | null = null;
  onCropFertilized: ((oc: number, or: number) => void) | null = null;
  onFarmState: ((farm: api.FarmState) => void) | null = null;
  onObjectState: ((objects: BootstrapResponse["gameplay"]["objects"]["objects"], aliases: Record<string, string>, baseZombieMax: number, rejectedLocalIds: string[]) => void) | null = null;
  onRosterState: ((roster: BootstrapResponse["gameplay"]["roster"], aliases: Record<string, string>) => void) | null = null;
  onRaidSettled: ((res: api.RaidFinishResult) => void) | null = null;
  onRaidRevival: ((offer: NonNullable<BootstrapResponse["gameplay"]["raidRevival"]>, brains: number) => void) | null = null;
  onEpicBossState: ((event: BootstrapResponse["gameplay"]["epicBoss"]) => void) | null = null;
  onTutorialState: ((rewarded: boolean) => void) | null = null;
  onGameplayUnavailable: ((reason: string) => void) | null = null;
  onWriterReplaced: (() => void) | null = null;
  onWriterAvailable: (() => void) | null = null;
  onCommandRejected: ((command: GameplayCommand | undefined, error: string) => void) | null = null;

  constructor(private state: GameState, accountId: string) {
    this.queue = new CommandQueue(accountId);
    this.queue.onProjection = (response) => this.adoptCommandResponse(response);
    this.queue.onUnavailable = (reason) => {
      this.onGameplayUnavailable?.(reason);
      this.scheduleRecovery();
    };
    this.queue.onWriterReplaced = () => this.onWriterReplaced?.();
    this.queue.onStateConflict = () => { void this.reloadAfterConflict(); };
    api.setWriterRejectedHandler(() => this.handleWriterLost());
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void this.checkOwnership();
      });
      // A different device cannot push a takeover notification into this page.
      // Poll the cheap writer projection so an idle displaced session discovers
      // its server-side revocation and returns to auth without waiting for input.
      setInterval(() => {
        if (document.visibilityState === "visible") void this.checkOwnership();
      }, 5_000);
    }
  }

  async start(): Promise<void> {
    try {
      let bootstrap = await api.bootstrap();
      // A missing token can be recovered without a takeover when this document
      // owns the browser-local lock and the server lease belongs to the same
      // session/client. A genuinely different browser still receives writer_active.
      if (bootstrap.writer.status !== "mine" && api.hasLocalWriterLock()) {
        try { await api.acquireWriter(bootstrap.writer.generation, false); }
        catch { /* another client may have acquired it between bootstrap and claim */ }
        bootstrap = await api.bootstrap(true);
      }
      // A page reload cannot resume the rendered battle scene. If bootstrap finds a
      // session left open by the previous page (for example, a short tutorial fight
      // whose delayed finish request was interrupted), settle it as a retreat before
      // exposing the farm. Otherwise both normal invasions and Epic Boss attempts stay
      // blocked until the session's 15-minute TTL expires.
      if (bootstrap.writer.status === "mine" && bootstrap.resumableRaid) {
        await api.raidFinish(bootstrap.resumableRaid.sessionId, 0, [
          { seq: 1, tick: 0, type: "retreat" },
        ]);
        bootstrap = await api.bootstrap(true);
      }
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay);
      if (bootstrap.writer.status === "mine") this.onWriterAvailable?.();
      else this.onWriterReplaced?.();
    } catch {
      this.ready = false;
      this.queue.disable("bootstrap_failed");
      this.scheduleRecovery();
    }
  }

  get available(): boolean { return this.ready && this.queue.available; }

  async takeOver(): Promise<boolean> {
    try {
      const current = await api.bootstrap(true);
      await api.acquireWriter(current.writer.generation, true);
      return true;
    } catch {
      return false;
    }
  }

  private handleWriterLost(): void {
    api.clearWriterCredential();
    this.queue.markWriterLost();
    this.optimistic.clear();
    this.commandsBySequence.clear();
    this.onWriterReplaced?.();
    void this.refreshReadOnly();
  }

  private async refreshReadOnly(): Promise<void> {
    try {
      const bootstrap = await api.bootstrap(true);
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay);
    } catch { /* the blocking state remains until a later focus/reconnect */ }
  }

  private async checkOwnership(): Promise<void> {
    if (!this.ready || !api.getSession()) return;
    try {
      const writer = await api.writerStatus();
      if (writer.status !== "mine") {
        this.handleWriterLost();
      }
    } catch { /* ordinary recovery owns network failure handling */ }
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer || typeof window === "undefined") return;
    const delays = [2_000, 5_000, 10_000, 30_000, 60_000];
    const delay = delays[Math.min(this.recoveryAttempt, delays.length - 1)];
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.recover();
    }, delay);
  }

  private async recover(): Promise<void> {
    try {
      const bootstrap = await api.bootstrap(true);
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay);
      if (!this.queue.available) {
        if (bootstrap.writer.status === "other") this.onWriterReplaced?.();
        return;
      }
      this.recoveryAttempt = 0;
      await this.queue.retry();
    } catch {
      this.recoveryAttempt++;
      this.scheduleRecovery();
    }
  }

  private async reloadAfterConflict(): Promise<void> {
    try {
      const bootstrap = await api.bootstrap(true);
      this.queue.rebaseAfterConflict(bootstrap);
      this.ready = true;
      this.optimistic.clear();
      this.adoptGameplay(bootstrap.gameplay);
      await this.queue.retry();
    } catch {
      this.onGameplayUnavailable?.("state_conflict");
    }
  }

  private enqueue(command: GameplayCommand, delta: Partial<OptimisticDelta> = {}): number | null {
    try {
      const sequence = this.queue.enqueue(command);
      this.commandsBySequence.set(sequence, command);
      this.optimistic.set(sequence, {
        gold: delta.gold ?? 0,
        brains: delta.brains ?? 0,
        xp: delta.xp ?? 0,
        inventoryKey: delta.inventoryKey,
        inventoryCount: delta.inventoryCount,
        localUnitId: delta.localUnitId,
        localZombieHarvests: delta.localZombieHarvests,
        localObjectId: delta.localObjectId,
      });
      this.reconcile();
      return sequence;
    } catch {
      this.onGameplayUnavailable?.("gameplay_unavailable");
      return null;
    }
  }

  /** Raw client-authored balance changes are intentionally not representable in v3.
   * Callers must use a semantic command or a server-derived quest/raid reward. */
  record(_currency: api.Currency, _delta: number, _reason: string): void {}

  submitFarm(input: FarmActionInput, optimistic: { gold?: number; brains?: number; xp?: number }): void {
    const command: GameplayCommand = input.type === "plant"
      ? { type: "farm.plant", oc: input.oc, or: input.or, cropKey: input.cropKey ?? "" }
      : input.type === "harvest"
        ? { type: "farm.harvest", oc: input.oc, or: input.or }
        : input.type === "remove"
          ? { type: "farm.remove", oc: input.oc, or: input.or }
          : { type: "farm.plow", oc: input.oc, or: input.or };
    this.enqueue(command, { ...optimistic, localUnitId: input.unitId });
  }

  submitInventory(input: InventoryInput, optimistic: { count: number; gold?: number; brains?: number }): void {
    if (input.type === "grant") return; // grants are emitted only by server subsystems
    const command: GameplayCommand = input.type === "buy"
      ? { type: "power.buy", key: input.key }
      : { type: "power.use", key: input.key, oc: input.oc, or: input.or, target: input.target };
    this.enqueue(command, {
      gold: optimistic.gold,
      brains: optimistic.brains,
      inventoryKey: input.key,
      inventoryCount: optimistic.count,
      localUnitId: input.unitId,
      localZombieHarvests: input.localZombieHarvests,
    });
  }

  submitPower(key: "insta_harvest" | "insta_plow"): void {
    this.enqueue({ type: "power.use", key }, { inventoryKey: key, inventoryCount: -1 });
  }

  submitRoster(input: RosterInput, optimistic: { gold?: number } = {}): void {
    if (input.type === "combineStart") {
      const potId = input.potId ?? "legacy";
      this.combineParents.set(potId, {
        parentAId: input.parentAId,
        parentBId: input.parentBId,
        playerLevel: input.playerLevel,
      });
      this.enqueue({
        type: "roster.combine_start",
        potId,
        parentAId: this.authoritativeUnitId(input.parentAId),
        parentBId: this.authoritativeUnitId(input.parentBId),
        ...(input.playerLevel === undefined ? {} : { playerLevel: input.playerLevel }),
      });
      return;
    }
    const potId = input.type === "combineCollect" ? input.potId ?? "legacy" : "legacy";
    const parents = input.type === "combineCollect" ? this.combineParents.get(potId) : undefined;
    if (input.type === "combineCollect" && parents) {
      this.enqueue({
        type: "roster.combine",
        potId,
        parentAId: this.authoritativeUnitId(parents.parentAId),
        parentBId: this.authoritativeUnitId(parents.parentBId),
        ...(parents.playerLevel === undefined ? {} : { playerLevel: parents.playerLevel }),
      }, { localUnitId: input.unitId });
      this.combineParents.delete(potId);
      return;
    }
    if (input.type === "sell") this.enqueue({ type: "roster.sell", unitId: this.authoritativeUnitId(input.unitId) }, optimistic);
    // Grants, casualties, and veterancy come from farm/raid results in v3.
  }
  submitRosterStatus(unitId: string, stored: boolean): void {
    this.enqueue({ type: "roster.status", unitId: this.authoritativeUnitId(unitId), stored });
  }

  restoreCombineParents(parentAId: string, parentBId: string): void;
  restoreCombineParents(potId: string, parentAId: string, parentBId: string, playerLevel?: number): void;
  restoreCombineParents(a: string, b: string, c?: string, playerLevel?: number): void {
    const [potId, parentAId, parentBId] = c === undefined ? ["legacy", a, b] : [a, b, c];
    this.combineParents.set(potId, { parentAId, parentBId, playerLevel });
  }

  async settleUnitIds(ids: string[]): Promise<string[]> {
    await this.settleBeforeDependency();
    return ids.map((id) => this.authoritativeUnitId(id));
  }

  submitObject(
    input: { type: "buy" | "refund"; key: string; instanceId?: string } |
      { type: "upgrade"; fromKey: string; toKey: string; instanceId?: string },
    optimistic: { gold?: number; brains?: number; xp?: number }
  ): void {
    if (input.type === "buy") this.enqueue(
      { type: "object.buy", catalogKey: input.key, clientInstanceId: input.instanceId },
      { ...optimistic, localObjectId: input.instanceId }
    );
    else if (input.type === "refund" && input.instanceId) this.enqueue({ type: "object.refund", instanceId: input.instanceId }, optimistic);
    else if (input.type === "upgrade") {
      if (input.instanceId) this.enqueue({ type: "object.upgrade", instanceId: input.instanceId, catalogKey: input.toKey }, optimistic);
    }
  }

  submitObjectStatus(instanceId: string, status: "placed" | "stored"): void {
    this.enqueue({ type: "object.status", instanceId, status });
  }

  submitTreeHarvest(instanceIds: string[], optimisticGold = 0, optimisticXp = 0): void {
    if (instanceIds.length) this.enqueue(
      { type: "object.harvest_trees", instanceIds },
      { gold: optimisticGold, xp: optimisticXp }
    );
  }

  submitStorageClaim(
    itemName: string,
    optimistic: { inventoryKey?: string; localObjectId?: string }
  ): boolean {
    return this.enqueue(
      { type: "storage.claim", itemName, clientInstanceId: optimistic.localObjectId },
      {
        inventoryKey: optimistic.inventoryKey,
        inventoryCount: optimistic.inventoryKey ? 1 : undefined,
        localObjectId: optimistic.localObjectId,
      }
    ) !== null;
  }

  submitShopSize(size: number, currency: "gold" | "brains", cost: number): boolean {
    return this.enqueue(
      { type: "shop.size", size, currency }, currency === "gold" ? { gold: -cost } : { brains: -cost }
    ) !== null;
  }

  submitFarmerBuy(headId: number, currency: "gold" | "brains", cost: number): boolean {
    return this.enqueue(
      { type: "farmer.buy", headId },
      currency === "gold" ? { gold: -cost } : { brains: -cost }
    ) !== null;
  }

  submitFarmerEquip(headId: number): boolean {
    return this.enqueue({ type: "farmer.equip", headId }) !== null;
  }

  submitPetBuy(petKey: string, cost: number, xp: number): boolean {
    return this.enqueue({ type: "pet.buy", petKey }, { brains: -cost, xp }) !== null;
  }

  submitPetEquip(petKey: string | null): boolean {
    return this.enqueue({ type: "pet.equip", petKey }) !== null;
  }

  submitPenPets(petKeys: string[]): boolean {
    return this.enqueue({ type: "pet.pen", petKeys }) !== null;
  }

  submitShopClimate(terrain: string, cost: number): boolean {
    return this.enqueue({ type: "shop.climate", terrain }, { gold: -cost }) !== null;
  }

  submitTutorialCompletion(): void {
    this.enqueue({ type: "tutorial.complete" }, { gold: 200 });
  }

  submitQuest(_questId: string): void {
    // Completion and reward happen inside the accepted command/raid transaction.
  }

  async submitRaid(
    sessionId: string,
    finalTick: number,
    inputs: api.RaidReplayInput[],
    outcome: import("../raid/types").RaidOutcome,
    _optimistic: { gold?: number; xp?: number }
  ): Promise<api.RaidFinishResult> {
    let result: api.RaidFinishResult | null = null;
    // Tutorial invasions can resolve before the server's minimum fight duration.
    // Retry-After is calculated on another clock, so waiting exactly that duration
    // can still arrive a few milliseconds early. Allow repeated 425s and include a
    // small scheduling margin so the session is always closed after a fast fight.
    for (let attempt = 0; attempt < 4 && !result; attempt++) {
      try {
        result = await api.raidFinish(sessionId, finalTick, inputs, outcome);
      } catch (error) {
        if (!(error instanceof api.ApiError) || error.status !== 425 || attempt === 3) throw error;
        const retryAfterMs = Number((error.body as { retryAfterMs?: unknown } | undefined)?.retryAfterMs);
        const delay = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) + 250 : 1_250;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    if (!result) throw new Error("raid_settlement_failed");
    this.base = result.balance;
    if (result.inventory) this.serverInv = { ...result.inventory };
    if (result.storage) this.state.syncStorage(result.storage.received, result.storage.stored);
    if (result.raidProgress) this.state.syncRaidProgress(result.raidProgress);
    this.state.syncRaidCooldown(result.lastRaidAt);
    this.onQuestChanges?.(result.questChanges ?? []);
    this.reconcile();
    this.onRaidSettled?.(result);
    return result;
  }

  async resolveRaidRevival(sessionId: string, reviveIds: string[]): Promise<api.RaidReviveResult> {
    const result = await api.raidRevive(sessionId, reviveIds);
    this.base = result.balance;
    this.reconcile();
    return result;
  }

  async flush(): Promise<void> { await this.queue.flush(); }
  async settleBeforeDependency(): Promise<void> {
    try {
      await this.queue.settle();
      return;
    } catch (error) {
      // A bootstrap/network failure can leave an otherwise empty durable queue paused.
      // Out-of-band mutations (gift claims, raids, Epic Boss actions) used to remain
      // blocked behind that stale flag even after connectivity returned. With no local
      // commands to preserve, a fresh bootstrap is a safe immediate recovery boundary.
      if (this.queue.size > 0) throw error;
    }

    const bootstrap = await api.bootstrap(true);
    this.queue.adoptBootstrap(bootstrap);
    this.ready = true;
    this.adoptGameplay(bootstrap.gameplay);
    if (bootstrap.writer.status !== "mine") {
      this.onWriterReplaced?.();
      throw new Error("writer_replaced");
    }
    // Re-check the queue state so maintenance mode, a protocol gate, or ownership
    // loss still blocks the external mutation instead of bypassing server authority.
    await this.queue.settle();
  }

  /** Establish a fresh CAS boundary for a direct cross-account mutation. Market
   * actions deliberately do not auto-replay after this version is observed. */
  async prepareExternalMutation(): Promise<number> {
    await this.queue.settle();
    const bootstrap = await api.bootstrap(true);
    this.queue.adoptBootstrap(bootstrap);
    this.ready = true;
    this.adoptGameplay(bootstrap.gameplay);
    if (bootstrap.writer.status !== "mine") throw new Error("writer_replaced");
    return bootstrap.accountVersion;
  }

  adoptRaidStartInventory(inventory: Record<string, number>): void {
    this.serverInv = { ...inventory };
    this.reconcile();
  }

  adoptEpicBossResult(result: api.EpicBossFinishResult): void {
    this.base = result.balance;
    this.serverInv = { ...result.inventory };
    this.state.syncStorage(result.storage.received, result.storage.stored);
    this.onPetState?.(result.ownedPets, this.state.activePet, this.state.penPets);
    this.onQuestState?.({ completed: result.quests.completed, progress: result.quests.progress, questChanges: result.questChanges });
    this.onQuestChanges?.(result.questChanges);
    this.onEpicBossState?.(result.event);
    this.reconcile();
  }

  adoptEpicBossActivation(event: NonNullable<BootstrapResponse["gameplay"]["epicBoss"]>, balance: api.Balance): void {
    this.base = balance;
    this.onEpicBossState?.(event);
    this.reconcile();
  }

  /** Translate an optimistic harvest id after its command has settled. */
  authoritativeUnitId(id: string): string {
    return this.authoritativeUnitIds.get(id) ?? id;
  }

  async refreshInventory(): Promise<void> {
    const bootstrap = await api.bootstrap(true);
    this.queue.adoptBootstrap(bootstrap);
    this.ready = true;
    this.adoptGameplay(bootstrap.gameplay);
  }
  async refreshAuthoritative(): Promise<void> { await this.refreshInventory(); }

  /** Adopt a balance returned by a trusted server-side mutation such as claiming a
   * social gift. Pending optimistic gameplay deltas remain layered on top. */
  adoptExternalBalance(balance: api.Balance, accountVersion?: number): void {
    this.base = { ...balance };
    if (accountVersion !== undefined) this.queue.adoptAccountVersion(accountVersion);
    this.reconcile();
  }

  // Reset means there is no client seed/import path. These remain as no-ops until
  // their call sites are removed from the presentation hydration code.
  async syncRoster(_units: api.RosterSeedUnit[]): Promise<void> {}
  async syncObjects(_counts: Record<string, number>): Promise<void> {}
  async syncFarm(_plowed: { oc: number; or: number }[]): Promise<void> {}
  async syncShop(_size: number, _climates: string[]): Promise<void> {}

  private adoptCommandResponse(response: CommandBatchResponse): void {
    const aliases: Record<string, string> = {};
    const objectAliases: Record<string, string> = {};
    const rejectedObjectIds: string[] = [];
    for (const result of response.results) {
      const pending = this.optimistic.get(result.sequence);
      const command = this.commandsBySequence.get(result.sequence);
      if ((result.status === "rejected" || result.status === "dependency_failed") && result.error) {
        if (command?.type === "roster.combine_start") this.combineParents.delete(command.potId);
        this.onCommandRejected?.(command, result.error);
      }
      if (pending?.localUnitId && result.status === "applied" && result.createdIds?.[0]) {
        aliases[result.createdIds[0]] = pending.localUnitId;
        this.authoritativeUnitIds.set(pending.localUnitId, result.createdIds[0]);
      }
      if (pending?.localZombieHarvests?.length && result.createdZombieSources?.length) {
        const localByPlot = new Map(pending.localZombieHarvests.map((item) => [`${item.oc}:${item.or}`, item.id]));
        for (const created of result.createdZombieSources) {
          const local = localByPlot.get(`${created.oc}:${created.or}`);
          if (!local) continue;
          aliases[created.id] = local;
          this.authoritativeUnitIds.set(local, created.id);
        }
      }
      if (pending?.localObjectId && result.status === "applied" && result.createdIds?.[0] &&
          result.createdIds[0] !== pending.localObjectId) {
        objectAliases[result.createdIds[0]] = pending.localObjectId;
      }
      if (pending?.localObjectId && (result.status === "rejected" || result.status === "dependency_failed")) {
        rejectedObjectIds.push(pending.localObjectId);
      }
      this.optimistic.delete(result.sequence);
      this.commandsBySequence.delete(result.sequence);
    }
    Object.assign(this.deferredRosterAliases, aliases);
    Object.assign(this.deferredObjectAliases, objectAliases);
    rejectedObjectIds.forEach((id) => this.deferredRejectedObjectIds.add(id));
    this.onQuestChanges?.(response.questChanges);
    this.adoptGameplay(response.gameplay, aliases, objectAliases, rejectedObjectIds);
  }

  private adoptGameplay(
    gameplay: BootstrapResponse["gameplay"],
    aliases: Record<string, string> = {},
    objectAliases: Record<string, string> = {},
    rejectedObjectIds: string[] = []
  ): void {
    this.base = gameplay.balance;
    this.serverInv = gameplay.inventory;
    this.state.zombiePotBought = gameplay.zombiePotBought ?? false;
    const deferStructural = this.commandsBySequence.size > 0;
    const plowed: api.FarmState["plowed"] = [];
    const crops: api.FarmState["crops"] = [];
    for (const [key, plot] of Object.entries(gameplay.farm.plots)) {
      const [oc, pr] = key.split(":").map(Number);
      if (plot.state === "plowed") plowed.push({ oc, pr });
      else if (plot.state === "planted") {
        crops.push({
          oc,
          pr,
          crop_key: plot.cropKey,
          planted_at: plot.plantedAt,
          grow_ms: plot.growMs,
          fertilized: plot.fertilized ? 1 : 0,
        });
      }
    }
    if (!deferStructural) {
      this.onShopState?.(gameplay.farmSize, gameplay.climates);
      this.onFarmerState?.(gameplay.farmerHeads, gameplay.farmerHeadId);
      this.onPetState?.(gameplay.ownedPets, gameplay.activePet, gameplay.penPets);
      this.onQuestState?.({
        completed: gameplay.quests.completed,
        progress: gameplay.quests.progress,
        questChanges: [],
      });
      this.state.syncStorage(gameplay.storage.received, gameplay.storage.stored);
      for (const crop of crops) if (crop.fertilized) this.onCropFertilized?.(crop.oc, crop.pr);
      this.onFarmState?.({ plowed, crops });
      this.onObjectState?.(
        gameplay.objects.objects,
        { ...this.deferredObjectAliases, ...objectAliases },
        gameplay.zombieMax,
        [...new Set([...this.deferredRejectedObjectIds, ...rejectedObjectIds])]
      );
      this.deferredObjectAliases = {};
      this.deferredRejectedObjectIds.clear();
      // Capture/display a pending revival before roster reconciliation removes the
      // casualties from the local presentation cache. The offer remains server-owned.
      if (gameplay.raidRevival) this.onRaidRevival?.(gameplay.raidRevival, gameplay.balance.brains);
      this.onRosterState?.(gameplay.roster, { ...this.deferredRosterAliases, ...aliases });
      this.deferredRosterAliases = {};
      this.onEpicBossState?.(gameplay.epicBoss ?? null);
      this.onTutorialState?.(gameplay.tutorialRewarded);
    }
    this.reconcile();
  }

  private reconcile(): void {
    if (!this.base) return;
    const balance = { ...this.base };
    const inventory = { ...this.serverInv };
    for (const delta of this.optimistic.values()) {
      balance.gold += delta.gold;
      balance.brains += delta.brains;
      balance.xp += delta.xp;
      if (delta.inventoryKey) inventory[delta.inventoryKey] = (inventory[delta.inventoryKey] ?? 0) + (delta.inventoryCount ?? 0);
    }
    this.state.syncBalance(balance.gold, balance.brains, balance.xp);
    this.state.syncInventory(inventory);
  }
}

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
  | { type: "combineStart"; parentAId: string; parentBId: string }
  | { type: "combineCollect"; unitId: string; key: string; mutation?: number };

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
  private combineParents: { parentAId: string; parentBId: string } | null = null;
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
  onGameplayUnavailable: ((reason: string) => void) | null = null;
  onWriterReplaced: (() => void) | null = null;
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
  }

  async start(): Promise<void> {
    try {
      const bootstrap = await api.bootstrap();
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay);
    } catch {
      this.ready = false;
      this.queue.disable("bootstrap_failed");
      this.scheduleRecovery();
    }
  }

  get available(): boolean { return this.ready && this.queue.available; }

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
      if (!this.queue.available) return; // another device owns the writer intentionally
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
      this.combineParents = { parentAId: input.parentAId, parentBId: input.parentBId };
      return;
    }
    if (input.type === "combineCollect" && this.combineParents) {
      this.enqueue({
        type: "roster.combine",
        parentAId: this.authoritativeUnitId(this.combineParents.parentAId),
        parentBId: this.authoritativeUnitId(this.combineParents.parentBId),
      }, { localUnitId: input.unitId });
      this.combineParents = null;
      return;
    }
    if (input.type === "sell") this.enqueue({ type: "roster.sell", unitId: this.authoritativeUnitId(input.unitId) }, optimistic);
    // Grants, casualties, and veterancy come from farm/raid results in v3.
  }
  submitRosterStatus(unitId: string, stored: boolean): void {
    this.enqueue({ type: "roster.status", unitId: this.authoritativeUnitId(unitId), stored });
  }

  restoreCombineParents(parentAId: string, parentBId: string): void {
    this.combineParents = { parentAId, parentBId };
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

  submitTreeHarvest(instanceIds: string[], optimisticGold = 0): void {
    if (instanceIds.length) this.enqueue({ type: "object.harvest_trees", instanceIds }, { gold: optimisticGold });
  }

  submitShopSize(size: number, currency: "gold" | "brains", cost: number): void {
    this.enqueue({ type: "shop.size", size, currency }, currency === "gold" ? { gold: -cost } : { brains: -cost });
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

  submitPetBuy(petKey: string, cost: number): boolean {
    return this.enqueue({ type: "pet.buy", petKey }, { brains: -cost }) !== null;
  }

  submitPetEquip(petKey: string | null): boolean {
    return this.enqueue({ type: "pet.equip", petKey }) !== null;
  }

  submitPenPets(petKeys: string[]): boolean {
    return this.enqueue({ type: "pet.pen", petKeys }) !== null;
  }

  submitShopClimate(terrain: string, cost: number): void {
    this.enqueue({ type: "shop.climate", terrain }, { gold: -cost });
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
    let result: api.RaidFinishResult;
    try {
      result = await api.raidFinish(sessionId, finalTick, inputs, outcome);
    } catch (error) {
      if (!(error instanceof api.ApiError) || error.status !== 425) throw error;
      const retryAfterMs = Number((error.body as { retryAfterMs?: unknown } | undefined)?.retryAfterMs);
      await new Promise<void>((resolve) => setTimeout(resolve, Number.isFinite(retryAfterMs) ? retryAfterMs : 1_000));
      result = await api.raidFinish(sessionId, finalTick, inputs, outcome); // exactly one scheduled retry; no polling
    }
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
  async settleBeforeDependency(): Promise<void> { await this.queue.settle(); }

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
    this.onShopState?.(gameplay.farmSize, gameplay.climates);
    this.onFarmerState?.(gameplay.farmerHeads, gameplay.farmerHeadId);
    this.onPetState?.(gameplay.ownedPets, gameplay.activePet, gameplay.penPets);
    this.onQuestState?.({
      completed: gameplay.quests.completed,
      progress: gameplay.quests.progress,
      questChanges: [],
    });
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
        if (plot.fertilized) this.onCropFertilized?.(oc, pr);
      }
    }
    this.onFarmState?.({ plowed, crops });
    this.onObjectState?.(gameplay.objects.objects, objectAliases, gameplay.zombieMax, rejectedObjectIds);
    // Capture/display a pending revival before roster reconciliation removes the
    // casualties from the local presentation cache. The offer remains server-owned.
    if (gameplay.raidRevival) this.onRaidRevival?.(gameplay.raidRevival, gameplay.balance.brains);
    this.onRosterState?.(gameplay.roster, aliases);
    this.onEpicBossState?.(gameplay.epicBoss ?? null);
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

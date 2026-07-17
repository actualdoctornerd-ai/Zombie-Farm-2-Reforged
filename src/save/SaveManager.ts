import { GameState } from "../GameState";
import { CropConfig, Field } from "../Field";
import { PlaceableDef } from "../assets";
import { WalkController } from "../WalkController";
import { ZombieField } from "../zombie/ZombieField";
import { QuestSystem } from "../quest/QuestSystem";
import { SaveGame, SAVE_VERSION, SAVE_KEY } from "./schema";
import { activeSaveKey } from "./profiles";
import * as api from "../net/api";
import { getFarmBackground } from "../prefs";
import { epicBossById } from "../epicBoss/catalog";

type PresentationData = {
  player?: { name?: string; farmer?: { col: number; row: number }; farmerAppearance?: SaveGame["player"]["farmerAppearance"] };
  farm?: { climate?: string; background?: SaveGame["farm"]["background"] };
  objectLayout?: { id: string; oc: number; or: number; rotation?: number }[];
  rosterLayout?: { id: string; pos?: { col: number; row: number }; stored?: boolean; color?: [number, number, number] }[];
  zombiePot?: SaveGame["zombiePot"];
  tutorial?: SaveGame["tutorial"];
  ui?: { attackOrder?: string[] };
};

/** Offline builds retain a local full save. Signed-in v3 builds persist only visual
 * presentation; authoritative gameplay is hydrated from the shared bootstrap call. */
export class SaveManager {
  private presentationVersion = 0;
  private lastPresentation = "";
  private presentationDirty = false;
  private pushing = false;
  private pendingPresentation: Record<string, unknown> | null = null;
  private pendingPresentationImmediate = false;
  private autoFlush: (() => void) | null = null;
  private scheduleSave: (() => void) | null = null;
  private lastPresentationCallAt = 0;
  private suspended = false;

  constructor(
    private state: GameState,
    private field: Field,
    private walk: WalkController,
    private zombies: ZombieField,
    private quests: QuestSystem,
    private catalog: Map<string, CropConfig>,
    private placeCatalog: Map<string, PlaceableDef>,
    private preload: (sprite: string) => Promise<unknown>
  ) {}

  private isOnline(): boolean { return api.isConfigured() && !!api.getSession(); }
  private cacheKey(): string {
    const session = api.getSession();
    return session ? `${SAVE_KEY}::${session.accountId}` : activeSaveKey();
  }

  hasSave(): boolean {
    try { return localStorage.getItem(this.cacheKey()) !== null; } catch { return false; }
  }

  serialize(): SaveGame {
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      player: {
        name: this.state.name,
        gold: this.state.gold,
        brains: this.state.brains,
        xp: this.state.xp,
        zombieMax: this.state.zombieMax,
        zombieCount: this.state.zombieCount,
        farmer: this.walk.tile,
        unlockedAbilities: this.state.unlockedAbilities,
        zombiePotBought: this.state.zombiePotBought,
        farmerAppearance: {
          ownedHeads: this.state.ownedFarmerHeads,
          ownedBodies: this.state.ownedFarmerBodies,
          headId: this.state.farmerHeadId,
          bodyId: this.state.farmerBodyId,
        },
        petCollection: { owned: this.state.ownedPets, active: this.state.activePet, pen: this.state.penPets },
      },
      farm: {
        fieldId: "default",
        w: this.field.w,
        h: this.field.h,
        climate: this.field.climate,
        background: getFarmBackground(),
        ownedClimates: this.state.ownedClimates,
        plots: this.field.serialize(),
      },
      objects: this.field.serializeObjects(),
      ownedZombies: this.zombies.serialize(),
      zombiePot: this.zombies.serializePot(),
      storage: { itemCap: this.state.storageItemCap, items: this.state.storedItems, received: this.state.received },
      boosts: this.state.boostInv,
      quests: this.quests.serialize(),
      raids: { completed: this.state.raidsCompleted, lastRaidAt: this.state.lastRaidAt, attackOrder: this.state.raidAttackOrder },
      epicBoss: this.state.epicBossRun ?? undefined,
      social: { friends: this.state.friends },
      tutorial: this.state.tutorial,
    };
  }

  private presentation(blob = this.serialize()): Record<string, unknown> {
    return {
      player: {
        name: blob.player.name,
        farmer: blob.player.farmer,
        farmerAppearance: {
          headId: blob.player.farmerAppearance?.headId,
          bodyId: blob.player.farmerAppearance?.bodyId,
        },
      },
      farm: { climate: blob.farm.climate, background: blob.farm.background },
      objectLayout: (blob.objects ?? []).map((o) => ({ id: o.id, oc: o.oc, or: o.or, rotation: o.rotation })),
      rosterLayout: (blob.ownedZombies ?? []).map((u) => ({ id: u.id, pos: u.pos, stored: u.stored, color: u.color })),
      zombiePot: blob.zombiePot,
      tutorial: blob.tutorial,
      ui: { attackOrder: blob.raids?.attackOrder ?? [] },
    };
  }

  flush(): void { this.autoFlush ? this.autoFlush() : this.save(); }
  /** Persist state that must survive an immediate reload (currently Zombie Pot jobs). */
  flushCritical(): void {
    const blob = this.serialize();
    if (!this.isOnline()) { this.writeLocal(blob); return; }
    const data = this.presentation(blob);
    try { localStorage.setItem(this.cacheKey(), JSON.stringify(data)); } catch { /* ignore */ }
    if (this.pushing) this.pendingPresentationImmediate = true;
    void this.push(data);
  }
  suspend(): void { this.suspended = true; }
  syncRev(_rev: number): void {}

  save(): void {
    if (this.suspended) return;
    const blob = this.serialize();
    if (!this.isOnline()) {
      this.writeLocal(blob);
      return;
    }
    // Gameplay code calls save() at many semantic boundaries. In v3 those calls only
    // mark presentation dirty; they must not bypass the fixed one-minute deadline.
    if (this.scheduleSave) {
      this.scheduleSave();
      return;
    }
    this.commitPresentation(blob);
  }

  private commitPresentation(blob = this.serialize()): void {
    if (this.suspended || !this.isOnline()) return;
    const data = this.presentation(blob);
    const encoded = JSON.stringify(data);
    if (encoded === this.lastPresentation && !this.presentationDirty) return;
    this.presentationDirty = true;
    try { localStorage.setItem(this.cacheKey(), encoded); } catch { /* ignore */ }
    void this.push(data);
  }

  private writeLocal(blob: SaveGame): void {
    try { localStorage.setItem(this.cacheKey(), JSON.stringify(blob)); } catch (error) { console.warn("[save] local write failed", error); }
  }

  private async push(data: Record<string, unknown>): Promise<void> {
    if (this.pushing) { this.pendingPresentation = data; return; }
    this.pushing = true;
    this.lastPresentationCallAt = Date.now();
    try {
      const saved = await api.putPresentationV3({ protocolVersion: 3, expectedVersion: this.presentationVersion, data });
      this.presentationVersion = saved.version;
      this.lastPresentation = JSON.stringify(data);
      this.presentationDirty = false;
    } catch (error) {
      this.presentationDirty = true;
      if (error instanceof api.ApiError && error.status === 409) console.warn("[presentation] conflict; reload required");
    } finally {
      this.pushing = false;
      const next = this.pendingPresentation;
      this.pendingPresentation = null;
      if (next) {
        this.presentationDirty = true;
        if (this.pendingPresentationImmediate) {
          this.pendingPresentationImmediate = false;
          void this.push(next);
        } else this.scheduleSave?.();
      }
    }
  }

  async load(): Promise<boolean> {
    if (this.isOnline()) {
      try {
        const boot = await api.bootstrap();
        this.presentationVersion = boot.presentation.version;
        this.lastPresentation = JSON.stringify(boot.presentation.data);
        await this.applySave(this.fromBootstrap(boot));
        try { localStorage.setItem(this.cacheKey(), this.lastPresentation); } catch { /* ignore */ }
        return Object.keys(boot.gameplay.farm.plots).length > 0 || boot.gameplay.objects.objects.length > 0 || boot.gameplay.roster.length > 0;
      } catch (error) {
        console.warn("[bootstrap] authoritative load failed; gameplay remains unavailable", error);
        return false;
      }
    }
    return this.loadLocal();
  }

  private fromBootstrap(boot: Awaited<ReturnType<typeof api.bootstrap>>): SaveGame {
    const p = boot.presentation.data as PresentationData;
    const objectLayout = new Map((p.objectLayout ?? []).map((o) => [o.id, o]));
    const rosterLayout = new Map((p.rosterLayout ?? []).map((u) => [u.id, u]));
    const plots = Object.entries(boot.gameplay.farm.plots).map(([key, plot]) => {
      const [oc, or] = key.split(":").map(Number);
      if (plot.state === "plowed") return { oc, or, state: "plowed" as const };
      if (plot.state === "spent") return { oc, or, state: plot.zombie ? "hole" as const : "dirt" as const };
      return { oc, or, state: "planted" as const, crop: {
        key: plot.cropKey, isZombie: plot.zombie, plantedAt: plot.plantedAt,
        growMs: plot.growMs, fertilized: plot.fertilized,
      } };
    });
    const objects = boot.gameplay.objects.objects.flatMap((obj) => {
      if (obj.status !== "placed") return [];
      const layout = objectLayout.get(obj.instanceId);
      return [{ id: obj.instanceId, key: obj.catalogKey, oc: layout?.oc ?? 0, or: layout?.or ?? 0,
        rotation: layout?.rotation, readyAt: obj.readyAt }];
    });
    const pot = p.zombiePot?.parentAId && p.zombiePot.parentBId ? p.zombiePot : undefined;
    const hiddenPotParents = new Set(
      pot?.parentAId && pot?.parentBId ? [pot.parentAId, pot.parentBId] : []
    );
    const roster = boot.gameplay.roster.filter((unit) => !hiddenPotParents.has(unit.id)).map((unit) => {
      const layout = rosterLayout.get(unit.id);
      return { id: unit.id, key: unit.key, mutation: unit.mutation, invasions: unit.invasions,
        stored: unit.stored, pos: layout?.pos, color: layout?.color };
    });
    return {
      version: SAVE_VERSION,
      savedAt: boot.serverTime,
      player: {
        name: p.player?.name ?? "Zombie Farmer",
        ...boot.gameplay.balance,
        zombieMax: boot.gameplay.zombieMax,
        zombieCount: roster.filter((u) => !u.stored).length,
        farmer: p.player?.farmer,
        farmerAppearance: {
          ...p.player?.farmerAppearance,
          ownedHeads: boot.gameplay.farmerHeads,
          headId: boot.gameplay.farmerHeadId,
        },
        petCollection: { owned: boot.gameplay.ownedPets, active: boot.gameplay.activePet, pen: boot.gameplay.penPets },
      },
      farm: { fieldId: "default", w: boot.gameplay.farmSize, h: boot.gameplay.farmSize,
        climate: p.farm?.climate ?? "grass", background: p.farm?.background,
        ownedClimates: boot.gameplay.climates, plots },
      objects,
      ownedZombies: roster,
      zombiePot: pot,
      storage: {
        itemCap: 8,
        items: Object.entries(boot.gameplay.storage.stored).map(([key, count]) => ({ key, count })),
        received: Object.entries(boot.gameplay.storage.received).flatMap(([key, count]) => Array(count).fill(key)),
      },
      boosts: Object.entries(boot.gameplay.inventory).map(([key, count]) => ({ key, count })),
      quests: { active: boot.gameplay.quests.progress.map((q) => ({ id: q.questId, counts: q.counts })), completed: boot.gameplay.quests.completed },
      raids: { completed: boot.gameplay.raids.progress, lastRaidAt: boot.gameplay.raids.lastRaidAt, attackOrder: p.ui?.attackOrder ?? [] },
      epicBoss: boot.gameplay.epicBoss ?? undefined,
      social: { friends: boot.social.friends.map((friend) => ({ id: friend.accountId, name: friend.name, addedAt: boot.serverTime, giftsSent: 0 })) },
      tutorial: p.tutorial,
    };
  }

  private async loadLocal(): Promise<boolean> {
    let raw: string | null = null;
    try { raw = localStorage.getItem(this.cacheKey()); } catch { return false; }
    if (!raw) return false;
    try {
      const data = JSON.parse(raw) as SaveGame;
      if (data.version !== SAVE_VERSION) return false;
      await this.applySave(data);
      return true;
    } catch { return false; }
  }

  private async applySave(data: SaveGame): Promise<void> {
    const player = data.player;
    this.state.apply({ name: player.name, gold: player.gold, brains: player.brains, xp: player.xp,
      zombieCount: player.zombieCount, zombieMax: Math.max(16, player.zombieMax || 16) });
    this.state.unlockedAbilities = player.unlockedAbilities ?? [];
    this.state.zombiePotBought = player.zombiePotBought ?? false;
    this.state.ownedFarmerHeads = player.farmerAppearance?.ownedHeads ?? [];
    this.state.ownedFarmerBodies = player.farmerAppearance?.ownedBodies ?? [];
    this.state.farmerHeadId = player.farmerAppearance?.headId ?? 1;
    this.state.farmerBodyId = player.farmerAppearance?.bodyId ?? 0;
    const legacyPets = data.storage?.pets ?? [];
    this.state.syncPetOwnership(
      player.petCollection?.owned ?? legacyPets,
      player.petCollection?.active ?? legacyPets[0] ?? null,
      player.petCollection?.pen ?? [],
    );
    if (data.storage) {
      this.state.storageItemCap = data.storage.itemCap ?? 8;
      this.state.storedItems = data.storage.items ?? [];
      this.state.received = data.storage.received ?? [];
    }
    this.state.boostInv = data.boosts ?? [];
    this.state.raidsCompleted = data.raids?.completed ?? {};
    this.state.lastRaidAt = data.raids?.lastRaidAt ?? 0;
    this.state.raidAttackOrder = data.raids?.attackOrder ?? [];
    this.state.epicBossRun = data.epicBoss ? { ...data.epicBoss, attackOrder: [...data.epicBoss.attackOrder] } : null;
    this.state.friends = (data.social?.friends ?? []).map((friend) => ({ ...friend, giftsSent: friend.giftsSent ?? 0 }));
    this.state.tutorial = data.tutorial;
    if (data.farm.w && data.farm.h) this.field.resize(data.farm.w, data.farm.h);
    this.state.ownedClimates = data.farm.ownedClimates ?? ["grass"];
    if (!this.state.ownedClimates.includes("grass")) this.state.ownedClimates.unshift("grass");
    this.field.setClimate(data.farm.climate ?? "grass");
    this.field.restore(data.farm.plots, (key) => this.catalog.get(key));
    const objects = data.objects ?? [];
    await Promise.all(objects.flatMap((object) => {
      const def = this.placeCatalog.get(object.key);
      if (!def) return [];
      return [this.preload(def.sprite), ...(def.growingSprite ? [this.preload(def.growingSprite)] : [])];
    }));
    this.field.restoreObjects(objects, (key) => this.placeCatalog.get(key));
    this.zombies.restore(data.ownedZombies ?? []);
    this.zombies.restorePot(data.zombiePot);
    const epicRun = this.state.epicBossRun;
    const epicDef = epicBossById(epicRun?.bossId);
    const epicActive = !!epicRun && !epicRun.completedAt && Date.now() < epicRun.expiresAt;
    this.quests.setEpicBossActive(epicActive, epicActive ? epicDef?.questIds ?? [] : []);
    this.quests.restore(data.quests);
    if (player.farmer) this.walk.teleport(player.farmer.col, player.farmer.row);
  }

  async hydrateReadOnly(save: SaveGame): Promise<void> { await this.applySave(save); }
  clear(): void { try { localStorage.removeItem(this.cacheKey()); } catch { /* ignore */ } }

  enableAutosave(localMs = 250, remoteMs = 60_000): void {
    let localTimer = 0;
    let remoteTimer = 0;
    let dirtySince = 0;
    const flushLocal = () => {
      if (this.isOnline()) {
        try { localStorage.setItem(this.cacheKey(), JSON.stringify(this.presentation())); } catch { /* ignore */ }
      } else this.writeLocal(this.serialize());
    };
    const fireRemote = () => { remoteTimer = 0; dirtySince = 0; this.commitPresentation(); };
    const schedule = () => {
      const encoded = JSON.stringify(this.presentation());
      if (this.isOnline() && encoded === this.lastPresentation) return;
      clearTimeout(localTimer);
      localTimer = window.setTimeout(flushLocal, localMs);
      if (!this.isOnline()) return;
      if (!dirtySince) dirtySince = Date.now();
      if (!remoteTimer) {
        const sinceDirty = remoteMs - (Date.now() - dirtySince);
        const sinceCall = remoteMs - (Date.now() - this.lastPresentationCallAt);
        remoteTimer = window.setTimeout(fireRemote, Math.max(0, sinceDirty, sinceCall));
      }
    };
    this.scheduleSave = schedule;
    this.autoFlush = () => {
      clearTimeout(localTimer);
      clearTimeout(remoteTimer);
      remoteTimer = 0;
      flushLocal();
      const remaining = remoteMs - (Date.now() - this.lastPresentationCallAt);
      if (remaining <= 0) {
        dirtySince = 0;
        this.commitPresentation();
      } else {
        if (!dirtySince) dirtySince = Date.now();
        remoteTimer = window.setTimeout(fireRemote, remaining);
      }
    };
    this.state.onChange(schedule);
    window.addEventListener("beforeunload", () => this.autoFlush?.());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") this.autoFlush?.(); });
    window.addEventListener("online", () => { if (this.presentationDirty) void this.push(this.presentation()); });
  }
}

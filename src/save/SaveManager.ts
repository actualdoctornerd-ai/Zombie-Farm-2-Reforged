// Serializes the live game (GameState + Field + farmer position) into a SaveGame
// blob in localStorage, and restores it on load. Single-slot, no server.
//
// Autosave is driven off GameState.onChange (debounced): every farm mutation
// (plow/plant/harvest) also moves a currency or XP, so a state change reliably
// follows any change worth persisting. A beforeunload flush captures the final
// state (including the farmer's resting tile). The JobSystem queue is NOT saved
// — in-flight actions are cheap to redo and messy to restore mid-hoe.
import { GameState } from "../GameState";
import { CropConfig, Field } from "../Field";
import { PlaceableDef } from "../assets";
import { WalkController } from "../WalkController";
import { ZombieField } from "../zombie/ZombieField";
import { QuestSystem } from "../quest/QuestSystem";
import { SaveGame, SAVE_VERSION } from "./schema";
import { activeSaveKey } from "./profiles";

export class SaveManager {
  constructor(
    private state: GameState,
    private field: Field,
    private walk: WalkController,
    private zombies: ZombieField,
    private quests: QuestSystem,
    private catalog: Map<string, CropConfig>,
    private placeCatalog: Map<string, PlaceableDef>,
    // Lazily loads a placed object's texture before it's rendered on restore.
    private preload: (sprite: string) => Promise<unknown>
  ) {}

  hasSave(): boolean {
    try {
      return localStorage.getItem(activeSaveKey()) !== null;
    } catch {
      return false;
    }
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
      },
      farm: {
        fieldId: "default",
        w: this.field.w,
        h: this.field.h,
        climate: this.field.climate,
        ownedClimates: this.state.ownedClimates,
        plots: this.field.serialize(),
      },
      objects: this.field.serializeObjects(),
      ownedZombies: this.zombies.serialize(),
      zombiePot: this.zombies.serializePot(),
      storage: {
        itemCap: this.state.storageItemCap,
        items: this.state.storedItems,
        received: this.state.received,
      },
      boosts: this.state.boostInv,
      quests: this.quests.serialize(),
      raids: {
        completed: this.state.raidsCompleted,
        lastRaidAt: this.state.lastRaidAt,
        attackOrder: this.state.raidAttackOrder,
      },
    };
  }

  // When suspended, save() is a no-op. Used when switching profiles: after the
  // current game is flushed and the ACTIVE profile pointer is moved, this page
  // must not write again (its in-memory game belongs to the OLD profile) — else
  // the debounced autosave or the beforeunload flush would clobber the profile
  // we're switching INTO with the outgoing game's state.
  private suspended = false;
  suspend() {
    this.suspended = true;
  }

  save() {
    if (this.suspended) return;
    try {
      localStorage.setItem(activeSaveKey(), JSON.stringify(this.serialize()));
    } catch (e) {
      console.warn("[save] write failed", e);
    }
  }

  // Load and apply a save. Returns true if a valid save was restored, false if
  // there was none (or it was corrupt / a version we don't handle → fresh start).
  async load(): Promise<boolean> {
    let raw: string | null;
    try {
      raw = localStorage.getItem(activeSaveKey());
    } catch {
      return false;
    }
    if (!raw) return false;

    let data: SaveGame;
    try {
      data = JSON.parse(raw) as SaveGame;
    } catch {
      console.warn("[save] corrupt JSON; starting fresh");
      return false;
    }
    if (data.version !== SAVE_VERSION) {
      // No prior versions exist yet; add migrations here when the schema grows.
      console.warn(
        `[save] version ${data.version} != ${SAVE_VERSION}; starting fresh`
      );
      return false;
    }

    const p = data.player;
    this.state.apply({
      name: p.name,
      gold: p.gold,
      brains: p.brains,
      xp: p.xp,
      zombieCount: p.zombieCount,
      zombieMax: p.zombieMax,
    });
    this.state.unlockedAbilities = p.unlockedAbilities ?? [];
    if (data.storage) {
      this.state.storageItemCap = data.storage.itemCap ?? 8;
      this.state.storedItems = data.storage.items ?? [];
      this.state.received = data.storage.received ?? [];
    }
    this.state.boostInv = data.boosts ?? [];
    this.state.raidsCompleted = data.raids?.completed ?? {};
    this.state.lastRaidAt = data.raids?.lastRaidAt ?? 0;
    this.state.raidAttackOrder = data.raids?.attackOrder ?? [];
    // Grow the field to the saved size BEFORE restoring plots/objects, so plots on
    // land added by a Farm Size upgrade validate against the expanded bounds
    // (otherwise Field.restore would drop them as out-of-range). Never shrinks.
    if (data.farm.w && data.farm.h) this.field.resize(data.farm.w, data.farm.h);
    // Ground/climate skin: owned set + the currently-applied terrain.
    this.state.ownedClimates = data.farm.ownedClimates ?? ["grass"];
    if (!this.state.ownedClimates.includes("grass")) this.state.ownedClimates.unshift("grass");
    this.field.setClimate(data.farm.climate ?? "grass");
    this.field.restore(data.farm.plots, (key) => this.catalog.get(key));
    // Preload the saved objects' textures (lazy) before rebuilding them.
    const objs = data.objects ?? [];
    await Promise.all(
      objs.flatMap((o) => {
        const def = this.placeCatalog.get(o.key);
        if (!def) return [];
        const loads = [this.preload(def.sprite)];
        if (def.growingSprite) loads.push(this.preload(def.growingSprite));
        return loads;
      })
    );
    this.field.restoreObjects(objs, (key) => this.placeCatalog.get(key));
    this.zombies.restore(data.ownedZombies ?? []);
    this.zombies.restorePot(data.zombiePot);
    // Restore quest progress AFTER state (level gates) and the roster are applied,
    // so activation checks see the correct level/context.
    this.quests.restore(data.quests);
    if (p.farmer) this.walk.teleport(p.farmer.col, p.farmer.row);
    return true;
  }

  clear() {
    try {
      localStorage.removeItem(activeSaveKey());
    } catch {
      /* ignore */
    }
  }

  // Wire up autosave. Call AFTER load() so hydration doesn't trigger a redundant
  // write. Debounces bursts (e.g. drag-planting a row) into one write.
  enableAutosave(delayMs = 800) {
    let timer = 0;
    const schedule = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => this.save(), delayMs);
    };
    this.state.onChange(schedule);
    window.addEventListener("beforeunload", () => this.save());
  }
}

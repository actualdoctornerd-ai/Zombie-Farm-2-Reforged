// Serializes the live game (GameState + Field + farmer position) and persists it.
//
// Two tiers, and the online tier is PURELY ADDITIVE:
//   • Local (always): a debounced write to localStorage — the offline cache and
//     the sole store when signed out or no server is configured. Same behavior as
//     the original no-server game.
//   • Server (when signed in + VITE_API_URL set): the Cloudflare Worker is the
//     ground truth. load() pulls it; save() also pushes it (rev-guarded). On a
//     409 (another device wrote) local autosave-to-server pauses until a reload
//     reconciles; on a network error the write is retried (outbox) on reconnect.
//
// Autosave is driven off GameState.onChange (debounced). The JobSystem queue is
// NOT saved — in-flight actions are cheap to redo and messy to restore mid-hoe.
import { GameState } from "../GameState";
import { CropConfig, Field } from "../Field";
import { PlaceableDef } from "../assets";
import { WalkController } from "../WalkController";
import { ZombieField } from "../zombie/ZombieField";
import { QuestSystem } from "../quest/QuestSystem";
import { SaveGame, SAVE_VERSION, SAVE_KEY } from "./schema";
import { activeSaveKey } from "./profiles";
import * as api from "../net/api";

export class SaveManager {
  /** Server rev of the last save we loaded/wrote (0 = none). Drives 409 guarding. */
  private rev = 0;
  private pushing = false;
  private pendingBlob: SaveGame | null = null;
  /** A newer server save exists (another device); pause server autosave til reload. */
  private conflicted = false;
  /** A server push failed offline; retry on the next change / reconnect. */
  private dirty = false;

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

  /** Signed in AND a server configured → the server tier is active. */
  private isOnline(): boolean {
    return api.isConfigured() && !!api.getSession();
  }

  /** Where the local cache lives: per-account when signed in (so two Google
   *  accounts on one device don't collide), else the local profile slot. */
  private cacheKey(): string {
    const s = api.getSession();
    return s ? `${SAVE_KEY}::acct::${s.accountId}` : activeSaveKey();
  }

  hasSave(): boolean {
    try {
      return localStorage.getItem(this.cacheKey()) !== null;
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
      social: { friends: this.state.friends },
    };
  }

  // When suspended, save() is a no-op. Used when switching profiles / signing out:
  // after the current game is flushed and the active pointer is moved, this page
  // must not write again (its in-memory game belongs to the OLD identity) — else
  // the debounced autosave or beforeunload flush would clobber the one we switch to.
  private suspended = false;
  suspend() {
    this.suspended = true;
  }

  save() {
    if (this.suspended) return;
    const blob = this.serialize();
    this.writeLocal(blob);
    if (this.isOnline()) void this.push(blob);
  }

  /** Adopt a server rev after an out-of-band server-side write (e.g. a gift claim
   *  credited the save server-side). The next push then bases off this rev, so it
   *  isn't rejected as stale. Clears any prior conflict since we're now in sync. */
  syncRev(rev: number) {
    this.rev = rev;
    this.conflicted = false;
  }

  private writeLocal(blob: SaveGame) {
    try {
      localStorage.setItem(this.cacheKey(), JSON.stringify(blob));
    } catch (e) {
      console.warn("[save] local write failed", e);
    }
  }

  // Push the blob to the server, guarded by rev. Serializes concurrent pushes
  // (keeps only the latest pending) and handles conflict / offline outcomes.
  private async push(blob: SaveGame) {
    if (this.conflicted) return;
    if (this.pushing) {
      this.pendingBlob = blob;
      return;
    }
    this.pushing = true;
    try {
      const { rev } = await api.putSave(blob, this.rev);
      this.rev = rev;
      this.dirty = false;
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) {
        this.conflicted = true;
        console.warn(
          "[save] a newer save exists on the server (another device). " +
            "Server autosave paused; reload to sync."
        );
      } else if (e instanceof api.ApiError && e.status === 401) {
        // Session went away; api already cleared it. Drop to local-only silently.
      } else {
        this.dirty = true; // offline/other → retry on next change or reconnect
      }
    } finally {
      this.pushing = false;
      const next = this.pendingBlob;
      this.pendingBlob = null;
      if (next && !this.conflicted) void this.push(next);
    }
  }

  // Load and apply a save. Returns true if a valid save was restored, false if
  // there was none (or it was corrupt / a version we don't handle → fresh start).
  async load(): Promise<boolean> {
    // Online: the server is ground truth.
    if (this.isOnline()) {
      try {
        const res = await api.getSave();
        const data = res.save && this.validate(res.save);
        if (data) {
          this.rev = res.rev;
          await this.applySave(data);
          this.writeLocal(data);
          return true;
        }
        // Account has no server save yet → a genuinely fresh account. Start clean
        // from its own (empty) cache; do NOT adopt the device's offline farm — that
        // would bleed one player's farm into another account on a shared browser.
        this.rev = 0;
        return await this.loadLocal();
      } catch (e) {
        if (!(e instanceof api.ApiError) || e.status !== 0) {
          console.warn("[save] server load failed; falling back to local", e);
        }
        // fall through to the local cache
      }
    }
    // Offline / signed-out: local only (original behavior).
    return this.loadLocal();
  }

  // Load from THIS identity's own cache key only (account cache when signed in, the
  // local profile slot when not). Never reads another key, so accounts can't share
  // a farm on a shared device.
  private async loadLocal(): Promise<boolean> {
    const raw = this.readLocal(this.cacheKey());
    if (!raw) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[save] corrupt JSON; starting fresh");
      return false;
    }
    const data = this.validate(parsed);
    if (!data) return false;
    await this.applySave(data);
    return true;
  }

  private readLocal(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  /** Accept only a SaveGame at the current schema version. */
  private validate(data: unknown): SaveGame | null {
    const d = data as SaveGame | null;
    if (!d || typeof d !== "object") return null;
    if (d.version !== SAVE_VERSION) {
      // No prior versions exist yet; add migrations here when the schema grows.
      console.warn(`[save] version ${d.version} != ${SAVE_VERSION}; starting fresh`);
      return null;
    }
    return d;
  }

  // Hydrate the whole game from a validated SaveGame. Shared by the local and
  // server load paths.
  private async applySave(data: SaveGame): Promise<void> {
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
    // Friends: default gift counters for forward-compat with pre-social saves.
    this.state.friends = (data.social?.friends ?? []).map((f) => ({
      ...f,
      giftsSent: f.giftsSent ?? 0,
    }));
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
  }

  clear() {
    try {
      localStorage.removeItem(this.cacheKey());
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
    // Outbox: when the network returns, flush any change that failed to push.
    window.addEventListener("online", () => {
      if (this.dirty && this.isOnline() && !this.conflicted) void this.push(this.serialize());
    });
  }
}

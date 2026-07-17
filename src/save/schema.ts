// ---------------------------------------------------------------------------
// Save-game schema (Phase 1: Farm State Foundation)
// ---------------------------------------------------------------------------
// A single serializable snapshot of everything the local, no-server game needs
// to restore a farm across close/reopen. Stored as JSON in localStorage.
//
// Design principles:
//   1. Persist SOURCE-OF-TRUTH mutable state only. Anything derivable is
//      recomputed on load: player level (from xp), sprites/textures, screen
//      positions, baseY, growth stage art, the wandering-zombie cosmetic actor.
//   2. Reference catalog data by KEY, never embed it. A planted carrot stores
//      "carrot", not the whole CropConfig — configs come from plants.json /
//      zombies.json at load time.
//   3. Versioned from day one. `version` gates migrations so later phases can
//      grow the shape without corrupting old saves.
//   4. Later-phase sections are OPTIONAL and reserved below, so a v1 save stays
//      small and forward-compatible (a v1 loader ignores unknown fields).
//
// NOT persisted, by design:
//   - The JobSystem queue (in-flight farmer actions). On load the queue is empty
//     and the farmer is idle; queued work is cheap to redo and messy to restore
//     mid-hoe.
//   - The wandering Dr. Zombie actor (pure cosmetic until Phase 3 ownership).
//   - Camera pan/zoom (a view preference, not game state).
// ---------------------------------------------------------------------------

import type { Friend } from "../social/friends";
import type { FarmBackground } from "../prefs";
import type { EpicBossRun } from "../epicBoss/types";

/** Bump when the shape changes in a way that needs a migration. */
export const SAVE_VERSION = 1;

/** localStorage key for the single active save slot. */
export const SAVE_KEY = "zf2r.v3.presentation-cache";

/** localStorage key for device settings (kept separate from game progress). */
export const SETTINGS_KEY = "zf2r.v3.settings";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface SaveGame {
  /** Schema version this blob was written with. */
  version: number;
  /** Epoch ms the save was written (Date.now()). Used for offline-growth math. */
  savedAt: number;

  player: PlayerSave;
  farm: FarmSave;

  // ---- Reserved for later phases (optional so v1 saves omit them) ----
  /** Phase 2: trees, decor, roads/fences placed on the farm. */
  objects?: PlacedObjectSave[];
  /** Phase 3: owned zombies grown from zombie crops. */
  ownedZombies?: OwnedZombieSave[];
  /** A pending Zombie Pot combine job, if one is running. */
  zombiePot?: ZombiePotSave;
  /** Independent pending jobs keyed by placed Zombie Pot object id. */
  zombiePots?: Record<string, ZombiePotSave>;
  /** Phase 4: item + zombie storage. */
  storage?: StorageSave;
  /** Consumable boost inventory (Market Boosts tab). */
  boosts?: { key: string; count: number }[];
  /** Real quest engine progress (active per-requirement counts + completed ids). */
  quests?: QuestSave;
  /** Phase 5: raid/invasion progress (lifetime win count per raid id). */
  raids?: RaidProgressSave;
  /** Active/completed limited Epic Boss run. Absent in saves created before the feature. */
  epicBoss?: EpicBossRun;
  /** Local offline-fallback friends list + gifting state. The online friend system
   *  is server-backed (net/api.ts + server/), not stored here. Absent = no local
   *  friends. */
  social?: SocialSave;
  /** First-run Tim Buckwheat guided tutorial progress. Absent = never started. */
  tutorial?: TutorialSave;
}

/** Offline social state: the local friends list. */
export interface SocialSave {
  friends: Friend[];
}

/** Phase 5: invasion progress. */
export interface RaidProgressSave {
  /** Lifetime wins keyed by raid id (e.g. { "1": 3 }). */
  completed: Record<string, number>;
  /** Epoch ms of the last completed invasion (drives the 2h cooldown). */
  lastRaidAt?: number;
  /** Chosen attack order (deployed zombie ids, first attacks first). */
  attackOrder?: string[];
}

// ---------------------------------------------------------------------------
// Player / progression
// ---------------------------------------------------------------------------

export interface PlayerSave {
  /** Display name; "Zombie Farmer" by default. */
  name: string;
  gold: number;
  brains: number;
  /** Total XP. Level + level progress are DERIVED via XP_THRESHOLDS, not stored. */
  xp: number;
  /** Owned-zombie capacity (upgradeable later). Current count is derived once
   *  ownedZombies exists; kept as a counter meanwhile. */
  zombieMax: number;
  /** Live owned-zombie counter until the ownedZombies array is authoritative. */
  zombieCount: number;
  /** Farmer's resting tile, so he reappears where he was (cosmetic, optional). */
  farmer?: TileRef;
  /** Phase 4: ability-pool keys unlocked globally by winning tiered raids.
   *  Absent = none unlocked yet. */
  unlockedAbilities?: string[];
  /** Whether the player has ever acquired a Zombie Pot. Once true, extra pots cost
   *  a flat 30 brains forever (see GameState.zombiePotBought). Absent = never had one. */
  zombiePotBought?: boolean;
  /** Owned modular Farmer parts and the currently equipped mix. */
  farmerAppearance?: FarmerAppearanceSave;
  /** Cosmetic pet collection. Authoritative only for signed-out local saves. */
  petCollection?: PetCollectionSave;
}

export interface FarmerAppearanceSave {
  ownedHeads?: number[];
  ownedBodies?: number[];
  headId?: number;
  bodyId?: number;
}

export interface PetCollectionSave {
  owned: string[];
  active?: string | null;
  pen?: string[];
}

// ---------------------------------------------------------------------------
// Farm terrain + plots
// ---------------------------------------------------------------------------

export interface FarmSave {
  /** Which base field asset the farm was generated from (e.g. "default").
   *  Base terrain is loaded from that asset; only edits are stored below. */
  fieldId: string;
  /** Field dimensions in tiles, captured for validation against the asset. */
  w: number;
  h: number;
  /** Phase 2+: sparse terrain edits (climate/expansion) over the base field.
   *  Empty/absent = untouched base terrain. */
  terrainOverrides?: TerrainOverride[];
  /** Current ground/climate skin (a ground_index terrain key). Absent = "grass". */
  climate?: string;
  /** Density of the decorative foliage surrounding the farm. */
  background?: FarmBackground;
  /** Ground/climate skins purchased (switchable for free once owned). Always
   *  includes the free "grass" default. Absent = grass only. */
  ownedClimates?: string[];
  /** Every placed farming plot (free-placement 4x4 blocks). */
  plots: PlotSave[];
}

export interface TerrainOverride {
  col: number;
  row: number;
  terrain: string;
  variant: number;
}

/** Soil lifecycle: plowed -> planted -> (grows) -> harvest -> dirt|hole -> re-till. */
export type PlotStateSave = "plowed" | "planted" | "dirt" | "hole";

export interface PlotSave {
  /** Plot origin tile = north corner of the 4x4 block. Doubles as its identity. */
  oc: number;
  or: number;
  state: PlotStateSave;
  /** Present iff state === "planted". */
  crop?: CropSave;
}

export interface CropSave {
  /** Catalog key -> CropConfig at load (plants.json / zombies.json). */
  key: string;
  /** Whether this is a zombie crop: decides post-harvest soil (hole vs dirt) and
   *  growth art (gravestone->zombie vs seed->plant). Cached so a load never has
   *  to guess before the catalog is consulted. */
  isZombie: boolean;
  /** Epoch ms when planted. Growth age = clamp(now - plantedAt, 0, growMs), so
   *  crops continue growing while the game is closed (offline growth). */
  plantedAt: number;
  /** Effective grow duration (ms) chosen at plant time. Stored explicitly so a
   *  crop keeps its timeline even if runtime grow-time scaling changes between
   *  sessions. (Currently scaled to 8-45s for playtesting; real times live in
   *  the source data.) */
  growMs: number;
  /** A Garden zombie fertilized this crop (on plant) → 2x harvest + leaf FX. */
  fertilized?: boolean;
}

// ---------------------------------------------------------------------------
// Reserved later-phase shapes (stubs — refine when each phase lands)
// ---------------------------------------------------------------------------

/** Phase 2: a persistent placed object (tree/decor/functional). */
export interface PlacedObjectSave {
  id: string;
  /** Market/catalog key for the object type. */
  key: string;
  /** Footprint origin tile (north corner). */
  oc: number;
  or: number;
  /** Optional orientation for rotatable objects. */
  rotation?: number;
  /** Fruit trees: epoch ms when the fruit next becomes harvestable (offline
   *  growth — fruit ripens while the game is closed). */
  readyAt?: number;
}

/** Phase 3: an owned zombie unit. */
export interface OwnedZombieSave {
  /** Unique instance id. */
  id: string;
  /** Type/source key -> base stats from UnitStats/Zombies data. */
  key: string;
  /** Rank/level if the unit ranks up; base stats derived from key otherwise. */
  level?: number;
  /** Lifetime invasions fought (drives veterancy). Absent = 0. */
  invasions?: number;
  /** On-farm resting tile when deployed. */
  pos?: TileRef;
  /** true = in storage, false/absent = out on the farm. */
  stored?: boolean;
  /** Mutation BITMASK (mutations.ts). Absent/0 = unmutated. Stats are re-derived
   *  from key + this mask on load. */
  mutation?: number;
  /** Optional inherited display tint for Zombie Pot results. Omitted means use
   *  the source model's catalog tint. */
  color?: [number, number, number];
}

/** A pending Zombie Pot combine job. Both parents are consumed on start; the
 *  result is produced when `finishAt` passes (offline-safe: absolute epoch). */
export interface ZombiePotSave {
  /** Authoritative identities of the consumed parents. Persisted for signed-in
   * games so an in-progress job can be reconstructed after a reload. */
  parentAId?: string;
  parentBId?: string;
  /** Species key of parent A. */
  keyA: string;
  /** Species key of parent B. */
  keyB: string;
  /** Parent A's mutation mask at combine time. */
  maskA: number;
  /** Parent B's mutation mask at combine time. */
  maskB: number;
  /** Parent display tints at combine time, used to color the child. */
  colorA?: [number, number, number];
  colorB?: [number, number, number];
  /** Parent combat tiers (0..5) at combine time — drives species selection when
   *  both parents are non-veggie (higher tier wins). Optional for old saves. */
  tierA?: number;
  tierB?: number;
  /** Whether each parent is a mutation-base (veggie/mutant-tier) zombie. The
   *  species picker treats these as mutation donors (see ZombiePot). */
  baseA?: boolean;
  baseB?: boolean;
  /** Parent body types and Special-category flags used by the level-25 rare
   * combining-special roll and the one-special species override. */
  groupA?: string;
  groupB?: string;
  specialA?: boolean;
  specialB?: boolean;
  /** Player level captured when the combine began. Optional for old saves. */
  playerLevel?: number;
  /** Epoch ms the combine started. */
  startedAt: number;
  /** Epoch ms the result is ready (start + duration, Monolith already applied). */
  finishAt: number;
}

/** Phase 4: the storage shed's contents. */
export interface StorageSave {
  /** Item capacity (8 per shed tier, upgraded by placing a bigger shed). */
  itemCap: number;
  /** Stored placeable-object keys + counts (from the Items tab). */
  items: { key: string; count: number }[];
  /** Legacy: stored pet keys. Pets are out of scope for this rebuild (see
   *  docs/mechanics/PET_SYSTEM.md); retained optional only so older saves parse. */
  pets?: string[];
  /** Raid-looted placeables (unlimited; the Received tab). */
  received: string[];
}

export interface QuestSave {
  /** Active quests with a running count per requirement (aligned to the quest's
   *  requirements array). */
  active: { id: string; counts: number[] }[];
  completed: string[];
}

/** First-run guided tutorial (Tim Buckwheat) progress. Absent = never started.
 *  `step` is a numeric TutStep; `target` keeps the 4x4 action plot stable. */
export interface TutorialSave {
  done: boolean;
  step: number;
  /** Origin of the tutorial's 4x4 plot. Persisted across reloads. */
  target?: TileRef;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export interface TileRef {
  col: number;
  row: number;
}

/** Device settings — persisted separately from game progress (SETTINGS_KEY).
 * Managed by AudioManager, which reads/writes this key directly. */
export interface Settings {
  music: boolean;    // farm BGM loop — defaults on
  sfx: boolean;      // action + menu one-shots — defaults on
  ambience: boolean; // ambient farm bed (birds/rooster) — defaults on
  muteWhenUnfocused: boolean; // pause all audio while the game lacks focus
}

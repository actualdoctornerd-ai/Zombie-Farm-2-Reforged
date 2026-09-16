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
//   - Pixi animation state for farmer jobs. Local Farm persists semantic job intent
//     and restarts/replays it; sprites, bars, and partial walk paths are rebuilt.
//   - The wandering Dr. Zombie actor (pure cosmetic until Phase 3 ownership).
//   - Camera pan/zoom (a view preference, not game state).
// ---------------------------------------------------------------------------

import type { Friend } from "../social/friends";
import type { FarmBackground } from "../prefs";
import type { EpicBossRun } from "../epicBoss/types";
import type { PeriodicQuestState } from "../quest/periodic/types";
import type { ZombieTeam } from "../zombie/teams";
import type { FarmStats } from "../stats";

/** Bump when the shape changes in a way that needs a migration. */
export const SAVE_VERSION = 1;

/** Bring a save written by an older build up to `SAVE_VERSION`, or return null if it
 *  cannot be read at all.
 *
 *  There is nothing to migrate yet — every field added since launch was made optional
 *  with a default precisely so the version never had to move. That is exactly why this
 *  exists NOW rather than later: every reader compared `version !== SAVE_VERSION` and
 *  treated any difference as damage, so the first person to bump the constant would
 *  have made every Local Farm in existence unreadable, and the recovery dialog those
 *  players land on offers "Start a New Local Farm" — it deletes the save AND its
 *  backup. A one-line constant change was one click away from wiping every offline
 *  player, with the bytes on disk perfectly intact the whole time.
 *
 *  A save from the FUTURE is still refused: this build cannot know what a later one
 *  meant, and guessing would corrupt it for the build that can read it.
 *
 *  To add a migration: handle the old version here, return the upgraded blob, and add
 *  a case to schema.migrate.test.ts. `migrateSave` is the ONLY place allowed to know
 *  what an old save looked like. */
export function migrateSave(data: SaveGame | null | undefined): SaveGame | null {
  if (!data || typeof data !== "object") return null;
  const version = (data as SaveGame).version;
  if (!Number.isInteger(version) || version > SAVE_VERSION) return null;
  if (!data.player || !data.farm) return null;
  // if (version === 1) { ...upgrade in place, then fall through... }
  return version === SAVE_VERSION ? data : null;
}

/** Legacy mixed-purpose key. Retained only for safe migration. */
export const SAVE_KEY = "zf2r.v3.presentation-cache";
/** Local Farm profiles. These are never read by Online Farm. */
export const LOCAL_SAVE_PREFIX = "zf2r.local.save.v1";
/** Last server-confirmed account snapshot, used for disconnected viewing only. */
export const ONLINE_SNAPSHOT_PREFIX = "zf2r.online.snapshot.v1";
/** Account presentation cache. This never contains Local Farm progression. */
export const ONLINE_PRESENTATION_PREFIX = "zf2r.online.presentation.v1";

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
  /** Daily/weekly quests. OFFLINE ONLY — online these are server-owned and projected,
   *  never round-tripped through the save. Absent on saves written before the feature,
   *  and on every online save; both are read as "generate a fresh board". */
  periodicQuests?: PeriodicQuestState;
  /** Phase 5: raid/invasion progress (lifetime win count per raid id). */
  raids?: RaidProgressSave;
  /** Active/completed limited Epic Boss run. Absent in saves created before the feature. */
  epicBoss?: EpicBossRun;
  /** Unfinished farmer intents, replayed from elapsed wall time. Online saves keep
   * these in presentation data and revalidate them against server farm state. */
  farmJobs?: FarmJobQueueSave;
  /** Local offline-fallback friends list + gifting state. The online friend system
   *  is server-backed (net/api.ts + server/), not stored here. Absent = no local
   *  friends. */
  social?: SocialSave;
  /** First-run Tim Buckwheat guided tutorial progress. Absent = never started. */
  tutorial?: TutorialSave;
  /** Zombie Almanac: lifetime obtained count per species key. Absent in saves
   *  written before the Almanac existed — backfilled from ownedZombies on load. */
  almanac?: AlmanacSave;
  /** Zombies lost for good, kept only so a Memorial Statue can enshrine one.
   *  Absent = nothing has died yet (or the save predates memorials). */
  fallen?: FallenZombieSave[];
  /** Saved farm line-ups (a name + owned zombie ids). Pure client-side
   *  presentation — assembling one only issues ordinary store/deploy moves.
   *  Absent = no teams (or a save written before the feature). */
  teams?: ZombieTeam[];
  /** Lifetime statistics (the Account menu's Statistics panel). A kept tally that
   *  cannot be recovered from a save after the fact — see stats.ts. Absent in saves
   *  written before it existed; those start counting from the load, with the one
   *  figure that IS derivable (invasions won) seeded from the raid progress. */
  stats?: FarmStats;
}

/** A zombie that perished and was not revived — what a Memorial Statue remembers.
 *
 *  Deliberately the SAME minimal shape as OwnedZombieSave: species, mask, veterancy
 *  and tint, with the whole card (type name, body type, class, stats) derived from
 *  the catalog by key, exactly as it is for a unit that is still alive. Only two
 *  things cannot be derived once the unit is gone, and only those are stored: when
 *  it died, and the name its owner gave it.
 *
 *  It is display data. A fallen zombie can never fight, be sold, or come back — the
 *  one chance to keep it was the revival offer made when the raid settled. Mirrored
 *  by FallenUnitProjection on the wire and fallen_v3 on the server. */
export interface FallenZombieSave {
  id: string;
  key: string;
  /** Absent = the deterministic default name, same as an unnamed living unit. */
  name?: string;
  mutation: number;
  invasions: number;
  color?: [number, number, number];
  /** Epoch ms the unit was lost. Shown on the memorial. */
  diedAt: number;
  /** Epoch ms this zombie was last taken OFF a statue, if it ever has been. It ranks
   *  the graveyard in place of `diedAt` (see graveyardRank) so someone just released
   *  goes back to the top of the list rather than to whatever position their date of
   *  death earns — they still age out, just not the instant the statue is sold. Never
   *  shown: the plaque's date is always `diedAt`. */
  releasedAt?: number;
}

/** Zombie Almanac collection progress (cosmetic; counts never decrease). */
export interface AlmanacSave {
  discovered: Record<string, number>;
  /** Mutation Almanac: lifetime count per mutation key. Absent in saves written before
   *  that tab existed — backfilled from the owned roster's masks on load, which is
   *  lossy only for mutations the player owned and has since sold. */
  mutations?: Record<string, number>;
}

export interface FarmJobSave {
  kind: "till" | "plant" | "harvest" | "walk" | "harvestTree";
  oc: number;
  or: number;
  cx: number;
  cy: number;
  queuedAt?: number;
  cropKey?: string;
  objectId?: string;
}

export interface FarmJobQueueSave {
  savedAt: number;
  jobs: FarmJobSave[];
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
  /** OFFLINE brain pity: brain-eligible invasions settled since the last brain drop
   *  (see src/raid/brainDrops.ts). Absent in saves written before it existed. */
  brainDryStreak?: number;
  /** OFFLINE rare-zombie pity, keyed by raid id: wins of that raid since it last dropped
   *  its rare zombie (see src/raid/zombieDrops.ts). Absent in older saves. */
  zombieDryWins?: Record<string, number>;
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
  /** The head worn — appearance only, and the face friends see beside your name. */
  headId?: number;
  bodyId?: number;
  /** The head whose bonus is pinned. Absent/null = the worn head supplies it,
   *  which is what every save written before the two-slot split means. */
  bonusHeadId?: number | null;
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
  /** Whether the placed Zombie Patch has gathered the deployed zombies to nap.
   *  Absent in older saves, which restores the original awake behavior. */
  zombiePatchGathered?: boolean;
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
  /** Optional orientation for rotatable objects: 1 = mirrored on the vertical axis. */
  rotation?: number;
  /** Orientation of an object whose corners are separate pieces of art (the road
   *  bends): an index into the def's `turns`. Written INSTEAD of `rotation` for
   *  those, since for them a mirror is not what turning means — see savedTurn. */
  turn?: number;
  /** Fruit trees: epoch ms when the fruit next becomes harvestable (offline
   *  growth — fruit ripens while the game is closed). */
  readyAt?: number;
  /** Catalog key of a purely COSMETIC appearance override — an earlier storage shed
   *  whose art this object wears (see src/objectSkins.ts). Never the object's real
   *  type: `key` alone decides capacity, sale price and what the Market offers next.
   *  Absent on every object wearing its own look, which is almost all of them. */
  skin?: string;
  /** Memorial Statue only: the perished zombie enshrined on this plinth. Carried
   *  on the object rather than in `fallen` so the statue and its occupant move,
   *  save and load as one thing. */
  memorial?: FallenZombieSave;
}

/** Phase 3: an owned zombie unit. */
export interface OwnedZombieSave {
  /** Unique instance id. */
  id: string;
  /** Type/source key -> base stats from UnitStats/Zombies data. */
  key: string;
  /** Player-chosen individual name. Absent uses the deterministic default name. */
  name?: string;
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
  /** Parent A's display NAME at combine time. Slot 1 already decides the child's
   *  species, so it decides its name too: the zombie you fed into the first slot
   *  comes back out, renamed only if the player renamed it. Absent on jobs started
   *  before this (and on any job whose slot-1 parent had no name), which fall back
   *  to the usual id-derived random name. */
  nameA?: string;
  /** Parent A's mutation mask at combine time. */
  maskA: number;
  /** Parent B's mutation mask at combine time. */
  maskB: number;
  /** Parent display tints at combine time, used to color the child. */
  colorA?: [number, number, number];
  colorB?: [number, number, number];
  /** Parent combat tiers (0..5) at combine time. Retained for compatibility with
   *  saves created before slot 1 became the guaranteed output type. */
  tierA?: number;
  tierB?: number;
  /** Whether each parent is a mutation-base (veggie/mutant-tier) zombie.
   *  Retained for compatibility with older saves. */
  baseA?: boolean;
  baseB?: boolean;
  /** Parent body types and Special-category flags used by the level-25 rare
   *  promotion and permanent-special species override. */
  groupA?: string;
  groupB?: string;
  /** Parent colour classes (Green / Blue / Red / Silver / ...). A matched pair breeds
   *  one class up the ladder, so the result cannot be derived without them. Absent on
   *  jobs persisted before the ladder existed; those keep the older silver rule. */
  classA?: string;
  classB?: string;
  specialA?: boolean;
  specialB?: boolean;
  /** Player level captured when the combine began. Optional for old saves. */
  playerLevel?: number;
  /** True when this job was started against a server that RESERVES both parents
   *  (`lockedByRaid = "pot:<id>"`). It makes a missing reservation diagnostic: the
   *  server has no such combine, so the job is a local fiction and its parents — which
   *  the presentation hides while a job holds them — must be released rather than kept
   *  hidden forever. Absent on offline jobs and on jobs persisted before reservations
   *  existed, which the server still honours through its unreserved fallback. */
  reserved?: boolean;
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
 * Managed by AudioManager, which reads/writes this key directly; the authoritative
 * shape is its `StoredSettings`, and every field here is optional in storage (a
 * missing one takes the default noted beside it). Documented rather than imported
 * so this file stays the one place the save's storage keys are described. */
export interface Settings {
  master: boolean;   // "All Audio" kill switch over every channel — defaults on
  music: boolean;    // farm BGM loop — defaults on
  sfx: boolean;      // action + menu one-shots — defaults on
  ambience: boolean; // ambient farm bed (birds/rooster) — defaults on
  // Per-channel levels, 0..1. Each channel's final gain is its own level times the
  // master level times the clip's authored volume.
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  ambienceVolume: number;
  muteWhenUnfocused: boolean; // also pause while a visible desktop window lacks focus
}
